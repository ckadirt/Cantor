# Cantor node stress-test plan

Status: harness implemented and exercised at every level from one through five
users on this machine, including up to 25 concurrent transfer sessions.

## Goal and boundary

Measure whether a single Cantor node remains responsive to normal library
actions and artifact downloads while its generation worker is busy, with one
through five paired users. The test must use the same encrypted client → relay →
node protocol as the app. It must report what the machine actually sustains,
including failures and stalls, rather than merely submit requests successfully.

The initial test uses the existing relay endpoint. A temporary node gets a new
identity and therefore a separate relay room. Its config, library, control
socket, client identities, fixtures, logs, and reports live beneath an explicit
test work directory. Its `model_dir` points to the installed model store on the
machine; model weights and engine files are read from there. The normal node's
config and library are never used. The temporary node is stopped gracefully at
the end. The work directory is retained for inspection and is never deleted
automatically.

This evaluates the node plus relay path without the React Native UI. If a delay
appears, a later, targeted pass can add node-side timing to separate node work
from relay or network wait. The benchmark itself will not claim to diagnose UI
performance.

## Repository layout

Place the reusable tool in `node/stress/`:

| File | Responsibility |
| --- | --- |
| `PLAN.md` | This design and runbook. |
| `run.mjs` | CLI, isolated-node lifecycle, pairing, fixture setup, phase scheduling, and report writing. |
| `client.mjs` | Persistent encrypted test client built on `node/scripts/lib/SecureClient`, with request correlation and complete artifact transfers. |
| `metrics.mjs` | Timing summaries, percentile calculation, process sampling, and report schema. |
| `run.test.mjs` | Focused tests for CLI bounds, summaries, and artifact transfer validation. |

The final implementation can split files differently if that makes the code
clearer, but each responsibility should remain explicit. Shared wire constants
come from the existing manifest-backed client library; no wire format is copied
or changed.

## Launch and safety checks

The intended command, from the repository root, is:

```sh
node node/stress/run.mjs \
  --workdir /path/to/cantor-stress-run \
  --node-bin /path/to/cantor \
  --model-dir /path/to/existing/cantor/models \
  --relay wss://YOUR_EXISTING_RELAY \
  --model acestep:1.5-fast \
  --users 5
```

These paths and the model selector are examples. The tool requires the
work directory, node binary, model directory, relay URL, and model selector
explicitly. It rejects overlap with default config and library paths, verifies
the model marker and blob sizes, requires at least 2 GiB free, and relies on
the node's lock and control-socket checks. It prints paths, relay, model, and
workload before starting. Pairing URIs, tokens, and private keys are not written
to reports.

Two modes make an expensive setup reusable:

```sh
node node/stress/run.mjs ... --phase prepare
node node/stress/run.mjs ... --phase run --levels 1,2,3,4,5 --seconds 600 --repetitions 3
```

Use `--dry-run` to validate the binary, model files, disk space, and schedule
without creating files or starting a node. `--phases idle,mixed --fixtures 2`
gives a smaller first run. Optional `--install-backend cpu` or
`--install-backend vulkan` invokes the node's normal backend installer against
the selected model directory and pins that backend in the temporary node's
config. This writes an engine archive to the selected model directory; use an
isolated model store if the existing store must remain untouched.

For a short first run with an existing one-song fixture, use
`--phase run --users 1 --levels 1 --phases mixed --fixtures 1 --seconds 20
--repetitions 1 --max-outstanding 1`. The default maintains three outstanding
jobs per user. `--minimum-available-mib` sets the free-memory stop and defaults
to 2048. Node logs and JSON-line memory samples are written as the run proceeds
so they survive an unclean shutdown when the work directory is persistent.

`prepare` creates or reuses the requested number of test identities, pairs each independently,
generates the requested number of short songs owned by each identity, and waits until each song's
delivery artifact is available. The five songs per user make five simultaneous
downloads possible without sharing private files between owners. Fixture jobs
and delivery encoding are outside timed runs. Preparation records the job IDs,
artifact profile, byte lengths, and hashes in a private fixture manifest. A
rerun validates the manifest against the node before using it. If setup fails,
the run stops with a clear reason; it does not silently reduce the workload.

`run` reconnects those identities, checks fixtures, and executes the matrix
below. It should resume from the same work directory so generated fixtures do
not have to be recreated each time. The default `--users 5` prepares five
identities, while `--levels` chooses the tested active counts. A `--dry-run`
mode should validate paths and print the schedule without starting a node or
creating data.

The node has one native inference worker. Multiple accepted generation jobs are
expected to queue; the test must distinguish queue wait from engine runtime.
Artifact transfer allows one active transfer per secure session, so the burst
phase opens five sessions per identity. All sessions still authenticate as that
same user.

## Fixed workload per measured phase

The default runs every phase at 1, 2, 3, 4, and 5 users. Repeat each cell three times, each
for 10 minutes by default. Keep the same model variant, generation duration,
steps, artifact profile, fixtures, and client machine throughout a comparison.
Stagger periodic requests by a deterministic per-user offset so they do not all
arrive at the same instant. Record the random seed and schedule in the report.

| Phase | Per-user actions |
| --- | --- |
| Idle baseline | Alternate `library.list` and `song.get` every 5 seconds; every 15 seconds, use `song.patch` to add or remove a descriptive tag or a `p/` playlist tag; repeatedly download one fixture song. No generation jobs. |
| Mixed generation | Keep the idle actions running. Submit one generation at phase start and maintain up to three outstanding generation jobs per user: one running or preparing and up to two queued. Refill after a terminal result until the phase ends. |
| Download burst | Keep mixed generation, reads, and patches running. Open five extra secure sessions per user and continuously download five fixture songs in parallel. At five users this means 25 simultaneous transfers. |

The driver must match `song.patch` to the latest song revision. A genuine
revision conflict is recorded; the next edit re-reads the song and tries again.
It must not mutate fixture metadata before measuring or send invalid patches as
part of the normal workload. Playlists are represented by `p/` tags in the same
`song.patch` request as ordinary tags.

The download client sends `artifact.open`, then acknowledges each chunk at the
next expected offset until `artifact.complete`. It consumes bytes immediately,
verifies total length and SHA-256, and records errors or incomplete transfers.
It must never count a partial download as success. Reconnect and resume behavior
is measured separately, rather than silently included in a clean transfer.

## Measurements

Use a monotonic clock in the client process. Every request gets a unique ID;
the timer starts immediately before submitting it to the secure client and
stops when the matching response is received. The report includes every raw
sample, not only aggregate numbers.

| Measurement | Start → end |
| --- | --- |
| Connect/authentication | WebSocket open → authenticated `welcome`; track secure-handshake time separately if practical. |
| Job acceptance | `job.create` send → `job.accepted`. |
| Queue wait | `job.accepted` → first durable `preparing` or `running` update, with each state timestamp retained. |
| Generation | First `running` update → terminal `completed`, `failed`, or `cancelled` update; keep stage times when reported. |
| Library read | `library.list`/`song.get` send → matching page/detail response; a full paginated list also gets an end-to-end time. |
| Metadata edit | `song.patch` send → `song.updated` or error; record conflicts separately. |
| Transfer open | `artifact.open` send → `artifact.info`. |
| Transfer progress | Every `artifact.ack` send → next chunk/complete; record the inter-chunk gap and first-byte time. |
| Complete download | `artifact.open` send → `artifact.complete` with verified hash; report bytes/s. |

For each phase and active-user count, report successful count, error count by
code, timeout count, p50/p95/p99/max latency, download throughput, bytes moved,
and stalls. A download stall is a gap of at least 5 seconds between expected
chunks while a transfer is active; the raw gap is retained so a different
threshold can be applied later. A request timeout is 30 seconds by default,
and the exact timeout setting appears in the report. Long generation waits are
tracked independently and are not misclassified as request timeouts.

Sample the temporary node process once per second: CPU time and utilization,
RSS, disk bytes read/written, and process state. On Linux, `/proc/<pid>` supplies
these; when available, sample GPU utilization and VRAM with `nvidia-smi` and
label missing GPU telemetry as unavailable. Also retain the node's own logs,
job-state counts, relay disconnect/reconnect events, and the client machine's
network bytes if they can be sampled reliably. Report the node and client
machine characteristics (CPU, RAM, GPU, OS), model, backend, binary revision,
relay URL, and run start time so runs can be compared.

Output lives under `<workdir>/reports/`: one machine-readable JSON file with
raw events and samples, plus a concise Markdown summary with a row for every
phase/user-count/repetition. The summary compares mixed and burst results to
the same user count's idle baseline. It explicitly lists integrity failures,
stalls, disconnected sessions, failed jobs, and unfinished jobs left at the end.
There is no invented pass/fail threshold: the first run establishes the machine
baseline, then targets can be agreed from the observed numbers.

## Execution order and verification

1. Implement and unit-test the driver against a fake protocol client, including
   timeouts, job-state accounting, revision conflicts, and download hash checks.
2. Run a one-user smoke check on the isolated node: authenticate, accept one
   job, wait for a delivery artifact, patch a tag, and download it with a valid
   hash. Confirm the report and cleanup work after a normal exit and Ctrl-C.
3. Prepare all identities and fixtures. Keep this cost outside the measured
   phases.
4. Run the 1–5 user matrix. If a phase fails, preserve its raw report and node
   logs; do not hide the failure by averaging it into successful runs.
5. If latency spikes, repeat the smallest failing cell with node-side timing
   around application handling, SQLite operations, artifact read/encode, and
   outbound socket enqueue/write. This is a targeted diagnostic pass, separate
   from the unmodified-node benchmark.

## Current-machine results

On 2026-09-24, the isolated node connected through
`wss://cantor.ckadirt.xyz`. The source model store had
`acestep:1.5-fast-local-q4` and all four blobs, but its older engine archive did
not match the current backend manifest. A current CPU engine was installed into
an isolated hard-linked model-store copy; the engine loaded, then the plan stage
failed with `store_require_lm failed` / `no backend available`. Vulkan reached
the same allocation failure. The node retried the fixture job and marked it
failed. Rebuilding `node/target/debug/cantor` from current source fixed that
engine-loading mismatch. The first rebuilt fixture run crossed a deliberately
high 3072 MiB free-memory stop during decoding; the node shut down and still
published its artifact. The harness recovered that fixture on restart.

Subsequent small runs used the current CPU engine and a 2048 MiB memory stop.
At one user, a 20-second idle run had five verified downloads, median 4.79 s,
and no stalls. A 20-second mixed run had four verified downloads, median
4.85 s, two successful tag edits, and one completed generation. At two users,
a 20-second mixed run had ten verified downloads, median 4.06 s, no stalls or
request errors, and two completed generations. One job waited 42.8 s behind
the other on the single inference worker. These are smoke samples, not stable
performance estimates. Reports and live logs are in
`/home/ckadirt/Projects/Cantor/cantor-stress-run/reports/`; the isolated model
store is `/home/ckadirt/Projects/Cantor/cantor-stress-models`.

The 2026-09-24 full sweep used 60-second idle and mixed phases at each of
1–5 users, one outstanding generation job per user, 15-second/8-step jobs,
and two distinct fixture songs per user. Reads rotate among `library.list`,
`song.get`, `library.sync`, `jobs.list`, and `status`. Edits rotate across
ordinary tags, `p/Stress playlist` membership, favorite, and title; downloads
rotate across owned songs. Each download verifies length and SHA-256. No
request errors or 5-second download stalls occurred. The mixed-phase results
were:

| Users | Verified downloads | Downloaded bytes | Median transfer | Completed jobs |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 9 | 2,656,499 | 6.78 s | 2 |
| 2 | 26 | 7,582,967 | 4.68 s | 3 |
| 3 | 38 | 11,130,450 | 4.69 s | 4 |
| 4 | 59 | 17,225,848 | 3.93 s | 5 |
| 5 | 74 | 21,742,536 | 4.05 s | 6 |

Full raw report: `stress-2026-09-24T20-46-54-551Z.json` in the reports
directory above. These are short, single-repetition observations, not a
statistical capacity guarantee.

A separate 30-second-per-level burst swept 1–5 users with five different songs
and five transfer sessions per user (5–25 concurrent sessions), while reads,
edits, and generation continued. The first burst completed without errors:

| Users | Verified downloads | Downloaded bytes | Median transfer | 5 s stalls |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 37 | 10,870,213 | 4.26 s | 0 |
| 2 | 60 | 17,741,430 | 3.87 s | 0 |
| 3 | 120 | 35,556,592 | 3.91 s | 0 |
| 4 | 40 | 11,792,428 | 15.76 s | 2 |
| 5 | 86 | 25,374,023 | 10.29 s | 0 |

Raw report: `stress-2026-09-24T21-08-36-660Z.json`. The nominal phase length
does not include completion of transfers already in flight; do not divide the
listed byte totals by 30 seconds to claim aggregate throughput. The report
contains per-transfer byte rates and timestamps.

The targeted 4–5 user burst repeat again slowed at four users: 60 verified
downloads, 17,688,642 bytes, median 10.29 s, and four 5-second stalls. At five
users, 75 transfers verified (22,117,947 bytes, median 10.72 s) before a relay
`node-offline` error terminated the run; 28 transfer gaps of at least 5 seconds
were recorded. The temporary node log shows it was still generating, then the
harness shut it down after the relay error; sampled memory stayed above 4.24 GiB
available and node RSS below 7.37 GiB. This does not establish whether the
disconnect originated in the relay, network, or node connection handling.
The failed repeat report is `stress-2026-09-24T21-22-53-274Z.json`; preserve it
alongside its `.node.log` and `.samples.jsonl` for diagnosis.

# Private Library Implementation Notes

## Status

Milestone 0 implementation and its physical-phone hosted-relay exit gate were
completed on 2026-08-07.

## Decisions

- Application protocol v2 is a coordinated pre-release break. Relay carrier
  protocol remains v1 and is represented by a separate constant in clients.
- The authenticated principal is SHA-256 of the canonical 32-byte Ed25519
  public key. The app does not receive or authorize with the principal ID.
- The M0 session context contains only established facts: relay session ID,
  principal ID, and canonical client public key. Device and role fields wait
  until their policies exist.
- Job revisions are positive, per-job, monotonic integers. Revision 1 is the
  accepted job. Only client-visible persisted changes advance it.
- State is durable lifecycle; stage is current generation work. Progress does
  not duplicate stage and uses non-negative integer units.
- M0 defines pause/resume/cancel capability flags but not their request shapes.
  Their transition semantics belong to M4.
- Runtime validation is performed at the network boundary. Generated
  TypeScript describes trusted values but does not validate WebSocket input.
- Concrete v2 bounds are conservative initial admission limits and are exposed
  by `NodeLimits`; the node remains authoritative.

### Job lifecycle contract

- `queued -> preparing -> running -> finalizing -> completed` is the normal
  path. A running job's generation stage advances `plan -> codes -> diffuse ->
  decode`; stage is not a second lifecycle state.
- `pause_requested`, `paused`, `cancel_requested`, and `recovering` are reserved
  durable lifecycle states. Their command transitions remain unfrozen until M4.
- `completed`, `cancelled`, and `failed` are terminal. A retry is a new attempt,
  not a mutation out of a terminal state.
- Revision 1 represents acceptance. Each client-visible persisted transition
  increments the revision exactly once; display timestamps never decide order.
- Progress is non-negative integral work. If `total` is present it is positive
  and `completed <= total`.

## Implementation Log

- Began by auditing the existing v1 Rust protocol, node session dispatch,
  installed-model records, React Native boundary parsers, relay carrier, CI,
  and the manual protocol client.

## Deviations

- The milestone draft proposes reserving `device_id` and `role` in the session
  context. They are omitted because the current pairing store has no honest
  device or role semantics; adding placeholders would create accidental policy.
- The draft permits defining pause/resume/cancel early. M0 only advertises them
  as unavailable features because M4 has not frozen checkpoint transitions.
- The draft asks for a Rust/TypeScript principal derivation fixture if the app
  needs the value. The app has no such need in M0, so the canonical derivation
  vector is tested in Rust only.
- The draft recommends model display labels and input capabilities in
  `NodeInfo`. Existing installed records only persist selector, family, and
  engine. M0 exposes only those honest fields instead of fabricating metadata;
  catalog-backed display/capability fields can be added when installation
  persists them deliberately.

## Verification

- `cargo fmt --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo test --workspace`: 82 tests passed.
- `npx tsc --noEmit` in `cantor/`: passed.
- `npx jest --runInBand` in `cantor/`: 137 tests passed.
- `npx eslint .` in `cantor/`: passed with one pre-existing inline-style
  warning in `src/onboarding/panels/kit.tsx`.
- `npx vitest run` and `npm run check` in `relay/`: 6 tests passed; worker
  types, TypeScript, test TypeScript, and asset verification passed.
- `git diff --check`: passed.
- Physical app/hosted relay gate: passed on Android device `6b1f6ba8629c`
  through `wss://cantor.ckadirt.xyz`. A fresh temporary v2 node was paired from
  the phone, authenticated as the phone's existing Ed25519 identity, reached
  `READY`, rendered structured node limits/load and an empty correlated jobs
  page, and applied an unsolicited `node.info` rename push without reconnecting.
  The temporary backend was then removed from phone storage and the test node
  was stopped.

---

# Milestone 1 — Durable Submission

## Status

Implementation and the physical-phone exit gate completed on 2026-08-07.

## Decisions

- The node uses `rusqlite` with bundled SQLite. Acceptance runs through one
  connection under the existing node-state lock, giving idempotency and queue
  admission one serialization point.
- SQLite owns identity, uniqueness, order, and state. Per-job JSON sidecars own
  immutable accepted request/provenance bytes. The durable order is sidecar
  fsync, database commit, then `job.accepted`.
- Job IDs are UUIDv7; client UUIDs never become paths. Principal directories
  use the SHA-256 identity derived after authentication.
- The canonical idempotency hash covers the resolved model selector and the
  node-serialized `GenerationRequest`; it deliberately excludes the
  `client_request_id` that selects the uniqueness row.
- Idempotent lookup precedes queue and disk admission. A retry can therefore
  recover an acknowledged-or-not job even if the queue filled after acceptance.
- Initial admission defaults are 20 queued jobs per principal and a 2 GiB free
  space reserve. Both are node configuration, and the advertised limit is read
  from the same configuration.
- The phone freezes and persists the generation payload before the first send.
  Only non-retryable protocol errors move it to `rejected`; timeouts,
  disconnects, and retryable capacity errors keep it `pending`.
- Terminal protocol errors carry code/retryability through a typed
  `NodeRequestError`; an ordinary request rejection does not tear down an
  otherwise healthy authenticated connection.

## Implementation Log

- Added configurable library roots and `[jobs]` admission policy, including
  system/user installer paths and systemd `ReadWritePaths`.
- Added migration 001, WAL/full-synchronous startup policy, owner-only modes,
  startup `quick_check`, durable sidecars, idempotent insert, private list/get,
  queue/disk admission, and conservative orphan reconciliation.
- Routed `job.create`, `jobs.list`, `job.get`, and status through the
  authenticated session principal. Successful acceptance refreshes aggregate
  load and pushes `node.info` to authenticated sessions.
- Added the app composer with explicit installed-model selection, correlated
  request promises, durable outbox recovery, accepted-ID mapping, and
  synchronous duplicate-tap exclusion.
- Extended the manual protocol client with create, fixed request ID, retry, and
  canonical-ID verification modes.

## Deviations

- The draft splits storage across `library.rs`, `job_store.rs`, and `jobs.rs`.
  M1 keeps the transaction, paths, and reconciliation in one `Library` module;
  separating them now would allow filesystem and SQL ordering to drift. M2 can
  add a scheduler facade without weakening that boundary.
- The draft suggests adding a second mobile SQLite binding. M1 uses the
  existing AsyncStorage native persistence behind a dedicated outbox
  repository and serializes its read-modify-write operations. This avoids an
  unproven React Native 0.86 native dependency for one small key-value table.
  M3 must introduce a queryable cache/migration before relational library data
  needs joins or pagination.
- `jobs.list` rejects a non-null cursor in M1. With a per-principal queue capped
  at 20 and no completed library yet, returning partial cursor semantics would
  be less safe than a clear `invalid_request`; cursor paging is implemented
  with the M3 library index.
- The first composer exposes caption, lyrics, and duration but not steps/CFG/
  seed. `NodeInfo` does not yet publish authoritative bounds for those advanced
  fields; hardcoding app-only limits would let UI and node policy drift. The
  wire/outbox/node support them now, and a later capability addition can expose
  honest controls.
- Startup deletes only recognizable uncommitted M1 residue. Unknown content is
  moved to quarantine, never guessed at or deleted. Damage to a committed job
  is not silently reconstructed; M2 recovery owns its explicit state outcome.
- A database open, migration, or `quick_check` failure stops daemon startup
  instead of serving a partially functional relay presence. This is the
  conservative fail-closed behavior for irreplaceable state; offline config and
  model commands remain available, and a later maintenance mode may expose
  richer diagnostics without pretending the library is healthy.
- M1 does not bring the encrypted tunnel forward. Prompt/lyrics payloads remain
  readable inside the relay carrier until the planned privacy milestone, so
  physical validation uses non-sensitive fixture text.

## Verification

- `cargo fmt --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo test --workspace --no-fail-fast`: 87 tests passed (66 node, 21
  protocol).
- `npx tsc --noEmit`: passed.
- `npx jest --runInBand`: 142 tests passed.
- `npx eslint .`: passed with one pre-existing inline-style warning in
  `src/onboarding/panels/kit.tsx`.
- `sh -n node/install.sh`: passed. A real unprivileged installer fixture
  created mode-0700 model/library roots, a mode-0600 config with `[jobs]`, and a
  hardened service whose `ReadWritePaths` contains config, models, and library.
- Host release build passed. The x86_64 binary is 11,829,072 bytes unstripped
  and 9,178,456 bytes stripped; `ldd` shows no SQLite dependency, confirming the
  database is bundled. An aarch64 release artifact was not built locally because
  that target/toolchain is absent; the dependency configuration is target-
  independent and remains covered by the existing release workflow.
- Relay regression gate: 6 tests plus worker types, TypeScript, test TypeScript,
  static assets, catalog, and backend-manifest verification passed.
- Hosted-relay drill: a real node accepted one non-sensitive request, returned
  the same canonical UUIDv7 for an immediate retry, pushed aggregate load 0→1,
  and returned the same private job after a node restart.
- Physical Android `6b1f6ba8629c`: the current Metro bundle ran in the existing
  debug shell (M1 adds no native dependency). Because the phone temporarily had
  no working DNS route, its submission used the same relay locally through ADB
  reverse; the separate hosted-relay drill above covered production routing.
  The phone explicitly selected `acestep:m1-fixture`, persisted request UUID
  `db1037c0-9a9f-411c-9f6a-4067db09234d` before send, and mapped it to canonical
  job `019fde5c-2ba5-7cc2-a4dd-80997a5db365`. After both app kill and node
  restart it showed one private queued job while global load showed two; the
  other principal's queued job remained absent from its list.

---

# Milestone 2 — Generation Progress

## Status

Implementation and the bounded physical-phone real-engine exit gate completed
on 2026-08-08.

## Decisions

- Exactly one daemon scheduler owns claims. The SQL claim also refuses work
  while any job is preparing/running/finalizing, so the invariant survives an
  accidental second manager.
- A claim increments `attempt` and `revision` transactionally. Every worker
  mutation includes `(job_id, attempt)`, making callbacks from an older attempt
  harmless.
- Progress is durable at stage changes, stage completion, and at most once per
  second otherwise. The engine callback only uses a bounded `try_send`; it
  performs no database, filesystem, async, or WebSocket work.
- Automatic execution retry is capped at three total claims. Startup observes
  an interruption without incrementing the attempt, records
  `recovering -> queued`, and the next actual claim consumes the attempt.
- The canonical artifact is always `artifacts/master.wav`. Completion follows
  write/fsync, independent WAV inspection, SHA-256, atomic rename, directory
  fsync, manifest write, then the artifact/job database transaction.
- CLI generation uses a SHA-256-derived reserved local-operator principal.
  Ctrl-C only drops its observer; `--detach` is explicit, and `-o` exports the
  already-verified canonical master rather than becoming an engine output path.
- The app snapshot repository is keyed by node public key and job ID. Both list
  pages and pushes use the same higher-revision-only reducer; disconnect changes
  presentation to stale/offline without mutating canonical job state.

## Implementation Log

- Added migration 002 artifact metadata and scheduler/progress columns.
- Added transactional FIFO claims, durable transition helpers, restart-from-
  request recovery, three-attempt failure policy, artifact verification/export,
  and focused lifecycle tests.
- Added the single async scheduler, blocking real engine adapter, bounded
  progress channel, stable error classification, and truthful aggregate load.
- Added principal-targeted `job.updated` relay fan-out; only aggregate load is
  sent to other authenticated principals.
- Replaced direct CLI inference with durable local submission/follow/export.
- Added a serialized mobile job repository, revision reducer, offline-retained
  queue, technical stage labels, real unit progress, and safe terminal errors.
- Proved the light engine path independently of the node on CPU: 0.6B LM
  planning peaked at 1.5 GiB and a one-step, 15-second Q4 turbo synthesis
  completed in 39.35 seconds at a 4.8 GiB peak with no swap.
- Copied the reusable GGUF set from the external partition into persistent
  `/home/ckadirt/Projects/Cantor/ckpts`, verified all six SHA-256 digests, and
  kept the source partition mounted read-only. The physical gate node references
  the required blobs through same-filesystem hard links rather than duplicating
  them.
- Suppressed aggregate `node.info` fan-out for progress-only job revisions.
  Private `job.updated` remains immediate for the owner; aggregate load is
  broadcast only when its computed value actually changes.
- Reasserted the accepted request's explicit lyrics, duration, steps, CFG, and
  seed after the engine planning phase. Planning may enrich a caption, but it
  cannot silently replace user controls. Protocol `steps` and `cfg` map to the
  engine's `inference_steps` and `guidance_scale` fields.
- Unified normal completion, interrupted-finalization adoption, and completed-
  job startup reconciliation on the job-root `manifest.json`. A verified
  artifact advances that file from the empty schema-1 acceptance manifest to
  the canonical schema-2 artifact manifest before the completion transaction.

## Deviations

- The draft proposes a separate command actor around all M1 submit/list/get
  calls. The existing `NodeState` mutex already provides the same single
  serialization boundary, while the new scheduler copies owned work out before
  inference. M2 therefore adds a bounded event/progress channel and scheduler
  facade without duplicating SQLite ownership in a second actor. No lock is
  held during manifest fetch, engine load, inference, or WAV writing.
- App job snapshots and submission outbox use two AsyncStorage keys, so linking
  acceptance and the first snapshot cannot be one native cross-key transaction.
  The outbox remains accepted with the canonical ID and `jobs.list` repairs the
  snapshot idempotently after any crash. Introducing a second mobile database
  solely for this link remains less conservative than the existing proven
  native store; M3 owns richer query/cache migration.
- M2 keeps the protocol's existing stable `internal` code for repeat-engine
  interruption and corrupt-artifact diagnostics because M0 did not reserve
  narrower codes. Messages are safe and actionable; expanding a frozen enum
  without a coordinated protocol revision would be a breaking deviation.
- Progress events use a bounded best-effort relay queue. If it fills, durable
  SQLite revision state wins and the next correlated list repairs the app; the
  engine is never stalled by a slow relay.
- The physical phone uses the already-established local real relay through ADB
  reverse because that phone still lacks DNS. Hosted carrier behavior was
  exercised separately in M1; M2's new privacy/property is node-side targeted
  fan-out and is covered by a two-principal relay test plus the local real relay.
- The first real-engine harness copied required GGUFs under `/tmp`, which is a
  7.3 GiB RAM-backed tmpfs on this workstation, and selected Vulkan on an
  integrated AMD GPU that shares system RAM. During the run, the kernel's prior-
  boot log records a global OOM kill with AMD TTM allocation frames, and the
  desktop became unresponsive. The conservative correction is disk-backed
  persistent weights/library, CPU-only inference, six worker threads, a 6 GiB
  hard cgroup memory limit, 512 MiB swap limit, and monitored memory before the
  phone submits. The external source disk remains read-only. This changes only
  the validation harness; production storage was never specified as tmpfs.
- The published engine backend used by the installed node rewrote an explicit
  15-second request to 203 seconds when lyrics were absent, unlike the newer
  source checkout. The first bounded phone run was stopped conservatively at
  diffusion step 1/8; a second `[Instrumental]` run was rejected by a temporary
  duration ceiling. The durable recovery path safely exhausted/recovered those
  jobs. The adapter now restores every explicit accepted control after planning
  and retains the ceiling as defense in depth. The final request stayed at 15
  seconds. No engine checkout or external-disk file was modified.
- Completion originally wrote finalized metadata as
  `artifacts/artifacts.json`, leaving the job-root schema-1 manifest stale. The
  conservative fix preserves the documented single manifest: all completion
  paths atomically replace job-root `manifest.json`, and startup repairs a stale
  manifest only after the indexed master passes digest verification. A legacy
  nested metadata file is left untouched rather than silently deleted.

## Verification

- `cargo fmt --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo test --workspace --no-fail-fast`: 95 tests passed (74 node, 21
  protocol).
- `npx tsc --noEmit`: passed.
- `npx jest --runInBand`: 145 tests passed.
- `npx eslint .`: passed with the same pre-existing inline-style warning in
  `src/onboarding/panels/kit.tsx`.
- Relay `npm run check` and Vitest: passed; worker types, TypeScript, assets,
  catalogs, backend manifests, and 6 tests are clean.
- `git diff --check`: passed.
- Persistent model copy: 8,278,926,368 bytes across six GGUF files; source and
  destination SHA-256 digests match. Destination is the main ext4 filesystem;
  source is a read-only ext4 mount.
- Isolated published CPU engine: 0.6B LM completed in 10.45 seconds at 1.5 GiB
  peak; Q4 turbo synthesis completed a valid 14.4-second, 48 kHz stereo WAV in
  39.35 seconds at 4.8 GiB peak. Both ran with cgroup limits and zero swap.
- Physical Android `6b1f6ba8629c`: its existing app identity was already paired
  with `ckadirt-mf-m2`. A phone request with caption
  `final_phone_instrumental_smoke`, explicit `[Instrumental]`, and 15-second
  duration completed on attempt 1 in about 54 seconds as job
  `019fe1cb-a56a-7591-a7c1-2d577c1d01fc`, revision 33. The node stayed below
  its 6 GiB hard memory limit (5,369,511,936-byte peak) and 512 MiB swap cap.
- The canonical output is 2,734,124 bytes, PCM 16-bit, 48 kHz stereo, 14.240
  seconds, SHA-256
  `4c85f3284c88520949315d21e0be171a164ebfa08213889e2124832caf1b3aea`.
  The filesystem, schema-2 manifest, SQLite artifact row, and independent
  `ffprobe` inspection agree; `PRAGMA quick_check` returns `ok`.
- After node restart and Android force-stop/relaunch, the same pairing returned
  READY with `0 active · 0 queued`; the phone restored all three job snapshots,
  including `Generation complete r33`. Startup repaired the real job's stale
  root manifest without regenerating or changing the WAV.

---

# Milestone 3 — Private Library

## Status

Implementation and the physical-phone A/B privacy and metadata-recovery gates
completed on 2026-08-08.

## Decisions

- A valid M2 completion publishes the artifact row, terminal job state, song
  header, and library change in one SQLite transaction. Song ID equals job ID;
  startup backfill is deterministic and idempotent.
- Library revisions belong to one authenticated principal. Song metadata has a
  separate optimistic revision; job progress never advances the library log.
- Full sync uses newest-first keyset pages under one captured revision. Cursors
  are HMAC-SHA256 authenticated, stable across restarts, and bound to principal,
  snapshot, and `include_trashed` mode.
- Headers are small and cached automatically. Full request, lyrics, engine,
  attempts, and component digests are owner-only and fetched on demand. Audio is
  not transferred in M3.
- Trash is logical and reversible. Patch, trash, and restore require the
  expected metadata revision and return the current safe header on conflict.
- `library.changed` is only a private hint. Full/incremental sync remains the
  repair path after missed pushes, disconnects, and restarts.
- The phone's local identity is `(node_public_key, song_id)`. It merges known
  nodes newest-first and searches titles, summaries, tags, models, and node
  labels locally while offline.

## Implementation Log

- Added migration 003 with `songs`, `library_changes`, owner-order indexes,
  principal revisions, a mode-0600 cursor key, completed-job backfill, and
  corrupt-completion tombstoning.
- Added owner-scoped list/page/sync/detail/patch/trash/restore repositories,
  stable signed cursors, full-sync-gap signaling, Unicode/control bounds, and
  safe not-found behavior for foreign song IDs.
- Added the v2 library/song wire messages, fixtures, generated TypeScript, safe
  revision-conflict details, and exact JavaScript integer bounds for seeds.
- Added authenticated session dispatch and principal-targeted library hints;
  the relay remains a metadata-free carrier.
- Added staged full sync and incremental replay in the app connection. Partial
  pages are invisible, errors retain the old cache, and a pruned-history error
  restarts a safe full replacement.
- Added a serialized private-library cache, higher-revision reducers,
  multi-node timeline, local search/views, pull-to-refresh, lazy private detail,
  title/tag/favorite edits, and trash/restore with explicit remote/offline text.
- Extended the manual protocol client with library, detail, safe-not-found, and
  explicit-lyrics modes for physical privacy drills.

## Deviations

- The plan assumed an existing React Native SQLite abstraction, but the app has
  none. M3 keeps one serialized AsyncStorage record per complete library set.
  Pages stage in memory and only a final snapshot/incremental result replaces
  the native record atomically; reconnect restarts an interrupted full sync and
  never clears old rows. Adding an unproven native database binding during the
  protocol/storage milestone was the less conservative choice. The tradeoff is
  that large-library indexed queries and crash-resumable page staging remain a
  future storage migration.
- SQLite integers are signed 64-bit while the engine seed is unsigned 64-bit,
  and JavaScript numbers are exact only through `2^53-1`. Seeds are stored as
  decimal text on the node and remote requests reject values above
  `9,007,199,254,740,991`; the wire never silently rounds one.
- `job.create` has no display-title field, so the initial title is the same
  bounded, control-free caption summary. Rename is available immediately.
- Change-log gap detection and `full_sync_required` are implemented, but M3
  retains all changes instead of pruning at an unmeasured count/age threshold.
  This preserves correctness until real library growth justifies a policy.
- The physical recovery drill removed only the private-library AsyncStorage key
  by round-tripping the app's exact SQLite storage file while the app was
  stopped; backend, job, outbox, keychain, and pairing records stayed intact. It
  proved fresh local header reconstruction under the same cryptographic identity
  without extracting or re-entering the user's secret phrase. Deterministic
  phrase-to-key restoration remains covered by identity tests; handling the
  user's phrase in an automated device script would have been less conservative.
- The phone used its existing pairing through the local real relay over ADB
  reverse because it still lacks DNS. The URI pairing sheet was not needed;
  force-stop/relaunch and lazy private detail both authenticated with the
  already-stored key. Hosted carrier behavior was exercised in M1.
- End-to-end payload encryption is deliberately not moved forward from M6. M3
  prevents one paired principal from reading another's library, but the relay
  can still observe application payloads.

## Verification

- `cargo fmt --check` and clippy with warnings denied: passed.
- `cargo test --workspace --no-fail-fast`: 106 tests passed (79 node, 27
  protocol).
- App TypeScript and ESLint: passed; ESLint reports only the pre-existing
  inline-style warning in `src/onboarding/panels/kit.tsx`.
- `npx jest --runInBand`: 153 tests passed across 13 suites.
- Relay `npm run check` and Vitest: worker types, TypeScript, assets, catalogs,
  backend manifests, and 6 tests passed.
- `node --check node/scripts/protocol-client.mjs`, `git diff --check`, and
  SQLite `PRAGMA quick_check`: passed.
- Migration backfilled principal A's existing M2 song exactly once. On the
  phone, favorite, trash, and restore advanced its song/library revisions
  `1 -> 2 -> 3 -> 4`; clearing only the local library cache reconstructed the
  same revision-4 header without downloading the 2,734,124-byte WAV.
- Principal B used a separate temporary key and initially saw an empty library.
  Getting A's exact UUID returned the same safe `not_found` as an unknown ID.
  B then completed its own one-step, 15-second CPU job
  `019fe1f0-2a67-70b1-ac59-235b253f4128`, publishing a 15.040-second,
  2,887,724-byte WAV at B library revision 1. A's live phone still displayed
  only A's song and received no B header/hint.
- The node database contains exactly one song for each principal and ordered
  change logs `A: upsert/upsert/trash/restore`, `B: upsert`. The service stayed
  under its 6 GiB hard cap during B's real generation: 5,369,991,168-byte peak,
  with swap capped at 536,870,912 bytes.
- After a final node rebuild/restart, Android `6b1f6ba8629c` force-stop/relaunch
  retained the same app key, restored A's remote-only header, rendered local
  search/favorite/offline/trash views, and fetched the full request
  (`[Instrumental]`, engine, attempt, four component digests) lazily from the
  already-paired node. No generation or audio transfer occurred in this final
  UI check.

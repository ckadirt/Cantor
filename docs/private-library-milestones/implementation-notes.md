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

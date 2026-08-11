# Framework refactor implementation notes

This is the live engineering record for RF0–RF7. Update it before beginning a
milestone, while decisions are made, and after verification. Do not reconstruct
the reasoning only at the end.

## Program status

- Started: 2026-08-09
- Current milestone: RF5 node application and adapter framework
- Production refactor code: RF1 through RF4 complete
- Last completed product milestone: M6, commit `d3f890d`

## Decisions

- This is a behavior-preserving refactor. Wire formats, persisted formats,
  security construction, error behavior, and user-visible behavior remain fixed.
- Work proceeds through RF0–RF7 in `refactor-plan.md`, with small green commits.
- Existing façades remain stable until their callers have migrated and tests
  prove equivalent behavior.
- Cross-language constants may be generated; security-sensitive parsing and
  state transitions remain explicit and language-local.
- Abstractions require a concrete extension point, volatile implementation, or
  test seam. Line-count reduction alone is not sufficient justification.
- Android is the current app target and physical-device authority.
- The lightest/fastest installed generation configuration is used for necessary
  generation regressions. Model execution is not used for pure refactor loops.
- Subagents may own independent files/workstreams. The primary agent integrates,
  resolves architecture decisions, runs cross-system gates, and commits.

## Baseline evidence

Before the refactor program began:

- M6 commit: `d3f890d M6 encrypt private transport end to end`.
- Rust: 122 tests passed; formatting and strict Clippy passed.
- App: 166 tests passed; TypeScript passed; ESLint had one existing inline-style
  warning in `src/onboarding/panels/kit.tsx` and no errors.
- Relay: 8 tests and the full relay check passed.
- Android `assembleDebug` passed.
- Physical Android completed encrypted authentication, control, raw artifact
  download, digest verification, offline playback, pin survival, and reconnect
  across a stable node transport key. No generation ran during the M6 gate.
- Worktree was clean after M6.

RF0 will rerun and expand this baseline before moving production owners.

## Invariants under watch

### App

- Backend records and cached libraries survive upgrade and malformed sibling
  data according to their current per-store policies.
- Outbox idempotency and cache merge ordering remain stable.
- Current song-draft reset behavior on remote revisions is characterized and
  preserved during extraction. A better dirty-draft conflict policy is separate
  V1 product work, not silently introduced by this refactor.
- Revisions, audio states, and offline controls do not regress.
- React/Skia ownership follows the Flicker Law in `cantor/AGENTS.md`.

### Node

- Completion, artifact indexing, song publication, and revisions retain their
  existing transaction boundaries.
- Durable writes retain permission, symlink, temp, fsync, rename, and directory
  sync semantics.
- Owner isolation and event targeting remain explicit.
- The runtime mutex is never held across await.
- Native generation retains thread affinity and cached-session ownership.

### Transport/security

- Node authentication precedes app identity and pair proof.
- There is no plaintext application fallback.
- Carrier, inner, fragment, descriptor, and prologue bytes remain exact.
- Tamper, replay, reordering, cross-session input, malformed lengths, and key
  changes continue to fail closed.

## Implementation log

### 2026-08-09 — Audit start

- Assigned independent read-only audits for app/Android, Rust node, and
  relay/protocol/cross-language integration.
- Counted responsibility hotspots and inspected current CI/release/deploy gates.
- Defined the framework principles, compatibility contract, RF0–RF7 milestones,
  verification matrix, and commit policy before production code changes.
- Integrated and reviewed all three module audits. The documentation baseline is
  ready to commit independently before RF0 changes tests or production code.

### 2026-08-09 — RF0 started

- Committed the documentation prerequisite as `48bd2c5`.
- RF0 is limited to executable characterization: shared transport fixtures,
  app/audio/runtime tests, node persistence/application tests, and deterministic
  Android compilation. Production owners and observable behavior must not move.
- Assigned non-overlapping RF0 test work to app, node, and protocol subagents.
- The primary agent owns CI integration, fixture review, the full baseline matrix,
  physical-device baseline, staged-patch review, and the RF0 commit.
- Captured the physical baseline on Android device `6b1f6ba8629c`: the app opened
  directly to the paired Library, showed the expected All/Favorites/Offline/Trash
  filters, retained the pinned `M4 recovery drill` and cached
  `final_phone_instrumental_smoke` entries, and exposed the expected playback,
  pin, details, save, favorite, and trash controls. The app key remained present;
  its value is deliberately not recorded here.
- Added an Android CI gate that runs JVM tests and assembles the real debug app
  for `arm64-v8a`. One ABI is sufficient for deterministic Kotlin/native bridge
  compilation here; multi-ABI release packaging remains the release workflow's
  responsibility.
- Added byte-exact transport v1 fixtures for relay carrier framing, descriptor
  signature input, Noise prologue, control/artifact inner records, fragments,
  and negotiation JSON. Independent Rust, TypeScript, relay, and Kotlin tests
  consume the corpus; the Kotlin test drives the production secure module through
  a real Noise NK handshake.
- Added app characterization for the native audio boundary and repository, plus
  MainScreen offline hydration, connection startup, canonical persistence, and
  outbox delivery. Added node characterization for migrations, SQL rollback and
  restart recovery, attempts, checkpoints, delivery, effects, and exact errors.
- RF0 integrated verification passed: Rust formatting, strict Clippy, and 134
  workspace tests; app TypeScript, ESLint, and 190 Jest tests; relay checks and
  13 Vitest tests; two Android secure-module tests and an `arm64-v8a` debug APK
  build; fixture JSON validation; and whitespace checks.
- Reopened the unchanged installed app after the integrated checks. The phone
  remained paired and reproduced the recorded Library state and controls while
  the existing release node remained live. No generation was required for this
  test-only milestone.

### 2026-08-09 — RF1 started

- RF1 is split into independently reviewable seams: app protocol/security/core
  dependency direction, one serialized-store extraction and repository migration,
  then node `PrincipalId` and runtime ownership. Compatibility façades remain in
  place until callers migrate; storage keys, decoder policy, wire bytes, SQL text,
  lock ownership, and event timing are invariants.
- Assigned app core extraction, app serialized storage, and node `PrincipalId`
  to non-overlapping subagent paths. The primary agent owns integration, commits,
  the later node runtime move, and all full-matrix/device checks.
- New abstractions must own existing repeated behavior. RF1 will not add empty
  utility modules, a dependency-injection container, generalized crypto, or new
  persistence policy merely to create a directory structure.

### 2026-08-09 — RF1 completed

- App protocol constants, generated domain types, and pure decoders now live
  under `core/protocol`; shared validation, error text, and UTF-8 byte counting
  no longer depend on a backend adapter. Security owns its transport descriptor.
  `backends/types.ts` remains a compatibility façade while feature callers move.
- `createSerializedJsonStore` now owns one failure-tolerant update queue per key,
  explicit decoding/malformed-JSON policy, and an explicit queued no-write result.
  Jobs, the submission outbox, and private-library snapshots migrated in separate
  commits without changing keys or JSON. The no-write branch preserves the
  library's newer-revision early return rather than issuing a redundant write.
- Node principals are now a private checked `PrincipalId`: client keys derive by
  the same SHA-256 operation, durable text is canonical lowercase hex, and the
  CLI's exceptional local owner has a named domain-separated constructor.
- `NodeState`, shared mutex ownership, and relay-consumed `NodeEvent` effects now
  live under `runtime::{state,events}`. The control socket is a consumer again;
  compatibility exports preserve its former state/event entry points.
- RF1 commits: `312f170`, `d0e40c5`, `ae56f82`, `5378566`, `8c31d09`,
  `c733dec`, and `44d54f4` (plus the prerequisite note commit `ba3e4d7`).
- Integrated verification passed: Rust formatting, strict Clippy, and 137 tests;
  app TypeScript, ESLint, and 210 Jest tests; relay checks and 13 Vitest tests;
  Android JVM tests plus an `arm64-v8a` debug build; whitespace checks; and a
  cold app restart on the physical phone. The paired Library, pinned/cached songs,
  metadata, and controls matched RF0.

### 2026-08-09 — RF2 started

- RF2 freezes the current screen as presentation behavior. Library, backend, and
  queue components will first be copied into feature-owned modules and verified;
  `MainScreen` will switch imports only after those modules are independently
  complete. No styles, labels, accessibility text, draft-reset policy, action
  timing, filtering, or ordering may change.
- Backend lifecycle, cache hydration/persistence, outbox flushing, and feature
  commands will move together into `useBackendRuntime` because they share one
  ownership graph. The hook may expose named commands and state, but it may not
  reinterpret failures or introduce a service container.
- Assigned library presentation, backend/job presentation, and runtime-hook
  construction to non-overlapping new paths. The primary agent owns the final
  `MainScreen` integration, deletion of duplicates, phone screenshots, and commits.

### 2026-08-09 — RF2 completed

- Library presentation now lives under `features/library`; backend composition and
  generation drafts live under `features/backends`; job rows and control policy
  live under `features/jobs`. Each feature exposes a small named barrel API and
  owns focused rendering/state tests.
- `useBackendRuntime` now owns the former screen infrastructure as one explicit
  state/command contract: stored backends, live connections, cache hydration and
  persistence, outbox delivery, song/job commands, audio transfer/local state,
  pairing visibility, and refresh/error reporting. Production defaults remain the
  existing concrete connection and repositories; flat dependency overrides are
  available only as focused test seams.
- `MainScreen.tsx` fell from roughly 1,450 lines to 178 lines. It now projects
  library rows, selects theme colors, composes feature components, and wires their
  callbacks to the runtime; it no longer implements transport, persistence,
  request, audio, draft, or row presentation logic.
- An additive paired-backend removal command was discarded during review because
  the original screen had no such behavior. Existing local-audio removal remains
  unchanged. This was a scope correction before integration, not a product
  deviation.
- RF2 commits: `d54ef73`, `d72d730`, and `c72e660` (plus the prerequisite note
  commit `e1e5ec1`).
- Integrated verification passed: TypeScript, focused ESLint/Prettier, and 224
  Jest tests; Android JVM tests and debug assembly; whitespace checks; and a cold
  physical-phone restart. The paired Library retained the pinned/cached songs,
  search and filter controls, backend capability facts, queue entries, new-job
  form, and one authenticated `READY` node. No generation was triggered.

### 2026-08-09 — RF3 started

- RF3 keeps `BackendConnection` and the React Native audio API stable while
  extracting one independently tested service/state machine at a time. Request
  correlation, library-sync reduction, the local-audio port, transport lifecycle,
  application dispatch, and Android storage/player ownership are separate review
  and commit units.
- The first parallel pass is limited to new modules and focused tests so the
  existing connection/runtime owners remain untouched. The primary agent will
  review and integrate each seam sequentially, preserving exact timer, reconnect,
  message, revision, and native-filesystem behavior.
- No transport suite/version/byte change, reconnect tuning, storage migration,
  public façade rename, native bridge signature change, or UI policy change is in
  scope. Physical testing will use reconnect and existing cached audio; model
  generation remains unnecessary unless a later gate exposes a generation-only
  regression.

### 2026-08-11 — RF3 completed

- `BackendConnection` remains the public façade, but its former infrastructure
  now has named owners: `RequestRegistry` for correlated lifetimes,
  `RelaySocket` for raw socket/retry/keepalive state, `SecureTunnel` for Noise and
  encrypted carrier records, pure application response decoders, and a pure
  library-sync reducer. The façade composes them and retains request IDs, exact
  failure policy, callback ordering, and snapshot publication behavior.
- Outbound application messages are typed as generated `ClientMessage` values.
  Malformed job/song replies still wait for timeout, malformed artifact replies
  still reject immediately, status still has no timer, and automatic library
  requests keep their synchronous cleanup and publication ordering.
- The runtime now depends on one `LocalAudioStore` port using immutable
  `AudioRef` values. `RepositoryLocalAudioStore` delegates to the existing native
  repository without caching a competing filesystem truth; resume offsets are
  freshly inspected and the React state map remains advisory presentation state.
- Android's unchanged `CantorAudio` bridge now delegates disk/digest/cache work
  to `AudioStorage` and player lifecycle to `AudioPlayback`. The production
  directory-fsync implementation is unchanged; only that operation is injectable
  so Robolectric can test the complete state machine on its host filesystem.
- RF3 commits: `be83135`, `04141b1`, `7e09b66`, `36c61b9`, `a73aa89`,
  `870accb`, `cb829a6`, `8ed03db`, `39adb96`, `33b17a0`, `bc999a8`,
  `192a1b6`, `a71f6e2`, and `48db688` (plus the prerequisite note commit
  `718edec`).
- Integrated verification passed: TypeScript; ESLint with the one pre-existing
  inline-style warning; 30 Jest suites and 261 tests; nine Android JVM tests;
  multi-ABI `assembleDebug`; and whitespace checks. The repository-wide
  Prettier check still reports pre-existing files outside RF3; every changed
  TypeScript file passed focused formatting, and Kotlin compilation is clean.
- Physical Android `6b1f6ba8629c` received the rebuilt APK, cold-started through
  Metro, reattached to the existing local real relay, completed a fresh encrypted
  session with `ckadirt-mf-m2`, and showed `0 active · 0 queued`. The existing
  pinned recovery artifact started in the real `MediaPlayer`, routed to device 3,
  stopped at its natural end, and was released. No generation engine ran.

### 2026-08-11 — RF4 started

- RF4 will expose the existing persistence boundaries without redesigning them:
  the `Library` façade, its single SQLite connection, transaction scopes, SQL,
  schema versions, on-disk paths, and durable-write ordering remain authoritative.
- Work starts with a symbol/dependency map and mechanical private-module moves.
  Public callers will keep using `Library`; private visibility will be widened
  only as far as sibling persistence modules require.
- Existing `impl Library` persistence blocks in `songs.rs` and `delivery.rs` will
  move only after their protocol/worker responsibilities are separated. Traits
  will be added only where a real service or test consumer needs a narrow port.
- Recovery and filesystem primitives move last because symlink checks,
  permissions, digest verification, rename/fsync order, and quarantine decisions
  are behavior. Each move must retain focused recovery/reopen tests plus full
  workspace formatting, strict Clippy, and tests before commit.
- The initial dependency audit found no honest repository trait to introduce in
  RF4: every live caller shares the concrete `Library` and its one SQLite
  connection. Test seams for workers belong in RF5, where there are actual
  service consumers.
- Schema migrations now live in `library/schema.rs` and retain the exact
  `1 -> 2 -> 3 -> 4 -> 5` order. Row decoding lives in `library/rows.rs`; job
  admission, querying, control, and worker transitions live in
  `library/jobs.rs`.
- Filesystem contract tests now pin symlink rejection, owner-only directories
  and sidecars, exact initial JSON schemas, temporary-file cleanup, master-file
  collision behavior, and atomic export replacement.
- Canonical master artifact publication/verification/export moved to
  `library/artifacts.rs`. Song persistence moved from the root module to
  `library/songs.rs`; protocol callers still enter through the `Library` façade.
  Completion and song publication remain one SQLite transaction after the
  durable master and manifest are written.
- RF4 commits so far: `3a0cb78`, `808eb26`, `e52607a`, `1aa9195`, `e205379`,
  `0df8134`, and `0351d20` (plus start note `e7bc49d`). After each extraction,
  formatting, strict workspace Clippy, all 141 Rust tests, and whitespace checks
  passed.

### 2026-08-11 — RF4 completed

- Delivery candidate selection, publication, verification, and indexed manifests
  now belong to `library/artifacts.rs`. `delivery.rs` owns only worker/retry/event
  orchestration and the Opus encoder. The existing SQL-before-manifest ordering
  and all worker skip behavior remain unchanged.
- Startup reconciliation and interrupted-job recovery live in
  `library/recovery.rs`. Request/status sidecars and the shared library durable
  write primitives live in `library/sidecars.rs` and `library/durable_fs.rs`;
  checkpoint and cursor-key writers remain separate because their contracts and
  errors differ.
- Three delivery tests now pin newest/skipped/trashed selection, publication
  rollback across artifact/song/principal revisions, canonical manifest order,
  and the existing post-commit manifest-failure behavior.
- `Library` now has private root/connection/cursor-key fields. The one sibling
  test that previously inserted raw SQL now uses a test-only fixture method
  owned by the library module.
- No persistence trait was added: RF4 has one real SQLite implementation and one
  transaction authority. Worker-facing ports will be introduced in RF5 where a
  fake implementation has an actual consumer.
- Final RF4 commits: `2bf6516`, `2c970cb`, and `caf7aab`. Formatting, strict
  all-target/all-feature Clippy, 117 node tests, 27 protocol tests, and whitespace
  checks pass. The physical M2 library was inspected read-only: SQLite
  `quick_check` returned `ok`, migrations remain exactly 1–5, and the current
  rows are 9 jobs, 5 songs, 10 artifacts, and 13 changes.

### 2026-08-11 — RF5 started

- RF5 will separate application decisions from relay/control/worker adapters in
  small behavior-preserving steps. Explicit outcome/effect types come before
  handler splitting so event timing remains testable.
- The first honest ports are the delivery encoder/worker boundary and the native
  generation-driver boundary. Dedicated native-thread ownership, cached engine
  sessions, retry policy, and best-effort event publication remain fixed.
- Delivery now has a small façade over a worker and an Opus adapter. A fake
  encoder proves skip/continuation, publication, revision events, and failure
  behavior without invoking the codec; the real codec contract test remains.
- Job stop priority moved to `jobs/stop.rs`, while the data-only active-job
  control belongs to runtime state. Generation failure mapping and model/backend
  planning now live under `generation/`.
- `GenerationDriver` is the worker test seam. A factory creates its one cached
  native driver inside the named inference thread; fake tests prove sequential
  reuse, thread identity/name, and exact failure delivery without weights.
- Application requests now return explicit wake/stop/publish/refresh effects.
  Relay executes those effects under the existing lock and no longer infers
  domain behavior by matching response variants; response-before-refresh order
  remains unchanged.
- `ClientSession` is now owned by `application/session.rs`, while the root module
  is a compatibility re-export. `RequestContext` carries request-scoped runtime
  inputs and stable protocol error constructors live in `application/errors.rs`;
  relay calls the application façade instead of a transport-owned wrapper.
- Authentication state and challenge verification now live in a dedicated
  `AuthSession`. Focused tests pin challenge consumption, pending-state reset,
  failed proof behavior, and transfer reset only after successful authentication.
- Job scheduling is behind a seven-line `jobs` façade. Stop policy, planning,
  native worker/runner ownership, and scheduler orchestration each have one
  module without changing queue claim, retry, checkpoint, or event ordering.
- Relay and control have both moved behind directory façades. Relay carrier bytes
  are isolated and checked against the shared fixture corpus. Control wire and
  Unix-socket ownership are isolated with the existing line framing, path bound,
  symlink refusal, stale-socket replacement, and permission behavior intact.
- Characterization now covers the control adapter's whole-connection 64-KiB
  budget, short-versus-long version behavior, malformed-request survival, and
  one-shot/streaming client terminal ordering before those clients are moved.
- RF5 commits so far: `a502512`, `f11439e`, `8127764`, `309a219`, `4e7dcf1`,
  `8ac3e1e`, `986f382`, `43e52ea`, `596e9ab`, `1ab3011`, `3c6bc7a`,
  `8e70193`, `a45fd41`, `2cc838b`, `26aced5`, and `7789a22` (plus note
  commit `f93a08a`). Each integrated boundary passed formatting, strict
  all-target Clippy, the full Rust workspace tests, and whitespace checks.

## Deviations

### RF0 — malformed empty fragment timing

- The shared corpus exposed an existing difference for a zero-length first
  fragment in a multi-fragment record: Rust retains it as an incomplete assembly,
  while Kotlin rejects it immediately. Neither production encoder emits an empty
  fragment, so changing either decoder during a baseline milestone would be the
  riskier choice. The fixture records `accept_partial` versus `reject`; a future
  versioned hardening decision may make the policies identical.

### RF1 — canonical principal parsing fails earlier

- The old library parser required lowercase principal hex, but a delivery-local
  decoder accepted uppercase digits before later lowercase path/owner checks made
  that corrupt record unusable. `PrincipalId` now rejects uppercase consistently
  at every durable boundary. Valid persisted principals were already lowercase;
  the conservative choice is to fail a manually corrupted/noncanonical row early
  rather than carry an ambiguous owner farther into artifact publication.

### RF3 — superseded relay sockets fail closed

- Plan expectation: move the existing socket lifecycle without changing the
  supported one-start-per-connection behavior.
- Observed edge case: the extracted lifecycle makes it possible to unit-test a
  second `start()` while the first WebSocket can still emit callbacks. The old
  monolith did not consistently reject messages or close events from that
  superseded socket.
- Conservative decision: only the currently owned socket may start keepalive,
  deliver messages, report closure, or schedule retry. This does not affect the
  runtime path, which starts each `BackendConnection` once.
- Behavior/invariant protected: an obsolete transport cannot inject data into or
  reset the newer secure session.

### RF5 — native generation driver is intentionally not `Send`

- Plan expectation: make `GenerationDriver` a `Send` trait object passed to the
  dedicated inference thread.
- Observed edge case: the real cached ACE-Step `Session` contains a native
  pointer and is intentionally `!Send`. Constructing an empty driver on the
  scheduler thread and moving it would weaken the engine's thread-affinity
  guarantee even before a session is loaded.
- Conservative decision: only a `Send` factory crosses the thread boundary. The
  named `cantor-inference` thread constructs, owns, uses, and drops exactly one
  non-`Send` driver/cache instance for its mailbox lifetime.
- Behavior/invariant protected: no native session or native cache owner ever
  crosses threads; commands remain serialized and cache reuse is unchanged.
- Follow-up, if any: if restart becomes a public product command, specify it as a
  first-class lifecycle transition rather than relying on repeated `start()`.

When a deviation occurs, record:

```text
Date / milestone:
Plan expectation:
Observed edge case:
Conservative decision:
Behavior/invariant protected:
Follow-up, if any:
```

## Verification log

RF0 passed the complete Rust/app/relay/Android matrix described above. Before and
after device captures matched on Android device `6b1f6ba8629c`; only the clock
changed. The MIUI `uiautomator` command printed its known missing theme-compatibility
file stack trace but still wrote and pulled a valid hierarchy, so it did not alter
the result. RF1 and RF2 repeated the cold-start device check with the same paired
Library state; RF2 additionally inspected the extracted backend/job composition
and confirmed an authenticated `READY` node without submitting a generation. RF3
repeated encrypted reconnect and verified existing pinned audio through the real
Android player without invoking generation.

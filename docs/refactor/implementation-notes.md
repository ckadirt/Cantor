# Framework refactor implementation notes

This is the live engineering record for RF0–RF7. Update it before beginning a
milestone, while decisions are made, and after verification. Do not reconstruct
the reasoning only at the end.

## Program status

- Started: 2026-08-09
- Current milestone: complete — RF0 through RF7 finished
- Production refactor code: RF1 through RF6 complete and qualified on hardware
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

### 2026-08-11 — RF5 adapter decomposition continued

- Artifact transfer lifetime is isolated in `ArtifactTransferSession`. Failed
  opens preserve the prior transfer; successful opens replace it; invalid ID,
  owner, expiry, acknowledgement order, and read failures retain their existing
  consume-on-failure policy. Duplicate acknowledgements still retransmit one
  identical bounded chunk.
- `SessionRegistry` now owns relay session capacity, secure tunnel routing,
  detach, encryption, revocation, and owner-aware fanout. It intentionally keeps
  the two existing fanout modes separate: control events collect all frames
  before sending, while request-triggered refreshes stream session by session.
- Relay node-info projection and application-effect execution now have separate
  pure/runtime owners. Projection lock scopes remain selected by callers, and
  effects still execute in vector order under the request's existing state guard
  before the response is encrypted.
- Control client and server adapters are separate from commands. The fresh
  one-shot/streaming clients and the spawned per-connection server retain their
  exact line, terminal, timeout, and total-byte-budget contracts.
- Application job/status handling now lives in `application/jobs.rs`; its tests
  pin idempotent admission and exact wake/publish/refresh effect policy. Control
  catalog/pull workflows now live in `control/commands/models.rs` with unchanged
  progress and durable-publication order.
- Added commits: `39da7d6`, `45bf599`, `20c641f`, `bccb3f3`, `fd81e9a`,
  `46f11ef`, `44d5928`, and `5484d02` (plus progress note `009ffa6`). The
  current combined gate passes formatting, strict all-target/all-feature Clippy,
  150 node tests, 27 protocol tests, doctests, and whitespace checks.

### 2026-08-11 — RF5 completed

- The application layer is now explicit rather than relay-shaped:
  `application/router.rs` parses and routes, focused job/song/auth/transfer
  services decide, and `ApplicationOutcome` declares wake, stop, publish, and
  node-info refresh effects. Relay executes those declared effects without
  interpreting response variants.
- Relay is a façade over carrier framing, session registry/fanout, node-info
  projection, effect execution, claimed connection, and reconnect/claim policy.
  Its claimed-socket runner accepts an in-memory WebSocket; tests drive a real
  Noise handshake, app authentication, and job control through that seam and
  prove response-before-refresh ordering.
- Control is a façade over Unix-socket, JSON-line wire, client/server, and
  focused pairing/model/backend/generation command modules. The short router
  retains one state guard and long workflows retain their established streaming
  and version behavior.
- Delivery and generation each expose one honest volatile boundary. Fake
  encoders and drivers prove worker order/failure behavior without invoking
  codecs or weights; the real native generation driver is created, cached, and
  dropped on its dedicated inference thread.
- Phone and local CLI generation now converge at `application::admit_job`, which
  accepts an explicit identity, validated submission, resolved installed model,
  and node policy before delegating to the single durable `Library::submit`
  authority. Adapter-specific validation and response text remain outside it.
- Final RF5 commits after the prior progress entry: `1584e23`, `6c8feb8`,
  `a7fdbb4`, `20854d4`, `d59ee04`, `c2f40bb`, `93b5c12`, `020fb07`,
  `ee82dc8`, `b779ee9`, `596a92f`, and `3b64136`.
- Integrated automated verification passed: Rust formatting; strict workspace,
  all-target, all-feature Clippy; 157 node plus 27 protocol tests; app TypeScript
  and lint with no errors plus 30 Jest suites/261 tests; relay check plus 13
  Vitest tests; Android JVM tests and an `arm64-v8a` debug APK build; and
  whitespace checks.
- Physical device `6b1f6ba8629c` submitted one 15-second light CPU job through
  the real encrypted phone-relay-node path. Job
  `019ff18e-93f4-70e2-af6b-b20411954a8b` completed on attempt 1 at job revision
  36. The 2,887,724-byte WAV hash
  `0cd875b74e7a3354fe031c659558581896cf3796e837f8e7da6cfd031958bae0`
  and 303,777-byte Opus hash
  `980a1764590a3bd0fe565234fe90b91f708debde799c0da99996191f5736fd13`
  matched their indexed records; SQLite `quick_check` returned `ok`.
- The generation ran in a user scope capped at 6 GiB RAM and 512 MiB swap. It
  reached the 6,442,450,944-byte ceiling and used at most 12,247,040 bytes of
  swap without freezing the host. A graceful node restart retained the identity
  and library, reclaimed the same relay room, and a cold app restart displayed
  the new song as `REMOTE · ckadirt-mf-m2`.

### 2026-08-11 — RF6 started

- RF6 begins from clean commit `60efbec`. Three read-only audits cover the
  canonical manifest/generator, Rust secure codec and typed negotiation seams,
  and the app/Kotlin/secure-client/CI integration path before production edits.
- The transport manifest will name each deployed byte/string constant once and
  generate checked-in, language-idiomatic constants for Rust, app TypeScript,
  relay TypeScript, and Kotlin. A check mode must fail on stale generated files;
  security parsers remain handwritten and independently tested.
- Version numbers remain independent even where their current value is `1`.
  Existing exports stay as compatibility aliases while callers migrate. No RF6
  commit may change descriptor JSON, Noise prologue, carrier, inner, fragment,
  error, retry, or session-limit behavior.
- Extraction order is authority first, pure codecs second, typed negotiation
  third, maintained secure integration client fourth, and CI/release/deploy
  gates last. Native registry/session cleanup follows JVM vectors, not before.
- The RF5 node/Metro/relay qualification processes were stopped gracefully.
  RF6 codec loops do not require weights or another generation.

### 2026-08-11 — RF6 automated work completed

- `protocol/transport/v1/spec.json` is the single authority for every deployed
  transport constant. `protocol/transport/generate.mjs` renders checked-in
  constants for `cantor-proto`, `cantor-node`, the app, the relay, and the
  Android native module, validates the manifest structurally, and fails in
  `--check` mode when any output drifts.
- Layer versions are now independent names everywhere even though each value is
  still `1`: `TRANSPORT_DESCRIPTOR_VERSION` on the descriptor,
  `SECURE_NEGOTIATION_VERSION` on negotiation JSON, `SECURE_CARRIER_VERSION` on
  the carrier and prologue, `SECURE_RECORD_VERSION` on fragment records, and
  `SECURE_INNER_VERSION` on inner frames. A future version bump can move one
  without dragging the rest.
- Pure codecs are separated from Noise state in all three implementations.
  Rust has `secure/{fragment,inner,negotiation}.rs`, the app has
  `security/{carrier,inner}.ts`, and Android has `FragmentCodec`,
  `FragmentReassembler`, and `SecureChannel` behind an unchanged React Native
  bridge. Rejection reasons, accepted bytes, and JSON shapes are unchanged.
- Secure negotiation is typed: `secure.init` and `secure.handshake` parse into
  DTOs and the offer, step-two response, and secure-required refusal are
  serialized from structs. `SecureSession` still owns every state decision, so
  state is checked before fields and id before version before suite. The
  256-byte negotiation field bound is now named and tested, including the fact
  that it bounds the handshake payload far below the 4 KiB message bound.
- `node/scripts/protocol-client.mjs` is a real secure client again. Its
  transport modules live in `node/scripts/lib/` and read the manifest directly,
  so no sixth copy of the constants exists. It was verified end to end against a
  local relay and node: pairing proof, descriptor verification, Noise NK,
  encrypted carrier, node authentication, `status`, reconnect without the token,
  and `library.list` all succeeded.
- CI gained a `transport contract` job: generator check, manifest/generator
  tests, and the client's fixture plus full-handshake tests. The release
  workflow refuses to build a binary whose constants are stale, and the relay
  deploy now proves the live domain still answers a room request rather than
  only serving the installer asset.
- Integrated automated verification passed: Rust formatting; strict workspace,
  all-target, all-feature Clippy; 169 node plus 27 protocol tests; app
  TypeScript and lint with no errors plus 31 Jest suites/267 tests; relay check
  plus 13 Vitest tests; 14 Android JVM tests and an `arm64-v8a` debug APK; 9
  manifest tests and 6 secure-client transport tests; and whitespace checks.
- Commits: `acbb11d`, `259306c`, `5e80f51`, `438232b`, `376f1c4`, `e12be51`,
  `2c4132a`, `843f9ae`, and `c2a9f2f`.
- The RF6 physical device pass ran as part of the RF7 qualification below.

### 2026-08-11 — RF7 completed

- Published `architecture.md` plus `hacking-app.md`, `hacking-node.md`,
  `hacking-protocol.md`, and `hacking-relay.md`: module maps, dependency rules,
  extension recipes, tests, traps, and review checklists. The root context file
  and each module README now point at the guide that owns their code rather
  than restating volatile facts.
- The full automated matrix passed from a clean tree: generator `--check`, 9
  manifest tests, 6 secure-client transport tests, Rust formatting and strict
  all-target/all-feature Clippy, 169 node plus 27 protocol tests, app
  TypeScript and ESLint (0 errors, 3 pre-existing warnings), 31 Jest
  suites/267 tests, 13 relay Vitest tests plus `npm run check`, 14 Android JVM
  tests, an `arm64-v8a` debug APK, and `git diff --check`.
- Physical qualification ran on Android `6b1f6ba8629c` against the existing
  paired fixture node `ckadirt-mf-m2`, started from its own config directory
  and capped at 6 GiB RAM and 512 MiB swap. Evidence is in the log below.
- Commits: `607a3b9`, `69ab7ed`, and this entry.

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

### RF5 — qualification initially used the parent config directory

- Plan expectation: start the persistent M2 fixture with its existing
  `cantor-m2-node/config` directory and stable node identity.
- Observed edge case: the first qualification command passed the parent
  `cantor-m2-node` directory. The CLI initialized a fresh `node.toml`, `node.key`,
  and `noise.key` there and claimed the unrelated default room. No generation or
  durable product mutation ran through that identity.
- Conservative decision: stop it immediately, move only those three newly
  created files intact to the recoverable directory
  `/tmp/cantor-fresh-identity.RNoJ63`, verify they are absent from the fixture
  parent, and restart with the explicit existing `cantor-m2-node/config` path.
- Behavior/invariant protected: the stable paired identity, existing model
  manifest, and physical library were neither overwritten nor migrated through
  an unintended node.
- Follow-up, if any: the temporary recovery copy can be discarded manually after
  this program; it is not part of the repository or fixture.

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
Android player without invoking generation. RF5 ran the real capped light
generation and restart/reconnect qualification recorded above; the app observed
the completed queue item and, after its own cold restart, synchronized the new
remote song.


### RF7 physical qualification, Android `6b1f6ba8629c`

The debug APK was installed in place over the existing build, so app data was
never cleared.

- The app opened directly to its Library with the same app key, the existing
  pairing, and the cached `rf5_framework_phone_smoke` and `M4 recovery drill`
  entries. `ckadirt-mf-m2` authenticated to `READY`; the second paired node
  correctly showed `NODE OFFLINE`.
- One light generation was submitted from the phone through the real
  phone–relay–node path. Job `019ff2e6-a6a9-7531-b7db-5728968344e7` completed at
  revision 83 as `rf7_framework_phone_qualification`, 35,200 ms.
- The 6,758,444-byte WAV hash
  `15d2b8b378f70a1cbaf0e13b26d8cddcffeef3adbfeb932d3e476707792426a6` and the
  709,852-byte Opus hash
  `57d9bc8f3d44e5216c35efa57331c31d6d1ffa23f5d5ef904baa99bafbfd958d` matched
  their indexed artifact records exactly. SQLite `quick_check` returned `ok`.
- The phone downloaded the delivery artifact over the encrypted channel and the
  song moved to `CACHED`, then to `PINNED`. A graceful node restart reclaimed
  the room and the app returned to `READY` showing the completed job at r83.
- With the node stopped, a cold app restart still showed the song as
  `PINNED · 35.2s · 693.2 KiB` with `Node offline · cached header`, and playback
  started from local storage (`AudioTrack … sr 48000 ch 2` under the app's uid).
  Restarting the node cleared the offline note without another app restart.
- Downgrade-negative check: a client that skipped the secure handshake and sent
  a plaintext application frame received exactly
  `{"code":"secure-required","message":"A secure channel is required.","t":"secure.error","v":1}`.
- The integration client was separately verified end to end against a local
  relay and node: pairing proof, descriptor verification, Noise NK, node
  authentication, `status`, reconnect without the token, and `library.list`.

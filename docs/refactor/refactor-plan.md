# Cantor behavior-preserving framework plan

## Status

Approved direction. RF0 through RF6 are complete apart from the RF6 physical
device pass; RF7 hacking guides and final qualification are current.

## Objective

Turn Cantor's proven M0–M6 implementation into a codebase that is straightforward
to understand, test, extend, and integrate without changing what users or peers
observe.

Success is not measured only by lower line counts. A successful result provides:

- an obvious location for a new screen, command, protocol message, repository,
  generation backend, relay carrier, or native adapter;
- narrow APIs with named state and failure behavior;
- executable storage and wire contracts shared across languages;
- tests at module boundaries rather than only through monolithic owners;
- contributor guides that a new developer or coding agent can follow safely;
- the same physical-phone behavior, persisted data, encrypted transport, and
  generated/audio artifacts as before.

## Baseline hotspots

| Area | Current concentration | Framework problem |
|---|---:|---|
| App composition | `MainScreen.tsx` — 1,548 lines | Runtime ownership, commands, audio orchestration, projection, UI components, and styles share one file. |
| App connection | `backends/connection.ts` — 1,375 lines | WebSocket, Noise, app auth, message dispatch, RPC, transfer, sync, and retry state machines are coupled. |
| App protocol | `backends/types.ts` — 439 lines | Backend state and application wire validation share a dependency root. |
| Node persistence | `library.rs` — 2,483 lines plus external `impl Library` blocks | Schema, jobs, songs, artifacts, recovery, rows, sidecars, and transactions have no visible module boundaries. |
| Node adapters | `control.rs`, `session.rs`, `relay.rs` — 1,100–1,600 lines each | Runtime state and application effects are owned or inferred by transport adapters. |
| Generation/delivery | `jobs.rs`, `delivery.rs` | Scheduler, planning, native execution, checkpoints, repository work, and codecs are mixed. |
| Secure transport | Rust, TS, Kotlin, relay | Versions, suite names, kinds, headers, and bounds are duplicated without shared byte fixtures. |
| Integration tooling | `node/scripts/protocol-client.mjs` | The documented client still speaks the pre-M6 plaintext application protocol. |

The module audits contain exact evidence and risks. This plan is the integrated
execution order.

## Compatibility contract

Every milestone must preserve these unless a separately approved versioned change
explicitly says otherwise.

### Application behavior

- Pairing, same-phrase identity, authorization, revocation, and petnames.
- Submission idempotency and owner-scoped job/library visibility.
- Queue order, progress, controls, recovery, revisions, and safe errors.
- Library cache merge behavior, offline availability, editing conflicts, and
  outbox retry semantics.
- Download offset/ack/fsync/digest rules, pin/cache policy, and local playback.

### Persistence

- AsyncStorage keys and compatible stored JSON shapes.
- SQLite migration numbers, SQL semantics, transaction boundaries, and revision
  allocation.
- Job/artifact/checkpoint directory layouts, sidecar schemas, permissions, atomic
  rename/fsync order, and startup reconciliation decisions.
- Existing node keys and secure transport descriptors.

### Wire and security

- Application v2 JSON shapes, IDs, errors, bounds, and compatibility behavior.
- Relay v1 text negotiation and binary carrier bytes.
- Secure channel v1 descriptor signature, Noise suite/pattern, prologue, inner
  frames, fragments, limits, replay/order behavior, and no-plaintext fallback.
- Node authentication before app identity or pairing proof.

### Runtime

- One generation worker, native engine thread affinity, cached session lifetime,
  bounded delivery worker, and shutdown semantics.
- Relay reconnect/keepalive behavior and owner-targeted push delivery.
- No await while holding the node's synchronous runtime mutex.

## Architectural decisions

### Stable façades

Keep these entry points stable while internal modules move:

- App: `BackendConnection`, repository functions, native module adapters, and
  screen-level feature contracts.
- Node: `Library`, `SecureSession`, `TransportIdentity`, engine/generate low-level
  boundary, CLI commands, and wire-facing protocol types.
- Relay: Durable Object entry point and exact carrier parsing/encoding behavior.

### Ports only at volatile boundaries

Good candidates are `LocalAudioStore`, `DeliveryEncoder`, generation worker/
driver, socket transport, clock/timer, and request registry. SQLite row helpers,
simple pure functions, or every engine method do not need traits merely to look
architectural.

### Generated versus handwritten protocol code

- Generate constants and data types from small canonical specifications.
- Keep security-sensitive parsers and state transitions small, idiomatic, and
  reviewable in each target language.
- Prove them against shared byte-exact fixtures.
- Generated files are checked in and CI verifies they are current.

## Milestones

### RF0 — Executable baseline

**Purpose:** make current behavior hard to change accidentally before moving it.

Work:

- Commit the audits, plan, program notes, and compatibility contract.
- Record the current automated/device baseline.
- Add shared golden fixtures for carrier, descriptor signature preimage,
  prologue, control/artifact inner records, fragment records, and handshake JSON.
- Consume relevant fixtures from Rust, app TypeScript, relay TypeScript, and
  Kotlin/JVM tests where feasible.
- Add characterization tests for protocol error shapes, event targeting,
  persistence reopen/migration, app runtime orchestration, and audio repository
  behavior before moving those owners.
- Add Android compilation to CI or an equivalent deterministic native gate.

Exit gate:

- No production behavior changes.
- Every current implementation agrees on the frozen fixture bytes.
- Full Rust/app/relay/Android checks pass; physical phone baseline is recorded.

Commit intent: `RF0 freeze framework refactor behavior`.

### RF1 — Shared foundations and dependency direction

**Purpose:** create the low-level concepts that later modules may depend on.

App work:

- Add focused `core/errors`, `core/text`, and `core/validation` modules.
- Move application constants/validators into `core/protocol`; keep compatibility
  re-exports while imports migrate.
- Separate `security/types` from backend connection state.
- Add a per-store serialized JSON primitive with explicit decoder and corruption
  policy; migrate one repository at a time without changing keys or policy.

Node work:

- Introduce `PrincipalId` and digest/path codecs with strict parsing/display.
- Move `NodeState`, shared runtime ownership, and node events from the Unix
  control adapter into `runtime::{state,events}` with compatibility re-exports.
- Add shared test builders without exposing test-only shortcuts to production.

Exit gate:

- Domain/security/library layers no longer import backend UI/connection types.
- Workers and relay no longer depend on the Unix-control module for runtime types.
- Stored values and all externally visible behavior are unchanged.

Commit intent: multiple narrow commits, ending with `RF1 establish shared foundations`.

### RF2 — App composition framework

**Purpose:** make screens and features independently understandable and pluggable.

Work:

- Move `LibraryTimeline`, `LibrarySongRow`, `BackendCard`, and `JobQueue` into
  feature-owned files with unchanged rendering first.
- Extract `useBackendRuntime` to own backend records, connection lifecycles,
  snapshots, cache hydration, persistence, outbox flush, and feature commands.
- Add feature controllers such as `useSongEditor`, `useGenerationDraft`, and
  `useArtifactActions` only where state ownership becomes clearer. Initially
  preserve every existing state transition, including current draft-reset
  behavior; UX policy improvements belong to the later V1 design work.
- Keep `MainScreen` as composition/navigation and feature wiring.
- Document the recipe for adding a screen, feature component, controller, and
  command without bypassing the runtime.

Exit gate:

- `MainScreen` contains composition rather than infrastructure.
- Existing layout, accessibility text, actions, offline state, and motion
  ownership remain visually/functionally equivalent on the phone.

Commit intent: move-only component commits followed by one runtime extraction
commit; never mix a visual redesign into RF2.

### RF3 — App services and connection state machines

**Purpose:** preserve one convenient backend façade while making its internals
testable and reusable.

Work:

- Add a typed `RequestRegistry` that makes expected response/decoder/resolver and
  timeout lifecycle one atomic registration.
- Extract pure library-sync state/reducer logic.
- Extract relay socket lifecycle and secure-tunnel orchestration behind narrow
  ports, retaining `BackendConnection` as the app-facing façade.
- Move application message dispatch into typed handlers/builders using generated
  `ClientMessage`/`NodeMessage` types where useful.
- Introduce `AudioRef` and a `LocalAudioStore` port. Make native filesystem state
  authoritative and eliminate or explicitly reconcile redundant advisory state.
- Split Android audio storage/player responsibilities behind the unchanged React
  Native API after TypeScript and native characterization coverage exists.

Exit gate:

- Connection, request, sync, and transfer state machines can be tested without a
  screen and, where appropriate, without a real WebSocket.
- Reconnect, downgrade rejection, revision conflicts, transfer resume, and
  offline playback pass automated and physical-device regression.

Commit intent: one state machine/service per commit.

### RF4 — Node runtime and persistence framework

**Purpose:** make canonical data ownership obvious without changing transactions.

Work:

- Convert `library.rs` into an internal module tree:
  `schema`, `jobs`, `songs`, `artifacts`, `recovery`, `sidecars`, and `rows`.
- Keep one `Library` façade and one transaction authority; move code mechanically
  before altering private APIs.
- Move existing `impl Library` blocks from song/delivery modules into the owning
  persistence modules.
- Add narrow repository traits only for actual service/test consumers.
- Centralize durable filesystem primitives only after preserving each caller's
  symlink, permission, collision, fsync, and rename semantics in tests.

Exit gate:

- Migrations, database reopen, recovery drills, completion/publication atomicity,
  revisions, sidecars, and existing physical library remain unchanged.
- No new database connection or split transaction can create partial truth.

Commit intent: mechanical module moves in reviewable commits; API tightening only
after equivalence tests pass.

### RF5 — Node application and adapter framework

**Purpose:** separate domain decisions from relay, Unix socket, and worker loops.

Work:

- Split `ClientSession` into secure/auth/transfer state plus an application router.
- Return `ApplicationOutcome { response, effects }`; stop inferring domain effects
  from response variants in the relay.
- Extract relay carrier, session registry/fanout, connection loop, and client
  claim/reconnect modules behind the existing daemon behavior.
- Split delivery repository, worker, and encoder; introduce a real
  `DeliveryEncoder` test seam.
- Split job scheduler, generation planning, dedicated native worker, runner, and
  failure policy while retaining engine thread affinity and session cache.
- Split control socket, JSON-line wire, server/client, and command workflows.
- Route local and phone generation through the same job application service.

Exit gate:

- Adapters translate; application services decide; repositories persist.
- Fake encoder/driver tests exercise retries and state transitions without heavy
  codec/model execution.
- Full node tests and a light real generation regression pass.

Commit intent: relay/session, delivery, jobs, and control are separate commit
series with green tests between them.

### RF6 — Cross-language transport and integration framework

**Purpose:** make compatibility executable and the integration path reusable.

Work:

- Add a canonical versioned transport manifest for domain labels, suite name,
  independent layer versions, kind IDs, header sizes, and bounds.
- Generate checked-in Rust, TypeScript, relay, and Kotlin constants; keep old
  exported names as temporary aliases during migration.
- Split pure carrier/inner/fragment codecs from Noise state in Rust and Kotlin,
  leaving language-local parsers reviewable.
- Replace untyped secure negotiation `Value`/record handling with explicit DTOs
  and strict parsers without changing JSON shapes.
- Rebuild `protocol-client.mjs` on the secure transport or replace it with a
  maintained secure integration client; update its README instructions.
- Add cross-language and hosted-relay smoke gates to CI/release/deploy workflows.
- Refactor native secure registry/fragment/session internals last, after JVM
  vectors exist, then rerun the physical M6 gate.

Exit gate:

- One manifest and shared fixtures guard all four implementations.
- The documented CLI integration client works with secure-required M6 nodes.
- CI compiles Android native code and detects incompatible transport changes.

Commit intent: fixtures/spec, generated constants, codecs, secure CLI, then CI.

### RF7 — Hacking guides and final qualification

**Purpose:** make the framework usable by someone who did not create it.

Work:

- Publish `hacking-app.md`, `hacking-node.md`, `hacking-protocol.md`, and
  `hacking-relay.md` with module maps, dependency rules, extension recipes,
  examples, tests, common traps, and review checklists.
- Update root/module READMEs and `AGENTS.md` pointers without duplicating volatile
  facts.
- Add concise architecture diagrams and a “where does this change belong?” guide.
- Run the entire automated matrix from a clean checkout-equivalent state.
- On the physical phone, run pair/reconnect, submit/control with the lightest
  generation configuration, library mutation/sync, encrypted download, offline
  playback/pin, app restart, node restart, and downgrade-negative checks.
- Confirm existing user data opens without migration surprises.

Exit gate:

- A new contributor can follow the guides to add a small feature and its tests
  through the intended ports.
- Worktree is clean, commits are bisectable, and all behavior gates pass.

Commit intent: guides may land incrementally with their modules; RF7 closes with
qualification evidence and final documentation corrections.

## Verification matrix

Run proportionally during work and completely at each milestone boundary.

```text
Rust:
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace

App:
  npm test -- --runInBand
  npx tsc --noEmit
  npm run lint
  ./gradlew app:assembleDebug

Relay:
  npm test
  npm run check

Repository:
  git diff --check
  generated artifacts remain committed/current
```

Device testing is required when a milestone touches screen/component ownership,
connection lifecycle, secure/native code, audio, installation, or final runtime
integration. Pure move-only Rust internals may use automated gates until their
next integration boundary.

## Commit and deviation policy

- Commit documentation/baseline before production refactoring.
- Prefer one extraction or framework seam per commit.
- Never combine a file move, behavior redesign, and cosmetic formatting sweep.
- Do not commit with failing tests to “fix later”.
- If a move exposes an existing bug, first characterize the old behavior. Fix it
  in a separate commit unless preserving it would endanger data or security.
- Log every plan deviation before or alongside the code that requires it.
- Conservative deviations preserve bytes, persisted state, security, and user
  expectations even when they temporarily retain duplication.

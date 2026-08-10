# Rust node refactoring audit

Status: architectural audit only. This document proposes an incremental extraction; it does not authorize wire, database, cryptographic, recovery, or runtime behavior changes.

## Executive finding

The node has sound product behavior, but several implementation modules have become de facto frameworks without explicit boundaries. The main issue is responsibility and dependency direction, not line count by itself:

- `control.rs` owns global runtime state even though it is a local Unix-socket adapter.
- `library.rs`, `songs.rs`, and `delivery.rs` collectively form one persistence subsystem while exposing and extending one concrete database object across module boundaries.
- `session.rs` combines session state, authentication, application dispatch, validation, domain-error mapping, and artifact I/O.
- `relay.rs` combines the WebSocket client, relay protocol, encrypted carrier, session registry, application dispatch, and event fanout.
- `jobs.rs` combines scheduling, backend planning, native worker ownership, checkpoint-aware generation, persistence, and event publication, with no isolated scheduler tests.

The recommended approach is a sequence of behavior-preserving extractions behind the current public facades. Do not rewrite the system or introduce generalized plugin abstractions during this pass.

## Current dependency problem

`NodeState`, `SharedState`, and the cross-process event type live in the control adapter at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L50-L87). As a result:

- the scheduler imports the control module at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L20);
- the delivery worker imports it at [`delivery.rs`](../../node/crates/cantor-node/src/delivery.rs#L22);
- the relay imports it at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L21).

This reverses the intended dependency: control and relay should adapt external transports to the application/runtime, while workers should depend on runtime and persistence contracts rather than on a Unix-socket implementation.

Target direction:

```text
relay adapter ---------+
                       v
control adapter --> application services --> repository facades
                       |                         |
                       v                         v
                  runtime events        SQLite + durable files

generation worker --> repository facades + runtime event sink
delivery worker   --> repository facades + runtime event sink

secure transport and engine/codec implementations remain leaf infrastructure
```

No domain or worker module should import `control` or `relay` after the extraction.

## Priority 0: runtime ownership

### Evidence

[`control.rs`](../../node/crates/cantor-node/src/control.rs#L51-L65) defines a broad `NodeState` containing configuration, identities, pairing state, relay status, the SQLite-backed library, worker notifications, the active job control signal, and shutdown state. [`control.rs`](../../node/crates/cantor-node/src/control.rs#L67-L87) then defines the shared mutex and events used by every long-lived subsystem.

### Target

```text
runtime/
  mod.rs
  state.rs       NodeState, SharedState, lock helpers
  events.rs      NodeEvent, EventSink if a tested consumer needs it
```

Begin with compatibility re-exports from `control` so the change can be mechanical. Rename `ControlEvent` to `NodeEvent` only after all imports have moved.

Potential facade:

```rust
pub struct NodeRuntime {
    state: SharedState,
    events: tokio::sync::mpsc::Sender<NodeEvent>,
}

impl NodeRuntime {
    pub fn state(&self) -> &SharedState;
    pub fn emit(&self, event: NodeEvent);
}
```

Do not hide arbitrary closures behind a generic `with_state` API initially; explicit lock scopes are easier to audit for blocking and reentrancy.

### Runtime invariants

- Preserve `Arc<Mutex<NodeState>>` initially. A lock-model redesign is a separate concurrency project.
- Never hold the mutex across `.await`. Existing code deliberately copies plans out before long operations, for example [`control.rs`](../../node/crates/cantor-node/src/control.rs#L312-L331).
- Preserve the single active generation and single delivery-worker notification semantics.
- Preserve stop-reason priority in [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L106-L115).
- Event delivery remains best-effort where existing code uses `try_send`; do not silently turn it into blocking backpressure.

## Priority 0: persistence facade

### Evidence

The concrete `Library` exposes its filesystem root, SQLite connection, and cursor key as crate-visible fields at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L198-L202). Other top-level modules extend the same type and directly use those fields:

- song schema, publication, queries, revisions, and mutations: [`songs.rs`](../../node/crates/cantor-node/src/songs.rs#L101-L217) and its `impl Library` beginning at [`songs.rs`](../../node/crates/cantor-node/src/songs.rs#L217);
- artifact indexing and delivery publication: the `impl Library` at [`delivery.rs`](../../node/crates/cantor-node/src/delivery.rs#L45-L221).

Within `library.rs` itself:

- open, migrations, integrity checks, recovery, and backfill are combined at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L205-L282);
- admission and idempotent submission combine filesystem sidecars and SQL at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L285-L383);
- job controls occupy [`library.rs`](../../node/crates/cantor-node/src/library.rs#L407-L560);
- worker lifecycle transitions occupy [`library.rs`](../../node/crates/cantor-node/src/library.rs#L605-L979);
- startup reconciliation and interrupted-job recovery occupy [`library.rs`](../../node/crates/cantor-node/src/library.rs#L1068-L1287);
- row decoding, WAV inspection, filesystem validation, manifests, and atomic JSON writes share the remaining helpers at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L1397-L1682).

This is one persistence subsystem split along historical feature-file boundaries, not clean repository boundaries. `library -> songs` calls combined with `songs -> Library` extension form a conceptual cycle.

### Target module tree

```text
library/
  mod.rs          Library facade and open orchestration
  schema.rs       ordered migrations only
  jobs.rs         acceptance, queries, controls, lifecycle transitions
  songs.rs        publication, pagination, mutations, revision log
  artifacts.rs    indexed artifacts, verification, manifests
  recovery.rs     startup reconciliation and checkpoint recovery
  sidecars.rs     canonical paths and durable sidecar operations
  rows.rs         SQLite row codecs and enum conversion
```

Keep `Library` as the single concrete owner of one `rusqlite::Connection`, root, and cursor key. Its fields can become private to the module tree. Preserve the current external method names until consumers have been moved.

Only after the mechanical split, introduce narrow ports where a consumer gains a real fake/test seam:

```rust
pub trait JobRepository {
    fn submit(&mut self, command: SubmitJob<'_>) -> anyhow::Result<SubmitResult>;
    fn get(&self, owner: PrincipalId, id: &str) -> anyhow::Result<Option<JobView>>;
    fn control(&mut self, command: ControlJob<'_>) -> anyhow::Result<ControlResult>;
}

pub trait SongRepository { /* list, sync, detail, mutate */ }
pub trait ArtifactRepository { /* verify, open, publish */ }
```

One `Library` can implement all ports. Do not create separate database connections or service-owned transactions merely to make the traits look independent.

### Persistence and transaction invariants

- Job acceptance writes immutable sidecars before committing the job row, as documented at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L1-L5) and implemented at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L324-L371).
- Job completion, artifact insertion, and song publication must remain in one transaction. Completion begins at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L863), and song publication is explicitly transaction-scoped at [`songs.rs`](../../node/crates/cantor-node/src/songs.rs#L137-L188).
- Delivery artifact insertion and revision publication remain atomic at [`delivery.rs`](../../node/crates/cantor-node/src/delivery.rs#L91-L126).
- Preserve migration numbers, SQL text, defaults, and execution order. Refactoring migrations is not schema evolution.
- Preserve `PRAGMA journal_mode=WAL`, foreign keys, `synchronous=FULL`, busy timeout, `quick_check`, and database permissions from [`library.rs`](../../node/crates/cantor-node/src/library.rs#L211-L273).
- Preserve attempt-token compare/update predicates. They prevent stale worker callbacks from mutating a newer claim.
- Preserve owner predicates in every job, song, and artifact query.
- Preserve atomic-file order: write, chmod, file `sync_all`, rename/persist, parent-directory `sync_all`.
- Preserve symlink rejection, canonical paths, quarantine decisions, and startup recovery classifications.
- Do not reinterpret corrupt or ambiguous on-disk state during a structural refactor.

## Priority 0: application/session facade

### Evidence

`ClientSession` stores secure channel state, pending authentication, relay session identity, authenticated identity, and artifact transfer state at [`session.rs`](../../node/crates/cantor-node/src/session.rs#L30-L37). Its application handler spans [`session.rs`](../../node/crates/cantor-node/src/session.rs#L165-L864), takes seven external dependencies, and combines:

- challenge authentication and pairing enrollment at [`session.rs`](../../node/crates/cantor-node/src/session.rs#L190-L346);
- job/list/create/control routing beginning at [`session.rs`](../../node/crates/cantor-node/src/session.rs#L347);
- song and revision-sync routing in the middle of the same match;
- stateful filesystem-backed artifact open/ack transfer at [`session.rs`](../../node/crates/cantor-node/src/session.rs#L689-L861);
- repeated protocol-error construction and field validation at [`session.rs`](../../node/crates/cantor-node/src/session.rs#L866-L1018).

The relay subsequently infers side effects by matching response variants at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L645-L705). A transport adapter should not need to know that `JobAccepted` wakes the scheduler or that `SongUpdated` emits a library revision.

### Target

```text
application/
  mod.rs
  router.rs       ClientMessage -> ApplicationOutcome
  auth.rs         challenge state and pairing enrollment
  errors.rs       stable application error -> NodeMessage mapping
  jobs.rs         request validation and JobService calls
  songs.rs        list/sync/detail/mutation request handling
  transfers.rs    ArtifactTransferSession open/ack state
  node_info.rs    capability/load projection
```

Suggested facade:

```rust
pub struct ApplicationOutcome {
    pub response: NodeMessage,
    pub effects: Vec<NodeEvent>,
}

pub struct RequestContext<'a> {
    pub config: &'a mut NodeConfig,
    pub pair_offer: &'a mut Option<PairOffer>,
    pub library: &'a mut Library,
    pub node_info: &'a NodeInfo,
}

pub struct ClientSession {
    secure: SecureSession,
    auth: AuthSession,
    transfer: ArtifactTransferSession,
}
```

Parse into `ClientMessage` once at the application boundary. Preserve the current fallback request-ID behavior for malformed JSON. `ApplicationOutcome.effects` must make scheduler wakeups, job updates, library changes, and other consequences explicit; the relay then forwards the response and emits the returned effects without inspecting response variants.

A typed `ApplicationError` may centralize `ErrorCode`, retryability, public message, details, and correlation ID. Internal `anyhow::Error` remains a logged source and must not cross the client boundary.

## Priority 1: relay adapter

### Evidence

[`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L142-L353) combines WebSocket connection and claim, writer-task management, keepalive, the select loop, session registry, runtime events, application requests, node-info refresh, and shutdown state. Node-info fanout is duplicated at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L283-L301) and [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L321-L338).

The same file also contains:

- event-to-private-session routing at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L361-L465);
- binary carrier encoding/decoding at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L478-L542);
- secure-handshake routing at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L547-L593);
- decryption and application dispatch at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L595-L705);
- `NodeInfo` construction at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L724-L767).

The two application-facing helpers require `clippy::too_many_arguments` at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L595) and [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L645), indicating missing cohesive context objects.

### Target

```text
relay/
  mod.rs
  client.rs       URL, connect, challenge/claim, reconnect
  carrier.rs      exact bounded binary carrier codec
  connection.rs   writer task, keepalive, socket select loop
  sessions.rs     bounded SessionRegistry and targeted fanout
```

```rust
pub struct SessionRegistry {
    sessions: HashMap<SessionId, ClientSession>,
}

impl SessionRegistry {
    pub fn open_or_get(&mut self, id: SessionId) -> OpenResult<'_>;
    pub fn remove(&mut self, id: SessionId);
    pub fn authenticated(&mut self) -> impl Iterator<Item = SessionTarget<'_>>;
    pub fn for_principal(&mut self, owner: PrincipalId)
        -> impl Iterator<Item = SessionTarget<'_>>;
}
```

Carrier extraction must begin with golden byte tests for both directions. Do not alter carrier versions, field widths, endianness, UUIDv4 validation, ciphertext bounds, or relay pre-handshake text behavior.

## Priority 1: generation and job execution

### Evidence

`jobs.rs` contains 833 production lines and no module-local test section. It combines:

- stop arbitration and shutdown at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L30-L140);
- durable scheduling at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L142-L212);
- installed-model provenance and backend resolution at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L256-L404);
- a native-thread session cache and checkpoint-aware stage runner at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L406-L638);
- checkpoint, stop, progress, and event persistence at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L640-L788);
- public/internal worker-error policy at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L790-L833).

The dedicated native thread and its cached generation session are explicit safety constraints at [`jobs.rs`](../../node/crates/cantor-node/src/jobs.rs#L76-L103); they must not be replaced with generic task spawning.

### Target

```text
jobs/
  mod.rs
  scheduler.rs    claim/sleep/retry loop
  stop.rs         StopReason and priority arbitration

generation/
  plan.rs         exact model/backend/options resolution
  worker.rs       dedicated native thread and cache
  runner.rs       stage/checkpoint/stop state machine
  failure.rs      stable public failure policy
```

The valuable fake seam is the dedicated-worker boundary:

```rust
pub trait GenerationDriver: Send {
    fn run(&mut self, command: GenerationCommand) -> Result<(), GenerationFailure>;
}
```

Use it to test scheduling, persistence, stop behavior, and retry decisions without loading native weights. Do not add traits around every engine call. `engine.rs` and `generate.rs` already provide reasonable low-level boundaries and should remain intact during the first pass.

## Priority 1: delivery pipeline

### Evidence

`delivery.rs` contains three distinct layers:

- repository and artifact-index logic in its `impl Library`, [`delivery.rs`](../../node/crates/cantor-node/src/delivery.rs#L45-L221);
- background-worker scheduling and event publication at [`delivery.rs`](../../node/crates/cantor-node/src/delivery.rs#L224-L292);
- WAV validation, Opus encoding, atomic publication, and artifact inspection at [`delivery.rs`](../../node/crates/cantor-node/src/delivery.rs#L294-L434).

### Target

Move repository logic to `library/artifacts.rs`, then split:

```text
delivery/
  mod.rs
  worker.rs
  opus.rs
```

```rust
pub trait DeliveryEncoder: Send + Sync {
    fn ensure(&self, candidate: &DeliveryCandidate) -> anyhow::Result<InspectedDelivery>;
}
```

A fake encoder permits deterministic worker retry, skip, publication, and notification tests. Preserve the canonical WAV requirements, Opus profile, temporary-file naming, file mode, file sync, atomic rename, and parent-directory sync.

## Priority 2: local control surface

### Evidence

`control.rs` combines four systems:

- Unix socket location, authorization, permissions, and server transport at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L93-L303);
- streaming request detection and JSON-line emission at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L306-L398);
- catalog, backend, generation, and pull workflows at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L400-L1029);
- typed short requests, dispatch, and both client variants at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L1031-L1369).

Progress-channel/download orchestration is repeated for engine installation at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L438-L471), backend candidate installation at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L651-L677), component pulling at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L920-L951), and post-pull engine installation at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L979-L999).

Local job submission at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L738-L786) also duplicates model selection/admission behavior present in app request handling.

### Target

```text
control/
  mod.rs
  socket.rs
  wire.rs
  server.rs
  client.rs
  commands/
    pairing.rs
    models.rs
    backends.rs
    generate.rs
```

Prefer a concrete `JsonLineWriter<W>` and reusable progress pump over an async-trait hierarchy. Local and remote generation should call a shared `JobService::submit`; the control adapter alone owns terminal formatting and CLI-specific messages.

## Priority 2: security internals

### Evidence

`secure.rs` has a useful external facade but four internal responsibilities:

- transport-key lifecycle and signed descriptor at [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L42-L193);
- secure handshake state machine at [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L195-L391);
- Noise record limits, fragmentation, and reassembly at [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L393-L569);
- application inner-frame codec at [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L571-L643).

### Target

```text
secure/
  mod.rs          unchanged SecureSession/TransportIdentity facade
  identity.rs     key and descriptor
  handshake.rs
  record.rs       encryption limits and fragmentation
  inner.rs        exact application inner codec
```

All submodules should remain private. Do not add cipher-suite injection, a generic crypto-provider trait, automatic rekeying, alternative handshakes, or generalized framing. There is one reviewed protocol; making security “pluggable” would increase the state space without a real consumer.

## Shared value types and durable filesystem primitives

### Strong candidate: `PrincipalId`

Principal derivation is implemented in [`session.rs`](../../node/crates/cantor-node/src/session.rs#L129-L139) and repeated during revocation at [`control.rs`](../../node/crates/cantor-node/src/control.rs#L1201-L1205). Canonical encoding/decoding is duplicated at:

- [`library.rs`](../../node/crates/cantor-node/src/library.rs#L1481-L1490) and [`library.rs`](../../node/crates/cantor-node/src/library.rs#L1680-L1681);
- [`songs.rs`](../../node/crates/cantor-node/src/songs.rs#L817-L818);
- [`delivery.rs`](../../node/crates/cantor-node/src/delivery.rs#L436-L448).

Introduce a checked value type:

```rust
#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub struct PrincipalId([u8; 32]);

impl PrincipalId {
    pub fn from_client_public_key(key: &[u8; 32]) -> Self;
    pub fn as_bytes(&self) -> &[u8; 32];
}

impl Display for PrincipalId; // canonical lowercase hex for SQLite/filesystem
impl FromStr for PrincipalId; // rejects non-canonical or wrong-length input
```

This is more than deduplication: it prevents confusing client keys, raw hashes, encoded principal IDs, and arbitrary `[u8; 32]` values.

### Conservative durable filesystem module

Atomic JSON sidecar implementations are nearly identical at [`library.rs`](../../node/crates/cantor-node/src/library.rs#L1665-L1677) and [`checkpoints.rs`](../../node/crates/cantor-node/src/checkpoints.rs#L407-L419). Owner-only key creation is duplicated at [`identity.rs`](../../node/crates/cantor-node/src/identity.rs#L20-L87) and [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L59-L160).

A small `durable_fs` module may own explicitly named primitives such as `atomic_write_json_0600`, `sync_parent`, `require_real_directory`, and `create_new_0600`. Avoid a generic persistence framework. Each call must retain its existing temporary prefix, collision behavior, permissions, symlink policy, serialization, and error context.

Key-file consolidation should be last and must retain `create_new`, race-safe load-after-`AlreadyExists`, exact 32-byte length checks, zeroization, permission repair, and identity-specific interpretation.

## Characterization-test gaps

Before moving behavior, add tests at the boundaries most likely to regress:

1. **Relay carrier golden bytes**
   - node and client carrier shape;
   - version, kind, lengths, endianness, UUID validation, and maximum ciphertext;
   - malformed/truncated/trailing-byte rejection.

2. **Secure inner and fragmentation golden bytes**
   - control JSON and raw artifact encoding;
   - first/middle/final fragment records;
   - counters, reassembly ordering, overlap, replay, per-session byte/message caps;
   - cross-session failure and fail-closed state.

3. **Application response/effect characterization**
   - malformed request fallback IDs;
   - exact error code, retryability, details, and public message;
   - scheduler wakeup on acceptance/resume;
   - stop signaling on pause/cancel/revoke;
   - library revision effect after mutation;
   - no transport-level inference from response variants after `ApplicationOutcome` exists.

4. **Owner-isolation matrix**
   - every job, song, change-page, artifact, and unsolicited-event path;
   - authenticated non-owner must be indistinguishable from missing where required.

5. **Persistence compatibility**
   - open databases at each recorded migration version;
   - reopen with no schema or data changes;
   - completion/artifact/song all-or-nothing behavior;
   - idempotent submission and publication;
   - stale worker attempt cannot commit;
   - exact sidecar schema and canonical relative paths.

6. **Recovery characterization**
   - queued/preparing/running/pause-requested/cancel-requested/finalizing states;
   - valid, corrupt, stale, or absent checkpoints;
   - ambiguous orphan quarantine versus known-incomplete deletion;
   - master verification failure never remains published.

7. **Worker tests without native inference**
   - empty queue sleep/wakeup race;
   - retryable versus terminal failure;
   - stop-reason priority;
   - active-job cleanup after success, failure, and worker-channel closure;
   - delivery encoder failure skips one item without blocking later candidates.

8. **Control wire compatibility**
   - short and streaming request frames;
   - terminal `ok`/`catalog`/`error` behavior;
   - progress ordering and throttling;
   - socket permissions and stale-socket/symlink refusal.

Existing fixture duplication should be consolidated after characterization. Relay and control construct nearly identical complete node states at [`relay.rs`](../../node/crates/cantor-node/src/relay.rs#L859-L887) and [`control.rs`](../../node/crates/cantor-node/src/control.rs#L1383-L1409). The session delivery fixture embeds schema details through raw SQL at [`session.rs`](../../node/crates/cantor-node/src/session.rs#L1081-L1141). Add small explicit `#[cfg(test)]` builders such as `TestNode`, `TestLibrary`, `TestModel`, `TestPrincipal`, and `TestSong`; keep raw schema insertion confined to one compatibility-fixture helper.

## Anti-abstraction warnings

- Do not build a dependency-injection container. A small `RequestContext` and explicit constructors are sufficient.
- Do not replace all concrete repositories with traits at once. Add a narrow trait only where a worker or service needs a fake implementation.
- Do not create separate “job database”, “song database”, and “artifact database” objects. Cross-feature SQLite transactions are correctness boundaries.
- Do not make Noise suites, carrier versions, database backends, or audio profiles pluggable without a second supported implementation and migration story.
- Do not hide lock acquisition in pervasive generic closure helpers.
- Do not merge protocol errors, internal failures, and persistence errors into one universal error enum. Convert at the application boundary.
- Do not replace the dedicated native inference thread with general Tokio tasks; native thread affinity and cache ownership are deliberate.
- Do not deduplicate filesystem code until its durability and symlink semantics have been compared exactly.
- Do not move protocol constants into a generic utilities crate merely because multiple modules use them. Ownership should follow the wire layer that defines them.
- Do not combine this extraction with schema cleanup, wire-version changes, crypto changes, concurrency changes, UI contracts, or new product features.

## Safe extraction order

1. **Freeze externally visible behavior.** Add carrier/inner golden tests, application response/effect tests, persistence/recovery compatibility tests, and control-wire tests.
2. **Create shared test builders.** Replace duplicated whole-node fixtures gradually; retain specific per-test setup.
3. **Introduce `PrincipalId`.** Convert derivation and canonical SQL/filesystem encoding with byte-for-byte tests.
4. **Extract runtime ownership.** Move `NodeState`, `SharedState`, and events into `runtime` with compatibility re-exports; change imports only.
5. **Decompose persistence mechanically.** Convert `library.rs` into the proposed internal tree while preserving the `Library` type, method signatures, SQL, transactions, and file operations exactly.
6. **Extract relay pure pieces.** Move carrier codec first, then `SessionRegistry`, then node-info projection. Keep the socket loop behavior unchanged.
7. **Introduce `ApplicationOutcome`.** Make effects explicit before splitting the large session match; preserve response shapes and event timing.
8. **Split session responsibilities.** Extract authentication, job/song handlers, and artifact transfer state behind the existing `ClientSession` facade.
9. **Split delivery.** Move repository code under `library`, isolate the encoder, make the worker testable with a fake encoder.
10. **Split generation/jobs.** Separate planner, dedicated worker, runner, and scheduler while preserving thread ownership and checkpoint sequencing.
11. **Split control.** Separate socket/wire/client/commands, reuse application services, and consolidate progress pumping.
12. **Add a library crate boundary only after the modules stabilize.** Make `main.rs` a thin CLI/daemon composition root and expose only APIs with actual external or integration-test consumers.
13. **Consolidate durable filesystem/key primitives last.** Re-run security, recovery, restart, and permissions tests after every move.

Each step should be independently reviewable and committed with no intentional protocol, schema, filesystem-layout, cryptographic, scheduling, or user-visible behavior difference. If a proposed extraction requires one of those differences, stop and make it a separate design decision rather than disguising it as refactoring.

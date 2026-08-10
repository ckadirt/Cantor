# Cantor app refactoring audit

Status: read-only architecture audit

Baseline: `d3f890d` (`M6 encrypt private transport end to end`)

Scope: React Native application code and Cantor-owned Android native modules

## Purpose

Cantor's private product loop already works. The next refactoring phase should
make that behavior easier to understand, test, reuse, and redesign without
changing the protocol, persistence formats, or security properties.

This is not a rewrite plan. The safest strategy is to preserve the existing
public seams, extract one responsibility at a time, and keep the current tests
green after every move.

## Executive assessment

The strongest architectural pressure is concentrated in two files:

- `cantor/src/screens/MainScreen.tsx` is 1,548 lines and combines application
  startup, backend lifecycle, persistence reconciliation, outbox delivery,
  library/audio use cases, view-model projection, and four substantial UI
  components.
- `cantor/src/backends/connection.ts` is 1,375 lines and combines WebSocket
  lifecycle, reconnect policy, Noise negotiation, application authentication,
  message decoding/dispatch, request correlation, artifact transfer, and library
  synchronization.

The surrounding modules are generally small and purposeful. The goal should be
to turn the responsibilities already present in these two files into explicit
product-level seams, not to introduce a broad generic framework.

## Current responsibilities and pressure points

### 1. `MainScreen` is both the application runtime and the view

Evidence:

- Runtime state and mutable connection registries are declared at
  `cantor/src/screens/MainScreen.tsx:84-98`.
- Backend persistence is owned by the screen at
  `cantor/src/screens/MainScreen.tsx:122-187`.
- One effect hydrates job and library caches, creates/stops connections, merges
  remote snapshots, writes snapshots back to storage, and flushes the submission
  outbox at `cantor/src/screens/MainScreen.tsx:189-316`.
- Pairing and remote job/song commands live at
  `cantor/src/screens/MainScreen.tsx:328-402`.
- Artifact download, durable append/finalize, playback, pinning, and local state
  refresh are orchestrated at `cantor/src/screens/MainScreen.tsx:404-470`.
- Library view-model rows are assembled at
  `cantor/src/screens/MainScreen.tsx:508-543`.
- `LibraryTimeline`, `LibrarySongRow`, `BackendCard`, and `JobQueue` occupy
  `cantor/src/screens/MainScreen.tsx:639-1354`; formatting helpers and styles
  follow them.

Consequences:

- A UI redesign can accidentally alter reconnect, persistence, or offline
  behavior.
- Runtime behavior cannot be tested without rendering a large screen.
- Feature-local states such as song editing, download progress, and submission
  errors are mixed with global storage/runtime errors.
- Every snapshot change rebuilds the entire screen projection, and the library
  is rendered by mapping rows inside one `ScrollView`
  (`cantor/src/screens/MainScreen.tsx:547-618`, `:729-739`) rather than through a
  virtualized list.

### 2. `BackendConnection` contains several independent state machines

Evidence:

- Socket creation, keepalive, relay parsing, and presence handling:
  `cantor/src/backends/connection.ts:198-315`.
- Noise offer/handshake and encrypted carrier processing:
  `cantor/src/backends/connection.ts:317-441`.
- Application identity challenge/welcome flow:
  `cantor/src/backends/connection.ts:443-543`.
- Job, library, song, artifact, and error dispatch are one long conditional
  handler at `cantor/src/backends/connection.ts:474-883`.
- Public RPC operations and artifact transfer live at
  `cantor/src/backends/connection.ts:928-1179`.
- Full and incremental library synchronization is managed at
  `cantor/src/backends/connection.ts:1181-1234`.
- Failure and reconnect policy live at
  `cantor/src/backends/connection.ts:1250-1289`.

`PendingRequest` is an unstable internal abstraction. Its `expected` discriminator
is independent of several optional resolver fields
(`cantor/src/backends/connection.ts:71-89`), so TypeScript cannot prevent a
request from being registered with the wrong resolver. Timer creation,
registration, message construction, and sending are repeated by job, song, and
artifact methods at `:928-989`, `:999-1022`, and `:1093-1179`.

The existing public class is nevertheless valuable: callers already see a
coherent node API, and its constructor accepts a `SecureChannelFactory`
(`cantor/src/backends/connection.ts:163-170`). Preserve that façade while its
internals are extracted.

### 3. Protocol ownership points in the wrong direction

`cantor/src/backends/types.ts` is 439 lines. It owns backend records and connection
snapshots, but also protocol versions and every runtime decoder for node, job,
song, artifact, and library messages (`:20-21`, `:103-439`).

This causes lower-level features to depend on the backend adapter:

- `cantor/src/library/repository.ts:3` imports song parsing from `backends`.
- `cantor/src/jobs/repository.ts:3` imports job parsing from `backends`.
- `cantor/src/security/descriptor.ts:5-6` imports protocol constants and a
  security descriptor type from `backends`.
- `cantor/src/security/wire.ts:3` imports protocol constants and validation from
  `backends`.

Protocol constants, decoded domain data, and pure validation should sit below
all feature and transport adapters.

### 4. Persistence infrastructure is repeated and policies are implicit

Four repositories independently implement the same promise-chain write lock:

- `cantor/src/library/repository.ts:133-140`
- `cantor/src/jobs/repository.ts:73-80`
- `cantor/src/jobs/outbox.ts:144-151`
- `cantor/src/audio/repository.ts:140-147`

Their corruption behavior is materially different:

- Library loading skips an invalid node entry and retains other entries at
  `cantor/src/library/repository.ts:103-126`.
- Job loading rejects the whole stored snapshot when an entry is invalid at
  `cantor/src/jobs/repository.ts:49-67`.
- The audio index validates only its outer object before casting all entries at
  `cantor/src/audio/repository.ts:130-138`.
- Backend storage strictly validates each record and its signed transport
  descriptor at `cantor/src/backends/storage.ts:28-49`.

These policies must not be accidentally normalized by a generic repository.
Extract only the serialized read/update mechanism; require each store to provide
its decoder and explicit corruption policy. Each store needs its own queue so an
audio-index write does not block an unrelated job snapshot write.

### 5. Local audio has two representations of truth

The Android filesystem is authoritative for remote/partial/cached/pinned state
(`cantor/android/app/src/main/java/com/cantor/app/audio/CantorAudioModule.kt:32-48`).
TypeScript also maintains an AsyncStorage index with its own access timestamp
(`cantor/src/audio/repository.ts:107-138`).

These representations are not reconciled completely:

- Native eviction returns removed filenames at
  `CantorAudioModule.kt:203-223`.
- TypeScript ignores the returned eviction list at
  `cantor/src/audio/repository.ts:67` and `:94`.
- TypeScript `accessedAt` does not drive native eviction; native file timestamps
  do.

Current UI correctness is protected because `inspectAudio` asks native storage
first (`cantor/src/audio/repository.ts:25-33`). The framework should make that
truth explicit: either remove the redundant index or add an authoritative native
`list()` contract and reconcile against it.

The Kotlin bridge also combines three responsibilities:

- React Native argument/result conversion
- artifact filesystem, hashing, promotion, and eviction
- `MediaPlayer` lifecycle

Its single lock covers file hashing/fsync and synchronous player preparation
(`CantorAudioModule.kt:80-109`, `:159-188`). Split responsibility before changing
threading; changing both at once would make regressions difficult to diagnose.

### 6. Feature UI state has no durable controller boundary

`LibrarySongRow` owns draft title/tags, mutation state, detail loading, audio
state, and error forwarding (`cantor/src/screens/MainScreen.tsx:759-824`). Its
effect resets draft fields whenever the remote song revision changes (`:766-770`),
which can replace an unsaved local edit.

`BackendCard` owns node presentation, generation form state, UTF-8 limit
validation, submission state, job rendering, and model selection
(`cantor/src/screens/MainScreen.tsx:1011-1231`). These are reusable feature states,
not card-specific rendering details.

Errors are also conflated: `storageError` receives cache failures, connection
action failures, detail failures, and audio failures (`MainScreen.tsx:92`,
`:214-300`, `:495`, `:583`). The V1 UI will need separate global runtime,
feature-action, validation, and conflict states.

### 7. Native security has useful seams, but must be last

The TypeScript `SecureChannel` contract is already a good boundary at
`cantor/src/security/native.ts:16-24`, and `BackendConnection` already supports
factory injection. Keep it.

The Kotlin module owns the native session registry, Noise handshake,
fragmentation/reassembly, key-use limits, base64 boundary, and cleanup in one
class (`cantor/android/app/src/main/java/com/cantor/app/security/CantorSecureModule.kt:34-354`).
Those responsibilities could eventually become `NoiseSession`, `FragmentCodec`,
and `SecureSessionRegistry`, with `CantorSecureModule` reduced to bridge mapping.

Do not perform that cleanup until JVM protocol-vector and lifecycle tests exist.
This module is security-sensitive, and its current shape is less costly than a
subtle change to handshake order, counters, key destruction, fragmentation, or
downgrade rejection. The vendored Noise implementation is out of refactoring
scope.

## Target dependency direction

Use inward-facing product contracts:

```text
screens and visual components
        |
        v
feature controllers/hooks
        |
        v
application use cases -----> domain data + protocol codecs
        |
        v
application ports (NodeClient, LocalAudioStore, repositories)
        ^
        |
adapters (WebSocket/Noise, AsyncStorage, React Native modules, Android services)
```

Rules:

1. Screens may depend on feature controllers and presentation data, never on
   AsyncStorage, WebSocket, or `NativeModules`.
2. Feature controllers coordinate product use cases but do not parse wire data.
3. Protocol codecs are pure and do not import backend, UI, storage, or native
   modules.
4. Adapters depend on application ports; ports do not expose adapter-specific
   objects such as WebSocket frames or React Native maps.
5. Security remains a transport concern. Decrypted application messages cross a
   typed boundary; feature code never handles Noise sessions or ciphertext.

## Recommended framework seams

These are product-shaped seams justified by current behavior.

### Backend runtime

```ts
type BackendRuntime = {
  state: RuntimeSnapshot;
  pair(request: PairingRequest): void;
  submit(nodeKey: string, draft: GenerationDraft): Promise<void>;
  controlJob(nodeKey: string, command: JobCommand): Promise<void>;
  updateSong(nodeKey: string, command: SongCommand): Promise<void>;
  refreshLibraries(): void;
};
```

A `useBackendRuntime(identity, dependencies?)` hook can own the effect currently
at `MainScreen.tsx:189-316`. Inject dependencies in tests, but default them in one
composition module so production UI remains simple.

### Node client

```ts
interface NodeClient {
  start(): void;
  stop(): void;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
  createJob(command: CreateJobCommand): Promise<JobView>;
  controlJob(command: JobControlCommand): Promise<JobView>;
  getSong(songId: string): Promise<SongDetail>;
  updateSong(command: SongCommand): Promise<SongHeader>;
  downloadArtifact(command: ArtifactDownload): Promise<void>;
  refreshLibrary(): void;
}
```

Initially, `BackendConnection` should implement or be adapted to this interface
without changing its behavior.

### Typed request registry

Replace optional resolver fields with a discriminated request specification:

```ts
type RequestSpec<T> = {
  expected: ResponseType;
  timeoutMessage: string;
  decode(message: unknown): T;
};

request<T>(kind: string, payload: object, spec: RequestSpec<T>): Promise<T>;
```

The registry owns identifiers, timers, stale-response rejection, finish, and
disconnect cleanup. The connection owns only transport and routing.

### Local audio store

```ts
type AudioRef = { nodeKey: string; songId: string; digest: string };

interface LocalAudioStore {
  inspect(ref: AudioRef): Promise<LocalAudio>;
  createSink(ref: AudioRef): ArtifactSink;
  play(ref: AudioRef): Promise<void>;
  pin(ref: AudioRef): Promise<LocalAudio>;
  unpin(ref: AudioRef): Promise<LocalAudio>;
  remove(ref: AudioRef): Promise<LocalAudio>;
}
```

This replaces repeated three-string argument lists and gives artifact download a
stable port independent of the Android bridge.

### Serialized JSON store

```ts
createSerializedJsonStore<T>({
  key,
  empty,
  decode,
}): {
  read(): Promise<T>;
  update(change: (current: T) => T | Promise<T>): Promise<T>;
};
```

Instantiate it once per storage key. Keep migrations and corruption behavior in
the feature repository, not in this primitive.

### Feature controllers

Useful focused hooks include:

- `useSongEditor(song, commands)` with explicit `dirty`, `saving`, `conflict`,
  and field-error state.
- `useArtifactActions(audioRef, commands)` with download progress and retry
  state.
- `useGenerationDraft(nodeInfo)` with byte-accurate validation and a serializable
  command result.
- `useJobControls(job, commands)` with per-job pending/error state.

These hooks must remain independent of card/row layout so the V1 visual design
can replace presentation without replacing behavior.

## Behavioral invariants to freeze before extraction

Any refactoring change should keep these properties under automated tests:

### Connection and security

- No app public key, pairing proof, petname, or application request is sent before
  the Noise handshake succeeds.
- Application traffic is binary/encrypted after secure negotiation; plaintext
  fallback is forbidden.
- The transport descriptor is verified against the paired Ed25519 key and a
  changed pinned transport key requires removal/re-pairing.
- Reconnect destroys native secure-session state, clears pending requests, and
  does not allow a stale response to resolve a newer request.
- Fatal authorization/protocol failures stop retrying; transient transport
  failures retain bounded reconnect behavior.

### Jobs and outbox

- A submission is persisted before network delivery.
- Retrying uses the same client request identifier and preserves node-side
  idempotency.
- Terminal non-retryable rejection and accepted canonical job identifiers remain
  durable.
- Job snapshots merge only newer revisions, and job-control race winners replace
  stale local state.

### Library

- A full multi-page snapshot is staged before replacing the visible/cached
  library.
- Incremental changes begin at the completed snapshot revision.
- Revisions never move backward; stale song headers do not replace newer ones.
- Cached headers remain available while the node is offline.
- Revision conflicts expose and adopt the node's canonical current song.

### Artifacts and audio

- Resume begins at the native partial file's exact durable offset.
- Only one acknowledged chunk advances the offset at a time.
- Transfer/session identity, profile, length, order, and SHA-256 must remain exact.
- A partial file is promoted only after length and digest verification.
- Pinned files survive cache eviction and remain playable offline.
- Cache eviction never removes the playing artifact.

### UI controllers

- One action cannot be submitted twice while already pending.
- Remote revisions do not silently replace dirty local edits; conflict policy is
  explicit.
- Per-song/per-job errors remain local instead of replacing unrelated global
  runtime status.

## Characterization-test gaps

Current connection tests cover several high-value behaviors, including Noise
ordering, plaintext rejection, stale responses, library sync, revision conflict,
job controls, artifact durability, and fatal rejection in
`cantor/src/backends/__tests__/connection.test.ts`.

The audit found no direct tests for:

- `MainScreen` runtime orchestration
- the four UI components embedded in `MainScreen`
- TypeScript audio repository/native adapter behavior
- Cantor's Kotlin audio module
- Cantor's Kotlin secure module

Before moving code, add behavior-level characterization tests around injected
ports. Prefer assertions about commands, persisted revisions, progress, and error
state over large rendered snapshots. For Kotlin, add filesystem tests for
partial/promote/pin/evict behavior and fixed protocol vectors for secure
fragmentation and session lifecycle.

## Anti-abstraction warnings

Avoid these tempting but counterproductive changes:

- Do not create a universal `BaseRepository`. Backend, library, jobs, outbox, and
  audio stores have different validation, migration, and corruption semantics.
- Do not introduce a global event bus or application-wide state library merely to
  move state out of `MainScreen`. A scoped runtime hook with explicit commands is
  sufficient until multiple screens demonstrably need shared navigation state.
- Do not build a backend-plugin hierarchy around one implemented protocol.
  `NodeClient` is the reusable product seam; add adapter variants only when a
  second backend transport exists.
- Do not convert the message dispatcher into an untyped map of callbacks. Use a
  discriminated message union and typed decoders, or the current explicit logic
  is safer.
- Do not combine extraction with protocol renaming, storage-key changes, schema
  migrations, reconnect tuning, or security-suite changes.
- Do not wrap every function in an interface. Introduce ports only for boundaries
  that cross I/O, native/network adapters, or independent feature use cases.
- Do not create broad barrel files that make dependency direction invisible.
- Do not modify vendored Noise sources as part of framework cleanup.
- Do not refactor native cryptography and transport orchestration in the same
  milestone.

## Staged extraction recommendation

Each stage should be independently reviewable and committed with all existing
checks green.

### Stage 0 — Freeze observable behavior

1. Add MainScreen/runtime characterization tests using fake backend clients and
   repositories.
2. Add TypeScript audio-service tests with a fake native adapter.
3. Record explicit tests for every invariant above that is not already covered.
4. Make no production restructuring in this stage.

### Stage 1 — Extract leaf-level pure code

1. Move repeated `readError`, `utf8ByteLength`, and `isRecord` implementations to
   focused core modules.
2. Move protocol versions and decoders out of `backends/types.ts` without changing
   their signatures or validation behavior.
3. Move pure job labels/controls, library row projection, delivery-artifact
   selection, and formatting helpers out of `MainScreen` and test them.

This stage corrects dependency direction with very low lifecycle risk.

### Stage 2 — Separate presentation without changing ownership

Move `LibraryTimeline`, `LibrarySongRow`, `BackendCard`, and `JobQueue` into
feature directories. Keep their props and state exactly as they are. Do not add a
new state library or redesign them during the move.

### Stage 3 — Extract the backend runtime

Move connection maps, pairing tokens, cache hydration, snapshot persistence,
outbox flushing, and command handlers into `useBackendRuntime`. Keep
`BackendConnection` unchanged and inject factories/repositories only at the
runtime boundary. Confirm that rerenders do not recreate live connections or
resend the outbox.

### Stage 4 — Stabilize persistence and audio ports

1. Introduce the per-key serialized JSON-store primitive while retaining current
   keys and decoders.
2. Introduce `AudioRef` and `LocalAudioStore`.
3. Move download-and-play orchestration out of the screen.
4. Decide explicitly whether to remove the TypeScript audio index or make native
   listing/reconciliation authoritative.

### Stage 5 — Make request correlation typed

Extract `RequestRegistry` from `BackendConnection`. Convert one response family at
a time: song detail/mutation, job commands, artifact transfer, then automatic
library requests. Keep the existing class façade and connection tests.

### Stage 6 — Extract library synchronization

Represent full-page staging and incremental synchronization as a small explicit
state machine or pure reducer. Preserve atomic snapshot replacement, revision
monotonicity, and full-sync fallback behavior.

### Stage 7 — Split transport internals

Only after the preceding seams are stable, separate relay socket lifecycle from
secure tunnel negotiation. Preserve the `SecureChannel` interface, secure factory
injection, reconnect policy, and all downgrade tests. Run the full app suite and a
physical-phone pair/reconnect/download pass.

### Stage 8 — Thin the Android bridges

1. Extract Kotlin `ArtifactStore` and `AudioPlayer`, leaving the React Native
   method contract unchanged.
2. Add/retain Android tests and perform physical playback/offline validation.
3. Refactor `CantorSecureModule` only in a dedicated security change after JVM
   protocol tests exist; follow it with the full M6 interoperability test matrix.

## Definition of success

The refactor is successful when:

- a new screen can create/control jobs and browse/play the library through
  feature controllers without importing WebSocket, AsyncStorage, or
  `NativeModules`;
- `MainScreen` is a small composition surface rather than the application
  runtime;
- `BackendConnection` remains a stable node-client façade whose transport,
  request correlation, and library sync are independently testable;
- protocol and security modules no longer depend on `backends/types.ts`;
- native bridges translate calls while dedicated Kotlin classes own filesystem,
  playback, and secure-session behavior;
- existing storage remains readable, paired nodes remain paired, cached/pinned
  audio remains intact, and the end-to-end encrypted phone workflow still passes.

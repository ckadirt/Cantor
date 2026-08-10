# Protocol and relay refactoring audit

- Audit scope: Cloudflare relay, Rust node, React Native application, Android
  secure bridge, generated protocol types, fixtures, and release checks
- Revision inspected: `d3f890d` (`M6 encrypt private transport end to end`)
- Audit method: static, read-only architecture review
- Compatibility posture: preserve the current on-wire formats exactly

## Executive assessment

The current Android-to-node path has passed physical interoperability testing,
and this audit found no confirmed incompatibility in that working path. The main
risk is future divergence: protocol constants, handshake schemas, binary codecs,
and validation rules are independently maintained in Rust, TypeScript, and
Kotlin, while most tests exercise only one implementation against itself.

The safe refactor is therefore not a protocol redesign. First make the existing
contract executable through shared specifications and byte-exact fixtures. Then
extract pure codecs and state machines behind the current public interfaces.

## Current contract layers

| Layer | Current implementation | Intended authority |
| --- | --- | --- |
| Application protocol v2 | Rust Serde/`ts-rs`, generated TypeScript, manual app validators | Rust `cantor-proto` |
| Relay JSON protocol v1 | Relay TypeScript, Rust node parser, manual app parser | Not formalized |
| Secure negotiation v1 | Rust `serde_json::Value`, manual app parser | Security ADR only |
| Binary carrier v1 | Relay TypeScript, Rust node, app TypeScript | Security ADR only |
| Noise record fragmentation v1 | Rust and Kotlin | Security ADR only |
| Secure inner messages v1 | Rust and app TypeScript | Security ADR only |
| Descriptor and prologue | Rust producer, app verifier/builder, Kotlin length check | Security ADR only |

## Findings

### P1 — Versions, identifiers, and bounds have multiple authorities

The application protocol version and semantic bounds originate in
[`cantor-proto/src/lib.rs`](../../node/crates/cantor-proto/src/lib.rs#L10), but the
app repeats the application and relay versions in
[`backends/types.ts`](../../cantor/src/backends/types.ts#L20). The generated
`ClientMessage` and `NodeMessage` unions expose `v` as a generic `number`, so a
Rust protocol-version change does not generate a literal TypeScript version that
would force app changes.

Secure constants are independently repeated in:

- [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L20): Noise name,
  suite identifier, channel/carrier versions, domains, bounds, kind identifiers,
  fragmentation limits, and per-session limits.
- [`descriptor.ts`](../../cantor/src/security/descriptor.ts#L8): suite,
  channel/carrier versions, descriptor domain, and prologue domain.
- [`wire.ts`](../../cantor/src/security/wire.ts#L5): carrier/inner kinds and bounds.
- [`frames.ts`](../../relay/src/frames.ts#L1): relay/carrier versions, carrier
  kind, ciphertext bound, header sizes, and session-ID bound.
- [`CantorSecureModule.kt`](../../cantor/android/app/src/main/java/com/cantor/app/security/CantorSecureModule.kt#L13):
  Noise name, record identifiers, all fragmentation limits, session limits, and
  the derived 123-byte prologue size.

The app's [`wire.ts`](../../cantor/src/security/wire.ts#L5) uses one
`CHANNEL_VERSION` for both the relay carrier byte and decrypted inner-message
version. Rust and the ADR define those as independent layers. Their current
shared value of `1` masks this boundary error.

The 64 KiB artifact chunk limit is also declared as
`ARTIFACT_CHUNK_BYTES` in
[`cantor-proto/src/lib.rs`](../../node/crates/cantor-proto/src/lib.rs#L32), but
repeated as a literal in
[`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L584) and
[`wire.ts`](../../cantor/src/security/wire.ts#L117).

**Compatibility risk:** a local version, kind, limit, or domain-label edit can
compile and pass component-local tests while producing incompatible bytes or
signature/prologue preimages.

**Required direction:** application constants should be generated from
`cantor-proto`; transport constants should come from one machine-readable
transport specification and be generated into all three languages.

### P1 — Cross-language compatibility is not an automated gate

The relay binary-routing test uses the relay's own encoder and parser in
[`room.test.ts`](../../relay/test/room.test.ts#L155). The app carrier test likewise
round-trips its own implementation in
[`wire.test.ts`](../../cantor/src/security/__tests__/wire.test.ts#L10). Rust Noise
tests exercise Snow against Snow in
[`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L701).

There are no Kotlin unit or instrumentation tests for `CantorSecureModule`, and
the app CI job runs npm, TypeScript, ESLint, and Jest only; it does not compile
the Android native source
([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml#L57)). Consequently,
a Kotlin signature or API error can merge without being seen by CI.

The shared application fixtures are useful but incomplete. Rust consumes only a
subset of the client and node variants in
[`cantor-proto/src/lib.rs`](../../node/crates/cantor-proto/src/lib.rs#L697), and
the app fixture suite loads only node info, jobs, and a small malformed/forward
set in
[`protocolFixtures.test.ts`](../../cantor/src/backends/__tests__/protocolFixtures.test.ts#L1).
There are no committed fixtures for the relay carrier, secure negotiation,
descriptor binding, fragment records, or Kotlin/Rust Noise interoperability.

**Compatibility risk:** every component can be green while two components
disagree about the same record.

**Required direction:** add shared byte-exact vectors before moving code. Every
consumer must parse vectors produced outside its own codec and reject the same
malformed corpus.

### P1 — The documented command-line integration client is pre-M6

[`node/README.md`](../../node/README.md#L48) directs developers to
`scripts/protocol-client.mjs` for a handshake/status demonstration. The script:

- parses every received WebSocket message as JSON
  ([`protocol-client.mjs`](../../node/scripts/protocol-client.mjs#L90));
- sends application `hello` immediately after relay presence, before Noise
  negotiation ([line 92](../../node/scripts/protocol-client.mjs#L92)); and
- sends all application messages as plaintext relay tunnel payloads
  ([line 215](../../node/scripts/protocol-client.mjs#L215)).

The M6 node correctly requires `secure.init`, Noise handshake completion, and
binary encrypted application frames. The documented client therefore no longer
tests the current system.

**Compatibility risk:** contributors receive a false or broken integration
signal and may copy an obsolete layering model into new clients.

**Required direction:** rebuild the CLI on the same reusable secure-session and
wire-codec abstractions used by a real client. It should become the headless
interoperability smoke test, not a separate protocol implementation.

### P1 — Secure negotiation and descriptor schemas are handwritten twice

Rust handles secure text frames through untyped `serde_json::Value` and literal
field names in [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L246).
The app independently implements the corresponding parser and state transitions
in [`connection.ts`](../../cantor/src/backends/connection.ts#L317).

`TransportDescriptor` is separately defined in
[`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L42) and
[`backends/types.ts`](../../cantor/src/backends/types.ts#L23). Pairing URI field
names are then repeated by the Rust producer in
[`pairing.rs`](../../node/crates/cantor-node/src/pairing.rs#L82) and the app parser
in [`pairing.ts`](../../cantor/src/backends/pairing.ts#L33).

Error/version behavior is implicit. Rust's `secure.error` is assembled as an
untyped JSON value in [`secure.rs`](../../node/crates/cantor-node/src/secure.rs#L375),
while the app accepts `secure.error` without validating a version or enumerated
code in [`connection.ts`](../../cantor/src/backends/connection.ts#L339). Secure
version `1` is also repeated as a literal in both state machines instead of
flowing from the declared constants.

**Compatibility risk:** an additive handshake field, error code, or negotiation
version can acquire different validation and retry semantics on each endpoint.

**Required direction:** define relay and secure-negotiation DTOs plus explicit
parsers. Keep state-machine transition logic separate from WebSocket lifecycle
and application dispatch.

### P2 — Generated application types do not govern runtime traffic

Rust correctly documents `cantor-proto` as the source of truth and generates
committed TypeScript definitions
([`cantor-proto/src/lib.rs`](../../node/crates/cantor-proto/src/lib.rs#L1)). CI
also checks for uncommitted generated changes
([`ci.yml`](../../.github/workflows/ci.yml#L33)). However:

- runtime enum sets and validators are maintained manually from
  [`backends/types.ts`](../../cantor/src/backends/types.ts#L32);
- `BackendConnection` parses the `NodeMessage` union through a long sequence of
  manual `payload.t` branches starting at
  [`connection.ts`](../../cantor/src/backends/connection.ts#L474); and
- outbound application messages are accepted as `Record<string, unknown>` by
  [`sendApplication`](../../cantor/src/backends/connection.ts#L885), rather than
  being checked against generated `ClientMessage`.

**Compatibility risk:** a Rust field rename or required-field addition can
regenerate static types without forcing the actual app builders and validators
to change.

**Required direction:** generate protocol constants, type outbound builders with
`ClientMessage`, return typed variants from one boundary decoder, and expand the
fixture corpus to every message variant. Runtime validation may remain
language-local initially, but it must be centralized and fixture-driven.

### P2 — CI, deployment, and release validate components independently

Relay deployment runs relay-local tests/checks and verifies that `install.sh`
matches after deployment
([`deploy-relay.yml`](../../.github/workflows/deploy-relay.yml#L47)). It does not
perform a secure session through the deployed Worker.

The tag release workflow verifies the crate/tag version and builds the node, but
does not rerun tests, regenerate protocol outputs, or execute an interoperability
smoke test
([`release.yml`](../../.github/workflows/release.yml#L32)). The app CI gap also
means the native Java/Kotlin security path is outside continuous compilation.

**Compatibility risk:** independently valid relay, app, and node artifacts may
be released in an incompatible combination.

**Required direction:** introduce a transport-contract CI job, compile/test the
Android native module, and run the headless secure client against both the local
stack and a post-deploy hosted relay.

## Target reusable and generated boundaries

### 1. Application contract

Keep the Rust `cantor-proto` crate authoritative for application protocol v2.
Extend its generation step to emit:

- `ClientMessage` and `NodeMessage` types;
- application, minimum-supported, and maximum-supported versions;
- application semantic bounds used by clients; and
- a small generated barrel file for stable imports.

Do not move relay or Noise framing into `cantor-proto`; those layers evolve and
version independently.

### 2. Transport specification

Add a machine-readable `protocol/transport/v1/spec.json` containing only stable
declarative facts:

- relay, carrier, secure-channel, record, and inner-message versions;
- Noise protocol name and external suite identifier;
- signature/prologue domain labels;
- carrier, record, and inner kind identifiers;
- fixed header sizes and byte order;
- key, signature, nonce, session-ID, handshake, ciphertext, plaintext, logical
  message, fragment, and artifact bounds; and
- per-direction record/byte limits.

Generate checked-in constant modules for Rust, TypeScript, and Kotlin. A single
generator command must fail if generated output is dirty. Avoid generating the
security-sensitive parsers initially: small idiomatic parsers are easier to
review, while shared constants and fixtures eliminate accidental numeric drift.

### 3. Golden transport fixtures

Add `protocol/transport/v1/fixtures/manifest.json` plus binary fixtures. Each
fixture should record producer, expected result, and applicable consumers.
Minimum corpus:

- valid client-facing and node-facing carriers with exact expected bytes;
- zero, oversized, truncated, trailing-data, invalid-kind, invalid-version,
  invalid-UTF-8, and invalid-session-ID carriers;
- descriptor bytes, key ID, signature preimage, valid signature, and tampered
  descriptor cases;
- exact 123-byte prologue and each input field;
- all secure negotiation and error JSON frames, including wrong version, wrong
  step, changed ID, missing field, extra field, and oversized data;
- control and raw artifact inner records, including safe-integer offset edges;
- one- and multi-fragment records, maximum sizes, overlap, gaps, duplicates,
  reordering, changed totals, and trailing bytes; and
- deterministic Noise known-answer vectors where both libraries allow fixed
  handshake keys. If noise-java cannot inject the necessary test material, use
  a JVM interoperability harness against a Rust fixture process instead.

### 4. Language-local pure codecs

Keep codec implementations local to each language but make them independent of
network and UI lifecycle:

- Rust: extract relay carrier framing from `relay.rs`; extract inner and fragment
  framing from Noise session ownership in `secure.rs`.
- Relay TypeScript: retain `frames.ts` as the pure carrier boundary, consuming
  generated constants and shared fixtures.
- App TypeScript: keep carrier/inner framing pure, split carrier and inner version
  names, and consume the same fixtures.
- Kotlin: extract a `SecureRecordCodec` from `CantorSecureModule`; the React Native
  module should own bridge conversion and channel handles, while the codec owns
  record bounds and reassembly.

No extracted codec should allocate from an untrusted declared length before
validating the relevant global bound and exact available length.

### 5. Session state machines and adapters

Create typed secure-negotiation parsers and a transport-session state machine
that does not know about React callbacks, UI snapshots, or node application
services. WebSocket owners should translate events into the state machine and
send its outputs. Application messages should enter their own typed dispatcher
only after the transport reports `ready`.

The relay remains a carrier router. It must not import or understand secure
negotiation internals or application messages.

## Compatibility invariants

Every refactoring stage must preserve these properties:

1. Application protocol, relay protocol, carrier, secure channel, record, and
   inner-message versions are independent names, even when their numeric value is
   currently `1` or `2`.
2. All binary integers remain unsigned big-endian. Parsers require exact lengths
   and reject trailing bytes.
3. Client-facing carrier shape remains
   `version:u8 | kind:u8 | cipher_len:u32 | ciphertext`.
4. Node-facing carrier shape remains
   `version:u8 | kind:u8 | sid_len:u16 | sid:utf8 | cipher_len:u32 | ciphertext`.
5. Ciphertext is non-empty and at most 96 KiB. Relay session IDs are derived from
   the relay attachment, bounded to 64 UTF-8 bytes, and validated as UUIDv4 before
   node dispatch or client routing.
6. The relay may add or remove only the session ID. It must never inspect,
   transform, log, or classify ciphertext.
7. Text tunnel payloads are limited to pre-transport secure negotiation. App
   identity, pairing proof, control data, metadata, and artifacts are dispatched
   only after Noise transport mode begins.
8. The node X25519 key remains independent from Ed25519 and is accepted only when
   its descriptor signature, key ID, canonical encodings, suite, schema, and
   pinned node identity all verify.
9. The Noise prologue remains the exact concatenation documented in the M6 ADR;
   neither endpoint may normalize or JSON-encode it.
10. Fragments remain strictly consecutive with monotonic message IDs, fixed
    totals, no overlap, and no partial application dispatch.
11. Authentication/decryption failure, replay/reordering, invalid transitions,
    limit exhaustion, descriptor changes, or plaintext downgrade fail closed and
    destroy the affected secure session.
12. Existing unknown-relay-frame forward-compatibility remains explicit and is
    not generalized to malformed known frames or application messages.
13. There is no plaintext fallback, resumption, 0-RTT, silent transport-key
    rotation, or implicit protocol downgrade.

## Safe staged extraction

### Stage 0 — Characterize the current contract

Add the fixture directories, encode the currently deployed byte shapes, and make
the existing implementations consume them. Do not move production code yet.

Gate: all existing tests pass; each fixture has at least two independent
consumers or a documented reason why it cannot yet.

### Stage 1 — Generate constants

Introduce the application constant export and transport specification generator.
Replace literals one component at a time. Preserve existing exported constant
names as temporary aliases so this stage does not force structural changes.

Gate: generated files are clean after regeneration; fixture bytes are unchanged;
all version names remain distinct.

### Stage 2 — Extract pure codecs

Move carrier, inner, and fragment parsing/encoding into small pure modules within
their existing language and package. Keep the current call-site signatures or
thin forwarding wrappers during migration.

Gate: golden valid and malformed fixture results are unchanged; `git diff` shows
no protocol fixture changes.

### Stage 3 — Type relay and secure negotiation envelopes

Replace untyped JSON field access with explicit DTOs and parsers. Document the
version/error policy per known frame. Extract state transitions without changing
retry, close, or fail-closed behavior.

Gate: transition-table tests cover every valid edge and representative invalid,
duplicate, stale, downgrade, and future-version inputs.

### Stage 4 — Extract application dispatch

Move `NodeMessage` routing and pending-request resolution out of
`BackendConnection`. Type every outbound builder as `ClientMessage`; centralize
runtime decoding and use the complete application fixture corpus.

Gate: every application message variant has a compile-time construction test or
runtime fixture; connection lifecycle tests remain unchanged.

### Stage 5 — Replace the stale integration client

Build the command-line client on the extracted transport/session codecs. It must
verify the pairing descriptor, perform Noise, authenticate inside the encrypted
channel, send only binary application traffic, and exercise a small status or
library request without invoking generation.

Gate: the CLI succeeds against the real local relay and Rust node and rejects
descriptor tamper, plaintext downgrade, and wrong protocol versions.

### Stage 6 — Make compatibility a release gate

Add Android native compilation and JVM codec/interoperability tests to CI. Add a
transport-contract job that runs the shared fixture corpus across components.
After relay deployment, establish a secure session through the hosted Worker and
perform a bounded non-generation request. Re-run protocol generation and contract
tests in the tagged node release workflow rather than relying only on branch CI.

Gate: no relay, node, or app release artifact can publish without the shared
contract and secure smoke checks passing.

## Refactoring hazards to avoid

- Do not replace the existing binary formats with Protobuf, CBOR, or another
  encoding as part of extraction.
- Do not upgrade Snow or the vendored noise-java implementation in the same
  change that moves state-machine or framing code.
- Do not merge independently versioned layers into a single convenient
  `VERSION` constant.
- Do not generate opaque parser code that is harder to audit than the current
  fixed-size codecs.
- Do not expose Noise keys or counters to JavaScript to simplify abstractions.
- Do not let shared application schemas make the relay application-aware.
- Do not turn every unexpected frame into a reconnect; preserve the documented
  distinction between unknown extension frames, malformed known frames, and
  session-fatal security failures.

## Completion criteria

This area is ready to be called a reusable framework when:

- every cross-language numeric/string constant has one declared authority;
- generated output is deterministic and checked for drift;
- all wire layers have byte-exact shared valid and malformed fixtures;
- Rust and Kotlin interoperability runs automatically;
- relay, secure-session, and application state machines can be tested without a
  real socket or UI;
- the CLI uses the same secure abstractions as production clients; and
- CI/release checks prove compatibility among the artifacts that will actually
  be deployed together.

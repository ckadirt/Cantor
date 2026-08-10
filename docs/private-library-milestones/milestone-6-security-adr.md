# ADR — Cantor end-to-end relay transport

- **Decision:** accepted for implementation
- **Production approval:** blocked pending independent security review
- **Date:** 2026-08-09
- **Channel version:** 1

## Context

Before M6, TLS protected each WebSocket hop but the relay received application
JSON and base64 audio in plaintext. Cantor needs the relay to route a phone to a
node without learning app identity, pairing proof, prompts, library contents,
job state, errors, or audio.

The trusted endpoints are the Android app and the selected node. The relay and
network may observe, modify, replay, reorder, truncate, delay, or drop traffic.
Linux root on the node and a compromised phone are outside the E2E boundary.
Traffic timing, direction, size, room identity, IP addresses, and availability
remain visible.

## Decision

Use the standard Noise protocol name
`Noise_NK_25519_ChaChaPoly_SHA256` with a fresh handshake on every WebSocket
attachment.

- The app is the NK initiator and already knows the node's static X25519 public
  key through a descriptor signed by the QR-pinned Ed25519 node identity.
- The node is the responder and proves possession of its X25519 static secret
  before the app sends its Ed25519 identity or one-time pairing proof.
- The app's existing Ed25519 hello/challenge authentication remains the
  application identity layer, but runs entirely inside Noise transport mode.
- No custom Ed25519-to-X25519 conversion is used. The transport secret is
  independent, 32 random bytes, stored as `noise.key` with mode `0600`.
- A transport descriptor change fails closed. Version 1 rotation is an explicit
  remove-and-re-pair operation; there is no silent rollover or rollback.
- No resumption or 0-RTT is supported. Reconnect means a fresh handshake.
- There is no plaintext fallback. Text tunnel frames are accepted only for the
  pre-transport negotiation described below.

Implementations are Rust `snow` 0.10.0 on the node and the upstream Java
`noise-java` reference sources pinned at commit
`49377b6dfc6a1e75740bce2318118291a57c0d6e` on Android. `x25519-dalek` 2.0.1
derives the node public transport key. The vendored Java source is unmodified
and retains its MIT license.

## Identity binding

The descriptor is:

```text
schema                 u8 = 1
node_ed25519           canonical base58 Ed25519 public key
transport_suite        "noise-nk-25519-chachapoly-sha256-v1"
transport_key_id       lowercase hex SHA-256(transport_x25519 bytes)
transport_x25519       canonical unpadded base64url, 32 bytes
signature_ed25519      canonical unpadded base64url, 64 bytes
```

Its signature preimage is the exact byte concatenation:

```text
"cantor-transport-binding-v1" || node_ed25519[32] || transport_x25519[32]
```

The app checks schema, suite, canonical encodings, exact lengths, key ID,
Ed25519 signature, and equality with its pinned node identity before creating a
Noise initiator.

The 123-byte Noise prologue is:

```text
"cantor-secure-channel-v1"
|| application_protocol_version:u16be   # 2
|| secure_carrier_version:u8            # 1
|| node_ed25519[32]
|| transport_x25519[32]
|| node_generated_channel_nonce[32]
```

This binds each handshake to Cantor, the application/carrier versions, both
node identities, and fresh node-generated session material.

## State machine

```text
client text  secure.init(v=1, id, suite)
node text    secure.offer(v=1, id, descriptor, channel_nonce)
client text  secure.handshake(v=1, id, step=1, Noise message)
node text    secure.handshake(v=1, id, step=2, Noise message)
             ── Noise transport mode begins ──
client bin   encrypted app hello / optional pairing proof
node bin     encrypted challenge
client bin   encrypted Ed25519 signature
node bin     encrypted welcome
both bin     encrypted control and artifact records only
```

Unexpected state transitions, malformed descriptors, handshake errors,
authenticated-decryption failures, replay/reordering, limit exhaustion, or
plaintext after transport establishment destroy the session and close or strand
that transport. Application payloads are never dispatched before Noise succeeds.

## Binary formats

All integers are unsigned big-endian. Parsers require exact lengths and reject
trailing data.

Relay carrier:

```text
client -> relay: v:u8 | kind=1:u8 | cipher_len:u32 | ciphertext
relay -> node:   v:u8 | kind=1:u8 | sid_len:u16 | sid:utf8 |
                 cipher_len:u32 | ciphertext
node -> relay:   same node-facing form
relay -> client: same client-facing form
```

The carrier limits ciphertext to 96 KiB and the relay session ID to 64 UTF-8
bytes. The relay adds/removes only the attachment-derived session ID; it does
not parse the ciphertext.

Each encrypted Noise plaintext is a fragment record:

```text
channel_v:u8 | kind=1:u8 | message_id:u32 | fragment_index:u16 |
fragment_count:u16 | total_len:u32 | fragment_len:u32 | bytes
```

Fragments are strictly consecutive. One logical message is at most 1 MiB; one
Noise plaintext is at most 60 KiB. The 18-byte fragment header leaves 61,422
bytes of content per record. Noise adds its 16-byte authentication tag.

Reassembled inner messages are:

```text
control:  channel_v:u8 | kind=1:u8 | json_len:u32 | UTF-8 JSON

artifact: channel_v:u8 | kind=2:u8 |
          request_id_len:u16 | request_id:utf8 |
          transfer_id_len:u16 | transfer_id:utf8 |
          offset:u64 | data_len:u32 | raw artifact bytes
```

Artifact bytes become base64 only after decryption on the phone because the M5
native storage API still accepts that local representation. The relay never sees
that copy.

## Nonce and key limits

Noise owns the ChaChaPoly nonce counters and directional cipher states. Cantor
does not derive nonces from time, IDs, offsets, or random per-message values.
Version 1 closes and reconnects before either direction reaches 1,000,000 Noise
records or 1 GiB of ciphertext. It reconnects rather than rekeying because the
pinned Java API does not expose a compatible rekey operation.

The additional monotonic logical message and fragment indexes make duplicates,
gaps, overlaps, and cross-message fragment substitution fail before application
dispatch. Cipher state already makes replay, reordering, bit flips, truncation,
and cross-session ciphertext fail authentication/state validation.

## Consequences and explicit limits

- The relay is payload-blind but still sees traffic metadata and can deny
  service. Version 1 adds no padding, batching, or anonymity layer.
- Node files and Android caches remain plaintext at rest under their existing OS
  permissions. E2E transport does not protect a compromised endpoint.
- Android is the only current client target. iOS needs its own implementation and
  device gate before an iOS claim.
- React Native's synchronous bridge copies bounded base64 strings between
  JavaScript and native code. Cipher keys/counters stay native, but transient
  plaintext/ciphertext copies still exist in endpoint memory.
- The Java dependency is a pinned older reference implementation. Neither that
  dependency nor Cantor's cross-language state machine has been independently
  audited for this use.
- Handshake admission rate limiting, hosted-Cloudflare capture, release/rollback
  operations, and formal known-answer fixture review remain production-review
  items. The node does cap live client sessions and all frame allocations.

## Verification completed

- Rust unit tests cover stable owner-only key creation, descriptor signature,
  cross-session rejection, replay failure, fragmentation, and key limits.
- TypeScript tests cover descriptor/prologue equivalence, pairing tamper,
  strict carrier/inner parsing, no identity before Noise, binary-only application
  traffic, and plaintext downgrade rejection.
- Relay tests prove bounded opaque binary routing and malformed-frame rejection.
- A physical Android phone completed Java-to-Rust Noise interoperability through
  the real relay code, encrypted authentication, encrypted control traffic, and
  a 287,339-byte raw artifact download whose SHA-256 was
  `0f2208d83f5be5845f54fd41f096919e2da53ad4f9aede1f112a2114a34761c4`.
- Offline playback, pin retention, reconnect, and node transport-key stability
  across graceful node restart passed. No generation engine was invoked.

## Production decision

Implementation completion is not security approval. Before production release,
an independent reviewer must examine this ADR, the pinned dependencies, both
state machines, key creation/erasure, capture and adversarial results, and the
rollout/rollback path. Blocking findings must be resolved or explicitly accepted
and recorded here.

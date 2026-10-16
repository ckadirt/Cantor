# Hacking the Cantor protocol

Four implementations speak Cantor's wire: the Rust node, the React Native app,
the Cloudflare relay, and the Android native secure module. A fifth, the
integration client under `node/scripts/`, exists so a human can drive the same
path from a terminal.

This guide is about changing what goes over the wire without breaking the three
implementations you are not currently editing.

## The layers, from outside in

```text
WebSocket to the relay
  relay v1 text frames        {v, t, sid?, payload}      relay/src/frames.ts
  secure carrier (binary)     version | kind | length    node/src/relay/carrier.rs
    Noise NK ciphertext                                  node/src/secure.rs
      fragment record         header | slice             node/src/secure/fragment.rs
        logical inner frame   control JSON | artifact    node/src/secure/inner.rs
          application v2      {v, t, id, …}              node/crates/cantor-proto
```

Each layer has its own version byte and its own name, even where every deployed
value is currently `1`. That is deliberate: bumping the fragment format must not
force a new negotiation version.

## One manifest, four generated files

`protocol/transport/v1/spec.json` names every deployed transport constant
exactly once — layer versions, the Noise suite, the two domain labels, kind
identifiers, header sizes, key sizes, and bounds.

`protocol/transport/generate.mjs` validates that manifest and renders:

| Output | Consumed by |
| --- | --- |
| `node/crates/cantor-proto/src/generated/transport.rs` | application protocol version and chunk size |
| `node/crates/cantor-node/src/transport/generated.rs` | `crate::transport::*` in the node |
| `cantor/src/core/transport/generated.ts` | `core/transport` in the app |
| `relay/src/generated/transport.ts` | `relay/src/frames.ts` |
| `cantor/android/.../transport/GeneratedTransport.kt` | `CantorSecureModule` and friends |

The integration client does not get a sixth copy: `node/scripts/lib/manifest.mjs`
reads `spec.json` directly.

```sh
node protocol/transport/generate.mjs          # rewrite the generated files
node protocol/transport/generate.mjs --check  # fail if any of them drifted
```

CI runs `--check`, the release workflow runs it before building a binary, and
the relay deploy runs it before publishing.

**Generated files hold constants only.** Parsers and state machines stay
handwritten and idiomatic in each language, because a generated parser is the
one thing nobody reviews.

## The shared fixture corpus

`protocol/transport/v1/fixtures/` holds byte-exact vectors for the carrier,
descriptor signature preimage, prologue, inner records, fragments, and
negotiation JSON. `manifest.json` lists the files and states the rule: every
valid binary vector should be asserted by at least two independent
implementations.

Who consumes what today:

| Fixture | Rust | App | Relay | Kotlin | CLI |
| --- | --- | --- | --- | --- | --- |
| `carrier.json` | `relay/carrier.rs` | `security/__tests__/carrier.test.ts` | `relay/test/frames.fixtures.test.ts` | — | `scripts/lib/transport.test.mjs` |
| `fragment.json` | `secure/fragment.rs` | — | — | `FragmentCodecTest` | `transport.test.mjs` |
| `inner.json` | `secure/inner.rs` | `security/__tests__/inner.test.ts` | — | — | `transport.test.mjs` |
| `identity.json` | `secure.rs` | `security/__tests__/descriptor.test.ts` | — | `TransportFixtureTest` | `transport.test.mjs` |
| `negotiation.json` | `secure.rs`, `secure/negotiation.rs` | `secureTunnel.test.ts` | — | — | — |

A malformed vector may record *different* rejection layers per language; that is
what the `rust` and `kotlin` keys inside a vector mean. One such difference is
already recorded as a deviation: a zero-length first fragment is retained as an
incomplete assembly in Rust and rejected immediately in Kotlin. Neither encoder
emits one.

## Recipes

### Change a bound or a header size

1. Edit `protocol/transport/v1/spec.json`.
2. Run `node protocol/transport/generate.mjs`.
3. Run `node --test protocol/transport/generate.test.mjs` — the manifest
   validator enforces the arithmetic (a header must equal the sum of its
   fields, a ciphertext bound must hold a maximum plaintext plus its tag).
4. Run every implementation's tests. A bound that no longer matches a fixture
   is a protocol change, not a refactor: bump the owning layer version.

### Add an application message

1. Add the variant to `ClientMessage`/`NodeMessage` in
   `node/crates/cantor-proto/src/lib.rs`. `cargo test --workspace` regenerates
   the TypeScript definitions under `protocol/` via `ts-rs`; commit them.
2. Route it in `node/crates/cantor-node/src/application/router.rs` and decide
   it in the owning service (`jobs.rs`, `songs.rs`, `auth.rs`, `transfers.rs`).
3. If it should wake a worker, stop a job, publish an event, or refresh node
   info, declare that in `application/outcome.rs`. Do not infer effects from
   response variants in an adapter.
4. Add the app-side decoder in `cantor/src/backends/applicationResponses.ts`
   and register the request in `RequestRegistry` so its decoder, resolver, and
   timeout are one atomic registration.
5. The relay needs no change: it forwards opaque payloads.

### Add a new transport layer version

1. Bump only the version the format actually changed in.
2. Keep the old acceptance path until every deployed peer has moved. The node
   is the only participant that can refuse, and it must refuse closed.
3. Add fixtures for both versions before changing a decoder.

### Change the relay text protocol

`relay/src/frames.ts` defines the frame shapes; `relay/src/room.ts` is the
Durable Object. Nodes and apps ignore frame types and payload versions they do
not recognise, so an additive frame is safe. A change to an existing frame is
not, and must bump `versions.relay`.

## Traps

- **Key order.** The node builds negotiation JSON through `serde_json::Value`,
  whose object is a `BTreeMap`, so the bytes come out alphabetically ordered.
  Serializing a struct straight to a string would reorder keys. Go through
  `serde_json::to_value` as `secure/negotiation.rs` does.
- **The 256-byte negotiation field bound.** It applies to `data` as well as
  `id`, so a Noise handshake message must stay far below the 4 KiB message
  bound. It is named `MAX_NEGOTIATION_FIELD_BYTES` and tested.
- **Node authentication comes first.** The client proves the node's identity via
  the signed descriptor before it sends its own key or pairing proof. Never
  reorder that.
- **There is no plaintext fallback.** If the node sends application text after
  the channel opens, every client treats it as an attack, not a downgrade.
- **`ts-rs` bindings are generated by `cargo test`.** A protocol type change
  with no committed `protocol/*.ts` update fails CI's dirty-tree check.

## Review checklist

- [ ] Did the manifest change, and is `--check` green?
- [ ] Did the right layer version move — and only that one?
- [ ] Is there a fixture for the new bytes, asserted in at least two languages?
- [ ] Does a malformed input still fail closed in every implementation?
- [ ] Do the node, app, relay, Kotlin, and `node/scripts` all still build?
- [ ] Is the change additive for already-deployed peers, or is the refusal
      deliberate and documented?

## Open names: the app reads a newer node forward

The node writes only names it knows: its serde enums are closed, and the
malformed fixtures prove it refuses anything else. The app reads them open. A
job's `stage`, `state`, `progress.unit` and `error.code`, and a model's or
capability's `stages`, are kept by name when they are well-formed identifiers
(`isWireName`: `^[a-z][a-z0-9_]{0,31}$`) even if this build has never seen
them (`core/protocol/types.ts`, `StageName`):

- an unknown stage is drawn as the working stage, ∞ (`WORKING_SYMBOL` in
  `jobs/marks.ts`), labelled "Working", and keeps its slot on a declared arc;
- an unknown state is live work (`running`), or `failed` when the job carries
  an error;
- an unknown unit keeps its counts; an unknown code reads as `internal`.

A malformed value (a number, an empty or capitalised name) still fails closed.
So a node may add a stage, state, unit or code without an app release first:
older apps show it as work rather than dropping the job. Giving it its own
symbol and words is then an app change. `malformed/invalid-state.json` records
the split: refused by the node's types, read as `running` by the app.

`JobView.plan` optionally declares this job's ordered stages and each stage's
progress unit; it describes the job's own arc, including an audio act's encode
entrance, rather than the model's text pipeline. `JobView.client_request_id`
optionally echoes `job.create.client_request_id` so the submitting client can
match an acceptance it missed. Every job response and event is scoped to that principal.
Older nodes omit both fields, and jobs stored before plans existed have no plan.

A new job's id is `uuid_v8(sha256(b"cantor.job.v1\0" || principal_id_bytes ||
client_request_id_utf8))`: `cantor_proto::derive_job_id` takes the principal's
32 bytes (SHA-256 of the client's public key) and the exact request bytes, keeps
the digest's first 16 bytes, and sets the UUIDv8 version and RFC 9562 variant
bits. This gives the app one key from Make through the job to its song. A client
may predict an id only when `NodeFeatures.derived_job_ids` is true; missing means
false, and existing jobs retain their stored ids on resubmission. The shared
`protocol/fixtures/v2/derived-job-id.json` vectors include UTF-8 and are asserted
in Rust; the app must assert the same file in TypeScript.

## Model lyric capabilities

`ModelView.lyrics` is an optional additive declaration (`can_generate`,
`requires_lyrics`, optional `instrumental_text` and `writer_label`). Catalog
variants own the values; pulling saves them with installed metadata, and the
node advertises them through NodeInfo. The app prefers these declarations and
uses its legacy ACE adapter only when they are absent. Both old and capability
bearing NodeInfo fixtures must continue to decode. Extra model controls use
`parameters` and request `extensions`; caption, lyrics and duration remain
shared core fields.

`SongDetail.written_lyrics` (optional, additive) carries the words a model
wrote when the request gave none. The node reads them from the planned request
JSON's `lyrics` as diffusion begins and keeps them in `jobs.written_lyrics`
(migration 7); songs made earlier have none. The app's `facts/recipeWords.ts`
is the one reader: given words win, and a version or hum is never "the model's".

## Audio capabilities and uploads

`ModelView.capabilities` (lenient: an unknown kind is dropped, never fatal),
`NodeInfo.installable`, `NodeFeatures.audio_sources` / `uploads`, and
`NodeLimits.max_upload_bytes` / `max_source_seconds` are additive. A client
must not send `GenerationRequest.audio` unless `audio_sources` is true: an
older node ignores the field and would render text-to-music instead.
`AudioAct` is strict, so an act a node cannot name fails the request rather
than running another. Uploads (`upload.open` → `upload.ready`, `upload.chunk`
→ `upload.ack`, `upload.commit` → `upload.committed`) carry base64 slices of at
most `UPLOAD_CHUNK_BYTES`, a manifest bound. Fixtures:
`node-info-capabilities.json`, `job-create-audio.json`, `job-create-tune.json`,
`upload-*.json`, asserted in Rust and the app.

# Cantor architecture, and where a change belongs

Three programs and one shared contract. The app never talks to a node directly;
the relay never understands what it forwards; the node owns all durable truth.

```text
┌─────────────────────────────┐        ┌──────────────────────┐
│ React Native app (cantor/)  │        │ Relay (relay/)       │
│                             │        │ Cloudflare Worker    │
│ screens / features          │        │ one NodeRoom per     │
│   ↓                         │        │ node public key      │
│ useBackendRuntime           │        │                      │
│   ↓                         │  wss   │ proves ownership     │
│ BackendConnection ──────────┼───────▶│ reports presence     │
│   ↓                         │        │ splices opaque bytes │
│ SecureTunnel + native Noise │        └──────────┬───────────┘
│   ↓                         │                   │ wss
│ repositories, audio store   │                   ▼
└─────────────────────────────┘        ┌──────────────────────┐
                                       │ Node (node/)         │
                                       │ relay / control / CLI│
                                       │   ↓                  │
                                       │ application services │
                                       │   ↓                  │
                                       │ Library façade       │
                                       │   ↓                  │
                                       │ SQLite, filesystem,  │
                                       │ engine, codecs       │
                                       └──────────────────────┘

        protocol/transport/v1/spec.json  +  protocol/transport/v1/fixtures/
        one manifest generates constants for all four implementations
```

The encrypted path, from the app's point of view:

```text
app request  →  control inner frame  →  fragment record(s)  →  Noise NK
             →  client carrier  →  relay  →  node carrier  →  node
```

Nothing between the app and the node can read a request. The relay adds and
strips only the session id.

## Where does this change belong?

| If you are changing… | Go to | Guide |
| --- | --- | --- |
| what a screen shows or how it is laid out | `cantor/src/screens/`, `cantor/src/features/` | [`hacking-app.md`](hacking-app.md) |
| which state a screen owns | a feature controller, or `cantor/src/runtime/useBackendRuntime.ts` | `hacking-app.md` |
| how the app persists something | the owning repository under `cantor/src/{backends,library,jobs,audio}` | `hacking-app.md` |
| how the app talks to a node | `cantor/src/backends/connection.ts` and its state machines | `hacking-app.md` |
| motion, symbols, or Skia | `cantor/src/motion/` and `cantor/AGENTS.md` | `cantor/src/motion/README.md` |
| Android native audio or Noise | `cantor/android/app/src/main/java/com/cantor/app/` | `hacking-app.md` |
| a new application message | `cantor-proto`, then node `application/`, then app decoders | [`hacking-protocol.md`](hacking-protocol.md) |
| a transport bound, version, or label | `protocol/transport/v1/spec.json` | `hacking-protocol.md` |
| byte-level framing | the owning codec in each language, plus a fixture | `hacking-protocol.md` |
| what a node decides | `node/crates/cantor-node/src/application/` | [`hacking-node.md`](hacking-node.md) |
| what a node stores | `node/crates/cantor-node/src/library/` behind the `Library` façade | `hacking-node.md` |
| generation, delivery, or scheduling | `node/crates/cantor-node/src/{generation,delivery,jobs}/` | `hacking-node.md` |
| a CLI command | `node/crates/cantor-node/src/control/commands/` | `hacking-node.md` |
| presence, claims, or fanout | `relay/src/room.ts` | [`hacking-relay.md`](hacking-relay.md) |
| the integration client | `node/scripts/` | `hacking-protocol.md` |

## The three rules that decide most arguments

1. **Adapters translate, services decide, repositories persist.** If a relay
   handler or a React component is making a product decision, it is in the
   wrong layer.
2. **One authority per fact.** A transport bound lives in the manifest. A
   database transaction lives in `Library`. A storage key lives in its
   repository. Copying it somewhere else is how implementations drift.
3. **Extract first, redesign later.** Move code with its behavior intact, prove
   equivalence with tests, then change the behavior in a separate reviewed
   commit.

## Full verification matrix

```sh
# transport contract
node protocol/transport/generate.mjs --check
node --test protocol/transport/generate.test.mjs
node --test node/scripts/lib/transport.test.mjs

# node
cd node && cargo fmt --all -- --check \
  && cargo clippy --workspace --all-targets --all-features -- -D warnings \
  && cargo test --workspace

# app
cd cantor && npx tsc --noEmit && npx eslint . && npx jest
cd cantor/android && ./gradlew app:testDebugUnitTest app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a

# relay
cd relay && npx vitest run && npm run check

# repository
git diff --check
```

# Cantor

Three programs and one shared wire contract.

| Directory | What lives there |
| --- | --- |
| `cantor/` | the React Native app and its Android native modules |
| `node/` | the Rust daemon: library, generation, relay and control adapters, CLI |
| `relay/` | the Cloudflare Worker that splices opaque bytes between them |
| `protocol/` | the transport manifest, shared fixtures, and generated wire types |
| `docs/` | milestones, the framework refactor record, and the contributor guides |

## Read before changing code

- [`docs/refactor/architecture.md`](docs/refactor/architecture.md) — the layer
  map, a "where does this change belong?" table, and the verification matrix.
- [`docs/refactor/hacking-app.md`](docs/refactor/hacking-app.md),
  [`hacking-node.md`](docs/refactor/hacking-node.md),
  [`hacking-protocol.md`](docs/refactor/hacking-protocol.md), and
  [`hacking-relay.md`](docs/refactor/hacking-relay.md) — module maps,
  dependency rules, extension recipes, traps, and review checklists.
- [`cantor/AGENTS.md`](cantor/AGENTS.md) — product direction and the motion
  rules. Required before touching motion or Skia code.

The code is the source of truth when a document drifts. Update the document.

## Non-negotiables

- Wire bytes, storage keys, database migrations, file layouts, cryptographic
  construction, error shapes, and recovery policy are compatibility contracts.
- Transport constants come from `protocol/transport/v1/spec.json`. Regenerate;
  never hand-edit a generated file.
- Adapters translate, services decide, repositories persist.
- There is no plaintext application path between an app and a node.

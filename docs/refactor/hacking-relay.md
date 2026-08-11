# Hacking the Cantor relay

The relay is a Cloudflare Worker in `relay/`, backed by one hibernating
`NodeRoom` Durable Object per node public key. It proves node ownership, reports
presence, splices opaque payloads between a node and its attached clients, and
tells the node when a client session detaches.

It is deliberately the least trusted part of the system. It never sees an
application message in the clear and holds no key material.

## What it must never do

- **Never read a payload.** Client and node traffic is a Noise ciphertext inside
  a carrier frame. The relay validates framing and forwards bytes.
- **Never keep durable secrets.** A room claim is proved by signature per
  connection.
- **Never break an already-deployed node.** Every participant ignores frame
  types and payload versions it does not recognise, so additive frames are safe
  and changes to existing frames are not.

## Module map

| Path | Owns |
| --- | --- |
| `src/index.ts` | routing `/v1/room/<pubkey>`, base58 key validation, WebSocket upgrade |
| `src/room.ts` | the Durable Object: claim, presence, session registry, fanout, detach |
| `src/frames.ts` | frame types, carrier encode/parse, attachment parsing |
| `src/generated/transport.ts` | the relay's slice of the shared transport manifest |
| `scripts/smoke.mjs` | hosted check that a deployed relay still answers rooms |
| `scripts/verify-assets.mjs` | the published `install.sh` is a symlink, not a copy |
| `test/` | Vitest suites, including the shared carrier fixtures |

## Contracts shared with the node and the app

**Signed preimages.** Signatures are never taken over a bare nonce, or the two
challenge protocols would be interchangeable.

| Purpose | Signed bytes | Verified in |
| --- | --- | --- |
| Room claim | `"cantor-relay-claim-v1" \|\| room pubkey \|\| nonce` | `src/room.ts` |
| Client auth | `"cantor-node-auth-v1" \|\| node pubkey \|\| client pubkey \|\| nonce` | node `session.rs` |

**Keepalive.** Nodes and apps send the text frame `ping` every 25s and ignore
the `pong`. The Durable Object answers via `setWebSocketAutoResponse` without
waking, so idle rooms stay free while NAT timeouts do not silently kill a
connection that still reports itself online.

**Carrier framing.** The client-facing carrier is `version | kind | u32 length`;
the node-facing carrier adds the session id (`version | kind | u16 sid length |
sid | u32 length`). Both sizes come from
`protocol/transport/v1/spec.json` through `src/generated/transport.ts`. Do not
restate them.

## Recipes

### Add a relay frame

1. Add the type to `src/frames.ts` and, if inbound, a strict parser beside the
   existing ones.
2. Handle it in `src/room.ts`. Additive frames need no version bump because
   every peer skips what it does not know.
3. Add a Vitest case that an old peer ignoring the frame still works.

### Change carrier framing

That is a transport change, not a relay change. Edit the manifest, regenerate,
and update the node, app, Kotlin, and integration client in the same series.
See `hacking-protocol.md`.

### Change presence or detach semantics

Both are observable to every paired node and app. A node relies on
`relay.detached` to drop a session's state, and an app relies on
`relay.presence` to start its secure handshake. Add a test in `test/room.test.ts`
that covers the reconnect path before changing either.

## Tests and deployment

```sh
cd relay
npm ci
npx vitest run
npm run check          # wrangler types, tsc, and the asset check
npm run deploy:dry-run
node scripts/smoke.mjs http://localhost:8787   # against `npm run dev`
```

`deploy-relay.yml` runs the same gates plus the manifest check, deploys, then
proves two things about the live domain: rooms still answer, and the published
`install.sh` matches this commit. Both retry, because a fresh deploy takes a
moment to reach every edge.

## Traps

- **`getByName` keys the Durable Object by node public key.** A malformed key
  must be rejected in `index.ts` before it can create a room.
- **Session ids are UUIDv4 and validated as such.** The node rejects anything
  else; keep the relay's pattern and the node's `ensure_secure_sid` in step.
- **A replaced claim closes the old socket with 1012.** That is how a node that
  restarts reclaims its room; do not change the code silently.
- **The installer asset is a symlink.** `relay/public/install.sh` points at
  `node/install.sh`; replacing it with a copy is exactly the drift
  `verify-assets.mjs` exists to catch.

## Review checklist

- [ ] Can the relay still not read a payload?
- [ ] Does an older node or app survive this change untouched?
- [ ] Are new constants read from the generated module?
- [ ] Is the reconnect and detach path covered by a test?
- [ ] Does the hosted smoke check still describe something a user would feel?

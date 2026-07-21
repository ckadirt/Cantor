# cantor-relay

The relay is a Cloudflare Worker backed by one hibernating `NodeRoom` Durable
Object per node public key. It verifies node ownership, reports node presence,
splices opaque tunnel payloads between a node and its attached clients, and
notifies the node when a relay-assigned client session detaches.

## Cross-implementation contracts

Three details are duplicated across the relay, the Rust node, and the app, and
must be changed in all three at once.

**Signed preimages.** Ed25519 signatures are never taken over a bare nonce.
Both challenge protocols would otherwise be interchangeable, letting a
signature collected in one be replayed as the other.

| Purpose | Signed bytes | Verified by |
| --- | --- | --- |
| Room claim | `"cantor-relay-claim-v1" \|\| room pubkey \|\| nonce` | `src/room.ts` |
| Client auth | `"cantor-node-auth-v1" \|\| node pubkey \|\| client pubkey \|\| nonce` | `cantor-node/src/session.rs` |

The Rust side builds both in `cantor-node/src/signing.rs`; the app builds the
client-auth one in `cantor/src/identity/derive.ts`.

**Keepalive.** Nodes and apps send the text frame `ping` every 25s and ignore
the `pong` reply. The Durable Object answers it via `setWebSocketAutoResponse`
without waking, so idle rooms stay free while carrier NAT timeouts do not
silently break a connection that still reports itself online.

**Unknown frames are skipped, not fatal.** Every participant ignores frame
types and payload versions it does not recognise, so a relay can introduce a
frame without bricking already-deployed nodes and apps.

## Local development

Start the relay:

```sh
npm install
npm run dev
```

Run a node in another terminal:

```sh
cd ../node
cargo run -p cantor-node -- run
```

Copy the public key from the relay terminal's
`GET /v1/room/<node-pubkey>` request log. The node's dedicated pairing output
arrives with the Phase 2 `pair` command.

Then attach the Phase 1 command-line client:

```sh
npm run client -- ws://localhost:8787/v1/room/<node-pubkey>
```

The client prints `presence: online`. Stop the node to see
`presence: offline`; restart it to see `presence: online` again. Lines typed
into the client are wrapped as tunnel payloads. The Phase 1 node intentionally
does not answer those payloads yet; its end-to-end protocol arrives in Phase 2.

## Checks

```sh
npm test
npm run check
npm run deploy:dry-run
```

## Production

`wrangler.jsonc` binds the Worker to the `cantor.ckadirt.xyz` Custom Domain.
After the local checks pass, deploy it with:

```sh
npx wrangler deploy
```

Nodes and apps use `wss://cantor.ckadirt.xyz` as their base relay URL. The
Worker remains the origin for every path on that hostname; Cloudflare creates
and manages the DNS record and certificate declared by the Custom Domain.

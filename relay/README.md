# cantor-relay

The relay is a Cloudflare Worker backed by one hibernating `NodeRoom` Durable
Object per node public key. It verifies node ownership, reports node presence,
and splices opaque tunnel payloads between a node and its attached clients.

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

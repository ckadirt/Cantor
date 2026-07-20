# cantor-node

Phase 0 provides the node identity, configuration, and local relay claim loop.

Start the relay from the repository root in one terminal:

```sh
cd relay
npm install
npm run dev
```

Then run the node in another terminal:

```sh
cd node
cargo run -p cantor-node -- run
```

The first run creates `node.key` and `node.toml` under the platform config
directory (`~/.config/cantor` on Linux). Both files are owner-only, and the key
contains the raw 32-byte Ed25519 secret. The default relay is
`ws://localhost:8787`.

For an isolated first run or a non-default node name:

```sh
cargo run -p cantor-node -- run \
  --config-dir /tmp/cantor-local-node \
  --name cesar-desktop \
  --relay-url ws://localhost:8787
```

The first-run overrides are rejected once `node.toml` exists; edit that file for
later configuration changes. Never copy or commit `node.key`.

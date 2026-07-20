# Implementation notes

## Phase 1 — Presence + splice

Started: 2026-07-20

### Scope

- Complete the relay-level frame vocabulary.
- Verify Ed25519 room claims.
- Broadcast node presence to attached clients.
- Splice opaque tunnel payloads through relay-assigned session IDs.
- Make the most recently authenticated node connection own the room.
- Preserve hibernation-safe per-socket state and automatic ping/pong handling.
- Cover claim, presence, splice, reconnect, and bad-claim behavior in the
  Workers runtime.
- Add a small command-line client for the local presence demo.

### Implementation log

- Confirmed Phase 0 already provides the Worker route, SQLite-backed
  `NodeRoom`, hibernating node sockets, Ed25519 claim verification, and the
  Rust node's local claim loop.
- Confirmed the target protocol keeps application payloads opaque to the relay;
  only the relay envelope and session ID are inspected.
- Added client socket attachments with relay-generated UUID session IDs and
  hibernation-safe `client`/`session:<sid>` tags. The relay uses runtime socket
  discovery rather than an in-memory connection map.
- Added `relay.presence` and `tunnel` envelopes, client-to-node forwarding with
  an injected session ID, node-to-client routing with the session ID removed,
  and non-terminal `node-offline`/`client-offline` errors.
- Completed Ed25519 claim validation with encoding, length, import, and signature
  failures all mapped to `bad-claim`.
- Implemented reconnect-wins by authenticating the newest node, closing any
  authenticated predecessor with code 1012, and preserving truthful online
  presence while the predecessor's close event drains.
- Kept the Hibernation API and application-level automatic `ping`/`pong` pair.
  Per-socket attachments are the only connection state required after eviction.
- Explicitly completes WebSocket close handshakes in `webSocketClose`. Current
  Cloudflare runtimes also auto-reply, and the explicit call is documented as
  safe; it makes local Workerd cleanup deterministic.
- Added the current Workers test stack: `@cloudflare/vitest-pool-workers` 0.18.6
  with Vitest 4.1.10. The test TypeScript project skips third-party declaration
  checking because the pool's bundled declarations conflict with the latest
  standalone Workers declarations; all project and test source remains strictly
  checked.
- Added `relay/scripts/client.mjs` and documented the local demo in
  `relay/README.md`.

### Validation

- `npm test` in `relay/`: 4 tests passed (presence transitions and offline
  behavior, hibernation + ping/pong + bidirectional splice, reconnect-wins, and
  bad Ed25519 claim).
- `npm run check` in `relay/`: generated bindings current; Worker and test
  TypeScript checks passed.
- `npm run deploy:dry-run` in `relay/`: passed with the `ROOMS` Durable Object
  binding recognized.
- `cargo test --workspace` in `node/`: 3 tests passed.
- Live local demo: the command-line client observed `presence: online`, then
  `presence: offline` after stopping the Rust node, then `presence: online`
  after restarting the same identity.
- Physical Android device `6b1f6ba8629c`: `com.cantor.app` remained the focused,
  resumed activity (PID 11180), with no recent fatal Android/React Native errors.
- `git diff --check`: passed.

## Deviations

- None.

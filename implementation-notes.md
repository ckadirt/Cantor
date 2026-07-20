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

- The plan's linked protocol artifact is not accessible from this environment
  (the host returns an authorization challenge), and no copy of its schema is
  present in the repository. Phase 2 therefore uses the smallest versioned
  `NodeInfo` and `JobView` shapes needed by the written plan, without adding
  speculative engine controls.
- The documented pairing URI carries only the node identity and relay address,
  but the node is also required to reject clients outside its allowlist. To
  close that authorization gap conservatively, `cantor-node pair` adds a
  single-use random token to the QR URI. A client proves possession of its key
  during the normal signed handshake and presents that token once; the node
  then atomically adds the verified client key to its allowlist and invalidates
  the token. The relay remains unaware of both the token and the handshake.

## Phase 2 — Protocol + node handshake

Started: 2026-07-20

### Scope

- Add a shared Rust protocol crate and committed generated TypeScript types.
- Complete the end-to-end client/node challenge-response handshake.
- Enforce the client-key allowlist and the single-use pairing enrollment path.
- Return static node capabilities and an empty job status snapshot.
- Add `pair` terminal output and a reconnecting node relay loop.
- Exercise accepted and rejected clients against the local relay.

### Implementation log

- Added the `cantor-proto` workspace crate with the flat versioned
  `hello`/`challenge`/`auth`/`welcome`/`status`/`jobs`/`error` vocabulary,
  minimal `NodeInfo`, and `JobView`. `ts-rs` tests regenerate the committed
  TypeScript definitions under `protocol/`.
- Implemented an independent handshake state machine per relay-assigned
  session. It validates base58 Ed25519 keys, binds `auth` to the request and
  32-byte challenge, verifies the signature, and rejects status requests until
  authentication succeeds.
- Added allowlist enforcement and atomic owner-only config replacement for
  one-time enrollment. Invalid signatures cannot consume a pairing token or
  alter the allowlist.
- Added `cantor-node pair`, terminal Unicode QR output, and a copyable
  percent-encoded pairing URI. `run` accepts only previously paired keys.
- Added static Phase 2 capability data and the empty `jobs` status response;
  engine execution remains deliberately stubbed.
- Reworked the node relay connection into a persistent loop with a 1–30 second
  capped exponential delay and up to 250 ms of operating-system-random jitter.
  A successful claim resets the retry attempt.
- Added `node/scripts/protocol-client.mjs` for the complete handshake/status
  demo and documented pairing, allowlist, and binding generation behavior.

### Validation

- `cargo test --workspace` in `node/`: 15 tests passed, including generated
  TypeScript exports, wire shape, pairing enrollment, rejection, atomic config
  persistence, QR fields, and reconnect-delay bounds.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- Live local relay/client: a new Ed25519 client enrolled with the one-time
  token, received `welcome` with the static `NodeInfo`, requested `status`, and
  received `jobs: []`.
- Repeated live client with the persisted identity and no token: accepted.
- Fresh live client with no token: received application error `rejected` and
  did not enter the allowlist.
- Relay restart demo: the running node observed the disconnect, retried with
  jittered 1/2/4/8/16-second backoff, and reclaimed the same room once the
  local relay returned.
- `git diff --check`: passed.

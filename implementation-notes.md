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

## Phase 3 — App identity + first backend

Started: 2026-07-20

### Scope

- Derive a stable Ed25519 app identity from the onboarding mnemonic and protect
  its secret with Android Keystore.
- Persist paired backend records locally.
- Add QR scanning with a clipboard fallback.
- Implement the app connection lifecycle, signed handshake, reconnect, and
  status refresh.
- Render the paired node's capability card and exercise the flow on the
  physical Android device over the LAN relay.

### Implementation log

- Derived a domain-separated 32-byte Ed25519 secret from the BIP39 seed with
  HKDF-SHA256 (`cantor-identity-v1`), encoded the public key as base58, and
  added challenge signing with Noble's primitives. The temporary BIP39
  seed buffer is cleared after derivation.
- Stored the derived secret with `react-native-keychain` under the app-specific
  service using AES-GCM Keystore storage and a secure-software minimum. App boot
  now loads that identity before deciding whether onboarding is required.
- Added validated AsyncStorage persistence for the exact backend record shape:
  node public key, relay URL, petname, and last known `NodeInfo`.
- Added the Android camera permission, VisionCamera's built-in QR code scanner,
  an explicit camera-permission action, and the planned clipboard fallback.
- Added strict pairing URI validation, including base58 public-key and
  base64url token lengths, safe WebSocket relay normalization, and rejection of
  custom-scheme lookalikes.
- Implemented the app relay lifecycle (`disconnected`, `connecting`,
  `attached`, `handshaking`, `ready`), node-key verification, signed challenge
  response, one-time enrollment, status request, validated capability/job
  parsing, and jittered reconnect capped at 30 seconds.
- Added the Backends screen with persisted capability facts, live connection
  labels, zero-job/load status, and a green ready state. Added native-module
  Jest mocks plus identity and pairing parser coverage.

### Validation

- `npm test -- --runInBand` in `cantor/`: 118 tests passed across 7 suites.
- `npx tsc --noEmit` in `cantor/`: passed.
- `npm run lint` in `cantor/`: zero errors; the single inline-style warning in
  `src/onboarding/panels/kit.tsx` predates Phase 3.
- `./gradlew app:assembleDebug` in `cantor/android/`: passed, including native
  Keychain, AsyncStorage, and VisionCamera compilation with QR scanning enabled.
- Installed the debug APK on physical Android device `6b1f6ba8629c`. Completed
  onboarding once, then restarted the app and confirmed it opened directly to
  Backends with the same app key (`AaEmzBWq…bgoZpE`).
- Granted camera access through the in-app action and confirmed a live rear
  camera preview and QR detection on the device.
- Scanned the live LAN pairing QR. The node authenticated and persisted the app
  key; the app reached `READY` and rendered `studio-linux`, `linux-x86_64`,
  `ace-step-1.5-stub`, `ace-step-1.5`, advertised limits, zero load, and zero
  jobs.
- Stopped the node and observed `NODE OFFLINE` while the last capability data
  remained visible; restarted it without a pairing token and observed an
  automatic return to `READY`.
- Force-stopped and relaunched the app after pairing. The stored identity and
  backend loaded without onboarding and automatically reconnected to `READY`.
- Recent device logs contained no fatal Android or React Native errors.
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
- Hermes on the physical Android device does not expose custom `cantor://`
  hosts or `ws://` URLs consistently through `URL`. Phase 3 therefore validates
  both prefixes explicitly, parses only their remaining standard components
  through HTTP(S) sentinel URLs, and reconstructs the WebSocket URL. Lookalike
  schemes and hosts are rejected before query parsing.
- Requesting camera permission as soon as the pairing modal mounted raced the
  MIUI activity lifecycle and returned `NO_ACTIVITY`. Phase 3 conservatively
  requests permission only after the user presses `Allow camera`; the native
  permission dialog and camera preview were verified on the device.

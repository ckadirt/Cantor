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

## Phase 4 — Deploy + real-world test

Started: 2026-07-20

### Scope

- Deploy the tested relay and Durable Object migration to Cloudflare.
- Attach the relay to `cantor.ckadirt.xyz` as a Worker Custom Domain.
- Add a Linux node installer stub covering the binary, private config, and a
  systemd service.
- Validate the production `wss://` path with the node behind the home router and
  the physical phone on LTE, with no inbound port forwarding.

### Implementation log

- Confirmed Wrangler 4.112.0 is installed and authenticated with Worker,
  Durable Object route, certificate, and zone access.
- Confirmed `relay/wrangler.jsonc` already declares the current compatibility
  date, SQLite `NodeRoom` migration, observability, and the exact
  `cantor.ckadirt.xyz` Custom Domain. The hostname has no pre-existing DNS
  record, so Wrangler can create the originless Custom Domain record and
  certificate without replacing user DNS.
- Deployed Worker version `9e11285c-54ed-45ed-aa0a-31872e12b5b5`; the Custom
  Domain now resolves on public DNS and serves the expected Worker responses
  over a valid TLS certificate.
- Added the non-root Linux installer stub with checksum-verified release
  downloads, owner-only config, symlink/unmanaged-unit refusal, and a hardened
  per-user systemd service that remains stopped until pairing is complete.
- The first production `wss://` attempt exposed that `tokio-tungstenite` 0.30's
  Rustls feature does not select a process crypto provider. Added an explicit
  Ring provider installation at process startup so secure WebSockets cannot
  reach Rustls's ambiguous-provider panic.
- Paired the existing physical app with the production relay. The deployed
  path reached `READY`, reported `NODE OFFLINE` when the production-connected
  node stopped, and returned automatically to `READY` when normal node run mode
  restarted.
- Cold-launched the app after restoring the phone's original DNS settings. Its
  persisted identity and production backend reconnected to `READY` without
  onboarding or another pairing scan.
- A final installer test found that line-oriented `grep` does not treat an
  embedded newline as a matched control character. Added an explicit newline
  guard before the general control-character check.
- Phase 4 implementation is complete, subject to the documented no-SIM
  cross-network acceptance limitation.

### Validation

- `npm test` in `relay/`: 4 tests passed.
- `npm run check`, `npm run deploy:dry-run`, and
  `npx wrangler check startup` in `relay/`: passed.
- Production deployment: Worker version
  `9e11285c-54ed-45ed-aa0a-31872e12b5b5` is attached to
  `cantor.ckadirt.xyz`; Cloudflare and Google public resolvers return the
  Custom Domain addresses, HTTPS presents a valid certificate, `/` returns the
  expected JSON 404, and a room route without an upgrade returns the expected
  JSON 426.
- `cargo test --workspace` in `node/`: 16 tests passed, including explicit TLS
  provider installation.
- `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo build --workspace --release` in `node/`: passed.
- Installer: shell syntax, local-binary installation, managed reinstall with
  config preservation, owner-only config modes, executable/service modes,
  installed binary startup, `systemd-analyze --user verify`, newline/control
  rejection, symlink refusal, and unmanaged-unit refusal passed. ShellCheck is
  not installed in this environment.
- Physical Android device `6b1f6ba8629c`: paired through
  `wss://cantor.ckadirt.xyz` and reached `READY`; stopping the node produced
  `NODE OFFLINE`; restarting it in normal `run` mode restored `READY`; a cold
  app relaunch under the phone's restored default DNS settings also reached
  `READY`.
- `npm test -- --runInBand` in `cantor/`: 118 tests passed across 7 suites.
- `npx tsc --noEmit` in `cantor/`: passed.
- `npm run lint` in `cantor/`: zero errors and the same pre-existing inline
  style warning in `src/onboarding/panels/kit.tsx`.
- `git diff --check`: passed.

## Post-Phase 4 — High-priority hardening

Started: 2026-07-20

### Scope

- Keep the one-time pairing secret out of relay-visible application frames.
- Reclaim per-client node handshake state on disconnect and cap retained state.
- Prevent transient or permanent secure-storage read failures from opening the
  identity-creation path.
- Leave generation-specific protocol and transport work for the later
  generation phase requested by the user.

### Implementation log

- Replaced the plaintext `pair_token` hello field with `pair_proof`, computed as
  HMAC-SHA256 over a domain separator plus the raw node and client public keys.
  The app and command-line client derive the proof locally from the QR token;
  the node verifies it in constant time and still consumes the token only after
  a valid Ed25519 challenge signature and atomic allowlist persistence.
- Added one cross-language golden proof vector to the Rust and TypeScript test
  suites so encoding, domain separation, and key order cannot silently drift.
- Added the relay-only `relay.detached` frame. A client close/error notifies the
  currently authenticated node, which idempotently removes that session's
  handshake/authentication state.
- Added a hard ceiling of 1,024 simultaneous client sessions per node relay
  connection. Existing sessions continue at the ceiling; a new session gets a
  versioned `too-many-sessions` application error without allocating state.
- Changed app identity boot failures to a dedicated `IDENTITY LOCKED` screen
  with an explicit retry action. Onboarding is never rendered after a Keychain
  read error, so the stable identity cannot be overwritten through that error
  path.
- Updated the node and relay operator documentation for the proof and detach
  behavior. The QR format remains unchanged and the raw one-time token remains
  local to the QR holder and node process.

### Validation

- `cargo test --workspace` in `node/`: 18 tests passed, including pairing-proof
  binding and session-limit behavior; generated TypeScript bindings are current.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo build --workspace --release` in `node/`: passed.
- `npm test` in `relay/`: 5 tests passed, including detach notification.
- `npm test -- --runInBand` in `cantor/`: 120 tests passed across 7 suites,
  including pairing proof and non-destructive identity retry coverage.
- `npm run check` in `relay/`, `npx tsc --noEmit` in `cantor/`, and
  `node --check node/scripts/protocol-client.mjs`: passed.
- `npm run deploy:dry-run` and `npx wrangler check startup` in `relay/`:
  passed; no production deployment was performed.
- Reviewed the complete Worker against current Cloudflare Workers and Durable
  Objects guidance plus the latest published Workers type definitions. The
  hibernation attachments, close/error handlers, generated `Env`, current
  compatibility date, SQLite migration, and observability configuration match
  the current APIs and recommendations.
- Live local end-to-end pairing: the command-line client sent the new proof,
  the node persisted its verified Ed25519 key, returned `welcome`, and returned
  `jobs: []`; the relay observed the normal client detach afterward.
- `./gradlew app:assembleDebug` in `cantor/android/`: passed.
- Physical Android device `6b1f6ba8629c`: after wake and cold launch, the app
  loaded the same saved app key directly into Backends with no onboarding or
  fatal React Native/Android errors. The card correctly showed `NODE OFFLINE`
  because no production node process was running. The protected identity was
  not modified to induce the tested failure path.
- `npm run lint` in `cantor/`: zero errors and the same pre-existing inline
  style warning in `src/onboarding/panels/kit.tsx`.
- `git diff --check`: passed.

## Production hardening redeploy + stakeholder packet

Started: 2026-07-20

### Deployment log

- Re-ran the relay's Workers-runtime tests, generated-type checks, Worker and
  test TypeScript checks, and deployment dry run after commit `68ff3b8`.
- Deployed the hardened relay to the existing `cantor.ckadirt.xyz` Custom
  Domain. Cloudflare assigned Worker version
  `db43626e-1ab1-4382-8f4b-85dcc643d861` with a reported 5 ms startup time.
- Confirmed through Wrangler deployment status that the new version receives
  100% of production traffic.
- Confirmed the public HTTPS endpoint returns the expected JSON `404` at `/`
  and JSON `426` for a valid room route without a WebSocket upgrade.
- Connected the updated release node using the existing `studio-linux`
  identity/config and observed `relay.ok`, proving its production room could be
  reclaimed after the deployment. After the user noted the expected offline
  state from that stop, restarted the node and cold-relaunched the app to force
  a fresh relay socket; the physical device returned to `READY`. The node was
  left running at the user's request.

### Stakeholder packet

- The Slack-ready packet combines a current executive/prototype overview, the
  authoritative first-connection plan, the earlier backend protocol and network
  rationale as supporting references, and these complete implementation notes.
- The packet states the source precedence explicitly: the locked final plan is
  authoritative where the earlier guides differ, and generation work remains a
  later phase.
- Rendered the source bundle as one 47-page, approximately 0.8 MB PDF. Verified
  the three-page decision brief visually, checked the first page of every source
  section, and confirmed the merged document remained text-extractable through
  its final paragraphs.

### Validation

- `npm test` in `relay/`: 5 tests passed.
- `npm run check` and `npm run deploy:dry-run` in `relay/`: passed.
- `npx wrangler deployments status`: production is 100% on version
  `db43626e-1ab1-4382-8f4b-85dcc643d861`.
- Production `studio-linux` node claim: passed.
- Physical Android app cold-reconnect through the redeployed relay: `READY`.
- Stakeholder packet page count, visual samples, and full-text extraction:
  passed.

## Deviations

- During Phases 1–4, the plan's linked protocol artifact was inaccessible from
  this environment, so Phase 2 used the smallest versioned `NodeInfo` and
  `JobView` shapes needed by the final written plan. The user later supplied
  local copies of the protocol and network guides at the repository root. The
  final phased implementation plan remains authoritative where they differ;
  the earlier guides now provide referenced detail where it does not conflict.
- The supplied guides describe generation data-plane records and transports,
  but the final plan and the user's explicit sequencing put generation after
  first connection. This hardening pass therefore leaves those additions for
  the generation phase instead of expanding the current protocol speculatively.
- The documented pairing URI carries only the node identity and relay address,
  but the node is also required to reject clients outside its allowlist. To
  close that authorization gap conservatively, `cantor-node pair` adds a
  single-use random token to the QR URI. A client proves possession of its key
  during the normal signed handshake and presents a domain-separated, key-bound
  HMAC proof of the token; the node then atomically adds the verified client key
  to its allowlist and invalidates the token. The relay remains unaware of the
  raw token and cannot reuse the observed proof with a different client key.
- Hermes on the physical Android device does not expose custom `cantor://`
  hosts or `ws://` URLs consistently through `URL`. Phase 3 therefore validates
  both prefixes explicitly, parses only their remaining standard components
  through HTTP(S) sentinel URLs, and reconstructs the WebSocket URL. Lookalike
  schemes and hosts are rejected before query parsing.
- Requesting camera permission as soon as the pairing modal mounted raced the
  MIUI activity lifecycle and returned `NO_ACTIVITY`. Phase 3 conservatively
  requests permission only after the user presses `Allow camera`; the native
  permission dialog and camera preview were verified on the device.
- Phase 4 uses a per-user systemd service instead of a root-owned system unit.
  This keeps installation non-privileged and confines the node identity/config
  to the owning user; the service is intentionally not enabled until the app
  has completed its first pairing.
- The home ISP resolver retained the pre-deploy NXDOMAIN response after public
  resolvers had the new Custom Domain. The initial node activation used an
  unprivileged, process-local hosts overlay pinned to a current Cloudflare edge
  address. The router later returned the public records, and the final phone
  cold-launch passed with its original DNS settings restored; the Linux host's
  stub resolver still held its own stale negative cache during the test.
- The physical phone has no SIM card, so disabling Wi-Fi removes its only
  internet path. The attempted Wi-Fi-off check correctly became disconnected
  but cannot serve as the plan's LTE acceptance test. Conservatively, Phase 4
  verifies both peers using outbound-only production WSS over home Wi-Fi, with
  no inbound port forwarding, and records the literal cross-network/LTE test as
  not run rather than claiming it passed. The phone's Wi-Fi and original
  Private DNS settings were restored afterward.

# Private Library Implementation Notes

## Status

Milestone 0 implementation and its physical-phone hosted-relay exit gate were
completed on 2026-08-07.

## Decisions

- Application protocol v2 is a coordinated pre-release break. Relay carrier
  protocol remains v1 and is represented by a separate constant in clients.
- The authenticated principal is SHA-256 of the canonical 32-byte Ed25519
  public key. The app does not receive or authorize with the principal ID.
- The M0 session context contains only established facts: relay session ID,
  principal ID, and canonical client public key. Device and role fields wait
  until their policies exist.
- Job revisions are positive, per-job, monotonic integers. Revision 1 is the
  accepted job. Only client-visible persisted changes advance it.
- State is durable lifecycle; stage is current generation work. Progress does
  not duplicate stage and uses non-negative integer units.
- M0 defines pause/resume/cancel capability flags but not their request shapes.
  Their transition semantics belong to M4.
- Runtime validation is performed at the network boundary. Generated
  TypeScript describes trusted values but does not validate WebSocket input.
- Concrete v2 bounds are conservative initial admission limits and are exposed
  by `NodeLimits`; the node remains authoritative.

### Job lifecycle contract

- `queued -> preparing -> running -> finalizing -> completed` is the normal
  path. A running job's generation stage advances `plan -> codes -> diffuse ->
  decode`; stage is not a second lifecycle state.
- `pause_requested`, `paused`, `cancel_requested`, and `recovering` are reserved
  durable lifecycle states. Their command transitions remain unfrozen until M4.
- `completed`, `cancelled`, and `failed` are terminal. A retry is a new attempt,
  not a mutation out of a terminal state.
- Revision 1 represents acceptance. Each client-visible persisted transition
  increments the revision exactly once; display timestamps never decide order.
- Progress is non-negative integral work. If `total` is present it is positive
  and `completed <= total`.

## Implementation Log

- Began by auditing the existing v1 Rust protocol, node session dispatch,
  installed-model records, React Native boundary parsers, relay carrier, CI,
  and the manual protocol client.

## Deviations

- The milestone draft proposes reserving `device_id` and `role` in the session
  context. They are omitted because the current pairing store has no honest
  device or role semantics; adding placeholders would create accidental policy.
- The draft permits defining pause/resume/cancel early. M0 only advertises them
  as unavailable features because M4 has not frozen checkpoint transitions.
- The draft asks for a Rust/TypeScript principal derivation fixture if the app
  needs the value. The app has no such need in M0, so the canonical derivation
  vector is tested in Rust only.
- The draft recommends model display labels and input capabilities in
  `NodeInfo`. Existing installed records only persist selector, family, and
  engine. M0 exposes only those honest fields instead of fabricating metadata;
  catalog-backed display/capability fields can be added when installation
  persists them deliberately.

## Verification

- `cargo fmt --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `cargo test --workspace`: 82 tests passed.
- `npx tsc --noEmit` in `cantor/`: passed.
- `npx jest --runInBand` in `cantor/`: 137 tests passed.
- `npx eslint .` in `cantor/`: passed with one pre-existing inline-style
  warning in `src/onboarding/panels/kit.tsx`.
- `npx vitest run` and `npm run check` in `relay/`: 6 tests passed; worker
  types, TypeScript, test TypeScript, and asset verification passed.
- `git diff --check`: passed.
- Physical app/hosted relay gate: passed on Android device `6b1f6ba8629c`
  through `wss://cantor.ckadirt.xyz`. A fresh temporary v2 node was paired from
  the phone, authenticated as the phone's existing Ed25519 identity, reached
  `READY`, rendered structured node limits/load and an empty correlated jobs
  page, and applied an unsolicited `node.info` rename push without reconnecting.
  The temporary backend was then removed from phone storage and the test node
  was stopped.

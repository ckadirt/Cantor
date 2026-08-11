# Cantor framework refactor

This directory is the control center for the behavior-preserving framework
refactor that follows private-library milestones M0–M6.

The product works. This program changes how the code is organized so future
features, screens, transports, backends, and tests can be added through explicit
seams instead of extending accidental monoliths.

## Documents

- [`refactor-plan.md`](refactor-plan.md) — milestones, target architecture,
  ordering, invariants, verification gates, and commit policy.
- [`implementation-notes.md`](implementation-notes.md) — decisions, work log,
  deviations, verification evidence, and milestone status. Update it throughout
  implementation, not retrospectively.
- [`audit-app.md`](audit-app.md) — React Native and Android responsibility audit.
- [`audit-node.md`](audit-node.md) — Rust node responsibility and persistence audit.
- [`audit-protocol-relay.md`](audit-protocol-relay.md) — relay, wire-contract,
  cross-language, CLI, CI, and deployment audit.

## Contributor guides

Start here if you are changing code rather than reading about the refactor.

- [`architecture.md`](architecture.md) — the three programs, the encrypted path,
  a "where does this change belong?" table, and the full verification matrix.
- [`hacking-app.md`](hacking-app.md) — React Native app and Android native code.
- [`hacking-node.md`](hacking-node.md) — the Rust daemon.
- [`hacking-protocol.md`](hacking-protocol.md) — the wire, the transport
  manifest, and the shared fixtures.
- [`hacking-relay.md`](hacking-relay.md) — the Cloudflare Worker.

## Meaning of “framework” here

A framework is not a generic abstraction layer. In Cantor it means:

1. Each responsibility has one obvious home and one authority.
2. Stable façades hide replaceable implementation details.
3. Dependency direction is visible and enforced by imports/modules.
4. State machines are explicit and testable without a full UI or daemon.
5. Persistence and wire formats remain executable contracts.
6. New features have documented extension points and examples.
7. Small files exist because responsibilities are separated—not because code was
   fragmented arbitrarily.

## Non-negotiable rules

- Preserve observable behavior, wire bytes, storage keys, database migrations,
  file layouts, cryptographic construction, error shapes, and recovery policy.
- Extract first. Redesign later under a separately reviewed change.
- Add characterization coverage before moving sensitive or poorly tested logic.
- Keep public façades stable while internals move behind them.
- Do not add a trait/interface unless there is a real consumer, test seam, or
  expected second implementation.
- Do not create catch-all `utils`, `common`, or `helpers` modules. Name modules by
  the concept or policy they own.
- One source of truth does not mean one giant file. It means one authoritative
  model with language-specific adapters or generated constants where required.
- Every milestone ends green and independently revertible.

## Target dependency direction

```text
React Native
  screens/components
        ↓
  feature controllers/hooks
        ↓
  domain services + ports
        ↓
  protocol / repositories / native & network adapters

Rust node
  CLI / Unix control / relay adapters
        ↓
  application router + services
        ↓
  domain types and repository façades
        ↓
  SQLite / filesystem / engine / codec implementations

Cross-language
  canonical protocol specifications + fixtures
        ↓
  generated constants/types where safe
        ↓
  small idiomatic parsers and state machines in each language
```

Transport and platform adapters may depend on the core. The core must not depend
on a screen, WebSocket, React Native bridge, Cloudflare Durable Object, or Unix
control socket.

## How work is performed

- Use milestone branches/commits described in the plan.
- Run the narrow tests during extraction, then the full matrix before commit.
- Inspect `git diff --check` and the staged patch before every commit.
- Use the physical Android phone for milestones that move UI ownership, native
  bridges, connection lifecycle, encrypted transport, or audio behavior.
- Record surprises under **Deviations** in `implementation-notes.md`. Choose the
  conservative behavior-preserving option and keep moving when possible.

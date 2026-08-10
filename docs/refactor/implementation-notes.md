# Framework refactor implementation notes

This is the live engineering record for RF0–RF7. Update it before beginning a
milestone, while decisions are made, and after verification. Do not reconstruct
the reasoning only at the end.

## Program status

- Started: 2026-08-09
- Current milestone: RF0 executable baseline (documentation prerequisite ready)
- Production refactor code: not started
- Last completed product milestone: M6, commit `d3f890d`

## Decisions

- This is a behavior-preserving refactor. Wire formats, persisted formats,
  security construction, error behavior, and user-visible behavior remain fixed.
- Work proceeds through RF0–RF7 in `refactor-plan.md`, with small green commits.
- Existing façades remain stable until their callers have migrated and tests
  prove equivalent behavior.
- Cross-language constants may be generated; security-sensitive parsing and
  state transitions remain explicit and language-local.
- Abstractions require a concrete extension point, volatile implementation, or
  test seam. Line-count reduction alone is not sufficient justification.
- Android is the current app target and physical-device authority.
- The lightest/fastest installed generation configuration is used for necessary
  generation regressions. Model execution is not used for pure refactor loops.
- Subagents may own independent files/workstreams. The primary agent integrates,
  resolves architecture decisions, runs cross-system gates, and commits.

## Baseline evidence

Before the refactor program began:

- M6 commit: `d3f890d M6 encrypt private transport end to end`.
- Rust: 122 tests passed; formatting and strict Clippy passed.
- App: 166 tests passed; TypeScript passed; ESLint had one existing inline-style
  warning in `src/onboarding/panels/kit.tsx` and no errors.
- Relay: 8 tests and the full relay check passed.
- Android `assembleDebug` passed.
- Physical Android completed encrypted authentication, control, raw artifact
  download, digest verification, offline playback, pin survival, and reconnect
  across a stable node transport key. No generation ran during the M6 gate.
- Worktree was clean after M6.

RF0 will rerun and expand this baseline before moving production owners.

## Invariants under watch

### App

- Backend records and cached libraries survive upgrade and malformed sibling
  data according to their current per-store policies.
- Outbox idempotency and cache merge ordering remain stable.
- Current song-draft reset behavior on remote revisions is characterized and
  preserved during extraction. A better dirty-draft conflict policy is separate
  V1 product work, not silently introduced by this refactor.
- Revisions, audio states, and offline controls do not regress.
- React/Skia ownership follows the Flicker Law in `cantor/AGENTS.md`.

### Node

- Completion, artifact indexing, song publication, and revisions retain their
  existing transaction boundaries.
- Durable writes retain permission, symlink, temp, fsync, rename, and directory
  sync semantics.
- Owner isolation and event targeting remain explicit.
- The runtime mutex is never held across await.
- Native generation retains thread affinity and cached-session ownership.

### Transport/security

- Node authentication precedes app identity and pair proof.
- There is no plaintext application fallback.
- Carrier, inner, fragment, descriptor, and prologue bytes remain exact.
- Tamper, replay, reordering, cross-session input, malformed lengths, and key
  changes continue to fail closed.

## Implementation log

### 2026-08-09 — Audit start

- Assigned independent read-only audits for app/Android, Rust node, and
  relay/protocol/cross-language integration.
- Counted responsibility hotspots and inspected current CI/release/deploy gates.
- Defined the framework principles, compatibility contract, RF0–RF7 milestones,
  verification matrix, and commit policy before production code changes.
- Integrated and reviewed all three module audits. The documentation baseline is
  ready to commit independently before RF0 changes tests or production code.

## Deviations

None yet.

When a deviation occurs, record:

```text
Date / milestone:
Plan expectation:
Observed edge case:
Conservative decision:
Behavior/invariant protected:
Follow-up, if any:
```

## Verification log

No new verification run is claimed for the documentation-only audit commit. RF0
will establish a fresh executable baseline before the first code extraction.

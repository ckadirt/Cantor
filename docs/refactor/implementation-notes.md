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

### 2026-08-09 — RF0 started

- Committed the documentation prerequisite as `48bd2c5`.
- RF0 is limited to executable characterization: shared transport fixtures,
  app/audio/runtime tests, node persistence/application tests, and deterministic
  Android compilation. Production owners and observable behavior must not move.
- Assigned non-overlapping RF0 test work to app, node, and protocol subagents.
- The primary agent owns CI integration, fixture review, the full baseline matrix,
  physical-device baseline, staged-patch review, and the RF0 commit.
- Captured the physical baseline on Android device `6b1f6ba8629c`: the app opened
  directly to the paired Library, showed the expected All/Favorites/Offline/Trash
  filters, retained the pinned `M4 recovery drill` and cached
  `final_phone_instrumental_smoke` entries, and exposed the expected playback,
  pin, details, save, favorite, and trash controls. The app key remained present;
  its value is deliberately not recorded here.
- Added an Android CI gate that runs JVM tests and assembles the real debug app
  for `arm64-v8a`. One ABI is sufficient for deterministic Kotlin/native bridge
  compilation here; multi-ABI release packaging remains the release workflow's
  responsibility.
- Added byte-exact transport v1 fixtures for relay carrier framing, descriptor
  signature input, Noise prologue, control/artifact inner records, fragments,
  and negotiation JSON. Independent Rust, TypeScript, relay, and Kotlin tests
  consume the corpus; the Kotlin test drives the production secure module through
  a real Noise NK handshake.
- Added app characterization for the native audio boundary and repository, plus
  MainScreen offline hydration, connection startup, canonical persistence, and
  outbox delivery. Added node characterization for migrations, SQL rollback and
  restart recovery, attempts, checkpoints, delivery, effects, and exact errors.
- RF0 integrated verification passed: Rust formatting, strict Clippy, and 134
  workspace tests; app TypeScript, ESLint, and 190 Jest tests; relay checks and
  13 Vitest tests; two Android secure-module tests and an `arm64-v8a` debug APK
  build; fixture JSON validation; and whitespace checks.
- Reopened the unchanged installed app after the integrated checks. The phone
  remained paired and reproduced the recorded Library state and controls while
  the existing release node remained live. No generation was required for this
  test-only milestone.

### 2026-08-09 — RF1 started

- RF1 is split into independently reviewable seams: app protocol/security/core
  dependency direction, one serialized-store extraction and repository migration,
  then node `PrincipalId` and runtime ownership. Compatibility façades remain in
  place until callers migrate; storage keys, decoder policy, wire bytes, SQL text,
  lock ownership, and event timing are invariants.
- Assigned app core extraction, app serialized storage, and node `PrincipalId`
  to non-overlapping subagent paths. The primary agent owns integration, commits,
  the later node runtime move, and all full-matrix/device checks.
- New abstractions must own existing repeated behavior. RF1 will not add empty
  utility modules, a dependency-injection container, generalized crypto, or new
  persistence policy merely to create a directory structure.

## Deviations

### RF0 — malformed empty fragment timing

- The shared corpus exposed an existing difference for a zero-length first
  fragment in a multi-fragment record: Rust retains it as an incomplete assembly,
  while Kotlin rejects it immediately. Neither production encoder emits an empty
  fragment, so changing either decoder during a baseline milestone would be the
  riskier choice. The fixture records `accept_partial` versus `reject`; a future
  versioned hardening decision may make the policies identical.

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

RF0 passed the complete Rust/app/relay/Android matrix described above. Before and
after device captures matched on Android device `6b1f6ba8629c`; only the clock
changed. The MIUI `uiautomator` command printed its known missing theme-compatibility
file stack trace but still wrote and pulled a valid hierarchy, so it did not alter
the result.

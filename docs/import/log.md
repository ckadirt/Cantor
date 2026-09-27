# Device import — implementation log

The running record of device import. Read [`plan.md`](plan.md) first. Newest
entries at the top of each section. Update it as you go: every finding,
decision, trap and commit.

## Start here (handoff)

State on 2026-09-27: plan written, nothing built. **Next: I0**, the phone
spike. None of it is pushed; Cesar decides when to push.

**How a step is done here** — the field rewrite's routine, unchanged
(`../refactor/field-rewrite-log.md` § "How a step is done here" has the tap
coordinates and details):

1. Read the code the step touches and write down here what it will change,
   before editing. Measure first if a measurement could show the step is not
   worth it.
2. Change the code; match the comment density and voice around it.
3. `cd cantor && npx tsc --noEmit -p . && npx jest && npm run lint` — green,
   no new lint warnings (34 pre-existing, 0 errors). Changed behaviour gets a
   test; a fix gets a test that fails on the old code. Lens goldens change only
   on purpose, regenerated with `-u` and the reason logged.
4. Release build and install (keeps the app's data):
   `cd cantor/android && ./gradlew assembleRelease -q` (run twice if
   `:app:packageRelease` fails), `adb install -r …/app-release.apk`,
   force-stop, start, wait ~10 s.
5. Verify on the Xiaomi (`6b1f6ba8629c`) with screenshots.
6. Measure with `cantor/scripts/perf-sample.sh 15 "label"` when the step is
   about cost.
7. Commit on `main`, short code-only subject, no AI trailer; then a `docs:`
   commit updating this log.
8. Tell Cesar in plain terms what changed and what to look at on the phone.
   Anything outward — his nodes, pushing, his library, **files on his phone** —
   ask first. Import only reads the user's files; it never writes, moves or
   deletes them.

## Where we are

| Step | State |
| --- | --- |
| I0 phone spike | not started |
| I1 native reduction | not started |
| I2 phone database | not started |
| I3 native scanner | not started |
| I4 resolver | not started |
| I5 device source | not started |
| I6 mark and axis | not started |
| I7 import flow | not started |
| I8 300-song check | not started |

## Decisions

- **2026-09-27 — Own plan and log.** Import is a new feature, not part of the
  rewrite; it gets `docs/import/`. The rewrite log's phase 5 points here.
- **2026-09-27 — MediaStore paths, not the document picker.** The player
  opens paths only; the picker would force copies. Pending I0.
- **2026-09-27 — The three design calls** (Cesar: "all yours"): same drawn form
  with an imported cue and the cover only at L2; time axes by arrival plus an
  ALBUM/ARTIST axis; scan everything that passes the filter, then a summary to
  untick. See plan § Decisions.

## Measurements

(none yet)

## Findings

(none yet)

## Traps

(none yet)

## Commits

(none yet)

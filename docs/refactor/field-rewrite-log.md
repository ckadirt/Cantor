# Field rewrite — implementation log

The running record of the pre-alpha rewrite of the Cantor app's field (the
map, shelves, player and everything drawn on the Skia canvas). Written for
whoever picks this up next, including a new chat: read this first, then
[`field-redesign.html`](field-redesign.html) for the design and
[`app-walkthrough.html`](app-walkthrough.html) for how the app worked before.

Newest entries at the top of each section. Update it as you go: every
finding, decision, trap and commit.

## Start here (handoff)

State on 2026-09-26: phases 1–2 done; phase 3 R1–R4 done, R5 shelved, R6 not
started; phase 4 C1, C2, C2b, C3a, C4 done, C3b not started (measure first). None of the
field rewrite is pushed (`git rev-list --count origin/main..main`); Cesar
decides when to push.

**Next:** R6, the lens contract (see "Phase 3 plan" — it has a starting
map). Check "Open questions"
first: two things wait on Cesar.

**How a step is done here** — every step so far followed this, and the
entries below assume it:

1. Read the code the step touches and write down what it will change, in
   this log, before editing. If a measurement could show the step is not
   worth it, measure first (R5 was shelved that way).
2. Change the code; match the comment density and voice around it (long
   "why" comments, knobs as named constants with real units, see
   `cantor/AGENTS.md` § How Cesar prefers to work).
3. `cd cantor && npx tsc --noEmit -p . && npx jest && npm run lint` — all
   green, no new lint warnings (34 pre-existing warnings, 0 errors).
   Behaviour that changed gets a test; a fix gets a test that fails on the
   old code.
4. Build a release and install it (keeps the app's data):
   `cd cantor/android && ./gradlew assembleRelease -q` — the first run often
   fails in `:app:packageRelease`; run it again — then
   `adb install -r app/build/outputs/apk/release/app-release.apk`,
   `adb shell am force-stop com.cantor.app`,
   `adb shell am start -n com.cantor.app/.MainActivity`, wait ~10 s.
5. Verify on the Xiaomi (`6b1f6ba8629c`) with `adb exec-out screencap -p`
   (bursts for motion; see Traps for their limits). Useful taps at L0 on the
   home camera (screenshot first — positions drift after any pan): the dial's
   WEEK `102 1944`, MONTH `233 1944`; ENGINES `540 2196`; a sheet's CLOSE
   `954 297`; the This Week cluster ~`129 678`, and at L1 the first row
   `600 670`, play at L2 `538 1858`. BACK climbs a level (and leaves the app
   at L0). Pinch cannot be synthesised on this phone.
6. Measure cost with `cantor/scripts/perf-sample.sh 15 "label"` when the step
   is about cost; add the row to "Measurements".
7. Commit on `main` (never branch), short code-only subject, no AI
   attribution trailer; then a separate `docs:` commit updating this log
   (the step's entry, "Where we are", "Commits").
8. Tell Cesar in plain terms what changed and what to look at on the phone.
   He is new to React Native: say what a thing does before what it is called.
   Anything outward — starting a generation on his nodes, pushing, touching
   his library (KEEP/REMOVE/Delete) — ask first.

Where the field lives: `cantor/src/features/field/` (`FieldCanvas.tsx` is the
renderer — `NativeFieldContent` draws everything; `useFieldCamera.ts` owns
the camera, gestures and re-cuts), `cantor/src/field/` (pure geometry:
layout, bands, camera, shelf), `cantor/src/lenses/` (circle and seal),
`cantor/src/screens/FieldScreen.tsx` (composition). `docs/refactor/hacking-app.md`
is the module map and rules; `cantor/AGENTS.md` has the Flicker Law and the
motion rules, required before touching motion or Skia code.

## Where we are

| Phase | State |
| --- | --- |
| 1. Measure | **done** — `d76f4ee` |
| 2. Stores | **done** — `53b3488`, `d8f9588`, `1475be9` (field-screen UI stores deferred to phase 4) |
| 3. Renderer | **in progress** — R1 `ecddc22`, R2 `5218cf7`, R3 `82dc931`, R4 `9690ff0` `aa3e5ce` done, R5 shelved, R6 after phase 4; see "Phase 3 plan" |
| 4. Camera events, chrome, UI stores | **in progress** — C1 `b1a72aa`, C2 `c38fc87`, C2b `cd54f40`, C3a `4007b5e`, C4 `ea9657e` done; C3b only if measured; see "Phase 4 plan" |
| 5. Import (device songs) | not started — design in `field-redesign.html` § "Songs, homes and copies" |
| 6. L3 (grain) as a layer | not started; decide after phase 3 |

## Goals (agreed with Cesar, 2026-09-24)

- No flicker by construction, not by patching.
- A cool phone: nothing redraws that did not change; nothing runs with the screen off.
- Thousands of songs (300 imported on day one is realistic).
- Carry what comes next without renderer changes: device import (before
  alpha), a semantic UMAP field and more lenses (tree, …) after alpha.
- Keep what the app already does and looks like. This is an architecture
  rewrite, not a redesign of the product.

## Decisions

- **2026-09-25 — Phase 3 is done in place, step by step, not as a second
  renderer behind a flag.** The native path (`NativeFieldContent`) is already
  the right shape — UI-thread pictures from shared values — and each problem
  measured has a local owner. Rebuilding beside it would mean a week with two
  renderers and no user-visible gain until the switch. Each step below ships
  on its own and is verified on the phone.
- **2026-09-25 — Analyses live in their own AsyncStorage database**
  (`createAsyncStorage('cantor-analysis')`, Room/SQLite in async-storage v3, no
  6 MB cap), keyed by `analysisCacheKey` (node, song, artifact digest,
  resolution), 16-bit quantized, ~6 KB per song. New keys only; no existing
  storage contract changed.
- **2026-09-25 — The runtime is an object, the hook is a wrapper.**
  `BackendRuntime` (`runtime/backendRuntime.ts`) owns connections and publishes
  one `Store`; `useBackendRuntime` keeps its old API so the existing hook
  tests still guard behaviour.
- **2026-09-24 — Import before alpha is device-only** (no protocol change).
  Offload to a node and node-side import come after alpha and need a wire
  change (`SongHeader` has no artist/album and requires `model`).
- **2026-09-24 — Phone database for thousands of songs: op-sqlite** (planned
  with import; the library cache is still one AsyncStorage blob,
  `cantor.private-library.v1`, which must keep loading).
- **2026-09-24 — Own store primitive, not Zustand.** `core/store.ts` +
  `core/useStore.ts`, ~100 lines, no dependency.

## Measurements (Xiaomi 2201116PG, release build, CPU as % of one core)

Taken with `cantor/scripts/perf-sample.sh`. A debuggable build roughly
doubles every number — never measure on it (see Traps).

| Scenario | Before | Now | Notes |
| --- | --- | --- | --- |
| L0 idle | 11.6 | 10 (C1; 13 on the R4 build) | 0 React commits/s; mostly RN's own per-frame callbacks |
| L0, a generation running on the node | 17.6 | not re-measured | vs 11.6 idle then. (An earlier 30.3 included the composer's submit animation.) The node sends progress ≤1/s (`PROGRESS_INTERVAL`); each update re-rendered `FieldScreen` and re-recorded the job mark (~60 ms CPU). R4 + C3a address it — see Open questions |
| L2 playing | 102 | 61 | `PLAYHEAD_STEP_PX` 2 (80 at 1 px). R1: the canvas redraws per playhead step instead of 120/s; each redraw still costs ~20 ms of CPU |
| L0 playing | 105 | 33 | R1: canvas gets a still playhead when it has no player |
| Screen off, playing | 71 | 28 | R1: visual clock held while not `active` |
| … the three above with the clock frozen (experiment) | 32 / 32 / 28 | — | proves the clock is ~70 points |
| L0 panning, 35 songs | 78 | 54–59 (C1, 38 songs); 74 at R4 | 22% of samples on the JS thread: the camera mirror re-rendering `FieldScreen` |
| … with faces, rows, labels and jobs drawing nothing (experiment) | — | 62–71 | the ceiling for any cached settled layer (R5): 5–10 points |
| Lab, 2,280 songs idle / panning | 14.5 / 84 | — | culling holds; drawing cost barely grows |
| Shelf prefetch (analysis) | — | ~100 for ~9 s | 1.5 s of a core per decode; gap raised to 1.5 s → ~50% while it runs |

## Findings

- **2026-09-25 — Where L0 panning goes (R4 build, 38 songs, simpleperf 10 s,
  74% of a core).** By thread: UI 55% of samples, JS 25%, Hermes GC (`hades`)
  8%. On the UI thread nearly all of it runs inside the touch event
  (Reanimated runs the pan worklet and every mapper that reads the camera,
  synchronously): Skia's render of the canvas is 38% of the thread — 15%
  raster, 21% GL present/swap, paid once per frame whatever is drawn — and
  worklet JS (`libhermesvm` self 19%) plus Skia's per-call cost is the rest.
  Then an experiment: the faces, rows, labels and jobs pictures drawing
  nothing → panning still 62–71%. So **R5 as designed (a cached settled layer
  replayed under a transform) can save at most 5–10 points** here, and the
  lab's 2,280-song numbers (84 vs 78) say culling already keeps drawing from
  growing with the library. The large levers while panning are the JS thread
  and its GC — the camera mirror re-rendering `FieldScreen`, ~30% of samples,
  which is phase 4 — and the fixed per-frame render, which only fewer frames
  would reduce.
- **2026-09-25 — A mid-flight re-cut on the native path retargets shelf
  labels from the start of the interrupted flight.** `relayoutLinear` stays 0
  for a native flight until it lands (`useFieldCamera` stops publishing), and
  `FieldCanvas`'s label plan captures an interrupted flight at
  `lastLabelLinear` — so a second dial tap mid-re-cut plans the names from
  their source pose, not from where they were drawn. Faces and rows are
  unaffected (`lastVisualPlacements` is updated from the tick). Found reading
  R4; not yet seen on the phone. **Fixed** in `671af18`: `FieldCanvas` reads
  the outgoing re-cut's born clock when the next one is born
  (`interruptedAt`) and `retargetShelfLabelFlights` uses it as drawn, no
  second easing; the `relayoutLinear` prop is gone. Test: "starts an
  interrupting re-cut from where the names were drawn" (fails on the old
  code). The smoothness itself wants Cesar's eye (MONTH then WEEK quickly).
- **2026-09-25 — Tried and reverted: a separate playhead canvas (R5a).** Moved
  the ring's hand/arc and the detail ticks to their own transparent
  `<Canvas>` so a playhead step re-records only them. It worked as designed —
  a probe in RN Skia's mapper showed only that canvas moving — but L2 playing
  went 80 → 77% only: a transparent canvas is a TextureView, so every step
  now re-composites the whole app window on HWUI's RenderThread (~20% of
  samples), eating the saving; and it adds a second surface that can land a
  frame apart from the field during camera flights. Not worth it. Recoverable
  from this log's description if the trade changes (e.g. with an opaque
  SurfaceView overlay, which RN Skia does not offer).
- **2026-09-25 — Tried and reverted: driving the visual clock from a 30 Hz JS
  interval instead of a whole-song `withTiming`.** Worse everywhere: L2 77 →
  82%, L0 33 → 43%, screen off 28 → 30%. Each JS-side write to a shared value
  is a scheduled hop onto the UI runtime; thirty of those a second cost more
  than Reanimated stepping one animation per frame.
- **2026-09-25 — Where L2 playback goes now (profile with call graph, R2
  build):** ~73% of the main thread is inside Reanimated's frame loop
  (`AnimationFrameCallback::onAnimationFrame`); of that ~30 points are RN
  Skia actually rendering the canvas (`RNSkOpenGLCanvasProvider::renderToCanvas`,
  ~6 ms of fixed GL work per redraw), `applyUpdates`/`play` only ~2% each. The
  lever left is **how often** the canvas redraws: 20/s → 80%, 5/s → 51%
  (≈2 points per redraw per second). Settled: the playhead steps 2 px (61%).

- **2026-09-25 — Why a redraw costs ~20 ms: RN Skia re-records the whole canvas
  for any change.** `sksg/Container.native.ts` (RN Skia 2.6.9) installs *one*
  Reanimated mapper per `<Canvas>` over every shared value the scene uses; when
  any of them changes it calls `applyUpdates(allSharedValues)` — re-reading
  and converting every animated prop (`processPath` for every animated path) —
  then `recorder.play()` re-records the entire scene, and the view rasters it
  all. Cost ∝ size of the canvas, not size of the change. Attribution at L2
  playing (80%): removing the detail ticks → 68, the ring → 71, the morphing
  title/meta glyphs (static during playback!) → 67. Consequences for the
  renderer, replacing "one canvas, one draw function" in the design doc:
  **one canvas per rate of change** (static field / playhead / jobs), and
  inside a canvas **few `<Picture>` nodes fed by derived values**, not many
  animated declarative props.
- **2026-09-25 — `<Canvas opaque>` is a SurfaceView; otherwise a TextureView.**
  (`SkiaBaseView.java`.) A SurfaceView composites apart from the app window,
  a TextureView inside it. Two canvases that must move together on one camera
  should be the same kind — a TextureView overlay on the opaque field can land
  a frame apart during motion. (The job canvas was exactly that; R4 removed
  it.)
- **2026-09-25 — Playback floor ~28% with the screen off** is mostly the audio
  library: `AudioTrack` thread ~33% of samples, JS thread ~28% — the `<Audio>`
  component does a React `setCurrentTime` on every position event, every
  100 ms by default (`onPositionChangedInterval`, not exposed as a prop).
  Follow-up: patch the interval or drive `AudioFileSourceNode` directly
  (our clock only needs a resync every 250 ms).

- **2026-09-25 — A canvas redraw at L2 costs ~20 ms of CPU.** Measured by
  stepping the playhead: 20 redraws/s → 80%, 5/s → 51%, so ≈2 points per
  redraw/s and ~41% with none. Skia time is spread across per-call overhead:
  `Recorder::playGroup`/`applyUpdates` (declarative scene replay),
  `processPath`, and one JSI call per line in `drawSongDetail`'s tick loop.
  (R5 was to make a redraw re-record only what moves; shelved — see R5.)
- **2026-09-25 — L2 playing without any redraw still costs ~41%** vs 33% at L0
  playing and 11% at L2 paused: per-frame UI-thread work that is not drawing
  (the visual clock's `withTiming`, reactions, SongSurface). Not yet
  investigated.
- **2026-09-25 — Reanimated wakes nothing for a same-value write.**
  `valueSetter` returns early when a plain value equals `_value`; a derived
  value that settles on a constant stops every mapper downstream of it. This
  is the tool for rate-limiting redraws (`heard`, the stepped playhead).

- **2026-09-25 — Decoding a song for analysis is ~1.5 s of a full core**, most
  of it `readSamples`' JS loop over every sample (`player/createAudioApiPlayer.ts`).
  Fine per song, not fine for 300 imported songs. Move the reduction to native
  (or decode at a lower rate) before import.
- **2026-09-25 — Live job ≈ +6 points at L0, not +19.** Nothing animates per
  frame: the canvas is still and the main window posts one short burst per
  progress update (≤1/s from the node). The cost was breadth — each update
  re-rendered the whole `FieldScreen` and re-recorded the job's pictures.
  Addressed by R4 (jobs on the one canvas, marks via a shared value) and C3a
  (a tick re-renders only `LiveFieldCanvas`); not re-measured yet.
- **2026-09-24 — Flicker A (L1→L2, ticks pop in late)**: reveal clock driven by
  the camera only; analysis decoded on descent, in memory only. **Fixed** in
  `d8f9588` (late levels restart the draw-in; analysis persisted and
  prefetched). Verified by burst capture.
- **2026-09-24 — Flicker B (L2→L1, name gone one frame on arrival)**: the row
  batch excludes the focused placement; on arrival `setPlayerKey(null)`
  (`useFieldCamera.ts`, in `mirrorCamera`) unmounts the player flight and
  rebuilds `rows` in one commit, but `rowsPicture`'s mapper is re-created one
  passive effect later → one frame where nothing draws the name. **Fixed** in
  `5218cf7` (R2). Burst capture shows one name through descent and ascent on
  three runs; a one-frame gap is below burst resolution, so Cesar's eye is the
  final check.
- **2026-09-24 — Empty field after a regroup** (seen in the lab): regroup +
  flight home on one tap while the camera was far away settled on an empty
  canvas while React's camera read home; FIT MAP recovered. Same category as
  flicker B (two copies of the camera). **Unverified** since C1/C2b removed
  React's per-frame camera and the React re-cut path; reproduce in the lab
  (`FIELD_GROUP_LAB` in `App.tsx`) before calling it fixed.
- **2026-09-24 — Startup pop**: downloaded marks draw as outlines, then snap to
  filled once local audio is inspected. **Fixed** in `82dc931` (R3, ink
  arrivals).
- **2026-09-24 — 300 songs in one group** become one tall column clipped by the
  bottom veil. Import must group by something better than import date.

## Phase 3 plan (renderer)

Each step ships alone, keeps tests green, and is checked on the phone.

- **R1 — done (`ecddc22`). Nothing redraws for the playhead but the player.**
  What was built: the canvas gets the moving clock only while
  `fieldCamera.playerFocus` is the held song (`canvasPosition`), stepped to one
  physical pixel of the ring (`steppedPosition`); the faces' picture reads it
  through `heard`, which is -1 unless a seal is showing; `usePlayer` holds the
  visual clock when the app leaves `active`; the 160 ms `visualPosition`
  re-render is gone. *Not* done, on purpose: splitting the player face into
  its own picture — moving a face between two Skia nodes on a focus change is
  the flicker-B pattern.
- **R2 — done (`5218cf7`). The player and its row hand over on the UI thread.**
  As built: the row batch keeps every row (`rows` no longer depends on
  `focusKey`) and skips the focused one via `drawNativeRows(…, yieldKey)` only
  while `motion.owned` (camera past row distance: any song arrival > 0) *and*
  `playerRow` (a shared value the flight sets from its own
  `useAnimatedReaction` once live) names it. The flight's group opacity is
  gated by the same two values, so the two owners are exact complements on
  every frame. React mounting/unmounting the flight happens only at row
  distance, where `owned` is 0. Relies on: a pinch cannot pass the shelf seat
  (`MAX_SCALE_RATIO`), so only a tap/step enters a song, and both commit the
  owner before flying.
- **R3 — done (`82dc931`). Arrivals.** Data that lands late gets its own clock, so nothing
  snaps. *Ink* is built (`features/field/arrivals.ts`): a song's face stroke,
  face fill and name alpha come from what the phone holds of it, and when that
  changes under a song on screen — the file found at launch (the startup pop),
  a download landing — `arriveInk` bears one clock at 0 in the same commit,
  with each changed song's *drawn* ink as its `from`. So the first frame of
  the new targets paints what the last frame did, and an arrival interrupting
  another starts from where it stood. Same ink → the same object back, so
  download progress ticks restart nothing. The faces, the row batch and the
  player's name all read the one clock; `drawSealPlayer`'s `filled` became a
  number (a ring thickening into a dot). Knob: `ARRIVAL_KNOBS.INK_MS` 600.
  Analysis already had its clocks (the circle's draw-in restart, the seal's
  `soundClock`). Not covered: a rename (row text still swaps; wants the name
  morph) and the fallback picture path (R4 deletes it). Verified on the
  Xiaomi (release build, cold launch, burst capture): the downloaded faces
  pass through a half fill under a greying outline on the way to solid.
- **R4 — done (`9690ff0`, `aa3e5ce`). One renderer.** Jobs are a layer of
  the one canvas (`features/field/nativeJobs.ts`): `FieldCanvas` records each
  job's mark (`JobMark`, ring for the map and ring + words for the shelf) only
  when that job's presentation is a new object and publishes the marks in the
  `jobMarks` shared value, so a progress tick never hands `Canvas` a new
  element; an outgoing job keeps its mark while its flight is in the air. The
  transparent job canvas (a TextureView over the field's SurfaceView) is gone,
  and so is `FieldScreen`'s rule that any job on the field kept re-cuts in
  React. Then the fallback: `recordFieldPicture`, the record camera and
  `pictureTransformFor`, and `NativePlayhead`/`PlayerChrome` (drawn only for
  it) are deleted; the canvas is paper until the fonts load. `FieldCanvas`
  lost the mirrored `camera` prop with them, so a pan no longer re-renders
  it. FieldCanvas.tsx 4,399 → 3,325 lines. **Left for phase 4:**
  `useFieldCamera`'s React-driven re-cut branch (`nativeRelayout`,
  `nativeDriven`, `isNativeDrawnDistance`) is dead in the app — every
  placement is a song or a job — but six camera tests drive it; it goes with
  the camera mirror. **Left for R6:** the JS lens registry (`lensByKey`, each
  lens's `draw`, `drawRowWords`) now runs only in tests. Verified on the
  Xiaomi: cold launch (paper → field → faces fill), L0/L1/L2, the failed job
  at L0 and L1, and a MONTH re-cut with jobs on the field, mid-flight frames
  showing the job rings travelling with the songs.
- **R5 — shelved (2026-09-25, with Cesar).** A cached settled layer replayed
  under the camera transform. Measured first: with the faces, rows, labels and
  jobs drawing nothing, L0 panning still costs 62–71% of a core against 74%
  drawn, so the cache's ceiling is 5–10 points — see Findings. Revisit only if
  imported libraries make drawing grow; culling keeps it flat today.
- **R6 — Lens contract. Not started.** Goal: circle and seal behind one
  interface the renderer calls — `identity(song)`, `sound(analysis)`, draw at
  the mark / row / player poses, `hit`/seek at the player, and a lens change
  as `(from, to, t)` with a generic scale-out/scale-in and optional
  hand-written pair morphs (circle → seal keeps its dot walk) — so the tree
  lens (next after seal; memory "Lens direction: Seal then Tree") needs no
  renderer change. Design: `field-redesign.html` § 2½ ("Exactly two lenses")
  and the two-layer rule in `cantor/AGENTS.md` ("Every lens is two layers").
  Where the two lenses are woven in today (occurrences of lens/seal code):
  `FieldCanvas.tsx` ~100 (`drawFieldFaces` blends both on `lensMix`,
  `drawSealPlayer`, `faceFlightsOf`'s `sealPath`/`seal`, `heard`,
  `drawSongDetail`), `NativePlayer.tsx` ~25 (`PlayerRing`), `SongSurface.tsx`
  ~31 (seek: `seekFractionAt`, `sealRimFraction`, `sealTouchAt`),
  `songPose.ts` ~22, and `lenses/` (`face.ts`, `seal.ts` pure geometry;
  `nameLens.ts`/`sealLens.ts`/`registry.ts` — the old JS `Lens.draw` registry,
  which since R4 runs only in tests and should be replaced, not kept beside
  the contract). First step: read those, write the interface and the port
  order here, and agree it with Cesar before moving code — it is the largest
  remaining change and touches motion (Flicker Law applies).

## Phase 4 plan (camera events, chrome, UI stores)

- **C1 — done (`b1a72aa`). React hears the camera at thresholds.** The pan
  and pinch worklets and the camera flight used to copy every camera frame
  React could keep up with into React (`mirrorCamera`), re-rendering
  `FieldScreen` each time: ~30% of samples while panning, JS thread + GC.
  Now `cameraSummary` (`features/field/cameraSummary.ts`, a worklet) reduces
  the camera to what React shows of it — level, nearest shelf, the origin
  mark's run, the player surface's mount/touch step (`SONG_MOUNT_ALPHA` 0.01,
  `SONG_TOUCH_ALPHA` 0.6, which `FieldScreen` now reads too), the grain's zoom
  step (`GRAIN_STEPS_PER_E` 8) — and `mirrorOnChange` copies the camera only
  when that key changes; `mirrorNow` still hands over the camera a gesture
  ended on or a flight landed on. Taps, holds, descents, ascents, seat
  settles and the re-cut's `fromCamera` read the live `cameraShared` (a
  synchronous read from JS in Reanimated 4) instead of React's copy. L0
  panning 74 → 54–59%, idle 13 → 10. Verified on the Xiaomi: taps hit the
  right mark after a pan (a job ring, correctly), L0→L1→L2, the player's
  controls, a shelf-to-shelf drag at L1 renaming the header and moving the
  origin mark. Trap found: a synthetic drag must cross ~⅓ of the 300-unit
  shelf gap in *world* units — 800 px at L1 is only ~80, so it stays put.
- **C2 — done (`c38fc87`). One way to play a re-cut.** The React-driven branch
  (`setRecutClock`/`commitCamera` every frame), `nativeRelayout`,
  `nativeDriven` and `isNativeDrawnDistance` are deleted; their tests went
  with them, and the retarget test now reads the mid-flight pose from the
  flights (`placementFlightAt`) rather than from React, which no longer sees
  it. Verified on the Xiaomi: WEEK → MONTH → WEEK re-cut with jobs on the
  field.
- **C2b — done (`cd54f40`). A re-cut's camera runs on the UI thread.** It
  ticked on the JS thread by `requestAnimationFrame`, writing `cameraShared`
  and `fitScaleShared` from JS every frame (the cost the 30 Hz playhead
  experiment measured) and rebuilding every placement's pose per frame for a
  capture only the *next* re-cut reads. Now `recutProgress` is a `withTiming`
  and a reaction moves the camera and fit (flight curves: smootherstep on
  position, log on scale); `landRecut` hands React the landing. `liveCapture`
  and `renderedFit` answer the in-flight poses and fit on demand. Tests hold
  a re-cut mid-air with `holdRecut` (a `withTiming` spy), since the Jest mock
  lands at once and runs no reactions. Verified on the Xiaomi: WEEK → MONTH
  → WEEK plain and interrupted 250 ms in, landing on the same camera each
  round trip.
- **C3a — done (`4007b5e`). A job's progress re-renders what draws it.**
  `FieldScreen` read `useBackendRuntime`'s whole state and built the
  controller in render, so every runtime change — a running job's progress
  about once a second, a download's bytes — re-rendered the whole screen.
  Now `useRuntime` starts the runtime without subscribing;
  `fieldControllerStore` follows it and builds the controller outside React
  (ignoring pairing, errors and transfers); the screen selects backends, each
  node's phase, pairing, errors, `refreshing` and the songs/entities (which a
  job tick leaves as the same objects — tested). The jobs are read by
  `LiveFieldCanvas`, the job sheet's selector, the condense target's key
  selector and `LiveEnginesSheet` (only while open); a tap on a job reads the
  store at the tap. Verified on the Xiaomi: the library loads, a tap on the
  failed job opens its sheet, the engines sheet shows each node's live state.
  **Not yet measured:** L0 with a live generation (17.6 before vs 11.6 idle)
  — needs a real generation on a node, which is Cesar's call.
- **C3b — the rest of the screen's state.** Still re-rendering `FieldScreen`:
  a download's progress (it changes that song's presentation), and the
  screen's ~30 `useState`s (sheets, errors, targets). Worth it only if a
  measurement says so; `FieldCanvas` and most children are memoised.
- **C4 — done (`ea9657e`). Chrome fades on shared values.** Audit what still fades
  or steps from React state that moves with the camera or a clock (the rule
  in `cantor/AGENTS.md`, "Nothing that moves with the camera may be laid out
  in React"): start with `FieldOverlay.tsx`, `OriginMark.tsx`,
  `SongSurface.tsx`, `FieldA11yList.tsx`, and every `level`/`songAlpha` read
  in `FieldScreen.tsx`. React's camera now changes only at thresholds
  (C1), so anything faded from it steps. Expected to be small; if the audit
  finds nothing, record that and close it.
  **Audit (2026-09-26):** `SongSurface` already fades its readout and lens
  picker from `cameraShared` (`readout`), and only its mount and touch read
  React's `songAlpha` — decisions, not fades, which is right. `OriginMark`'s
  lit run is a discrete breadcrumb (a step by design). `FieldA11yList` draws
  nothing. The header's morphs and the dials' `Reveal`s are triggered by a
  level threshold but run on their own clocks (`HEADER_CHANGE_MS`), which is
  the "text change = morph" rule, not a camera fade. **One real case:**
  `FieldOverlay` hides the header and the foot with `opacity: 0` the commit
  React's level becomes `song` — a cut at 13·FIT, a commit late, while the
  camera is still moving and the player is only starting to arrive (the song
  band opens 12→27·FIT). On the way back it cuts in at 13·FIT. **Plan:** the
  header's and foot's opacity become `1 − song band`, read from
  `cameraShared`/`fitScaleShared` in a `useAnimatedStyle` — the same number
  `SongSurface` fades in on, so the chrome leaves as the player arrives, on
  the canvas's frame. `away` keeps deciding touches, accessibility and the
  frozen text, as now. Test: at a camera inside the song band the header is
  partly drawn (fails on the old code, which drew it at 0).
  **As built:** `CHROME_AWAY_WINDOW` in `FieldOverlay.tsx` — the song band's
  opening (12→27·FIT) that never closes, so the chrome stays gone at the
  grain where the song band itself closes again. Test:
  `fieldOverlay.test.tsx`. Verified on the Xiaomi by burst: mid-descent into a
  song the header and the hint are drawn part-way under the arriving player,
  and part-way again on the climb back out.

## Open questions (for Cesar)

- **Does an interrupted regroup glide now?** (`671af18`.) Tap MONTH then
  WEEK quickly at L0: the week names should move back from where they were,
  not jump. A burst capture cannot see it; Cesar's eye can.
- **May we run a throwaway generation to measure a live job?** C3a should
  bring L0-with-a-generation from 17.6% toward the 11.6% idle, but measuring
  it needs a real generation on one of Cesar's nodes, which adds a song to
  his library. Ask; do not start one unasked.
- Settled 2026-09-25: the playhead steps 2 px (`PLAYHEAD_STEP_PX` in
  `FieldScreen.tsx`, 61% of a core at L2 playing against 80 at 1 px); Cesar
  looked on the phone and it reads clean.

## Known leftovers (not scheduled)

- Analysis decode is ~1.5 s of a core per song on the JS thread
  (`readSamples` in `player/createAudioApiPlayer.ts`); must move to native or
  a lower rate before importing hundreds of songs (phase 5).
- The audio library posts a position event every 100 ms to React
  (`onPositionChangedInterval`); most of the 28% screen-off playback floor.
- 300 songs in one date group make one tall column; import needs a better
  grouping.
- A rename swaps the row's text instead of morphing it.
- L2 playing costs ~41% even with no redraw; not investigated.

## Traps (learned the hard way)

- **Instrumenting RN Skia:** Metro bundles it from `src/` (the package's
  `react-native` field), so a probe goes in
  `node_modules/@shopify/react-native-skia/src/sksg/Container.native.ts`;
  `console.warn` from that worklet reaches logcat on the release build. Restore
  the file afterwards.

- **A React prop in a picture's closure is stale for a while after the
  commit.** First R2 attempt read `focusKey` inside `rowsPicture`: at the start
  of a descent the flight had mounted and was drawing from the JS thread's
  initial camera while the batch's mapper still had the old closure → the name
  drawn twice, a few px apart (caught by burst capture). Hand-overs must be
  decided by shared values both owners read, set from the UI thread (a
  reaction runs only once the component's mappers are live).
- **Driving the phone:** after an ascent the camera centres on the row you
  left, so fixed tap coordinates drift; re-enter the shelf from L0 for a known
  layout. BACK at L0 leaves the app. Failed jobs' rows open a job sheet.
  `uiautomator` does not list the field's accessibility rows.

- **Measure on a release build.** Debuggable = interpreted Java + CheckJNI.
  `assembleRelease` is signed with the same `debug.keystore`, so
  `adb install -r` keeps the app's data. To profile it, add
  `<profileable android:shell="true" />` inside `<application>` in
  `AndroidManifest.xml` for the build only, then restore the file.
  `simpleperf record --app com.cantor.app -e cpu-clock -g`.
- **The phone's debug app runs with JS dev mode off**, so `__DEV__` is false
  and `__DEV__`-gated tools never show. Gate dev tools on their own flag
  (`PERF_HUD`, `MOTION_LAB` in `App.tsx`).
- **`dumpsys gfxinfo` reports 0 frames** — Skia draws into its own
  SurfaceView. Use `dumpsys SurfaceFlinger --latency '<SurfaceView layer>'`.
- **Burst `screencap` is ~250 ms per frame**: fine for 900 ms reveals, blind to
  one-frame flickers. A one-frame flicker needs an in-app trace.
- **Error text is a contract** — the runtime tests assert exact strings like
  `Backend is not connected.`.
- **Ordering against a `useDerivedValue` picture:** an effect that resets a
  clock must be declared *before* the `useDerivedValue` whose closure changes
  in the same commit, or its mapper paints one frame with the old clock value.

## Commits

- `ea9657e` field: the header and foot leave on the song band, not on the level
- `4007b5e` field: a job's progress re-renders what draws it, not the screen
- `8d216c9` docs: the label retarget fix in the log
- `671af18` field: an interrupted re-cut resumes its names from where they were drawn
- `32e91de` docs: C2b in the log
- `cd54f40` field: a re-cut's camera runs on the UI thread
- `dae7e30` docs: C2 in the log
- `c38fc87` field: every re-cut plays on the canvas's clock
- `2d2f643` docs: the 2 px playhead is settled
- `ad9bfab` docs: phase 4 plan, C1 in the log
- `b1a72aa` field: React hears the camera at thresholds, not every frame
- `0805800` docs: commit list
- `adcdd4a` docs: R5 shelved, the 2 px playhead, phase 4 next
- `c96cdef` field: the playhead steps two pixels of the ring
- `6465084` docs: where L0 panning goes; the ceiling for a cached layer
- `2756b9e` docs: R4 in the log; notes that still described the picture fallback
- `aa3e5ce` field: one renderer, no picture fallback
- `9690ff0` field: jobs are a layer of the one canvas
- `14c93c0` docs: R3 in the log
- `82dc931` field: ink that changes on screen arrives on its own clock
- `5218cf7` field: the player and its row hand over on the UI thread
- `2c4043b`, `4d99970` docs: R1 in the log
- `ecddc22` field: redraw for the playhead only where it is drawn
- `e193d35` docs: field rewrite implementation log
- `1475be9` docs: app module map for the runtime store and analysis store
- `d8f9588` lenses: persisted analysis store; late ticks draw in
- `53b3488` runtime: move state into a store that keeps unchanged songs and jobs
- `d76f4ee` dev: perf readout, adb cost sampler, thousand-song field scenarios

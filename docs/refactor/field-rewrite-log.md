# Field rewrite — implementation log

The running record of the pre-alpha rewrite of the Cantor app's field (the
map, shelves, player and everything drawn on the Skia canvas). Written for
whoever picks this up next, including a new chat: read this first, then
[`field-redesign.html`](field-redesign.html) for the design and
[`app-walkthrough.html`](app-walkthrough.html) for how the app worked before.

Newest entries at the top of each section. Update it as you go: every
finding, decision, trap and commit.

## Where we are

| Phase | State |
| --- | --- |
| 1. Measure | **done** — `d76f4ee` |
| 2. Stores | **done** — `53b3488`, `d8f9588`, `1475be9` (field-screen UI stores deferred to phase 4) |
| 3. Renderer | **in progress** — R1 `ecddc22`, R2 `5218cf7`, R3 `82dc931`, R4 `9690ff0` `aa3e5ce` done; see "Phase 3 plan" |
| 4. Camera events, chrome, UI stores | not started |
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
| L0 idle | 11.6 | — | 0 React commits/s; mostly RN's own per-frame callbacks |
| L0, a generation running on the node | — | 17.6 | vs 11.6 idle. (An earlier 30.3 included the composer's submit animation.) The node sends progress ≤1/s (`PROGRESS_INTERVAL`); each update re-renders `FieldScreen` and re-records the job mark (~60 ms CPU) → phase 4 |
| L2 playing | 102 | 80 | R1: canvas now redraws at 20 fps (1 px playhead step) instead of 120; each redraw still costs ~20 ms of CPU → R5 |
| L0 playing | 105 | 33 | R1: canvas gets a still playhead when it has no player |
| Screen off, playing | 71 | 28 | R1: visual clock held while not `active` |
| … the three above with the clock frozen (experiment) | 32 / 32 / 28 | — | proves the clock is ~70 points |
| L0 panning, 35 songs | 78 | — | 22% of samples on the JS thread: the camera mirror re-rendering `FieldScreen` |
| Lab, 2,280 songs idle / panning | 14.5 / 84 | — | culling holds; drawing cost barely grows |
| Shelf prefetch (analysis) | — | ~100 for ~9 s | 1.5 s of a core per decode; gap raised to 1.5 s → ~50% while it runs |

## Findings

- **2026-09-25 — A mid-flight re-cut on the native path retargets shelf
  labels from the start of the interrupted flight.** `relayoutLinear` stays 0
  for a native flight until it lands (`useFieldCamera` stops publishing), and
  `FieldCanvas`'s label plan captures an interrupted flight at
  `lastLabelLinear` — so a second dial tap mid-re-cut plans the names from
  their source pose, not from where they were drawn. Faces and rows are
  unaffected (`lastVisualPlacements` is updated from the tick). Found reading
  R4; not yet seen on the phone. Fix with the camera events of phase 4.
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
  (≈2 points per redraw per second). A product call — see "Open questions".

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
  a frame apart during motion. The job canvas is exactly that today.
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
  R5 must make a redraw re-record only what moves.
- **2026-09-25 — L2 playing without any redraw still costs ~41%** vs 33% at L0
  playing and 11% at L2 paused: per-frame UI-thread work that is not drawing
  (the visual clock's `withTiming`, reactions, SongSurface). Investigate in R5.
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
  progress update (≤1/s from the node). The cost is breadth — each update
  re-renders the whole `FieldScreen` and re-records `NativeJobFlight`'s
  pictures. Fix with the UI stores (phase 4) so progress re-renders only the
  job layer. The job canvas is transparent, so it composites into the main
  window rather than getting its own SurfaceView.
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
  flicker B (two copies of the camera). **Open** — phase 3/4.
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
- **R5 — Cached settled layer.** Record the settled field once and replay it
  under the camera transform; re-record only when the set, lens band or
  palette changes.
- **R6 — Lens contract.** Circle and seal ported onto `identity / sound /
  poses / morphs / hit`, so tree needs no renderer change.

## Open questions (for Cesar)

- **Playhead smoothness vs heat at L2.** The hand steps one physical pixel
  (~18 redraws/s on a 2-minute song) → ~80% of a core while the player is on
  screen. Two pixels ≈ 10/s ≈ 60%; four ≈ 5/s ≈ 51%. Knob: the divisor in
  `playheadStepSeconds` (`FieldScreen.tsx`).

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

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
| 3. Renderer | **in progress** — R1 done (`ecddc22`); see "Phase 3 plan" |
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
| L0, a generation running on the node | — | 30.3 | measured after phase 2; main thread in Choreographer/Fabric frame callbacks and `HybridData.<init>` → something draws every frame while a job is live (job canvas?) |
| L2 playing | 102 | 80 | R1: canvas now redraws at 20 fps (1 px playhead step) instead of 120; each redraw still costs ~20 ms of CPU → R5 |
| L0 playing | 105 | 33 | R1: canvas gets a still playhead when it has no player |
| Screen off, playing | 71 | 28 | R1: visual clock held while not `active` |
| … the three above with the clock frozen (experiment) | 32 / 32 / 28 | — | proves the clock is ~70 points |
| L0 panning, 35 songs | 78 | — | 22% of samples on the JS thread: the camera mirror re-rendering `FieldScreen` |
| Lab, 2,280 songs idle / panning | 14.5 / 84 | — | culling holds; drawing cost barely grows |
| Shelf prefetch (analysis) | — | ~100 for ~9 s | 1.5 s of a core per decode; gap raised to 1.5 s → ~50% while it runs |

## Findings

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
- **2026-09-25 — Live job ≈ +19 points at L0** (see table). Suspect the job
  scene (`NativeJobFlight` on its own transparent canvas) redrawing per frame.
  Fold into the renderer's job layer; check it draws only when progress moves.
- **2026-09-24 — Flicker A (L1→L2, ticks pop in late)**: reveal clock driven by
  the camera only; analysis decoded on descent, in memory only. **Fixed** in
  `d8f9588` (late levels restart the draw-in; analysis persisted and
  prefetched). Verified by burst capture.
- **2026-09-24 — Flicker B (L2→L1, name gone one frame on arrival)**: the row
  batch excludes the focused placement; on arrival `setPlayerKey(null)`
  (`useFieldCamera.ts`, in `mirrorCamera`) unmounts the player flight and
  rebuilds `rows` in one commit, but `rowsPicture`'s mapper is re-created one
  passive effect later → one frame where nothing draws the name. **Open** —
  phase 3 step R2.
- **2026-09-24 — Empty field after a regroup** (seen in the lab): regroup +
  flight home on one tap while the camera was far away settled on an empty
  canvas while React's camera read home; FIT MAP recovered. Same category as
  flicker B (two copies of the camera). **Open** — phase 3/4.
- **2026-09-24 — Startup pop**: downloaded marks draw as outlines, then snap to
  filled once local audio is inspected. **Open** — an arrival clock (R3).
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
- **R2 — The player and its row are one slot.** Ownership (which placement is
  the player, and how far it has shrunk back) becomes UI-thread state, so the
  ascent hands the name back to the row in the same frame. Fixes flicker B.
- **R3 — Arrivals.** A per-song born clock for data that lands late (audio
  inspected, analysis, rename), so nothing snaps. Fixes the startup pop.
- **R4 — One renderer.** Remove the `recordFieldPicture` fallback path and the
  10-condition `nativeField` switch; jobs join the one canvas as a layer that
  redraws only when progress moves.
- **R5 — Cached settled layer.** Record the settled field once and replay it
  under the camera transform; re-record only when the set, lens band or
  palette changes.
- **R6 — Lens contract.** Circle and seal ported onto `identity / sound /
  poses / morphs / hit`, so tree needs no renderer change.

## Traps (learned the hard way)

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

- `ecddc22` field: redraw for the playhead only where it is drawn
- `e193d35` docs: field rewrite implementation log
- `1475be9` docs: app module map for the runtime store and analysis store
- `d8f9588` lenses: persisted analysis store; late ticks draw in
- `53b3488` runtime: move state into a store that keeps unchanged songs and jobs
- `d76f4ee` dev: perf readout, adb cost sampler, thousand-song field scenarios

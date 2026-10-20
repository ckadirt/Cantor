# Cantor Project Context

This file is durable working context for coding agents. Treat it as guidance for
all work under `cantor/`. The code remains the source of truth when details drift;
update this file when the product direction or established motion rules change.

For the app's module map, dependency rules, extension recipes, and review
checklist, see [`../contributing/hacking-app.md`](../contributing/hacking-app.md).
For where a change belongs across the whole repository, see
[`../contributing/architecture.md`](../contributing/architecture.md).

## Product vision

Cantor is a local-first Android song-generation app built around ACE-Step 1.5
GGML. Its defining promise is full song generation on-device, without requiring
cloud inference.

Generation must ultimately be backend-agnostic. Local phones/tablets, a user's PC
or Mac, and remote servers should be interchangeable, pluggable generation
backends behind the same app experience. Do not unnecessarily couple product UI
or domain logic to a single inference location.

## Current state (2026-07-10 onward)

- The original v1 UI was intentionally deleted for a redesign reset.
- The v1 design is preserved outside this repo at
  `../cantor-design-v1-backup/`; use it only as reference, not as the current UI.
- The current app is a clean scaffold centered on a hot-reloadable onboarding
  experience.
- The immediate product work is the new motion language and data-driven
  onboarding, not restoring the old interface.

## Motion language and engine

**Read `src/motion/README.md` before touching motion code** — it documents the
architecture, the trigger model, component recipes, the house rules (linear
clocks, fixed-height containers, stable charStyle objects, born clocks,
verb-identity), authoring, tuning constants, and known limits.

The motion system follows a **Shapes + Verbs + Clock** model:

- Shapes define geometry and visual primitives.
- Verbs define transformations and transitions between shapes/states.
- A shared clock coordinates the motion deterministically.

Geometry is sampled and validated before animation. The transition model owns
visual state. Retargeting must support a mid-morph interrupt by starting
the new transition from the currently rendered/interpolated state—not by snapping
to either the previous source or destination.

Text and symbols use Skia glyph-outline morphing in the spirit of Manim. The
canonical reusable symbol set lives in `src/motion/symbolLibrary.ts`; each entry
owns semantic metadata, exact source-derived compound artwork, authored regular
weight, and optical aspect ratio. `AnimatedSymbol`/`WriteSymbol` are the semantic
entrypoints. Compound silhouettes—including holes—must morph directly; never
morph through a centerline proxy and fade to the real glyph. `strokeWidth`
offsets the canonical outline inward/outward, while `aspectRatio` controls optical
width. Preserve the reduced-motion crossfade.

### Text motion

The shared text engine exposes several reusable variants; preserve the choice at
the call site rather than replacing one behavior globally:

- `write`: Manim-style `DrawBorderThenFill`; exact glyph outlines trace on with
  controlled letter lag, then resolve into filled real glyphs. It runs both
  ways: a `write` line whose text becomes empty *erases* — the same models on a
  reversed clock — so chrome arrives and departs by one gesture. That needs the
  slot kept mounted with `''` and given a stable width; see
  `src/motion/README.md`.
- `transform`: a plain whole-object Manim transform. Glyph families align in
  reading order and all geometry uses one shared alpha—no matching cascade.
- `matching`: the original hierarchical character-matching gesture. Words glide,
  leftover characters match by proximity, and unmatched characters shape-morph.
- `crossfade`: the reduced-motion path and graceful geometry fallback.

All variants share font layout, clocks, glyph geometry, interruption handling,
and flicker-free UI-thread hand-offs. Keep the matching variant available even
when the product UI chooses the calmer whole-object transform.

### Semantic zoom: one drawing, three poses

The field's levels are not three screens that hand over to each other. A mark
(L0), a row (L1) and the player (L2) are **one drawing** at three distances, and
the camera moves continuously between them:

- One face path per song, from `nameLensFacePath`, which is exactly linear in
  its radius — so the row's face *is* the mark's at 1.2× and the player's is the
  same path again at about 12×. There is never a second contour to crossfade to.
- The name is one object across L1 and L2, morphed between the row's 15 px cut
  and the player's 26 px, because a row truncates a long title and the player
  has room for it. Two strings, one interpolation.
- `NativeFieldContent` owns the canvas for all three and the grain beyond them
  (`drawSongDetail`), and for generating jobs (`nativeJobs.ts`). It is the only
  renderer: until the fonts load the canvas is paper. Everything is written
  against the live camera on the UI thread.

Each crossing is **two beats, not one**: `ROW_ARRIVAL` for L0→L1 and
`SONG_ARRIVAL` for L1→L2. The shape moves first and the words follow it. Putting
a whole crossing on one number makes everything in the frame move at the same
instant, which reads as a lurch rather than as a sentence — that is what
`ROW_ARRIVAL`'s own note means by "two things that must not happen at once."

**A pose is not a band.** Crossfade bands (`REPRESENTATION_WINDOWS`) say how
*present* something is; arrivals say where it *is*. Never drive a position or a
size from a band: bands are measured in linear ratio and eased in their own
right, while `interpolateCamera` eases once and then walks the scale
exponentially. Drive a pose from a band and you get a second smootherstep on top
of the camera's, over a window that covers a fraction of the flight — the player
was built that way first, and its name stood still through half of every descent
and then hooked across the screen at six times its own average speed. Arrivals
are measured in log scale with no easing of their own, so a local pose advances
in lockstep with the camera carrying it and the two motions sum to a straight
line.

**A song is a page, not a map.** The pan is locked at `isSongDistance` and a
pinch inside a song pulls against the middle of the view rather than the
fingers, so the player cannot slide out from under itself. Zoom is still the
navigation — a pinch is how you leave — and the edge pulls still open the
composer and the engines, because neither of those moves the camera.

**The player belongs to the song you are in.** Navigation focus and the canvas
owner have different lifetimes. `ascend` clears navigation focus immediately,
but retains the outgoing `playerKey` until the live camera reaches the shelf
seat. The drawing shrinks back into its row on the UI thread before React
releases it. A new descent replaces that owner before starting its flight.
Never clear the visible player at the start of an ascent: that removes its
geometry at full size and produces a flash.

**The queue steps at L2 by morphing, not by leaving.** When the next song on
the shelf starts while you watch the player, the player stays where it is and
becomes the next song's (`FIELD_CAMERA_KNOBS.STEP_STYLE: 'morph'`; the old
fold — back into the row, down into the neighbour — is `'fold'`, kept whole).
See `features/field/stepMorph.ts`. The rules it was built on:

- *The morph is the motion layer's.* `PlayerMotionLayer` draws everything
  that changes — face (`LensUi.morphPlayer`, or two beats through a point),
  ring of ticks, orbit, name, byline, the hand — and the field holds still
  under it (`fieldStepClock` only moves 0 → 1). Redrawing the field costs
  most of a frame at L2; the layer is a handful of paths.
- *Nothing waits on Skia's mount to look right.* The next song's player is
  mounted most of a second after the commit. Until then the layer holds the
  leaving player on the music it was last drawn to (`PlayerLayer.frozen`), the
  lines are handed to it from `FieldCanvas`'s own commit effect, and the
  camera is cut only once the arriving flight's mount effect says it is on
  the canvas (`StepMorph.ready`); anything of the leaving song's still drawn
  after the cut uses `fromCamera`.
- *The clock cannot jump.* The layer advances it a frame at a time, capped,
  starting a few frames after the mount: a timing reads timestamps, and the
  frame after a mount comes late enough to land the morph at once.
- *Side effects from a derived value only on the UI thread* (`onUIThread`):
  its first run is on the JS thread, mid-render.
- *A morphing line is one picture* (`MorphLine`), not a node per letter: a
  byline loop is ninety letters, and mounting them held both threads.
- *A step is only running for the song it arrives at.* The press winds the
  clock back a commit before the focus moves, and every reader — the field
  (`fieldStepClock`), each focus layer (`useOwnStepClock`), the layer
  (`layerClock`) — treats anything else as landed; read raw, the song before
  last flashed up.
- *Two canvases never hand over in plain sight.* The lines change hands
  under paper the layer lays behind its own (`StepLinesDraw.band`), the
  marquee's strip is released under it too (the layer sits above the strip),
  and once a step has given the player to the layer it keeps it
  (`PlayerDraw.hold`) until the player is left, so music rising or pausing
  does not cross canvases. Every crossfade between the two showed as a frame.
- *The held music is the leaving song's only until the step lands.* Once the
  arriving song is the focus at clock 1 the layer draws it on its own music
  (none, until it rises); held a frame longer, the circle sang the song
  before last's shape for that frame.
- *A step has the whole clock, not just its hand.* The field's step clock
  waits at 0 while the layer has the step (`fieldStepClock`), so anything
  of a step left on the field holds the leaving song until the landing and
  snaps there. The seal's form is on its rim, so the field hands the rim,
  ticks, cuts and letters over with the hand (`handInk`) and the layer draws
  them on its own form clock (`drawClockFace`), which it keeps using while
  it holds the player after a step: the field's copy of the form in
  `DetailDraw` is only rewritten when the field re-records.
- *Every lens morphs its own player.* The seal's (`drawSealStep`) works on
  the deepest grid both seals share: a cell both fill keeps its dot and
  changes it, the rest flow into or grow out of their nearest neighbour, each
  thread rides its own dots, and one bead travels between the two playheads.
  Its ends are `drawSealPlayer` itself: a still seal draws its quiet dots at
  an alpha over the thread and a moving one draws them opaque, and the morph
  walks between the two looks rather than snapping at either end.

A step asked mid-morph waits for it to land.

**Lenses share the renderer, through one contract.** A lens decides only what a
song looks like; the renderer decides where it is and how present
(`src/lenses/contract.ts`). Each lens gives an `identity` (JS, from the recipe
alone), a `player` model (JS, for the one song the camera is in, with its sound
once measured), worklets to draw a mark and a player, its clock as numbers
(`ClockShape`), and what a touch on the player means. Adding a lens is a new file
in `src/lenses/` and one entry in `LENSES`; nothing in `features/field/` changes.
A lens change is `(from, to, t)` (`features/field/lensClock.ts`) on a retained
linear clock (`SEAL_PLAYER_KNOBS.LENS_MORPH_MS`) that counts frames, capped, and
waits out the commit's long frame: a timing lost a third of every lens morph to
it on the phone. Marks and rows take two beats:
the lens being left scales in to a point, then the one arriving opens out of it
— scale, never a ghosted crossfade. The player can have a hand-written pair
morph instead (`src/lenses/pairs.ts`): circle ↔ seal walks each dot out of the
face's contour where the circle's clock stands at its moment, the contour
becomes the Peano thread, and `PlayerRing` mixes the two `ClockShape`s so the
arc and hand run out to the rim and knob. Reduced motion crossfades instead.
Reversing a change mid-way swaps `from`/`to` and takes `1 − t`, which draws the
same frame; a third lens asked for mid-change waits for this one to land.
Keep the lens clock outside the keyed re-cut generation so regrouping during a
lens change preserves its current progress. `lensGoldens.test.ts` and
`playerRingGoldens.test.tsx` pin what the lenses draw; a change that is meant to
look different regenerates them with `-u` and says why.

**Every lens is two layers, like the circle.** *Identity* is a pure function of
the recipe (`facePoints`'s inputs), so it exists at L0 for songs never on the
phone; *sound* exists only once the song is measured, lives inside the identity's
own geometry, carries the playhead, and is gone at L0. The seal's identity is
three nested symmetric 3×3 masks plus an orientation (`lenses/seal.ts`); its sound
is the Peano-ordered deepest dots, sized by loudness, hollowed by punch, split by
stereo width (`SongAnalysis.slices`). Its clock and seek are a rim around the
dust; a touch that starts on the dust is a tap that jumps to that dot.
Marbling's identity is a few drops of ink and clear water and one or two tine
strokes (`lenses/marble.ts`); its sound is the bath the song leaves — a drop a
bar at the playhead's place round the dial, sized by the bar's loudness and
kick, nothing ever erased (`lenses/marbleTimeline.ts`). Its clock is the seal's
rim, and a drag anywhere on the bath seeks by angle. **Marbling morphs ring by
ring** — its sound rising at L2, a seek while it plays (the back button
restarting a song), the queue's next song, a change with any other lens: both
drawings as rings, paired (the same ink by id within one song), resampled,
aligned and lerped, the motion engine's silhouette morph
(`lenses/marbleMorph.ts`). The morphs are built off the drawing threads by the
bath's own runtime; the UI thread only lerps them, and each end dissolves into
the lens's own drawing without thinning the ink. A lens whose field of
unloaded songs looks identical has broken the identity rule.

**The player moves to its music, and every frame is a pure function of the
playhead.** A measured song has a motion track (`lenses/motion/`: beats, onsets,
sections, drops, measured natively in `cpp/motion/`), and the renderer turns it
into one `MotionFrame` a frame, the only thing a lens is shown. No per-frame
state, no springs: seek, scrub, pause and reduced motion fall out of that, and
since the whole song is known a hit may rise *before* it sounds. **The circle
shows form as shape** (a pose per section, so a returning chorus returns to the
same shape); **the seal shows form as its thread**, never as dot motion — a
seal dot moving means *this sound is sounding*; **marbling shows form as its
comb** — a section start drags a comb across the whole bath, in its letter's
direction, so a returning chorus combs the same way, and a drop of ink means
only *a bar has passed*. The one exception, in all three, is
the drop (and its smaller kin, the lift): the only structural event big enough
to move everything. Every gesture is scaled by the frame's `presence` and by how
far the player has arrived, so at the hand-off to the row the drawing is the
identity to the pixel. A pause lets what sounds settle and keeps the form. In a
lens change the leaving lens's motion goes over the first half and the arriving
lens's comes over the second, so the morph runs between still shapes. Moving
content is drawn in pieces the GPU draws by itself (segments, circles, recorded
pictures): an anti-aliased path that changes every frame is rasterised on the
CPU and uploaded every frame. A player whose drawing is too heavy to redraw
each frame but changes as the song plays keeps it as a slow layer
(`Lens.bake`): marbling bakes its settled bath into an image off every drawing
thread and lands what is still moving in a shader over it. And the moving player is drawn on its own canvas
(`PlayerMotionLayer`) once it has landed, because re-rendering the field canvas
costs most of a frame at L2 whatever moves in it.

**Nothing that moves with the camera may be laid out in React.** React's copy of
the camera changes only at thresholds (`cameraSummary`: level, shelf, origin
run, the player surface's mount and touch) and when a gesture ends or a flight
lands — so chrome faded by React state would step while the canvas under it
moves — two clocks on one gesture. This is the Flicker Law's first rule at the level of a whole
representation, and the player violated it until it was drawn here.

What stays in React at L2 is what has no pose at L1 and no reason to be
geometry: the elapsed readout (a string that changes twice a second would hand
the canvas a fresh element on every tick), the lens picker, and an invisible
layer of touch targets laid out from the same measurement the canvas draws from.

### The Flicker Law

React commits and Skia canvas-mapper ticks are separate scheduling domains. A
React commit can replace or expose real glyphs before the Skia mapper has rendered
the matching terminal animation frame, producing a one-frame flash, duplicate,
or disappearance even when the numeric animation state is correct.

Keep these invariants:

1. One owner draws a glyph at any instant; never let React text and Skia outlines
   visibly own the same glyph simultaneously.
2. Do not use a React commit as proof that Skia has painted a particular frame.
3. Complete the visual transition on the canvas timeline first, then hand
   ownership to real glyphs on the UI thread.
4. Keep the outgoing representation available until the incoming representation
   is confirmed ready; avoid a commit-sized ownership gap.

When changing animation lifecycle, retargeting, keys, conditional rendering, or
glyph hand-off behavior, explicitly check these rules. A logically correct state
transition can still flicker if it violates scheduling/ownership.

## Onboarding

Onboarding panels are data-driven through the `PanelDef` structure and use the
shared morphing system.

Panel 1 is the Cantor introduction:

- A regular set of 29 bars draws in.
- The bars resolve into a constellation built directly from the ten canonical
  primitives: ℵ₀, ∞, 𝒞, ∮, 𝄞, 𝄋, 𝄐, ∂, ∇, and 𝔠.
- At the morph boundary, the 29 bars become source subpaths of ten compound
  glyph transitions. Exact font counters stay in even-odd paths; surplus source
  bars collapse into zero-area contours rather than fading away.
- The middle of the viewport is a hard quiet zone for the Cantor wordmark and
  slogan; their reveal begins only after the final morph has cleared that zone.
- The Cantor wordmark fades in.

Keep panels declarative where possible; avoid panel-specific animation machinery
when a reusable shape, verb, slot transition, or panel datum expresses the same
idea.

## Visual and motion direction

- Manim-style mathematical motion is the north star.
- Use mathematical easing such as smoothstep/smootherstep or deliberate cubic
  Bezier curves. Never introduce bouncy, elastic, or spring-like motion.
- Prefer thin, delicate, intricate, single-stroke forms over chunky graphics.
- Preserve the intrinsic aspect ratio of source-derived SVG/font artwork. Fit
  it with uniform scaling; never stretch a finished silhouette to an optical
  width or height.
- Favor larger, elegant forms with clean negative space.
- Keep chrome and gathered song lists orderly. Overview groups use stable,
  irregular particle clusters: sparse groups have air, dense groups compress
  with slight internal overlap. Keep separate groups clear of each other.
- Bundled typefaces are CMU Serif for display and Spectral for body copy. They
  must continue to work with the hot-reload development flow.

## Engineering facts and quality bars

- React Native app targeting Android (`applicationId com.cantor.app`).
- Jest exercises real CanvasKit; do not replace it with a mocked canvas in tests.
- On-device motion performance has been measured at 5.15% janky frames with a
  90th-percentile frame time of 17 ms. Treat this as a baseline to protect, not a
  theoretical benchmark.
- Test motion and hand-offs on real hardware. Simulator/Jest correctness alone is
  insufficient for visual scheduling bugs.
- Preserve launcher icon, theme, bundled fonts, and the known-working development
  environment unless the task explicitly changes them.
- See `README.md` for the current build, Metro, device, NDK, and environment-trap
  workflow.

## On-device visual debugging playbook

Use this loop for layout, typography, SVG/Skia, and flicker work. A full-screen
screenshot is useful for composition; also make a focused crop so small type and
alignment differences are not judged from a downscaled image.

### Target the physical phone explicitly

As of 2026-07-16 the authorized Xiaomi phone is `6b1f6ba8629c` (1080×2400).
Another ADB entry may be present but unauthorized, so first check the list and
always pass `-s` when more than one device appears:

```sh
adb devices -l
adb -s 6b1f6ba8629c reverse tcp:8081 tcp:8081
```

The package is `com.cantor.app`. A debug build can be reloaded without opening
the Dev Menu:

```sh
adb -s 6b1f6ba8629c shell am broadcast -a com.cantor.app.RELOAD_APP_ACTION
```

Fast Refresh is normally enough for TypeScript/style edits. Use the broadcast
when a deterministic replay from the beginning of an animation is needed.

### Reliable screenshot and crop workflow

Device-side capture plus `adb pull` has been more reliable here than shell
redirection or Android `screenrecord`:

```sh
adb -s 6b1f6ba8629c shell screencap -p /sdcard/cantor-check.png
adb -s 6b1f6ba8629c pull /sdcard/cantor-check.png /tmp/cantor-check.png
```

Android screenshots are RGBA. Some image viewers render large white regions as
black even though their pixels are correct; flatten the alpha channel before
judging the result. ImageMagick can also make a focused crop (adjust geometry to
the area under inspection):

```sh
convert /tmp/cantor-check.png -background white -alpha remove /tmp/cantor-check.jpg
convert /tmp/cantor-check.png -background white -alpha remove \
  -crop 1080x900+0+950 /tmp/cantor-check-crop.jpg
```

Use the local image viewer on the flattened full screenshot and crop. Keep both
the before and after captures for any spacing or scale change. On this Xiaomi,
`screenrecord` has produced tiny/truncated MP4 files; verify a recording before
depending on it, and prefer a short screencap sequence for discrete states.

### Inspect native text and touch bounds

UIAutomator exposes React Native accessibility text, button bounds, and scroll
containers even when Skia artwork itself is not inspectable:

```sh
adb -s 6b1f6ba8629c shell uiautomator dump /sdcard/cantor-ui.xml
adb -s 6b1f6ba8629c pull /sdcard/cantor-ui.xml /tmp/cantor-ui.xml
rg -o 'text="[^"]*"[^>]*bounds="\[[0-9,]+\]\[[0-9,]+\]"' /tmp/cantor-ui.xml
```

MIUI may print a `theme_compatibility.xml` stack trace during the dump. If the
command ends with `UI hierarchy dumped to`, the XML was still written and can
be pulled normally.

### Close every visual pass

After checking the real device, run the repository checks from `cantor/`:

```sh
npm test -- --runInBand
npm run lint
git diff --check
```

At the time of writing, lint has two pre-existing inline-style warnings in
`App.tsx` and `src/onboarding/panels/kit.tsx`, and no errors. Treat new warnings
as regressions; do not mistake the existing two for changes from the current
task.

## How Cesar prefers to work

- Expose every tunable duration and size as a named constant in real units (for
  example seconds and pixels).
- Group those constants together and label them as **knobs**, with concise comments
  explaining what each controls. Do not bury tuning values in expressions.
- Iterate in small, precise passes.
- After a visual change, provide a runnable result and state exactly what to
  inspect on real hardware.
- When reporting a change, call out the relevant knob names and their exact values
  so tuning feedback can be equally precise.

# Cantor Project Context

This file is durable working context for coding agents. Treat it as guidance for
all work under `cantor/`. The code remains the source of truth when details drift;
update this file when the product direction or established motion rules change.

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
  controlled letter lag, then resolve into filled real glyphs.
- `transform`: a plain whole-object Manim transform. Glyph families align in
  reading order and all geometry uses one shared alpha—no matching cascade.
- `matching`: the original hierarchical character-matching gesture. Words glide,
  leftover characters match by proximity, and unmatched characters shape-morph.
- `crossfade`: the reduced-motion path and graceful geometry fallback.

All variants share font layout, clocks, glyph geometry, interruption handling,
and flicker-free UI-thread hand-offs. Keep the matching variant available even
when the product UI chooses the calmer whole-object transform.

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
- Prefer uniform spacing, even rhythm, regularity, and clear spatial order over
  deliberately uneven or noisy layouts.
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

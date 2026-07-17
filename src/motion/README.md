# The Cantor motion engine

`src/motion` is a self-contained re-implementation of **Manim's animation
grammar** (the 3Blue1Brown library) on `@shopify/react-native-skia` +
`react-native-reanimated`. Every effect in the app — glyphs morphing, letters
flying between titles, text writing itself on, the intro's Cantor bars becoming
a constellation — is one mechanism wearing different clothes:

> **Two verb-identical Skia paths, interpolated on a single linear 0→1 clock,
> where each element eases through its own `smootherstep` window of that
> clock.** Staggered starts, arcs over straight lines, nothing bouncy.

There are no imperative `animate()` calls anywhere. You change a React prop
(`text`, `shape`, `symbol`, `centerX`); the component diffs during render,
captures the outgoing animation exactly where it is, builds the new geometry
once, and plays it. **The prop change is the trigger.** Everything is
interruptible by construction: live geometry is a plain lerp between point
arrays, so "where is everything right now" is always answerable and a new
target can take over mid-flight without snapping.

This directory has **zero imports from app code**. Treat it as a library.

---

## Map

| Layer | Files | Role |
| --- | --- | --- |
| Components | `MorphText.tsx`, `MorphShape.tsx`, `AnimatedSymbol.tsx`, `CanonicalSymbol.tsx` | React shells, one Skia `Canvas` each; detect prop changes, build models, own clocks |
| Builders | `text.ts`, `glyphs.ts`, `silhouette.ts`, `shapes.ts`, `library.ts`, `symbolLibrary.ts`, `transition.ts` | Turn "A → B" into interpolable geometry; all policy (matching, pairing, windows) lives here |
| Math floor | `geometry.ts`, `clock.ts`, `fonts.ts` | Resampling, correspondence alignment, smootherstep, born clocks, synchronous font metrics |

`transition.ts` (the generic Slot model) is the raw engine for bespoke scenes;
the live components sit on the text and silhouette pipelines. The intro
(`onboarding/IntroPanel.tsx`) uses the math floor directly and is the reference
for hand-built scenes.

**Workbench:** flip `MOTION_LAB` in `App.tsx` to open `dev/MotionLab.tsx` —
tap shape chips fast (the interruption test: geometry must flow, never snap),
scrub the clock by hand, cycle phrases through every text variant.

---

## Quick start

```tsx
import {
  AnimatedSymbol, LIBRARY, MatchingText, MorphShape,
  TransformText, WriteText,
} from '../motion';

// A title that writes itself on first mount, then whole-line-morphs on change.
// ALWAYS reserve a fixed height — the canvas fills its container absolutely.
<TransformText
  text={title}
  charStyle={type.title}
  color={pal.ink}
  appearance="write"
  style={{ height: 78 }}
/>

// Trigger an animation: change the prop. That's the whole API.
setTitle('Where songs are made');

// Letters fly between phrases; unmatched leftovers shape-morph (the default).
<MatchingText text={phrase} charStyle={type.body} color={pal.ink}
              style={{ height: 44 }} />

// Symbols morph by name; position changes are morphs too (same geometry,
// new destination — do NOT wrap the component in a moving view).
<AnimatedSymbol symbol={playing ? 'note' : 'infinity'}
                width={w} height={168} color={pal.ink}
                centerX={playing ? w * 0.3 : w * 0.5} />

// Drive timing yourself: pass a 0..1 clock and the component never
// starts its own. Derived windows of a master clock are the intended use.
const clock = useSharedValue(0);
<MorphShape shape={LIBRARY.aleph} progress={clock} width={w} height={168}
            color={pal.ink} />
```

### Component reference

| Component | Use for | Key props |
| --- | --- | --- |
| `MorphText` | Any animated text | `text`, `charStyle`, `color`, `variant` (`matching` \| `transform` \| `crossfade`), `appearance` (`write` \| `fade` \| `none`), `duration`, `progress?`, `style` (fixed height!) |
| `TransformText` / `MatchingText` / `CrossfadeText` / `WriteText` | Same engine, explicit vocabulary at call sites | as `MorphText`, minus the pinned prop |
| `MorphTextSequence` | Several planned text transforms on one canvas, each in its own window of one external clock | `items` (with `start`/`end` windows and optional source slots), `writeWindow?`, `progress` |
| `MorphShape` | Shape/symbol morphing, moving, first-mount growth | `shape`, `width/height`, `scale`, `strokeWidth`, `aspectRatio`, `inkInset`, `centerX/Y`, `appearance` (`write`), `duration`, `progress?` |
| `AnimatedSymbol` / `WriteSymbol` | `MorphShape` keyed by canonical symbol name | `symbol` + `MorphShape` props |
| `CanonicalSymbol` / `SymbolArtworkPath` | Crisp settled artwork (no motion); the latter composes inside an existing `<Canvas>` | `symbol`, `size`/`width`/`height`, `strokeWidth` |

### Text variants, in Manim terms

- **`matching`** — `TransformMatchingShapes`. Whole words present in both lines
  glide as units; leftover characters match by identity + nearest relative
  position (flights longer than `MAX_FLIGHT_FRAC` of the line are demoted to
  exit+enter); whatever remains pairs in reading order and **shape-morphs** —
  the old glyph's outline bends into the new one's.
- **`transform`** — plain `Transform`. The whole line morphs as one coordinated
  object on a single shared window: no matching, no arcs, no cascade. Unequal
  lengths use Manim's invisible alignment copies (`alignFamily`).
- **`crossfade`** — simultaneous exchange. Also the forced reduced-motion path.

`appearance="write"` is Manim's `Write` / `DrawBorderThenFill`: each glyph's
exact outline traces on (stroke, first half), then resolves into its fill
(second half), cascading with Manim's lag ratio. Duration follows ManimGL's
rule: 1 s under 15 glyphs, 2 s at or above (`writeDurationMs`).

---

## House rules (breaking these causes the bugs this engine was built to kill)

1. **Linear clocks only.** If you drive `progress`, drive it linearly
   (`Easing.linear`); the smootherstep windows do all easing. Feeding an eased
   clock double-eases everything into mush.
2. **Fixed-height containers for text.** The canvas fills its container
   absolutely and reports no height; the page must never reflow mid-flight.
3. **Stable `charStyle` objects.** Components are memoized; a fresh style
   object every render defeats the memo and re-records a ticking canvas.
   Hoist styles to module scope.
4. **The Flicker Law: no completion callback may mutate the React tree.**
   Animated outlines hand ownership to already-mounted `<Glyphs>` on the UI
   thread (outline opacity → 0 and glyph opacity → 1 in the same worklet
   tick). Never "fix" this by swapping components in a `withTiming` callback.
5. **Born clocks, generation keys.** Every committed transition owns a fresh
   `bornClock(start)` and remounts its subtree under a `gen` key so an
   outgoing generation can never paint one frame against a newborn clock.
   Follow the pattern when adding variants.
6. **Verb identity is the contract.** `interpolatePaths` silently misdraws if
   from/to verbs diverge. Builders guarantee identity by construction and
   assert it in dev (`assertInterpolatable`); keep both sides of any new
   builder flowing through the same resample/align helpers.
7. **Respect reduced motion.** Every animated component must degrade to a
   crossfade under `useReducedMotion()`. `MorphText`, `MorphShape`, and
   `MorphTextSequence` already do; new components must too.

---

## How a transition is built (the trigger ritual)

All components follow the same five steps — read `MorphTextImpl` once and
you've read them all:

1. **Diff during render** — compare incoming props against the committed model
   (`model.text !== text`, build-key mismatch, …).
2. **Capture** — read the outgoing clock's current value and reconstruct live
   geometry (`captureModel` / `captureSilhouette` / `captureTransition`).
   This is why interruptions flow.
3. **Plan** — run the policy (`buildFlights` / `buildTransformFlights` /
   `buildSilhouetteTransition` / `buildGlyphMorphPaths`) producing
   verb-identical path pairs. Pure math, runs once, never per frame.
4. **Commit** — `setModel({ …, clock: bornClock(0), gen: ++genRef.current })`.
5. **Run** — one `withTiming(1, { easing: Easing.linear })` in an effect;
   cleanup cancels. If an external `progress` is present, skip this step.

Per-frame work is exclusively worklet math: derived values computing
`smootherstep(a, b, clock.value)` into path interpolations, opacities, and
transforms.

---

## Authoring shapes & symbols

A `Shape` is contours in a **0..100 box**, one contour per SVG string:

```ts
const lightning: Shape = {
  name: 'lightning',
  contours: [
    { d: 'M 55 20 L 38 55 L 50 55 L 43 80 L 66 45 L 53 45 Z', mode: 'stroke' },
  ],
};
```

- `mode: 'stroke'` — thin centerline, round caps, open or closed.
- `mode: 'fill'` — solid ink; **must close** (end with `Z` or touch endpoints).
- Optional `artwork: { d }` — an exact compound silhouette (outer rings +
  counters) used verbatim; see `symbolLibrary.ts` for the STIX/Noto-derived set.
- Optional `strokeWidth` (authoring units) and `aspectRatio`.

`validateShape` enforces the contract loudly in dev, and
`engine.test.ts` runs it over the whole library in CI — a bad path string
fails the build, not the demo. Add new shapes to `LIBRARY` (`library.ts`) or
`SYMBOL_LIBRARY` (`symbolLibrary.ts`); anything in there can morph into
anything else for free.

Weight tools: per-instance `strokeWidth` inflates/deflates exact artwork
uniformly (counters included); `meanInkThickness` (≈ 2·area/perimeter)
supports normalizing perceived weight across glyphs — see the intro's
constellation for the pattern.

---

## Tuning ("every constant is a taste lever")

Text windows on the 0..1 clock, in `text.ts`:

| Constant | Value | Meaning |
| --- | --- | --- |
| `EXIT_END` | 0.35 | exits fade out (rising `EXIT_RISE` = 8 dp) by here |
| `MOVE_START…MOVE_END` | 0.08…0.92 | the shared flight window |
| `MOVER_LAG` | 0.30 | fraction of the window spent cascading, reading order |
| `ARC_RATIO` / `ARC_MAX` | 0.16 / 22 dp | perpendicular flight bulge, applied as 4u(1−u), biased upward |
| `MOVER_DIP` | 0.15 | movers dim mid-flight |
| `ENTER_START` | 0.62 | entrances rise in (`ENTER_RISE` = 10 dp) after movers pass |
| `MAX_FLIGHT_FRAC` | 0.55 | longer would-be flights become exit+enter |

Write timing (`WRITE_*`) ports ManimGL's numbers: border/fill split at 0.5,
lag `min(4/(n+1), 0.2)`, 1 s/2 s auto duration. Slot cascades in
`transition.ts` use `STAGGER` = 0.08 with a `MIN_SPAN` = 0.5 floor so windows
can never invert regardless of slot count.

Judge changes in MotionLab, not in the flow.

---

## Testing

`jest` runs against **real CanvasKit** (see `jest.config.js`), so geometry
actually executes:

- `__tests__/engine.test.ts` — library-wide validation, silhouette/slot
  transitions stay verb-identical, capture reproduces endpoints, mid-flight
  retargets, stagger-window and alignment invariants.
- `__tests__/text.test.ts` — flight planning, Manim write timing laws, layout
  (centering, grapheme clusters, forced breaks, over-wide words). Layout tests
  load the real bundled `cmu-serif.ttf` because the jest default font has no
  typeface (all widths 0).

When you add a builder: test that its output pairs are interpolatable
(`from.isInterpolatable(to)`), that point counts match, and that capture at
t=0/t=1 reproduces the endpoints.

Text notes: `layoutText` segments by **grapheme cluster** (via
`Intl.Segmenter` when the runtime has it, code points otherwise), honors `\n`
as a forced break, and breaks over-wide words mid-word rather than
overflowing.

---

## Known limits / future work

- **Interruption alpha pop** — `captureBoxes` keeps a fading glyph only above
  α 0.25 and re-captures it at full alpha; a badly-timed interrupt can pop a
  30 %-visible glyph to 100 %. Fix: carry `alpha` on `CharBox` through capture.
- **Width changes snap** — text retargeting requires identical width and font;
  a rotation mid-flight rebuilds cold. Rescaling captured boxes into the new
  width would make it flow.
- **Build cost is unbudgeted** — planning runs synchronously in render
  (O(N²) alignment per contour pair). Fine on current devices; if a low-end
  target janks, memoize aligned pairs by `(from, to, size)` and/or prebuild
  heavy scenes.
- **MotionLab doesn't yet scrub the constants** — they're module `const`s.
  Restructuring into a `TUNING` object with lab sliders would close the loop
  the comments promise.
- **No golden-frame tests** — property tests cover structure; rasterizing
  mid-morph frames via CanvasKit and snapshotting would catch "the morph
  twisted" regressions.

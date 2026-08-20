# The zoom model

## Why not tabs

A tab bar is chunky chrome, and `cantor/AGENTS.md` asks for thin, delicate,
single-stroke forms and clear spatial order. More importantly, tabs would put
explore, library and player in three unrelated places when they are the same
object seen from three distances.

The Cantor set is self-similar: zoom into the middle thirds and the structure
repeats. The app is named after the one object in mathematics whose defining
property is that zooming reveals more of itself. So zoom is the navigation.

Originality is spent on the make/browse/listen loop, where the user lives and
where identity is made. Engines and settings take convention; nobody's love for
this app will come from a novel settings page.

## The four levels

| Level | Shows | Meaning |
| --- | --- | --- |
| **L0 FIELD** | every placement as a mark | the explorer |
| **L1 SHELF** | one cluster, as rows | a playlist, a week, a similarity group |
| **L2 SONG** | one song filling the view, playing | the player |
| **L3 GRAIN** | inside the audio | precision scrubbing |

L3 is not decoration. Zooming past a song enters its waveform, and the visible
window narrows as scale grows — so **zoom is the scrubber**. Desktop audio
editors work this way and no phone player does. Sample access from
`react-native-audio-api` is what makes it real rather than a picture.

### The field scale is fitted, never constant

`FIT` is the scale at which every placement is on screen at once, recomputed on
every layout and on canvas resize. Every other level is a ratio of it:

```
R_SHELF  5      L0: s/FIT <   2
R_SONG   30     L1: s/FIT <  13
R_GRAIN  670    L2: s/FIT < 170
                L3: otherwise
```

This is what makes the model work at any library size. Three songs and five
hundred both frame correctly, the level bands stay meaningful because they are
relative, and an arrangement that produces thirteen clusters does not overflow
the frame. A fixed field scale breaks all three.

### Crossfade, not switch

Representations overlap on the scale axis and cross-fade through `smootherstep`
windows expressed as multiples of `FIT`:

```
dot    0      → 0      → 2.0f  → 3.8f
row    1.2f   → 3.6f   → 12f   → 29f
song   12f    → 27f    → 178f  → 378f
grain  178f   → 467f   → ∞     → ∞
```

Exactly one representation is at full alpha at each canonical level. That is
the semantic zoom: marks *become* rows *become* a song, never cut to it.

## Gestures

| Gesture | Does | Why |
| --- | --- | --- |
| tap a mark | descend one level | primary path, no discovery needed |
| **back** | ascend one level | the Android back gesture already exists |
| pinch / scroll | continuous zoom | the expert accelerator, never the requirement |
| drag | pan | |
| **pull down** | compose | the composer descends over the current view |
| **pull up** | engines | what you make, and what makes it |
| tap origin | home to the fitted field | escape hatch |

Mapping ascend onto the system back gesture is what makes this viable — it
removes the undiscoverable pinch-out that kills most zoom UIs, and it costs
nothing to teach.

Pull-down spends the pull-to-refresh slot. Accept that: the library syncs live
over the tunnel, so manual refresh is a debugging affordance and belongs in the
engines sheet.

## The breadcrumb is the logo

The Cantor set is self-similar, so the mark showing *where you are* can be the
mark itself, with the third you are inside drawn solid and the rest faint.

```
L0   ▌▌ ▌  ▌▌▌▌  ▌ ▌▌     the whole set
L1   ▌▌ ▌  ░░░░  ░ ░░      you are in the left third
L2   ▌▌ ░  ░░░░  ░ ░░       …its left third
L3   ▌░ ░  ░░░░  ░ ░░
```

Launcher icon, onboarding animation and navigation indicator become one object,
and it is honest — the structure it draws is the structure being moved through.
Geometry already exists in `src/onboarding/cantorBars.ts`.

## A mark is a placement, not a song

Under an arrangement where membership is many-to-many, a song must appear in
every cluster it belongs to at once. So the field is built from **placements** —
`(song, group)` pairs — and one song can own several.

Everything downstream follows, and none of it is optional:

- hit-testing returns a placement, not a song
- the playing indicator lights **every** placement of the playing song
- changing arrangement fans a song's copies out from wherever it last stood
- zoom-to-song targets the nearest placement

This is the single most invasive consequence of playlists. Get it wrong and
multi-membership silently shows one copy.

## Two dials

Orthogonal, both extensible, and the reason the roadmap is a dial rather than
new screens.

**Arrangement** — *where marks sit*, and therefore what a shelf **means**:

| Axis | Shelf becomes | Status |
| --- | --- | --- |
| time | a week | v1 |
| playlist | a playlist | v1 |
| semantics | a cluster of things that sound alike | needs node embeddings |

**Lens** — *how each mark draws*:

| Lens | v1 | Notes |
| --- | --- | --- |
| name | yes | title, date, cluster, playlist tags |
| cantor wave | yes | 32 middle-thirds bars, height = RMS of that slice |
| vector scope | phase 2 | L vs R as a Lissajous curve |
| melgram, sphere, embedding map | later | plug into the same registry |

The same lens plugs into a mark, a row, and the full-screen player — differing
only in size and whether it is live. Ship two and the registry is proven.

**Name is deliberately not an arrangement.** Alphabetical clustering by first
letter produces thirteen near-meaningless buckets for generated music. The name
belongs in the lens (what the mark says), not the axis (where it sits).

### Semantic clusters get human names

When the semantic axis lands, clusters should be named from their content —
places, animals, feelings — not `Cluster 3`. "Harbour", "Foxes", "Melancholy".
The naming is a presentation concern over whatever the node returns; the axis
only has to supply grouping and position.

## The queue is not a screen

A generating song is a mark in the field **being drawn**. Its stage glyph writes
itself in as `JobProgress` advances and resolves into a finished mark at
`decode`. The song appears where it will always live, and you watch it come into
existence there.

Tap it to descend for stage, lyrics, pause, cancel, retry.

### Stage glyphs

From `src/motion/symbolLibrary.ts`, chosen to be semantically true rather than
decorative:

| Stage | Glyph | Why |
| --- | --- | --- |
| `plan` | **∇** nabla | gradient — the model finding a direction |
| `codes` | **ℵ₀** aleph-null | countable infinity; codes *are* discrete tokens |
| `diffuse` | **∮** contour integral | the loop, iterative passes over steps |
| `decode` | **𝄞** treble clef | latents become audible |

**The arc is built from the engine's stage mask, never authored as four acts.**
`node/crates/cantor-node/src/engine.rs` is explicit: LeVo derives its own
conditioning inside code generation, so its pipeline starts at `codes`. Stages
are a contiguous run ending at `decode`, and the app can only observe them as
they arrive unless `ModelView` advertises the mask.

The rest of the set stays literal: **𝄐** fermata = pause (it means *hold*),
**𝄋** segno = repeat (it means *return to the sign*), **∞** = the library,
**𝒞/𝔠** = Cantor's own marks, **∂** = variation.

## Playlists

The entire implementation is a reserved tag namespace. The text after the prefix
**is** the display name, so it round-trips through `SongPatch.tags` and survives
a reinstall with no protocol change and nothing for the node to learn.

```
tags: ["ambient", "p/Late Night", "p/Keep"]
```

| Concern | Resolution |
| --- | --- |
| many-to-many | three playlists = three tags. Free. |
| naming | the name is the tag; rename is a batch patch |
| ordering | none — **sets, not sequences**, which kills index rot |
| empty playlists | cannot exist; creating one *is* adding the first song |
| collisions | compared case-folded, stored form kept for display |
| across backends | unions by name, so a playlist spans nodes for free |
| namespace | `p/` is reserved; the tag editor hides and rejects it |

Ordering is dropped deliberately. These are *collections*, not mixtapes, and
manual order is what makes tag-encoded playlists rot.

## Core + declared extension

`ModelView` is `{ selector, family, engine }` and the catalog carries no
parameter schema, so today the app cannot know that ACE-Step takes BPM and LeVo
does not.

Caption, lyrics and duration render **identically for every model**. Everything
else is declared by the node and rendered generically, below a rule. The app
never hard-codes knowledge of an engine.

Requires additions to `ModelView` (a parameter schema and the stage mask) and
`GenerationRequest` (an extension map). Those are compatibility contracts —
see [`milestones.md`](milestones.md), M8.

When a model is not installed on the selected engine, say so and give the
command: `cantor pull acestep:1.5-fast`. `Needs.vram_bytes` in the catalog lets
the app explain *why* an engine cannot run it.

## Cache honesty

The existing model is already right: `remote → partial → cached → pinned`, with
`enforceCacheBudget(maxBytes)` in `AudioStorage.kt`. `cached` is a temporary
copy, `pinned` is guaranteed. The only gap is last-played tracking so eviction
is LRU rather than arbitrary.

The design obligation is honesty: **never show a "downloaded" state that can
silently become false.** Cached and pinned must look different, so a song
disappearing is never a surprise.

## The empty start

A zoom UI is glorious at 500 songs and absurd at zero, and every user starts at
zero. So the origin mark is the first thing in the field and songs accumulate
around it — the app visibly grows outward from a point. Same screen on day one
as at 500 songs, and a better empty state than any illustration.

The harder problem is upstream: a new user must install a node on another
machine before the app does anything. Generating one short clip on the phone
during onboarding — slow, not the recommended path, but *theirs* — turns the
ask from "install this to try it" into "install this to make it fast". That is
onboarding work and is out of scope here, but the field's empty state should
assume it lands.

## Motion budget

Non-negotiable, from `cantor/AGENTS.md`:

- mathematical easing only — smoothstep/smootherstep or deliberate cubics.
  Never bouncy, elastic or spring-like.
- **one Skia canvas drawing N paths, never N canvases.** This is the difference
  between fine and unusable at a few hundred marks, and it constrains the lens
  API from day one: a lens is a *draw function into a shared canvas*, not a
  component.
- the Flicker Law applies to every hand-off between Skia-drawn marks and React
  text. One owner per glyph; a React commit is not proof Skia has painted.
- reduced motion turns zoom transitions into crossfades.
- protect the measured baseline: 5.15% janky frames, 17 ms p90.

## Known risks

| Risk | Mitigation |
| --- | --- |
| **Accessibility** — a zoom canvas is opaque to screen readers where tabs are free | a parallel semantic list, built in M2, not retrofitted |
| **Gesture conflict** — pinch vs scroll vs scrub | strict zones; back-to-ascend removes the worst of it |
| **L1 does the most work and is the least novel** | it is a list; spend the polish budget there, not on the flourishes |
| **The field is only truly spatial under semantics** | by time or playlist, 2D position is partly arbitrary. Honest, and the reason M9 matters |
| **Discoverability** | the origin mark is persistent; the hint line states the gesture for the current level |

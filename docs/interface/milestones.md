# Execution

Two phases. Phase 1 proves the concept end to end on real hardware and can be
lived in. Phase 2 adds the depth and the extensibility, and is where the
protocol work lands.

**No milestone depends on a protocol change until M8.** That is deliberate:
everything through M7 ships against today's wire format.

Every milestone ends the same way — the repository checks pass, and the result
is inspected on the Xiaomi (`6b1f6ba8629c`) per the playbook in
`cantor/AGENTS.md`. Motion is not verified in Jest.

---

## Phase 1 — the spine

### M1 · The field engine, headless

`src/field/` in full: types, camera, bands, layout, hitTest, and the time
arrangement. No React, no Skia, no runtime.

Port `camera.ts` and `layout.ts` from the mockup rather than re-deriving them —
the fitted scale, level bands and crossfade windows are verified.

**Done when** Jest drives every arrangement × scale with zero throws, and
asserts: the field fits a 380×800 frame at `FIT`; exactly one band is at full
alpha per canonical level; every song is reachable in every arrangement.

**Risk** — none. Pure code, no device.

### M2 · L0 and L1 on screen

`FieldCanvas.tsx` (one canvas), `useFieldCamera.ts`, `OriginMark.tsx`,
`FieldOverlay.tsx`, `FieldA11yList.tsx`, `PullSheet.tsx`. The name lens.
Gestures: tap-descend, back-ascend, pinch, drag. `FieldScreen` renders real
library data from `useBackendRuntime`.

Accessibility list ships **here**, not later.

**Done when** you can browse the real library by zoom on the phone, the origin
mark tracks depth, and back ascends reliably from every level.

**Risk** — gesture conflict between pan, pinch and the system back gesture.
Resolve with strict zones before adding anything else.

### M3 · The player

`src/player/` with the `react-native-audio-api` adapter. `AudioStorage.kt`
grows `localPath()`; `AudioPlayback.kt` is deleted. L2 lands: `SongSurface`,
transport, scrub rule, the playing mark lit at every level.

**Done when** a cached song plays, pauses, seeks and survives backgrounding,
and the playing indicator is visible at L0 without any mini-player chrome.

**Risk — the highest in phase 1.** `react-native-audio-api` is Web Audio in RN,
not a music-player library. Background playback and lockscreen controls need
verifying against RN 0.86 and the New Architecture **before** M3 starts. If it
cannot do background audio, `PlayerPort` is why swapping it is cheap — but find
out in a spike, not in M3.

### M4 · Compose, and generation as marks

`ComposerSheet` with the three core fields, engine and model chips, the
not-installed state. `JobMark`: stage glyph, progress ring, controls. Jobs
render as marks in the field.

The condense gesture: the caption transforms into the mark via `TransformText`.
Read the Flicker Law before wiring the hand-off.

Stage sequence comes from **observed** stages, since the mask is not yet
advertised — do not assume four.

**Done when** submitting from the phone produces a mark that draws itself
through the real stages and resolves into a song, with no queue screen anywhere.

---

## Phase 2 — the depth

### M5 · Lens registry

`src/lenses/` proper: `types`, `registry`, `analysis`, `cantorIntervals`, and
`cantorWaveLens` as the second implementation. A lens picker at L2.

Two lenses is the point — one proves nothing about the abstraction.

**Done when** switching lens re-skins marks, rows and the player from one
control, and the field still holds frame rate at a few hundred marks.

### M6 · Playlists and placements

`src/playlists/`, `byPlaylist` arrangement, `PlaylistChips`, and the
**placement** refactor if it was not already the shape from M1.

**Done when** a song in three playlists draws three marks in three clusters,
the playing indicator lights all three, toggling membership re-forms the field,
and the change survives a reinstall through `SongPatch.tags`.

**Risk** — this is the invasive one. If M1 modelled marks as songs rather than
placements, this milestone is a rewrite of the field. Model placements from the
start.

### M7 · L3 grain

`GrainView`, sample-resolution waveform, zoom-as-scrubber, the vector scope
lens.

**Done when** zooming past a song narrows the visible window continuously and
scrubbing by zoom is more precise than the L2 rule.

### M8 · Protocol: declared parameters and stage mask

The first wire change. `ModelView` gains a parameter schema and a stage mask;
`GenerationRequest` gains an extension map. `ModelParams.tsx` renders whatever
the node declares.

Wire bytes are a compatibility contract — regenerate from
`protocol/transport/v1/spec.json`, never hand-edit, and coordinate the node and
relay together. See `docs/refactor/hacking-protocol.md`.

**Done when** ACE-Step shows BPM/steps/CFG and LeVo shows nothing, with no
engine names anywhere in the app, and the generation arc is drawn ahead of time
from the advertised mask.

### M9 · Semantics

`bySemantics` arrangement backed by node embeddings, with clusters named from
their content — places, animals, feelings — rather than `Cluster 3`. The
embedding-map lens.

**Done when** position in the field means similarity, which is the point at
which the zoom model fully earns itself.

**Depends on** node work to compute and carry embeddings. Largest unknown here;
scope it separately before committing.

---

## Sequencing risks

| Risk | When it bites | What to do |
| --- | --- | --- |
| marks modelled as songs | M6 becomes a rewrite | model placements in M1 |
| `audio-api` cannot do background/lockscreen | M3 | spike **before** M3 |
| N canvases instead of one | M5, at scale | lens = draw function, enforced in M1 |
| accessibility retrofit | after ship | `FieldA11yList` in M2 |
| protocol churn | M8 | nothing before M8 may assume the new fields |
| the first-run wall | at launch | onboarding work, tracked separately |

## Out of scope here

Onboarding (including generating a clip on-device to survive the first-run
wall), the node-side embedding work in M9, Cantor Cloud, and any social or
sharing surface beyond a system share of the audio file and the recipe.

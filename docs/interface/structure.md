# Structure

## Dependency direction

Unchanged from [`../refactor/hacking-app.md`](../refactor/hacking-app.md). The
new modules slot into the existing tree; they do not create a parallel one.

```text
screens                          compose
    ↓
features/                        render
    ↓
field/ · lenses/ · player/       decide how it looks and sounds
    ↓
runtime/ · playlists/            decide what is true
    ↓
core/ · backends/ · library/ · jobs/ · audio/ · security/
```

Three rules that keep this honest:

**`src/field/` has zero React and zero React Native imports.** It is pure
geometry, arithmetic and data — camera, layout, placements, hit-testing, level
bands. That is what makes it testable in Jest without a canvas and portable to
the mockup and back.

**A lens is a draw function, not a component.** `(ctx, box, song, opts) => void`
against one shared Skia canvas. The moment a lens is a component you get N
canvases and the field dies at a few hundred marks.

**Nothing under `field/`, `lenses/` or `player/` imports `runtime/`.** Data
arrives as arguments. The binding happens in `features/` and `screens/`.

## What survives from today

Keep, untouched: `core/`, `security/`, `backends/`, `runtime/`, `library/`,
`jobs/`, `identity/`, `motion/`, `onboarding/`, `theme/`, and the native audio
**storage** in `AudioStorage.kt`.

Retired in M4, once the field replaced them: `screens/MainScreen.tsx`,
`features/library/`, `features/jobs/`, `features/backends/`, and
`android/.../audio/AudioPlayback.kt` with the native `play`/`stop` bridge.
Playback lives in `src/player/`, so native storage no longer holds a player: the
caller releases a file before removing it and passes the protected path into
cache-budget enforcement.

`useBackendRuntime` is the seam. Its commands (`submit`, `controlJob`,
`patchSong`, `changeSongPresence`, `getSongDetail`, `audio`, `refreshLibraries`)
are what the new UI binds to. **The runtime should barely change** — if a
milestone wants to rewrite it, the design is wrong.

## New modules

### `src/field/` — the zoom engine (pure)

| File | Owns |
| --- | --- |
| `types.ts` | `Placement`, `Group`, `Camera`, `Level`, `Arrangement` |
| `camera.ts` | `worldToScreen`, `screenToWorld`, `fit()`, `levelOf()`, log-scale tween. Pure functions over a `Camera` |
| `bands.ts` | the crossfade windows as multiples of `FIT`; `win(s,a,b,c,d)` and `smootherstep` |
| `layout.ts` | groups → grid → placements. Dynamic columns (`√n`), centred short last row, fan-out origins for relayout |
| `hitTest.ts` | screen point → placement, with the L1 row band |
| `arrangements/index.ts` | the registry: `{ key, label, group(songs) }` |
| `arrangements/byTime.ts` | week buckets |
| `arrangements/byPlaylist.ts` | one group per `p/` tag, plus `Unfiled` |
| `arrangements/bySemantics.ts` | cluster id → group; named clusters when the node supplies them |

`camera.ts` and `layout.ts` are the two files worth porting verbatim from the
mockup. They are verified.

### `src/lenses/` — how a song draws

| File | Owns |
| --- | --- |
| `types.ts` | `Lens = { key, label, draw(ctx, box, song, opts) }` and `LensOpts` (alpha, progress, live) |
| `registry.ts` | registration and lookup; the only place a lens list exists |
| `nameLens.ts` | title, date, semantic cluster, `p/` tags, `×n` for multi-membership |
| `cantorWaveLens.ts` | 32 middle-thirds intervals, bar height = RMS of that slice |
| `scopeLens.ts` | L vs R Lissajous (phase 2) |
| `analysis.ts` | RMS/envelope/peak extraction, memoised per `(songId, resolution)` |
| `cantorIntervals.ts` | middle-thirds interval generation, shared with the origin mark |

### `src/player/` — playback

| File | Owns |
| --- | --- |
| `types.ts` | `PlayerPort` — `load/play/pause/seek/position/duration/state`, plus `samples()` for lenses |
| `audioApiPlayer.ts` | the adapter's state machine. No React, and no import of the audio library |
| `createAudioApiPlayer.ts` | binds the adapter to `react-native-audio-api` |
| `PlayerHost.tsx` | the app's single `<Audio>` element, and the system wiring around it |
| `fakePlayer.ts` | hand-clocked `PlayerPort` for tests above this layer |
| `playerContract.ts` | the behavioural suite both implementations run |
| `usePlayer.ts` | hook: current song, transport, position, exposed to features |
| `analyser.ts` | live sample/FFT taps for L2 and L3 lenses |

`PlayerPort` exists so the library choice stays swappable. **Position must not
be polled at 60 fps.** Take duration and a start timestamp, run the visual on a
Reanimated clock, and resync on discrete events.

Three files touch the library rather than one, because it has no imperative way
to create a streaming file source: `StreamerNode` is deprecated in favour of the
`<Audio>` element, so the element must be rendered by React even though the port
is imperative. `audioApiPlayer.ts` therefore holds the state machine and stays
free of both React and the library; `PlayerHost.tsx` renders the element and
owns the audio session, the playback notification and the remote-control
subscriptions; `createAudioApiPlayer.ts` binds the two. Swapping engines means
replacing that trio, not touching a feature.

`PlayerHost` mounts **once**, above anything that plays. A second mount is a
second element and a second audio session. It renders the element for as long as
a source exists and changes only the `source` prop, because each source swap
leaks about 1.6 MB — see [`m3-audio-gate.md`](m3-audio-gate.md).

Needs `AudioStorage.kt` to expose a `localPath()` to JS — the path stays
app-private, and nothing crosses the trust boundary.

### `src/playlists/` — the `p/` namespace (pure)

| File | Owns |
| --- | --- |
| `playlists.ts` | `PL_PREFIX`, `playlistsOf`, `plainTagsOf`, `normalise`, `toggle`, `allPlaylists`, `rename` |
| `usePlaylists.ts` | binds toggling to `runtime.patchSong` |

Every `p/` string literal lives in `playlists.ts`. Nothing else parses tags.

### `src/features/field/` — the rendered field

| File | Owns |
| --- | --- |
| `FieldCanvas.tsx` | **the one Skia canvas.** Iterates placements, calls lens draw functions, applies band alphas |
| `useFieldCamera.ts` | camera state, tweens, gesture handlers, back-to-ascend |
| `OriginMark.tsx` | the Cantor-set breadcrumb; depth from `levelOf` |
| `FieldOverlay.tsx` | engine chip, depth label, hint line |
| `FieldA11yList.tsx` | the parallel accessible list — built in M2, never retrofitted |
| `PullSheet.tsx` | the shared pull-down/pull-up tongue and its threshold |

### The remaining features

| Path | Owns |
| --- | --- |
| `features/composer/ComposerSheet.tsx` | caption / lyrics / duration, engine + model chips |
| `features/composer/ModelParams.tsx` | node-declared extension fields, rendered generically (M8) |
| `features/composer/NotInstalled.tsx` | the `cantor pull …` state |
| `features/song/SongSurface.tsx` | L2: live lens, transport, scrub rule |
| `features/song/PlaylistChips.tsx` | `p/` add/remove |
| `features/song/SongDetail.tsx` | seed, engine, digests, lyrics |
| `features/song/JobMark.tsx` | stage glyph + progress ring + controls |
| `features/engines/EnginesSheet.tsx` | list, status, load |
| `features/engines/PairFlow.tsx` | install command → `cantor pull` → QR → paste fallback |
| `features/grain/GrainView.tsx` | L3 waveform window and precision scrub |
| `screens/FieldScreen.tsx` | composition and wiring only — the single surface |

## File-level rules

- Knobs at the top of the file, named, in real units, grouped and commented.
  No tuning value buried in an expression.
- A feature component receives data and callbacks. It never calls
  `BackendConnection`.
- Anything persisted goes through the repository that owns the key.
- Styles live beside their component.
- Every feature directory has an `index.ts`.

## Tests

| Layer | How |
| --- | --- |
| `field/`, `playlists/`, `lenses/analysis.ts` | plain Jest. Pure functions, no canvas |
| `field/layout.ts` | placement counts, multi-membership, no lost songs, fit geometry per arrangement |
| `lenses/` | real CanvasKit, per `AGENTS.md` — never a mocked canvas |
| `features/` | render tests against fake runtime data |
| motion, hand-off, flicker | **real hardware only.** Jest correctness is insufficient |

The mockup's harness is the model for the pure tests: drive every arrangement ×
scale × lens, assert zero throws, then assert placement and geometry invariants.

```sh
cd cantor && npx tsc --noEmit && npx eslint . && npx jest
```

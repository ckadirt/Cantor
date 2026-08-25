# Interface implementation steps

This is the living build guide for the interface described in
[`design.md`](design.md). [`milestones.md`](milestones.md) decides the order and
the outcome of each milestone; this document decides how to reach those
outcomes without weakening the framework described in
[`../refactor/hacking-app.md`](../refactor/hacking-app.md).

The HTML prototype at `reports/cantor-zoom-mockup.html` is the behavioural
tie-breaker. Port its fitted scale, camera maths, relative level bands,
crossfade windows, grid layout and fan-out behaviour. Do not re-derive them.
Onboarding is unchanged.

## Working agreement

- `FieldScreen` becomes the default post-onboarding surface in M2. Keep the old
  console code only until its remaining capabilities have moved, then remove it
  at the end of M4.
- Keep `useBackendRuntime` as the application seam. Components receive data and
  callbacks; they never open a connection or read a persisted key directly.
- The field is one Skia canvas. A lens draws into that canvas; it is never a
  component and never creates a canvas per mark.
- Keep geometry, placement, grouping and hit-testing pure. Anything under
  `field/` has zero React, React Native or Skia imports.
- Put every tunable size and duration at the top of its owning file, grouped as
  **knobs**, named in real units and explained in one short comment.
- Use linear clocks with `smootherstep` windows. Reduced motion keeps the same
  states and replaces spatial transitions with crossfades.
- Preserve storage keys, stored JSON shapes, native file layouts, application
  errors and encrypted transport. Generated files are regenerated, never
  hand-edited.
- Finish each milestone with automated checks and a physical-phone pass on the
  Xiaomi identified in `cantor/AGENTS.md`. Motion is not accepted from Jest
  alone.

For reviewability, build each milestone in this order: pure models and tests,
ports/adapters, feature controller, rendering, then device qualification. Do
not mix a protocol change or unrelated redesign into an earlier milestone.

## Shared interface shapes

These boundaries should exist before features begin depending on them. Names
may be adjusted to match TypeScript conventions, but their ownership and
semantics are fixed.

### Field read model

The field never uses a bare song ID as identity because songs come from several
nodes. Normalise runtime data into a small read model:

```ts
type FieldEntity = {
  key: string; // `${nodePublicKey}:${songOrJobId}`
  nodePublicKey: string;
  entityId: string;
  kind: "song" | "job";
  createdAtMs: number;
  tags: readonly string[];
};

type Group = {
  key: string;
  label: string;
  entityKeys: readonly string[];
  cx: number;
  cy: number;
};

type Placement = {
  key: string; // arrangement + group + entity
  entityKey: string;
  groupKey: string;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
};
```

A mark is always a placement. Hit-testing returns a placement; focus retains a
placement; the player compares the placement's entity to the playing song.
This is required even while the only arrangement is time, so M6 is an addition
instead of a field rewrite.

Jobs use their canonical job ID as `entityId`. Completed songs use that same ID,
which gives the job-mark-to-song hand-off a stable identity.

### Arrangement

```ts
type Arrangement = {
  key: string;
  label: string;
  group(entities: readonly FieldEntity[]): readonly ArrangementGroup[];
};
```

The registry is the only list of arrangements. Each arrangement decides only
membership, labels and stable group keys. `layout.ts` alone decides positions.

### Lens

```ts
type Lens = {
  key: string;
  label: string;
  draw(
    canvas: SkCanvas,
    box: LensBox,
    song: LensSong,
    options: LensOptions
  ): void;
};
```

`draw` must be worklet-safe and allocation-conscious. `FieldCanvas` records the
variable drawing commands into one immediate-mode Skia
[`Picture`](https://shopify.github.io/react-native-skia/docs/shapes/pictures/)
and renders that picture inside the single on-screen canvas. Prepare fonts,
paints, paths and song data outside the canvas renderer; do not read React
context from it.

### Player

```ts
type PlayerSnapshot = {
  state: "empty" | "loading" | "paused" | "playing" | "ended" | "error";
  track: AudioRef | null;
  positionSeconds: number;
  durationSeconds: number;
  error: string | null;
};

interface PlayerPort {
  load(ref: AudioRef, localPath: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  unload(): Promise<void>;
  snapshot(): PlayerSnapshot;
  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void;
  samples(request: SampleRequest): Promise<SampleWindow>;
}
```

`usePlayer` is the feature-facing owner of the current track, notification
actions, interruptions and the visual clock. A component never imports the
concrete audio library.

### Playlists

Every `p/` literal and every operation on that namespace lives in
`playlists.ts`. The public pure helpers are `playlistsOf`, `plainTagsOf`,
`normalise`, `toggle`, `allPlaylists` and `rename`. Names compare
case-insensitively after trimming, while the stored spelling remains the
display spelling. New storage is canonical `p/<display name>`.

## Phase 1 — the spine

### M1 · The field engine, headless

#### Build

1. Add the field types, point/box helpers and constants. Use descriptive
   `scale` names in public types even if the prototype's local variable is `s`.
2. Port `worldToScreen`, `screenToWorld`, focal-point zoom, `fit`, `levelOf`
   and level-camera targets. A camera flight interpolates position normally and
   scale logarithmically.
3. Port the relative levels exactly:

   ```text
   R_SHELF = 5       FIELD when scale/FIT < 2
   R_SONG  = 30      SHELF when scale/FIT < 13
   R_GRAIN = 670     SONG  when scale/FIT < 170
                         otherwise GRAIN
   ```

4. Port `smootherstep` and the four representation windows as multiples of the
   fitted scale. Keep the shelf-label window separate from representation
   alpha.
5. Port the grid layout: dynamic columns from group count, centred short final
   row, fixed world-space group/song gaps, target positions and last-position
   fan-out sources.
6. Compute `FIT` from target placement bounds, safe viewport space and named
   padding knobs on every layout or viewport change. An empty field uses the
   origin and a documented default scale.
7. Implement placement hit-testing. At L0 use mark distance; at L1 also accept
   the row band. Return the nearest winning placement deterministically.
8. Add the arrangement registry and `byTime`. Production weeks are local-time
   ISO weeks, Monday through Sunday. Keep the date-to-week-key helper pure and
   separately tested.

#### Tests

- Empty, 1, 3, 34 and 500-entity layouts fit a 380 x 800 viewport at `FIT`.
- Re-fitting after rotation/resize keeps every target placement within the safe
  frame.
- Exactly one representation is fully opaque at each canonical level.
- World/screen conversion round-trips within floating-point tolerance.
- Focal zoom keeps the world point below the fingers fixed.
- Short final rows are centred and placement keys remain stable after relayout.
- Local ISO weeks cover Monday/Sunday, year boundaries and a daylight-saving
  boundary without losing or duplicating an entity.
- The harness iterates every registered arrangement and representative scale
  with zero throws and every input entity remains reachable.

#### Exit gate

No React, React Native, Skia or runtime imports exist under `src/field/`. The
pure test suite proves the mockup's camera and layout invariants.

### M2 · L0 and L1 on screen

#### Build

1. Add a field controller that projects backend snapshots into `FieldEntity`
   records and a keyed presentation map containing the `SongHeader`, backend,
   readiness, node labels, delivery artifact and native audio state. Exclude
   trashed songs from the spatial field.
2. Build `FieldCanvas` as one canvas with one recorded picture per rendered
   frame. Cull placements outside a named overscan margin before invoking the
   active lens.
3. Implement the name lens directly against `SkCanvas`: dot at L0, title/meta/
   duration row at L1, and shared band alpha from `bands.ts`. Prepare bundled
   CMU Serif, Spectral and mono fonts outside the frame loop.
4. Implement `useFieldCamera` with shared values for camera, focus placement,
   layout transition and fitted scale. Retarget an interrupted flight or
   relayout from the currently rendered values.
5. Compose gesture ownership explicitly:
   - pinch wins over pan and zooms around its focal point;
   - a one-finger drag pans after the tap slop is crossed;
   - top and bottom edge zones may claim a vertical pull before pan begins;
   - a tap that never crosses slop runs placement hit-testing;
   - opening a sheet cancels the active camera gesture.
6. Clamp camera scale to L1 until M3. Tapping at L0 flies to the placement's
   group; tapping a row records focus but cannot enter an unimplemented L2.
7. Handle Android back in this order: close the open sheet, ascend one level,
   otherwise return `false` at L0 so Android performs normal app back.
8. Build the origin mark from `onboarding/cantorBars.ts`. Its highlighted
   interval is derived from camera position and `levelOf`; tapping it clears
   focus and flies to fitted field.
9. Add the engine chip, level label, current-level hint, storage error and
   offline status as a React Native overlay outside the canvas.
10. Add `FieldA11yList`, using the same groups, placements, labels and descent
    callbacks. At L0 it announces groups and placements with group context; at
    L1 it lists the focused shelf's rows. Do not expose duplicate canvas nodes
    to accessibility services.
11. Add the conventional engines sheet with paired-node status, the existing
    pairing flow and manual `refreshLibraries`. Wire the bottom pull and engine
    chip to the same sheet.
12. Replace `MainScreen` with `FieldScreen` in the ready branch of `App.tsx`.
    Keep the old files temporarily for the M3/M4 capability migration, but do
    not retain a second default interface or a permanent feature flag.

#### Tests and device pass

- Render tests use fake runtime data for loading, empty, offline, ready, storage
  error and multi-backend libraries.
- Gesture tests cover tap-versus-pan, pinch focal stability, edge pulls, sheet
  cancellation and back at every implemented level.
- Accessibility tests prove every visible placement has a labelled semantic
  action and the canvas itself is hidden from traversal.
- On the phone inspect full/cropped screenshots in light and dark mode, rotate,
  resize, pan at field edges, interrupt camera flights and verify reduced
  motion.

#### Exit gate

The field is the default post-onboarding UI, real cached library data can be
browsed through L0/L1, pairing and refresh remain reachable, and back always
has a predictable result.

### M3 · The player

#### Audio feasibility gate

Before player feature work, create a throwaway spike against an exactly pinned
`react-native-audio-api` version. The spike must prove on RN 0.86/New
Architecture and the physical Android phone:

- native build and cold launch;
- local app-private Opus decode and duration;
- play, pause, seek, completion and repeated track replacement;
- screen-off and background continuation;
- Android notification/lock-screen play, pause and seek;
- audio focus/interruption recovery;
- bounded memory for a maximum-duration song and repeated load/unload.

The library documents [Opus
decoding](https://docs.swmansion.com/react-native-audio-api/docs/utils/decoding/)
and a [playback notification
manager](https://docs.swmansion.com/react-native-audio-api/docs/system/playback-notification-manager/),
but its current [compatibility
table](https://docs.swmansion.com/react-native-audio-api/docs/other/compatibility/)
does not yet list RN 0.86. Treat successful device results, not API presence, as
the decision. If every gate passes, build `audioApiPlayer`. If build,
background playback or lock-screen control fails, use AndroidX Media3 behind
the same `PlayerPort`; keep audio-api only for sample decoding/analysis if that
isolated use passes. Record the result and exact dependency version at the top
of the M3 implementation log.

#### Build

1. Add `PlayerPort`, `PlayerSnapshot`, sample types, a fake player and contract
   tests before the concrete adapter.
2. Add `localPath(nodeKey, songId, digest)` to `AudioStorage` and the native
   bridge. It returns only a digest-verified cached or pinned file, never a
   partial path, and touches last-used time only when playback actually loads.
3. Split storage actions from playback. Replace `LocalAudioStore.play` with
   verified path resolution; retire the native `play`/`stop` surface and
   `AudioPlayback.kt` after the new adapter passes the same physical playback
   gate.
4. Coordinate destructive audio actions: unload the active reference before
   removal and pass the active path/reference as the protected entry during
   cache-budget enforcement. Native filesystem inspection remains
   authoritative.
5. Adjust the runtime audio command to own download, pin, unpin and remove. The
   player controller performs load/play after a download resolves; runtime must
   not import `player/`.
6. Implement `usePlayer`. On play, store the native/audio-context start time
   and seek offset, then drive visual position with a Reanimated clock. Resync
   on load, play, pause, seek, completion, notification actions, interruption
   and app resume; never poll native position at 60 fps.
7. Unlock L2 and implement `SongSurface`: active lens, title, model/seed,
   transport, coarse scrub rule, elapsed/duration, honest remote/partial/cached/
   pinned state and every-placement playing indicator.
8. Add plain-tag/title/favourite/trash controls and `SongDetail` for lyrics,
   engine, attempts and digests. Put trashed-song restore, manual cache cleanup
   and other maintenance in the engines/settings sheet so they do not become a
   fifth zoom level.
9. Keep L3 clamped until M7.

#### Tests and device pass

- Run the same `PlayerPort` contract suite against the fake and concrete
  adapter where possible.
- Extend JVM coverage for verified `localPath`, corrupt files, last-used time,
  removal of an active reference and LRU protection.
- Test remote-to-partial-to-cached playback, download resume, pin/unpin/remove,
  player replacement, end-of-track and adapter errors.
- On hardware verify backgrounding, screen lock, notification actions,
  headphone/Bluetooth interruption, app kill/reopen expectations and the L0
  playing indicator.

#### Exit gate

A cached or newly downloaded song plays, pauses, seeks, survives the qualified
background cases and appears as the playing object at every implemented level,
with no mini-player chrome.

### M4 · Compose and generation as marks

#### Build

1. Build `ComposerSheet` with caption, lyrics and duration validated against the
   selected node's byte/second limits. Keep draft state in a composer
   controller, not in the sheet component.
2. Treat the selectable model set as the union of installed model selectors
   advertised by paired nodes. A backend chip chooses the target node. If that
   node does not advertise the selected model, show
   `cantor pull <selector>`, explain offline/unavailable state where known and
   disable submission.
3. Keep one submission guard and route submission through `runtime.submit`, so
   the existing persisted outbox and idempotency behaviour remain intact.
4. Extend the runtime read model only enough to expose persisted outbox entries
   indexed by `(nodePublicKey, canonicalJobId)`. This gives job marks their
   caption/request without adding it to `JobView` or duplicating storage.
5. Merge jobs into field entities using their canonical ID and creation time.
   In time arrangement they occupy their production week. Later playlist
   arrangement treats them as `Unfiled` until a song with tags exists.
6. Render these job states:
   - queued/preparing/running/pause-requested/paused/cancel-requested/
     recovering/finalizing as live marks;
   - failed as an actionable mark with retry when allowed;
   - cancelled as absent;
   - completed until a same-ID `SongHeader` is observed, then hand ownership to
     the song without changing the placement identity.
7. Draw the current stage using ∇, ℵ₀, ∮ or 𝄞 from the canonical symbol library.
   When `progress.total` is present, the ring and glyph write use
   `completed/total`; otherwise use a restrained indeterminate trace and never
   fabricate a percentage.
8. Before M8, remember only stages actually observed for that job. Do not
   display a four-part future arc.
9. Expose valid pause/resume/cancel/retry actions by reusing the pure
   `jobControls` policy and `runtime.controlJob`.
10. On submit, transform the persisted caption into its placed job mark with
    `TransformText`. Keep the outgoing representation until the incoming canvas
    has painted the terminal frame; never use a React completion callback to
    swap glyph ownership.
11. After all current console capabilities have an owner in the new interface,
    remove `MainScreen`, `features/library`, `features/jobs` and
    `features/backends`. Preserve reusable pairing, policy and formatting code
    by moving it to the new owner rather than copying it.

#### Tests and device pass

- Test model union/availability, UTF-8 validation, duplicate taps, offline
  submission, outbox recovery and job-to-song identity.
- Test every lifecycle state's visibility and valid controls, including missing
  totals and failed non-retryable jobs.
- Interrupt caption condensation and job-stage changes repeatedly on hardware;
  inspect for duplicate/missing glyphs and one-frame flashes.
- Submit through a real encrypted node and watch the mark appear, progress and
  resolve into the published song.

#### Exit gate

The make/browse/listen spine is usable without the old console. Generation is a
field object, not a queue screen, and the old post-onboarding UI has been
retired.

## Phase 2 — depth and extensibility

### M5 · Lens registry

#### Build

1. Extract the M2 name drawing into the formal lens registry. Registry keys are
   unique and the registry is the only source for picker labels/order.
2. Add Cantor middle-thirds interval generation. Depth five produces exactly
   32 ordered, non-overlapping intervals inside `[0, 1]`.
3. Add analysis functions for RMS, peak and envelopes. Cache by
   `(nodePublicKey, songId, artifactDigest, resolution)` so a replacement
   artifact cannot reuse stale analysis.
4. Add `cantorWaveLens`: one bar per interval, height from interval RMS, with
   the current playback portion distinguished at L2.
5. Never auto-download audio for decoration. A remote or partial song draws a
   neutral equal-height Cantor skeleton; cached, pinned or loaded audio upgrades
   to real analysis without changing placement.
6. Add one lens picker at L2. Changing it updates L0 marks, L1 rows and L2
   together.
7. Keep paints, fonts, paths and interval arrays reusable. Do not allocate one
   object per visible placement on every frame.

#### Tests and device pass

- Test registry uniqueness, interval geometry, RMS/envelope bounds, cache
  invalidation and unavailable-sample fallback as pure functions.
- Draw each lens at mark, row and song sizes against real CanvasKit.
- Exercise every lens x canonical scale x registered arrangement in the
  harness.
- Profile a 500-placement field on hardware. Protect the measured 5.15% janky
  frames and 17 ms p90 baseline; document any unavoidable regression before
  continuing.

#### Exit gate

Two lenses prove the draw-function abstraction and one control consistently
re-skins every distance without creating more canvases.

### M6 · Playlists and placements

#### Build

1. Implement `playlists.ts`. Trim names, reject empty/control-character input,
   compare names case-insensitively, preserve the first stored spelling for
   display and enforce existing tag count/UTF-8 byte bounds before patching.
2. Hide all `p/` tags from the plain tag editor and reject attempts to create
   them there. Playlist UI is the only writer of the reserved namespace.
3. Add `byPlaylist`: each playlist is a group, each membership emits a
   placement, and songs/jobs without membership go to `Unfiled`. Merge groups
   across backends by normalised display name.
4. On arrangement or membership change, map each entity to its last visible
   point. New copies begin there and fan out to their new placement targets;
   disappearing copies finish their current visual transition before removal.
5. Keep focus as a placement. Opening a song by another route chooses its
   nearest placement; the playing state highlights every placement whose
   entity is that song.
6. Add `PlaylistChips` at L2. Creating a playlist means adding it to the current
   song; empty playlists do not exist.
7. Implement rename as a batch of existing `SongPatch.tags` calls. There is no
   cross-node transaction, so report failures per song/node, retain successes
   and allow retry; never imply an atomic rename.

#### Tests and device pass

- Cover zero, one and three memberships; case collisions; plain-tag isolation;
  tag limits; toggle idempotence; rename; cross-backend union and `Unfiled`.
- Prove placement count equals total memberships plus unfiled entities, no song
  is lost, hit-testing identifies the correct copy and all playing copies light.
- Change membership and arrangements mid-animation repeatedly on hardware and
  check for snaps, ghost marks and wrong focus.
- Reinstall/re-pair and verify playlists reconstruct solely from song tags.

#### Exit gate

A song in three playlists has three real placements, edits persist through the
existing song contract and no playlist state exists outside tags.

### M7 · L3 grain

#### Build

1. Unlock L3 and port the visible-window relationship from the prototype:
   visible duration shrinks continuously as camera scale grows beyond the grain
   target, with named minimum/maximum clamps.
2. Pinch around the gesture's focal timestamp so the audio point under the
   fingers remains stable. Horizontal drag moves the time window and seeks the
   centre playhead. Clamp the window and seek at both track boundaries.
3. Request only the sample resolution needed for the current window and
   viewport. Bound decoded memory and reuse analysis buffers across nearby
   scales.
4. Draw the waveform, centre playhead, visible-duration label and resolved
   sample detail in the shared field canvas. Reduced motion changes only the
   crossfade, not the continuous scrub mapping.
5. Add `scopeLens`, drawing left versus right samples as a Lissajous curve.
   Mono, remote, partial or invalid audio uses the same neutral fallback policy
   as the Cantor-wave lens.
6. Keep playback time authoritative. A scrub issues a discrete seek and then
   restarts the visual timestamp clock from the acknowledged position.

#### Tests and device pass

- Test window/scale round-trips, focal stability, start/end clamps, duration
  changes and resolution bounds as pure functions.
- Test mono/stereo/empty/corrupt sample windows and vector-scope bounds.
- On hardware compare L2 and L3 seek precision, scrub while playing/paused,
  background and return, and pinch/drag gesture competition.

#### Exit gate

Zooming past a song reveals progressively finer real samples and produces a
more precise scrub than L2 without polling playback at frame rate.

### M8 · Declared parameters and stages

This is the first application-wire milestone. It is an additive v2 change; the
relay carrier and secure layers do not change.

#### Public protocol additions

```text
ModelView.stages: GenerationStage[]
ModelView.parameters: ModelParameter[]
GenerationRequest.extensions: map<string, ParameterValue>
```

`ModelParameter` is a tagged union with these initial forms:

- integer: key, label, default, minimum, maximum, step;
- number: key, label, default, minimum, maximum, step;
- boolean: key, label, default;
- choice: key, label, default, ordered string choices;
- text: key, label, default, maximum UTF-8 bytes.

`ParameterValue` is scalar only: number, boolean or string. Parameter `key` is
the field name the engine expects in its JSON input; the app never translates
an engine family or selector.

Bound the extension map to 32 entries, 64 UTF-8 bytes per key and 4 KiB encoded
total. Validate that each key is declared once and that submitted values match
the selected installed model's kind, range, step/choice and text bound.

#### Build

1. Add the protocol types in `cantor-proto` with `serde(default)` and omitted
   empty values so old clients still parse new node messages and new clients
   treat old nodes as declaring no extensions.
2. Keep legacy top-level `steps` and `cfg` accepted for old clients. The new UI
   sends declared fields through `extensions`. Reject a request that supplies
   the same canonical engine field through both paths rather than silently
   choosing precedence.
3. Add ordered `stages` and parameter schemas to catalog variants. Extend the
   lenient catalog parser and persist both in installed variant markers.
   Markers written by older releases decode with empty declarations; do not
   guess metadata. Re-running `cantor pull <selector>` refreshes the marker from
   the catalog even when its blobs already exist.
4. Project persisted declarations into `ModelView`. Convert the engine's
   internal bitmask into the ordered contiguous stage list once on the node;
   the app does not interpret engine ABI bits.
5. Validate extensions during admission against the exact installed variant,
   before outbox acknowledgement or durable sidecars.
6. Flatten validated extension keys into the engine's initial JSON alongside
   caption, lyrics and duration. Keep explicit duration and legacy input
   reassertion/security checks intact.
7. Update the app's untrusted-input decoders for every new tagged shape and
   bound. Missing declarations remain the M4 behaviour: core fields only and
   observed stages.
8. Implement `ModelParams` as a generic renderer over the tagged union. It owns
   draft values and local validation but contains no engine/model names.
9. Draw the generation arc from `ModelView.stages` before work begins; continue
   using real `JobView.stage` and progress for the active segment.
10. Run Rust tests to regenerate committed TypeScript bindings. Do not edit
    generated TypeScript. The transport manifest does not change for additive
    application fields; run its generator with `--check`.
11. Update and verify the relay catalog asset. Relay application handling stays
    untouched because the payload is encrypted opaque bytes.

#### Compatibility tests

- Old app with new node: extra `ModelView` fields are ignored and legacy
  requests still run.
- New app with old node: no parameter controls or future stage arc are shown,
  and no extension map is sent.
- New app/node: ACE-Step fixtures declare BPM/steps/CFG; LeVo fixtures declare
  only what its catalog provides and its stages begin at `codes`.
- Reject duplicate keys, unknown keys, bad tagged schemas, wrong value kinds,
  non-finite/out-of-range values, oversized keys/maps and legacy/extension
  collisions.
- Catalog parser, installed marker round-trip, admission, sidecar recovery and
  engine JSON all preserve the declared values exactly.

#### Exit gate

Different engines expose different controls and stage arcs without a selector,
family or engine-name branch anywhere in the app.

### M9 · Semantics design gate

Do not start production implementation from the current one-line milestone.
First land an ADR and deterministic fixture spike that settle these contracts:

- which embedding model/version runs, on which node capability and at what
  lifecycle point;
- whether embeddings derive from caption, lyrics, audio or a documented
  combination;
- SQLite columns/tables, model/version provenance, migrations, invalidation and
  incremental recomputation;
- whether raw embeddings ever leave the node, or the app receives only cluster
  membership, coordinates and names;
- stable cluster/placement IDs while songs arrive or embeddings refresh;
- human-name generation, provenance and deterministic fallback names;
- cross-backend meaning: independently named node clusters, app-side merging or
  a shared embedding/version space;
- owner isolation, encrypted message shapes, offline cache and corruption
  policy;
- missing/stale embedding behaviour and the performance budget for hundreds of
  songs.

The spike uses a checked-in fixture library, clusters it reproducibly, assigns
human-readable names, adds/removes songs incrementally and produces the exact
app-facing payload proposed by the ADR. It must render 500 resulting placements
within the field performance budget without exposing prompts, audio or
embeddings outside the encrypted path.

After ADR approval, implementation order is fixed: node computation and
persistence, owner-scoped application projection, generated protocol bindings,
app cache/runtime projection, `bySemantics`, embedding-map lens, then encrypted
end-to-end and device qualification. The ADR replaces this gate with concrete
steps; do not invent those decisions inside feature code.

## Verification matrix

Every milestone runs:

```sh
cd cantor
npx tsc --noEmit
npx eslint .
npx jest --runInBand
cd android
./gradlew app:testDebugUnitTest app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a
cd ../..
git diff --check
```

M8 and any later protocol/node work also run:

```sh
node protocol/transport/generate.mjs --check
node --test protocol/transport/generate.test.mjs
node --test node/scripts/lib/transport.test.mjs

cd node
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace

cd ../relay
npx vitest run
npm run check
```

Close every visual milestone with the physical-phone workflow in
`cantor/AGENTS.md`: target the named device, capture a flattened full screenshot
and a focused crop, inspect accessibility bounds, replay interruptions and then
rerun the repository checks.

## Review gates

A milestone is not complete if any answer below is “yes”:

- Did a component call `BackendConnection` directly?
- Did field geometry acquire a React, React Native or Skia dependency?
- Did a lens create a component or a canvas per placement?
- Did a bare song ID become cross-backend identity?
- Did a persisted key/shape or native path change without compatibility work?
- Did the app infer engine-specific parameters or stages from a model name?
- Did an animation hand glyph ownership across a React completion callback?
- Is a canvas action missing from the parallel semantic interface?
- Was a generated file hand-edited?
- Did the phone qualification or required automated matrix remain incomplete?

When implementation reveals that this guide, `design.md`, `structure.md` or
`milestones.md` has drifted from executable truth, update the relevant document
in the same milestone. The code is the source of truth; undocumented divergence
is not.

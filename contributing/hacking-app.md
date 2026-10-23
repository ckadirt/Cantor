# Hacking the Cantor app

The app is the React Native client in `cantor/`. It pairs with nodes, submits
generations, mirrors the library offline, downloads encrypted audio, and plays
it back. Node library and job state come from authenticated nodes; this phone
also keeps saved submissions visible while they wait or send.

Read `cantor/AGENTS.md` before touching motion or Skia code — the Flicker Law
and the Shapes/Verbs/Clock model are not negotiable and are not repeated here.

## Dependency direction

```text
screens / feature components        render
        ↓
feature controllers and hooks       own screen state
        ↓
domain services and ports           decide
        ↓
protocol / repositories / native and network adapters
```

The core must not import a screen, a WebSocket, or a React Native bridge type.
`core/` is the bottom of the tree and imports nothing above it.

## Module map

| Path | Owns |
| --- | --- |
| `src/core/` | `errors`, `text`, `validation`, `protocol` decoders and constants, `storage` primitives (including `storage/sql.ts`, the SQL port and migration runner; tests bind it to Node's SQLite with `jest/nodeSqlite.ts`), `transport` (the generated manifest constants), `store`/`useStore` (the external store every shared state lives in) |
| `src/security/` | `descriptor` verification, `carrier` and `inner` codecs, `secureTunnel` orchestration, `native` channel factory, `types` |
| `src/backends/` | `BackendConnection` façade, `relaySocket` lifecycle, `requestRegistry`, `applicationResponses` decoders, `pairing`, `storage` |
| `src/runtime/` | `BackendRuntime` — a plain object publishing one store: backend records, connection lifecycles, snapshots, cache hydration, persistence, outbox flush, audio inspection, feature commands. `useBackendRuntime` starts it for a component's life |
| `src/features/` | `field/` (the canvas, camera, controller, overlays), `find/` (the tags blind, set as an index), `song/` (player surface and sheet), `composer/`, `engines/`, `curtain/`, `controls/` |
| `src/screens/` | `FieldScreen`: the one screen after onboarding — composition and wiring |
| `src/library/` | cached library repository, `find` (the folded search index and the layout-ordered matcher), and the pure `sync` reducer |
| `src/work/` | pure `deriveWork`, submission/job matching, derived job ids and the plan a piece of work runs. The field and sheets read `Work`, never the outbox or snapshots directly |
| `src/notices/` | transient notices keyed by subject, their lifetime, and the hook lending them the field foot’s hint seat |
| `src/facts/` | what is known about a song, with provenance: `types` (subjects, providers, readings), the `device_song_fact` repository, the service that runs providers in order and remembers the answer, `lyrics` (the `recipe` → `file-tags` → `lrclib` providers) and `recipeWords` (`wordsOf`, the one reader of a made song's words) |
| `src/jobs/` | job repository and the submission outbox |
| `src/audio/` | `AudioRef`, the `LocalAudioStore` port, its repository implementation, and the native bridge |
| `src/device/` | songs whose files live on the phone (device import): the phone database's schema (`schema.ts`), its op-sqlite binding (`database.ts`, the only importer of op-sqlite), `repository.ts`, and `native.ts`, the bridge to `CantorMedia` (Kotlin `media/`: MediaStore list, fingerprint, album art and its brightness grid for the cover lens, a file's embedded lyrics — read only), and `lyrics.ts`, the adapters behind the `file-tags` and `lrclib` fact providers: each answers found, none, or (LRCLIB offline, 429, 5xx) unreachable with its `Retry-After`. LRCLIB is the app's one network call that is not the relay; it learns a title, an artist and a length, never audio |
| `src/identity/` | phrase derivation, mnemonic, and keychain-backed identity |
| `src/lenses/` | how a song is drawn: the lens contract (`contract.ts`), the registry (`LENSES`, `LENS_UI`, `LENS_PAIRS`), the circle (`nameLens.ts`), the seal (`sealLens.ts`, `sealPlayer.ts`, geometry in `seal.ts`) and the cover (`coverLens.ts`: the circle's marks, an imported song's album art as hairline glyphs at the player, from `cover.ts`), marbling (`marbleLens.ts`; geometry in `marble.ts`, the mark in `marbleMark.ts`, the strokes in time in `marbleTimeline.ts`, the player and its live shader in `marblePlayer.ts`, the settled bath on its own worklet runtime in `marbleBath.ts`), pair morphs (`pairs.ts`), its `analysis`, and the `AnalysisStore` that measures songs once and keeps them; `motion/` (the motion track, its store and the per-frame `MotionFrame`) and each lens's motion (`circleMotion.ts`, `sealMotion.ts`) |
| `src/motion/`, `src/onboarding/`, `src/theme/` | the motion engine and the onboarding experience |
| `src/player/` | the player contract, the react-native-audio-api player and its fake, `PlayerHost` (the one player for the app's life), scrub sessions, output latency and sync offsets, the visual clock, and what happens after a song ends (`afterSong.ts`) |
| `src/playlists/` | playlists as the `p/` tag namespace on songs, and every operation on it |
| `src/network/` | whether the phone has a connection at all, from `CantorNetworkModule.kt` |
| `src/update/` | updating Cantor from inside Cantor: the `cantorfm.com/app/latest.json` decoder (`manifest.ts`), the controller and its persisted marks (`appUpdate.ts`), and `native.ts`, the bridge to `CantorUpdateModule.kt` (download, verify, install through `PackageInstaller`). See "Releasing the app" |
| `src/haptics/` | the rationed haptics (`tick`, `click`, `confirm`), backed by `CantorHapticsModule.kt`; nothing else buzzes |
| `src/marks/` | identity marks drawn from public keys: the phone's seal and a node's station |
| `src/field/` | the field's pure geometry: layout and arrangements, camera levels and bands, bloom and gather, filter, glide, rail, shelf queue, hit testing |
| `src/dev/` | developer labs and HUDs (motion lab and bench, sync check, perf HUD), switched by constants at the top of `App.tsx`; every one ships off |

## The rules that are not obvious

**`BackendConnection` is the app-facing façade.** Its internals — socket
lifecycle, secure tunnel, request registry, transfer and sync state machines —
are replaceable. Its surface should not churn.

**One atomic request registration.** `RequestRegistry` binds the expected
response, decoder, resolver, and timeout together. A request registered any
other way will leak or resolve twice.

**Native filesystem state is authoritative for audio.** `LocalAudioStore`
inspects the device rather than trusting a cached flag. If you add advisory
state, reconcile it explicitly.

**Shared state lives in a store, and keeps unchanged objects.** `BackendRuntime`
and `AnalysisStore` publish through `core/store`; a component selects the part it
reads with `useStore`. Writers return the previous object when nothing changed —
a snapshot, a song, a presentation — because everything downstream (the layout,
the canvas's mappers) treats a new object as new work. A song's audio file is
inspected once when it appears and every file again only after something that
can evict (a finished download, an unpin); do not go back to inspecting on every
snapshot.

**Select the part you show, never the whole runtime.** `FieldScreen` starts the
runtime with `useRuntime` (no subscription) and selects slices — backends, each
node's phase, pairing, errors — and the field's songs from
`fieldControllerStore` (`features/field/`), a store that follows the runtime and
builds the controller outside React. A running job's progress changes only
`jobs`, which is read by `LiveFieldCanvas`, the job sheet's selector and
`LiveEnginesSheet` (while open); reading `useBackendRuntime`'s whole state
re-renders the caller on every job tick.

**Library sync is a pure reducer.** `library/sync/state.ts` returns
`{state, effects}`. Keep decisions there and side effects at the caller, so
reconnect, revision conflicts, and resume are testable without a socket.

**Draft reset behavior is characterized, not improved.** The current
song-draft reset on a remote revision is preserved deliberately. A better
dirty-draft conflict policy is separate product work.

**A superseded socket cannot speak.** Only the currently owned socket may start
keepalive, deliver messages, report closure, or schedule a retry.

**Transient notices have one seat.** `src/notices/` replaces by subject key
(`audio:<entityKey>`, `work:<workKey>`), newest first. Failed row audio actions
(download/keep/remove) offer TRY AGAIN; a durable submission refused after Make
has closed the composer posts its `submissionFailure`. The foot's hint line at
L0/L1 morphs into `words.short` and an optional action, then back into the hint.
Notices wait at L2/L3, where the player's transport owns the foot. Unactionable
notices stand for `NOTICE_KNOBS.STANDS_MS` (6000 ms); actionable ones stand until
acted on, cleared, or replaced. The full sentence is the accessibility label.
Sheet and composer errors (`songProblem`, `songDetailError`, `jobError`, composer
`error`) stay on their surface; playback errors stay in the transport; OFFLINE
stays in the header. A durable submission timeout remains pending, without a
notice. Storage/settings failures belong to Settings, never over the field dial.

**A song's facts carry where they came from, and unknown is not none.**
`src/facts/` asks providers in order; the first `found` wins, `none` passes
on, and nothing found with any provider out of reach is `unreachable`, rested
(`FACT_KNOBS.BACKOFF_MS`, or LRCLIB's `Retry-After`) and asked again on the
next opening or TRY AGAIN. Only `found` and `none` are final; the subject is
the song's field key, which changes with an imported song's audio. Lookups
start when a sheet opens (a made song's once the sheet has its recipe) and
when a version opens. The composer never fetches words: the draft's `same` is
an intent, and `withSourceWords`/`wordsModeOf` resolve it against the fact on
every render, so words that land while it is open fill the row, and a choice
the person made stays. A new fact kind is a new `FactKind` and its providers;
a new source of words is one more provider.

**Acts are declared; the composer renders inputs, not act names.** A model's
acts come from `ModelView.acts`, or, from a node that predates them, the
built-in three in `core/protocol/acts.ts` (`actsOf`), kept identical to the
node's `builtin_acts`. The composer draws the source (a song or a tune) and
then one row per declared input, in the declaration's order (`SourceRows`'
`InputRow`); `audioPromptFor` sends one field per declared input plus
`act_id`, and an input the act does not declare (lyrics included) is never
sent. An optional prompt with `from_source` sends, for an empty caption,
the source's own description (a made song's recipe caption, carried as
`source.prompt`) and shows it as the placeholder; with no
description (an imported song, until a node can listen) the act needs a
prompt and the placeholder says why (`captionOf`, `promptPlaceholder`),
unless the node advertises the prompt `heard`: then an empty prompt is sent
and the node listens to the source (`heardByNode`; stage `listen`, ∂). A
song made from a source is named by its act's words (`titleOf`: `Variation
of Terraza`), never by its caption; the sheet's From row names the source. Words for an act come from `wordsForAct`: the
app's own for ids it knows, else made from the catalog's `label`. Nothing
outside `core/audioActs.ts`'s word table branches on an act id. A new act
made of known inputs needs no app change; a new input kind needs its row in
`SourceRows`, its rule in `problemsWith`, its fields in `audioPromptFor`, and
its parser case in `parseActs` (which otherwise drops the act).

**A made song's recipe is kept on the phone.** `library/recipes.ts` stores
every `SongDetail` the app fetches (phone database, `node_song_recipe`) and
`FieldScreen` keeps the recipe of every song whose audio is cached or pinned,
while its node is ready. The sheet and the lyrics fact read through
`recipes.detail`: the node when it answers, the kept copy when it does not.
A made song never changes, so a kept recipe never goes stale. When a song's
node is away and its audio is on the phone, an act that takes an upload opens
on another ready node from that copy, and its From it door says so
(`FROM THE COPY ON THIS PHONE · SENT TO <NODE>`): the copy is the delivery
file, not the master, and the result lives on that node.

## Recipes

### Add a screen

1. Create the screen under `src/screens/`, composing feature components.
2. Give it a feature controller hook only when it owns state; otherwise start
   the runtime with `useRuntime` and select what it shows with `useStore`.
3. Wire navigation in `MainScreen`. Do not reach around the runtime to open a
   connection.

### Add a lens

1. Write it in `src/lenses/<name>Lens.ts` as a `Lens` (`types.ts`): `key`,
   `label`, `identity(recipe)` (JS, cached per recipe — from the recipe alone,
   which is the two-layer rule), `player(recipe, analysis, cover, track)` (JS;
   null if its player is its mark grown; `track` is the song's motion track
   when its sound is built from the bars), `touch` (JS: `reachRatio`, `landAt`, `seekAt`, in
   coordinates about the player's centre), and `ui` — worklets and numbers only
   (`drawMark`, `drawPlayer`, `ringTicks`, `hearsPlayhead`, `clock`), because it
   is captured onto the UI thread. `drawPlayer`'s last argument is the
   `MotionFrame` (or null): a lens that moves reads only that, scales every
   gesture by `frame.presence × arrived`, and draws the still player exactly
   when either is 0. Define a worklet helper above its caller — a worklet
   captures the functions it calls when it is created. Draw solid ink whole
   wherever `paints.share` is above 0 (the field and the motion layer
   crossfade a landed player; two half-inked moving shapes read as a ghost),
   and say in `clock.lettersOutside` which side of its ring the form's letters
   stand. A player too costly to rebuild every frame that still changes as the
   song plays has a **slow layer**: `ui.bakeKey(player, seconds)` names the
   version the playhead needs (an integer that changes rarely) and
   `bake(player, key)` rebuilds it on the JS thread — or hands it off — and
   gives the result to `drawPlayer` through a shared value the player holds.
   The renderer (`features/field/lensBake.ts`) calls it while the lens shows.
2. Add it to `LENSES` in `registry.ts`. The picker lists it, the renderer draws
   it, and a change to or from it takes the generic two beats. Mark it
   `preview: true` until it is done: the picker offers it only while
   `PREVIEW_LENSES_OFFERED` is on, and a saved lens key is a contract.
3. For a hand-written player morph with another lens, add a `LensPairMorph` to
   `pairs.ts`; at `t` 0 it must look like its `a` lens's own player.
4. Extend `lensGoldens.test.ts` and `playerRingGoldens.test.tsx` with frames
   of the new lens, and check it on the phone at L0, L1 and L2 and through a
   change each way.

Nothing under `features/field/` should need to change. If it does, the contract
is missing something — add it to `contract.ts` rather than special-casing the
lens in the renderer.

### Add a feature component

Put it under `src/features/<feature>/`, export it from that feature's
`index.ts`, and keep its styles beside it. Components receive data and
callbacks; they do not call the connection.

### Add a runtime command

1. Add the command to `BackendRuntimeCommands` in
   `src/runtime/useBackendRuntime.ts`.
2. Implement it through the connection façade and the repositories, not
   through a screen.
3. If it mutates persisted state, go through the repository that owns the key —
   `backends/storage.ts`, `library/repository.ts`, `jobs/repository.ts`, or the
   outbox — so storage keys and merge policy stay in one place.

### Add a node request

1. Add the decoder to `backends/applicationResponses.ts`.
2. Add the method to `BackendConnection`, registering the request through
   `RequestRegistry`.
3. Surface it as a runtime command; the screen calls the command.

### Change the native audio or secure bridge

The Kotlin side lives under `cantor/android/app/src/main/java/com/cantor/app/`.
`CantorSecureModule` is only the bridge: session registry plus the canonical
base64 boundary. `SecureChannel` owns Noise and session limits, `FragmentCodec`
and `FragmentReassembler` own record framing. Add JVM tests before moving any
of it; the React Native method names, arguments, return shapes, and error text
are the contract.

Reading a song's samples (`PlayerPort.samples`, for the analysis and the L3
grain) is native first: `CantorAudio.reduce` → `AudioReduction.kt` →
`src/main/cpp/AudioReduction.cpp`, the app's only C++, compiled into React
Native's `libappmodules` through `src/main/jni/CMakeLists.txt`. It decodes with
react-native-audio-api's own decoders — its FFmpeg for `.mp4`/`.m4a`/`.aac`,
its miniaudio (looked up with `dlsym` in its library) for everything else — so
the columns match what plays. `player/nativeSamples.ts` falls back to the JS
decode if the native side throws. **Upgrading react-native-audio-api** can
break it (the FFmpeg paths, the dispatch rule, the exported `ma_*` symbols);
the fallback keeps the app working, but re-check native reduction against the
JavaScript fallback on representative audio formats after an upgrade.

## Forgetting and recovering engines

Forgetting removes the pairing record and stops its connection. It never touches
the node's durable library, and it keeps every song you **pinned** — `GET` and
`KEEP` both pin, so a pin means you asked for it. Cached copies and part
transfers are released: `cached` is a loan under the audio budget, which
`enforceCacheBudget` reclaims by LRU on every download, and a field that kept
marks standing on those would watch them vanish with no engine left to ask
again. `availabilityOf` is where the two promises are written down; keep any new
policy agreeing with the words the row already shows.

The runtime hydrates cached metadata for all nodes, including forgotten ones,
and verifies audio against native storage, so the field shows an unpaired node's
songs only where a pinned file is really on disk — after a restart too.
Re-pairing with the same app identity restores the full owner-scoped library,
released audio included. Playlist membership is stored in song tags (`p/<name>`)
on the node and returns with library sync; empty playlists have no separate
durable record.

Releasing audio has two orderings that are not optional: the socket is stopped
before any file is deleted, so a transfer in flight is cut before its bytes go,
and the screen closes the transport first when the track being played is one of
the released copies — the rule a row's `REMOVE` already follows. A song that
leaves the field while the camera is standing in it is handled one layer down;
see the `lastVisualPlacements` trap below.

## The shelf queue

`field/queue.ts` is pure: a `ShelfQueue` is the group a song was started from
plus the seating it had then, and `stepFrom` walks the *live* seating when the
group still holds the song, falling back to the saved one. `features/field/
useShelfQueue.ts` owns every way of moving along it — a song running off its
end (read against `player/afterSong.ts`: continue, stop, repeat), the L2 steps,
and the lock screen's next/previous through `PlayerHost`'s `onStep`.

Three rules that are not optional:

- **`ended` is heard on `PlayerPort.subscribe`, never in an effect.** The song
  that matters ends with the screen off, where a React commit may not happen.
  The advance, the fetch, the source swap and the notification all run in doze;
  this was verified on the Xiaomi with the phone `Dozing`.
- **Every play takes a ticket.** An advance mostly waits on a download; a tap
  meanwhile takes a newer ticket and the stale advance must not open its track.
- **Ask native storage for the path before fetching.** `fetchPath` tries
  `audioPath` first, because `commands.audio('download')` throws "not connected"
  for an offline node even when the file is on the phone.

"Previous" restarts the song past `RESTART_WITHIN_SECONDS`, read from the
port's `snapshot()` — the element's position events keep arriving in doze; the
visual clock does not move without frames. The camera follows with
`useFieldCamera.step`: ascend to the row, then descend into the neighbour on the
first flight's landing. A step can be retargeted during its first leg (a song
that refuses at once is stepped over while the camera is still folding), and a
follow that happens with the screen off is deferred to the next `active`.

## Android playback lifetime

`audio/PlaybackSurface.kt` retains the existing React surface while a playback
session exists. `MainActivity` attaches that surface to a new window when the
app is reopened and detaches it without unmounting on activity destruction.
Its mutable context points at the application while detached, so the surface
does not retain a destroyed activity. The foreground service has
`stopWithTask=false`; retaining the service alone would not preserve the React
audio element or the shelf queue. Queue ownership and stepping remain unchanged.

`AudioApiPlayer` serializes and coalesces notification updates. Its production
factory claims audio focus/session activity and marks the native surface active
for the playback session, releasing both after the notification is hidden.
`PlayerHost` translates Stop and permitted dismissal to `player.stop()`. Pause
retains the session. The dependency patch exposes a separate Stop button for
legacy notifications and an Android 13+ custom media action alongside Pause.

Stop invalidates pending duration inspection, settles an outstanding element
load, and refuses later automatic loads. `FieldScreen` resolves playback paths
through `player.resolvePath`, so a download that started before Stop cannot
restart playback. Only deliberate UI play/step calls `beginSession`; notification
next/previous continue to call the existing queue callbacks. `usePlayer.open`
also verifies that the requested track is ready before starting it. These are
playback-lifetime guards, not another queue or a change to queue tickets.

Once a stopped session is detached, its surface is released. If the UI remains
open, it stays usable for another deliberate play. `App` reapplies status-bar
appearance when becoming active because the retained React tree may now live
in a new Android window. There is no queue persistence, process-death recovery,
or automatic playback after Force stop or reboot.

## Playback gestures and field lenses

`player/scrubSession.ts` owns a silent seek transaction: pause once, preview on
the shared position clock, seek on release, and resume only if playback was
running before the drag. `SongSurface` finalizes on gesture completion and
unmount. Track replacement cancels ownership so a late release cannot seek the
next song. Ordinary seeks also reconcile the visual clock after native seek.

Circle and Seal share `NativeFieldContent` through the lens contract
(`lenses/contract.ts`; the recipe for a new lens is below). A lens change is
`(from, to, t)` on one retained linear clock (`features/field/lensClock.ts`,
`SEAL_PLAYER_KNOBS.LENS_MORPH_MS = 420`) that `drawFieldFaces` reads in two
beats for marks and rows: the lens being left scales in to its centre, then the
one arriving scales out. The player uses a pair morph where one is registered
(`lenses/pairs.ts`): circle ↔ seal walks the dots out of the contour in time
order and the contour becomes the Peano thread, while `PlayerRing` mixes the two
lenses' `ClockShape`s, widening the circle's arc out to the seal's rim.
The seal's geometry is pure and Skia-free in `lenses/seal.ts` (masks, Peano
order, per-dot sound, `sealDotAt`); its identity is one cached path per song
(`sealMarkPath`); its player is drawn a dot at a time by `drawSealPlayer`
(`lenses/sealPlayer.ts`): mark dots split into their children as
`songShapeArrival` runs, and the sound rises on the scene's sound clock
(`SEAL_PLAYER_KNOBS.SOUND_MS`), restarted with the focus, when a measurement
lands. `seekGesture` asks the
lens drawn at the player what a touch means (`Lens.touch`): the circle scrubs by
angle; the seal scrubs by rim angle and treats a touch that starts on the dust
as a tap that jumps to the dot under it.
**Marbling** is suminagashi
with Jaffer's exact equations: drops of ink and clear water, and tines. Every op
is a homeomorphism, so ring outlines never cross and the whole bath is one
even-odd path of the rings whose colour differs from their parent's
(`MarbleRing.toggle`). Its identity is the recipe's drops and strokes; its sound
is a drop a bar round the dial, a comb at each section start and a bullseye on
a drop (`marbleTimeline`), built from the motion track. At the player the
*settled* bath — everything landed — is baked into an image (ink in red,
outlines in green) on a worklet runtime of its own (`marble-bath`; on the
Xiaomi a late bar is 150–300 ms of CPU raster, which cost frames on either
drawing thread), every fourth op; a runtime shader (`MARBLE_SKSL`) runs the
inverse of the ops between the bake and the playhead per pixel and tints the
image. Rings are refined as ops stretch them (`applyMarbleOpRefined`) or
combs leave chords across the pattern. The seek is the seal's rim, by angle
anywhere on the disc. Its morphs (`marbleMorph.ts`) are the motion engine's
silhouette morph: both drawings as rings, wound by nesting depth and filled
nonzero (crossing ink stays ink), paired — by id within one song (a bath's rings
in the order they fell), else by size, place and role — resampled, aligned and
lerped per frame, each ring in its own window. The bath runtime builds them with
each bake, in its own unit (a bath's rings over its extent), from what JS asks
(`BakeAsk`: the rise, a seek, a step from the song before, the other lenses'
sides from `marbleSides.ts`), and sends them as typed arrays; the UI thread
only lerps, and builds one itself only when it came without. A seek while
playing (`drawMarbleSeek`) holds the bath until the new bake lands, then
morphs. The cover pair morphs its strokes (filled toward marbling, stroked at
its own end); `marbleArrivesOver` (the drop) is the fallback for a lens with no
model to morph.
`analyseWindow` keeps per-bucket loudness, punch (crest factor) and width
(side/mid, from `SampleWindow.stereo`) at `ANALYSIS_BUCKETS = 729`.
**The motion track and the frame.**
`CantorAudio.motionTrack(path)` runs the analysis in C++
(`android/app/src/main/cpp/motion/`, a port of the reference page held exact by
`scripts/motion-check.mjs`) on the reduction's decoder; `MotionStore`
(`lenses/motion/motionStore.ts`, keys `motion.v1:…`) measures the focused song
once and keeps it, beside the `AnalysisStore` on the same `MeasurementStore`.
`playerMotionFrame` (`features/field/playerMotion.ts`) makes the frame from the
track, the unstepped playhead, the scene's `motionIn` and the transport's
play/pause morph — null under reduced motion, before the track, or before it has
risen. The field canvas stays on its stepped playhead; once the player has
landed and its lens is at rest it is drawn on `PlayerMotionLayer`, a canvas of
its own. A byline longer than its column is seated at the column's left edge,
morphs onto a two-copy loop, and scrolls on `BylineMarqueeLayer`
(`features/field/BylineMarquee.tsx`), a strip canvas the line is handed to on
the frame it first moves and handed back from when the player is left; the
`BylineClock`'s `owner` says which canvas draws it. Under reduced motion it is
cut with an ellipsis instead. Keep the strip's child element held by identity:
a canvas handed a fresh child stops its mapper until the JS thread has
re-recorded it, and the strip froze over the field's take-back on every Back.
The clock carries the song's form (`ClockCuts`: section cuts, drop
dots, letters outside the ring). The visual clock's latency is the route's
(`player/outputLatency.ts`) plus this phone's correction for it
(`player/syncOffsets.ts`, set in settings' `SyncRow` by eye against the song
playing).
`features/field/songDetailPhase.ts` separates reveal, hold, and hidden states:
the outgoing waveform keeps its ink while camera opacity fades it, and resets
only after it is hidden. Playhead mappers must include the position shared
value in their dependencies so loading a track replaces the idle clock.

## Releasing the app

### Two apps on one phone

Only a published release is **Cantor** (`com.cantor.app`, signed with
Cantor's release key). Every build made for development is **Cantor Dev**
(`com.cantor.app.dev`, the debug key), so the two install side by side and
keep separate data:

| Build type | App | For |
| --- | --- | --- |
| `debug` | Cantor Dev | everyday work, JS from Metro |
| `preview` | Cantor Dev | device passes: the release bundle, no Metro (`./gradlew assemblePreview -PreactNativeArchitectures=arm64-v8a`) |
| `release` | Cantor | publishing, by the script below only |

A device pass installs Cantor Dev, never Cantor: a phone's Cantor is its
owner's app.

### Publishing a version

On the machine that holds the release key (`cantor/README.md`, "Signing"),
from a terminal:

```sh
cd cantor
npm run release:apk -- patch --notes "Songs you cancel no longer come back"
```

`patch`, `minor`, `major` or an exact `X.Y.Z`; `--dry-run` builds and
verifies without publishing. `scripts/release-apk.mjs`:

1. Checks it is on `main`, clean and level with `origin`; `gh` is signed in;
   the keystore's certificate is Cantor's; the tag is free; the notes are
   one line under 90 characters with no long dashes.
2. Bumps `versionCode` (+1) and `versionName` in `android/app/build.gradle`.
3. Builds the arm64 release APK and verifies it: Cantor's certificate,
   `com.cantor.app`, the new `versionCode`.
4. **Asks for the version to be typed back.** Nothing before this is public;
   everything after it is.
5. Commits the bump with the site's `APP` record (`docs/src/site.ts`), tags
   `app-vX.Y.Z`, publishes the GitHub release **not marked latest** (`cantor
   upgrade` reads GitHub's latest release for the node), and pushes `main`.
6. `deploy-site` redeploys cantorfm.com: `/download` and `/app/latest.json`
   move to the new APK, and the workflow checks the manifest and the APK's
   size.

Within minutes every installed Cantor offers the update.

### How an installed Cantor updates

`src/update/` reads `/app/latest.json` on launch, on return to the
foreground (at most every 6 hours) and whenever Settings opens. A newer
`versionCode` for `com.cantor.app` shows as:

1. A dot after **NODES** on the field (until the offer is seen).
2. `UPDATE READY · X.Y.Z` on the Settings door, in ink.
3. The **Version** row in Settings: `Update to X.Y.Z`, the release's notes
   under it.

Pressing it downloads the APK (resumable) and `CantorUpdateModule.kt` proves
it before Android sees it: its size and SHA-256 against the manifest, then its
package, a higher `versionCode` and **the same signing certificate as the
running app**. Then a `PackageInstaller` session; Android asks the user to
allow installs once, and to confirm every time. The first launch on the new
version says `Updated` with the notes, once. Cantor Dev never offers updates.

### The rules

- **Never lose or regenerate the release key.** Android only updates an app
  signed with the same key; without it every user reinstalls and loses their
  data on the phone. A backup lives off the build machine.
- **`versionCode` only goes up**, one per published APK, and a published
  version is never reused or rolled back (Android refuses a lower one). A bad
  release is fixed by the next release.
- **The first build with the updater is installed by hand**; every version
  after it updates from inside the app.
- **Never test the script's guards against the real command.** Use
  `--dry-run`. (0.1.1 was published by such a test.)
- The notes follow the site's copy rules: what changed, for the person who
  installed the app, in one line.

## Tests

```sh
cd cantor
npx tsc --noEmit
npx eslint .
npx jest
cd android && ./gradlew app:testDebugUnitTest app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a
```

Three ESLint warnings are pre-existing (one inline style in
`src/onboarding/panels/kit.tsx`, two inside a generated Gradle report). There
must be zero errors.

Device work uses the physical Android phone. `npm start` runs Metro;
`adb reverse tcp:8081 tcp:8081` is required over USB and is dropped when the
cable is replugged.

## Traps

- **Jest transforms.** `@scure`, `@noble`, and several React Native packages
  ship untranspiled ESM and are listed in `transformIgnorePatterns`. A new
  ESM-only dependency needs to be added there.
- **`core/transport` is generated.** Edit `protocol/transport/v1/spec.json` and
  run the generator; never hand-edit `src/core/transport/generated.ts`.
- **The secure tunnel fails loudly.** Plaintext after the channel opens is a
  fatal failure, not a downgrade to retry.
- **Storage keys are a compatibility contract.** Existing AsyncStorage keys and
  stored JSON shapes must keep loading; per-store corruption policy is
  deliberate.
- **The soft keyboard must never resize the window.** The activity asks for
  `adjustNothing`. `viewportHeight` is a blind's whole travel *and* the number
  the field's layout is planned on, so a window that shrank under an open sheet
  re-ran the blind's height animation, the field's re-cut, and every seat
  measured inside the open panel, all on one frame — which is what made a tap
  on a text field shove every dropdown on screen. `Curtain` takes
  `useKeyboardInset` out of the sheet's own height instead, so the band the
  keyboard covers is paid for by the sheet's content and by nothing else. RN's
  `Modal` sets `adjustResize` on its own window regardless, so the pairing and
  restore sheets are unaffected.
- **The coda's line is narrower than the page.** A Folio `Coda` starts one
  gutter past the spine, so its note holds about 26 mono characters, and a
  head's meta line beside the clef about 28. Two sheets have already lost a
  word off the right edge there; count the string.
- **Every blind is a Folio.** `features/controls/Folio.tsx`: `FolioHead` (clef,
  eyebrow with the one `CLOSE` or back word, title, meta), `Stave` (the
  scrolling measures, whose last stretch of spine meets the coda, with a paper
  fade and no scroll indicator), `Measure`/`Rest` (a spine per group, broken
  between), and `Coda` (the double bar and the page's one act, or nothing).
  Use those components when adding a sheet.
- **An arrival stagger has to finish inside its clock.** A block's window is
  `ROWS_FROM + index * ARRIVAL_LAG` to `+ ARRIVAL_RISE`, and a window that ends
  past 1 is a row that never reaches full ink — it does not fail, it just sits
  at a fraction of its opacity forever. Adding a block means lowering the lag.
- **A submission keeps one key from Make to song.** Its key is its derived job
  id when the node advertises `derived_job_ids`; acceptance and the published
  song keep it. Older nodes use `pending:<clientRequestId>` until acceptance.
  Never guess a submission’s mark from the first job on its node.
- **A job's caption has two sources, and the node's wins.** `JobView.caption`
  is what every device sees; the submission outbox is what only the phone that
  typed it has. `useBackendRuntime` hydrates the outbox at mount — without that
  the map is empty until the next submission, and every mark from an earlier
  session draws with no words at all.
- **Job snapshots only ever merge in — except for deletion.** `mergeJobViews`
  keeps the highest revision and never drops a job, because a job missing from
  one page is not evidence it is gone. `job.forgotten` is that evidence, and it
  is the only thing allowed to remove one. It arrives two ways — as the reply to
  this phone's `forgetJob`, and unsolicited when another session of the same
  account deleted it — and both land on `onJobForgotten`, which has to prune the
  live snapshot, `jobs/repository.ts`, and the outbox entry holding the caption.
  Prune fewer than all three and the job returns on the next launch.
- **`lastVisualPlacements` is a capture *and* a source.** `useFieldCamera`
  keeps it as the poses on screen, so an interrupted re-cut resumes from where
  the eye left it — and plans the next re-cut's `before` from it. Anything left
  in it after its flight has landed gets re-planned forever. A finished exit
  that stayed there named a song `controller.presentations` no longer had;
  when the canvas still had a picture fallback, that held the whole field on
  it until the app restarted. There is one renderer now, which draws such a
  flight as nothing, but it is still a flight planned for ever. `stillDrawn` is
  the shed; keep any new ownership that ends at alpha zero behind it.

**A lens change that has landed still names the lens it left.** `useLensClock`
keeps `from` until the next change; at `t = 1` read it as `to` alone
(`drawFieldFaces`' `leftLens`). Read as two lenses, the player stayed in a pair
morph after every change and never went back to the motion layer.

**A per-frame anti-aliased path costs a CPU raster and an upload.** Ganesh draws
a non-convex AA path through `SoftwarePathRenderer` and caches the mask per path
object, so a path built anew each frame is rasterised and uploaded each frame
(37% of the UI thread for the moving seal before it was drawn as circles and
segments). Profile with the recipe in the reactive player's log before guessing.

## Review checklist

### Composer lyrics compatibility

`core/protocol/lyrics.ts` adapts the existing ACE engine contract until nodes
advertise lyrics capabilities directly. Automatic words are offered only for
the `acestep` engine with a declared `plan` stage. Automatic mode omits lyrics;
instrumental mode sends `[Instrumental]`; manual mode sends the supplied words.
There is no `write_lyrics` extension in that engine ABI. Unknown engines must
not inherit either this capability or its sentinel. Stage count alone does not
establish lyric-writing support.

The Ledger uses a compact dial whose tick sits near its text while retaining a
48 dp touch target.

- [ ] Does a component call the connection directly?
- [ ] Is the new state owned by exactly one hook or repository?
- [ ] Is every request registered atomically with its timeout?
- [ ] Does offline behavior still work with no socket?
- [ ] Did a persisted key or stored shape change without a migration story?
- [ ] Does motion still follow the Flicker Law in `cantor/AGENTS.md`?

### Live jobs on the field

Jobs are a layer of the one field canvas (`nativeJobs.ts`), not a canvas of
their own. `FieldCanvas` records each job's mark (`JobMark`: the ring for the
map, the ring and its words for the shelf) when that job's presentation is a
new object, and publishes the marks through the `jobMarks` shared value; the
native scene draws every non-song flight from it on the UI thread. A progress
update therefore never hands `Canvas` a new element — it re-records one job's
pictures and wakes the canvas's mapper once. A job that leaves keeps its mark
while its outgoing flight is in the air. The jobs map reaches the canvas through
`LiveFieldCanvas` in `FieldScreen`, so a tick re-renders that wrapper and not
the screen.

`fieldCanvasClock.test.tsx` checks that a live job keeps one canvas and the same
scene element across progress updates, and records nothing for a render with
nothing new.

### Group layout stress checks

`layoutField` uses a two-column browsing window. Date groups start newest
first. The scale depends on viewport width, never library length. Marks form
stable irregular oval clusters whose area follows their count
(`CLUSTER_PITCH_WORLD` per song), so two songs make a small pair and forty a
large face; past `CLUSTER_MAX_RADIUS_X_WORLD` a cluster grows downward instead
of across. Rows are as tall as what they hold, and a field shorter than the
band between header and foot stands in its middle. Group-key-seeded variation
keeps refreshes deterministic; gathered shelves retain their order. Rows
reserve at least 64 screen pixels between their mark envelopes.

An arrangement group may carry a `subtitle` (the name's second line reads
`SUBTITLE · N SONGS`, or just the count), a `hub` (the album axis keeps the
middle `HUB_SEATS` seats empty for the album's cover, drawn as halftone from
its thumbnail by `nativeMap.ts`), and a `section` (the artist axis splits
engines from imported artists; a new section starts a new row, with
`SECTION_GAP_PX` of room for its hairline). The lattice under the map is
world-anchored and drawn only while the dots are. Generated songs are credited
to their model on the artist axis — `FieldEntity.model`, the node's selector,
read as words by `modelLabel`. At overview
distance, dragging moves freely in both axes, even when all groups fit;
zooming out cannot compress all groups into the viewport.

A cluster's seats are handed out top to bottom (`browseCluster`), so row `i`
of the gathered column is the `i`-th mark from the top of the bloom: the
L0→L1 gather keeps every mark's height order instead of sending neighbours
across the oval. A tap on the map enters the shelf around the touched row
(`shelfAround`), and back from a shelf climbs out to that cluster on the map
(`mapCameraAround`), not to the top of the field.

Crossing between the map and a shelf reshapes every cluster (blooms close
into columns, and the columns above push everything below them down the
world), so neither a pinch nor a flight may hold a *world point* still across
it — the cluster you were zooming into slid out from under the fingers. A
pinch holds the song nearest the fingers (`PINCH_ANCHOR_REACH_PX`) and moves
the camera with that song's bloom offset as the gather changes; a flight
that is about a song (`flyTo`'s `anchor`: a tap into a shelf, the climb back
to the map, the now-playing trip) runs `flightCameraAt`, which carries the
song on the eased line between its two ends. Both ends are unchanged.

A released drag carries on (`field/glide.ts`, `GLIDE_KNOBS`): a cubic
ease-out that leaves at the finger's speed and stops at the map's range
(`mapCameraRange`) or, at L1, the column's run. It starts on the UI thread at
release, on the camera flight's own clock; a touch on a glide still faster
than `CATCH_SPEED_PX_S` stops it and is not taken as a tap. Reduced motion,
a pinch inside the drag, or a blind that is down means no glide.

A map at least `RAIL_KNOBS.MIN_SCREENS` tall gets an index rail down the
right edge (`field/rail.ts`, drawn by `FieldRail` on its own small canvas from
the live camera). The rail is the map squeezed into the band between header
and foot: each run of clusters shows its index word at its name's height
(`Arrangement.indexWords` — months with the year where it turns on the date
axis, initials elsewhere, the longer run winning a collision), and an ink
bracket spans what is on screen. A touch flies the band's middle there
(`JUMP_MS`); a drag then steers that flight and, once landed, moves with the
finger. The gesture is `useFieldCamera`'s `railGesture`, and does nothing
away from the map.

Below the map's own scale is the overview (`OVERVIEW_KNOBS` in `bands.ts`):
the camera zooms out to `overviewMinRatio` — until the whole map stands in the
band, never past `MIN_RATIO`, and not at all for a map that already fits. It
is the map in miniature: marks, rings and job marks shrink with the world
(`overviewShrink`), covers are world-sized already, cluster names fade out on
`NAME_WINDOW`, and `FieldMargin` writes each index run's word large in the
empty left margin on `WORD_WINDOW`, the longer run winning a collision. A
pinch that ends zoomed out settles into `mapCameraRange`, which at overview
centres a map that fits rather than hanging it from home.

Album clusters are a cover above rows of songs (`hubCluster`,
`HUB_SIDE_WORLD` ≈ 60 dp at fit), not particles round a small cover; a row of
covers gets `HUB_ROW_GAP_PX` more room above its names so each name reads as
its own cover's. Covers are 18×18 halftone (`MAP_KNOBS.HUB_CELLS`) and culled
off screen.

At the map the header's action seat is the now-playing jump
(`features/field/NowPlaying.tsx`, `now-playing-variants.html` § I): the held
song's own lens mark inside the ring the map draws round it, the ring's arc
its progress, and the title beside it. The face turns once per
`NOW_PLAYING_KNOBS.TURN_S` while the song sounds; paused, speed and ink ease
to rest over `STATE_MS`. The mark is re-recorded only when the turn or the
arc has moved `STEP_PX` physical pixels, and its frame callback stops while
the header is away. The title gets the row less the count line's measured
ink; a longer one scrolls left without end like a bus sign, a second copy
following after `MARQUEE_GAP`, at the mark's eased speed — paused, it slows to
a stop where it stands. Under reduced motion it is cut with an ellipsis. A tap is `useFieldCamera`'s
`visit` — out to the song's row in its shelf, then down into the song. At L1
the seat is the shelf's bulk action, a separate slot.

Each axis keeps its own place on the map (`useFieldCamera`'s `axisKey`; the
date axis is one map per resolution): leaving an axis remembers the camera,
coming back returns to it inside the map's current range, and an axis not yet
visited this session opens at its home. Inside a shelf or a song a regroup
still keeps you where you are.

A tag filter (`field/filter.ts`, `TagFilter`) takes songs out of the
entities before `layoutField`, so the map re-packs; an empty filter returns
the very same array, or every render would re-cut. `FieldScreen` holds it in
memory only, and everything that names the library as a whole — the tag
list, playlists, `OF 64` — keeps reading the unfiltered entities. The map's
count line says it (`10 OF 64 · RAINY OR LIVE`, `features/field/
filterWords.ts`, fitted to the row and to a held song's mark): the tag words
open the tags blind, the conjunction flips any/all with an ordinary animated
re-cut. `useFieldCamera` takes `filtered` and `recutQuiet`. A quiet re-cut —
a filter changed behind the fully drawn tags blind — has no flights and lands
at the new home; the first filtered layout stashes the camera it replaced, at
any level, and the first unfiltered one returns there (that axis's own place
if the axis changed meanwhile). While filtered, the per-axis memory is
neither read nor written. A re-cut that removes the shelf you stand in goes
home rather than leaving you over an empty page.

Find is a gather. `FIND` turns the
header's title line into the query (`FieldScreen.finding`, a `TextInput` in
`FieldOverlay`'s title slot, crossing with the title on one linear clock).
`library/find.ts` folds each song's searchable text once per library change
(`buildFindIndex`), and a keystroke only compares folded words — every query
word must begin a word (`findIn`, over `mapLayout`, so inside the filter).
What it finds becomes a real shelf: `field/gather.ts` `gatherLayout` copies
the map — never `layoutField` — moving one copy of each found song, the first
`MAX_GATHERED` (60) in field order and then in the shelf's ORDER, into a
`FOUND_GROUP_KEY` group standing `SHELF_GAP_WORLD` left of the map's frame.
`FieldScreen` hands everything that draws or touches the field `layout =
gathered ?? mapLayout`, so the re-cut, hit testing, the shelf seats, the
queue and the a11y list treat it as any shelf; the rail and the overview
index keep reading `mapLayout`. An empty query gives back the map object
itself, so no re-cut runs.

The motion is the study's (`find-motion.html` frame III): the map stays
where you stood and recedes behind the shelf, and each face flies out of it
into its row. That is two cameras (`gatherInk.ts`, `GatherCameras` on the
re-cut model): the map is drawn through `gatherMap`, the camera when find
opened, eased to `RECEDE_SCALE` and `RECEDE_INK`; the found shelf through the
real camera, which `useFieldCamera` cuts to the shelf's seat at the first
letter and back to where find began on leaving — so the shelf is a real one
to touch, scroll (it is the only seat while it is out), order and descend
from. A face changing sides is placed on the screen between its two
pictures (`flightOnScreen`), by its own window of the cut's linear clock
(`planGatherCut`: staggered in shelf order, bowed, its name written on as it
lands or erased where it stood), and drawn somewhere between a mark and a
row. The canvas recovers the linear clock from its eased one once a frame
(`linearOfEased`); the camera's capture records a moving face's screen
point back through the camera the next cut will draw it with, so a letter
typed mid-flight carries on from where the eye is. The shelf's paper and
faces are drawn over the map's names, its words over both; the ghost has
faces and no words, and gives way as you go into a song. A settled scene
follows the live camera only while it stands at the shelf, so the cut back
to the map never shows a frame of the shelf drawn from the map's camera.

Inside a shelf, find holds that shelf's matches and offers the rest as the
column's last row (`foundFoot`, drawn by the canvas; a tap there reaches the
screen through `onTapNothing`). Found rows say where they came from and how
long they are (`foundPlaces`). Find's chrome hides the shelf's bulk action,
and the held song. While nothing is typed, the count line ends in the tags'
door, as on the map: `TYPE A NAME · TAGS`, or the filter's own words; the
foot is under the keyboard, so the door is never there. The tags blind (`features/find/TagsSheet.tsx`) is set as a
book's index, not as a Folio: it shares the field header's seats.

Group names are fitted to one map column at FIT (`labelMaxWidthPx`): the
title wraps once at spaces and the second line ends in an ellipsis, growing
upward away from the cluster; the axis key stays one line under it. Header/footer veils
and hit testing keep off-screen marks clear of controls. Job captions appear
at shelf distance, leaving compact overview marks unobstructed.

Gathered shelves are packed separately after FIT, using their actual member
counts and the 92 px shelf row pitch, and stand `SHELF_CLEAR_SCREENS` (half a
screen at shelf distance) plus a row apart vertically, so no other shelf's
rows are on screen while you stand in one. Their centers may differ vertically from
the map centers. Bloom offsets preserve the map pose, and the existing gather
interpolates into the separate shelf pose without changing glyph ownership.

For device QA, set `FIELD_GROUP_LAB = true` in `cantor/App.tsx` in a debug build.
`NEXT SCENARIO` cycles a six-month sample (576 songs, 24 weeks, 4–44 songs
per week) and 7, 29, 61, and 155 artificial songs in uneven groups;
`BUSIEST SHELF` checks the dense list pose. The lab also switches between
weeks and months and supports dragging to inspect off-screen groups. Fixtures are memory-only and have no
backend actions. Restore the flag to false after QA. Regression tests cover
both date and playlist groupings, map clearance, and cross-group shelf spacing.

The lab uses the same `SafeAreaView` canvas sizing and `useFieldCamera` as
`FieldScreen`; its controls overlay the canvas instead of reducing its height.
Use `FIT MAP` after changing a lab scenario. Compare settled views after using production's “Return to the fitted field”:
startup library hydration can preserve a different camera position. The default
`crowdedWeek` fixture matches the measured phone's 5/3/2/19 memberships (26 songs
plus 3 jobs in the actual library). At 392.727 × 792.727 dp, both layouts have
browsing scale approximately 0.7265 and home center (0, 0). The lab substitutes
synthetic remote songs, so artwork, job captions and availability ink differ;
this is geometry parity, not a release-build performance comparison.

### Regrouping startup cost

The native field batches ordinary song rows and group labels into one UI-thread
picture (`nativeRows.ts`, `nativeLabels.ts`). Regrouping must not mount a text
mapper tree per song: that delayed the start of the re-cut clock even at L0,
where every row title is invisible. The focused player keeps its own morph
owner; the batch excludes that placement. Title tracing, label crossfade windows,
flight ownership and the 850 ms re-cut remain unchanged. Cull off-screen row
text before tracing it, and return immediately when the row has not arrived.

Jobs are drawn inside the native scene, under the map/shelf veils, so the veils
protect the header from failed jobs as they do from songs.

### The living scene

`NativeFieldContent` is mounted once for the canvas's life and never keyed by
re-cut (`features/field/livingScene.ts`). Every re-cut used to build a scene of
its own, and the phone paid for each twice on the UI thread: installing a fresh
set of worklet closures (~150 ms on the Xiaomi's debug build) and unpacking what
they captured (~130 ms). A letter typed into find is a re-cut, so each letter
froze the canvas.

- **The cut is a shared value** (`NativeCut`): plain data — flights, found
  places, prepared labels, hubs, sections, cameras, recede, gather cameras,
  found foot. `FieldCanvas` installs it from a layout effect with one `runOnUI`
  that sets the cut and restarts the scene's one clock in the same UI task, so
  no frame pairs one cut's data with another's clock (motion rule 5, kept
  without a generation). A render that is not a new cut updates the data and
  leaves the clock alone.
- **Songs are a store** (`SongDraw`: lens identities, row model, ink,
  download). Built once per drawn change of a presentation (`sameDrawnSong`)
  and sent only for the songs that changed, with the ink arrival's `from` and
  clock in the same UI task.
- **Joined on the UI thread**: `joinFaces`, `joinRows`, `joinJobs` turn cut +
  songs + focus into the arrays `drawFieldFaces` and `drawNativeRows` take,
  when an input changes, never per frame.
- **The focus layer** (`FocusDetail`, `FocusFlight`) is the one part still
  mounted per focus and per cut while focused. It reads the clock through
  `useFocusClock`: the scene's while its cut is on the canvas, landed after.
- Anything a scene worklet captures must keep its identity across cuts
  (shared values, memoised paints and fonts). A captured value that changes
  per cut re-creates the worklet, which is the cost this removed.

Measured per letter in find, keypress to the first frame of the gather
(Xiaomi, 64 songs): debug 410–800 ms → 84–120 ms; release ~86 ms, of which
~40 ms is React rendering the screen and ~45 ms is the UI thread taking the cut
and drawing its first frame. Song measurements are read by the canvas wrapper
(`LiveFieldCanvas`), not `FieldScreen`: each one landing used to re-render the
whole screen. The header's eyebrow and count line are `useDeferredValue`d so
their morph planning (~30 ms debug) runs after the cut is sent.

While a query is typed the whole overlay renders a step behind
(`FindDeferredOverlay`: 10–12 ms debug per letter), and the a11y list always
does (`DeferredA11yList`: 43 ms debug when a re-cut hands it the whole map).
The query field is therefore uncontrolled — a controlled value a render behind
would write old letters back — and is cleared when find opens. After these,
release measured 49–93 ms (≈70 typical) from key to the gather's first frame.

**A letter is sent from the keystroke.** `FieldScreen.changeQuery` runs
find's chain itself (`features/find/chain.ts`, through `findFor`, which caches
one result per query and world), asks the camera to plan and start the cut
(`useFieldCamera`'s `recutNow`: the render-time diff as a function, `planNow`,
and `startRecut`, which starts a cut once), and hands it to the canvas
(`installRef` → `sendCut`, which never sends a cut older than the one on the
canvas). Then it sets the state; the render that follows reads the same cached
layout, finds the cut already planned, and brings the chrome up to date. The
state must be set in the same handler as `recutNow`: `recutNow` sets camera
state too, and a render between them would see the new cut with the old
layout and plan its way back. The camera's gather start watches both the
canvas's drawn generation and its own pending cut — whichever arrives second
starts it. Release, key → the cut's first recorded frame: 20–39 ms.

**Frames during a re-cut.** The field's own drawing is ~1 ms of a frame; what
filled the rest on an axis change was surfaces and layout. Every animating Skia
canvas presents on its own (the second costs ~1.7 ms, each further one ~0.6),
so the overlay's morphing lines that move together — eyebrow, count, hint —
draw on one `MorphHost` canvas. The dial's tick slides by transform, not by
`left`/`width`. The a11y targets are keyed by position, so a re-cut that
renames every placement does not remount ~70 views mid-flight. Release, week ↔
month: p90 19 → 17.4 ms, frames > 20 ms 15 → ~5, longest 61 → ~25 ms.
Measure with perfetto (`gfx`/`view` atrace + `Choreographer#doFrame` per
frame, `eglSwapBuffers` per frame for surfaces) on a release build.

**Faces are stamps.** With a real library the faces are the frame: 194 songs
on a Samsung A52s (120 Hz) cost ~13 ms a frame as paths. A lens may declare
its mark as a few looks (`MarkSprites` in `lenses/contract.ts`: the circle's
filled and outline-only, the seal's dots and filled dots, each with its line);
`features/field/faceAtlas.ts` draws every song's looks once into one image at
the map's mark size, and `drawFieldFaces` stamps every plain face with one
`drawAtlas` a frame — one stamp per face, its alpha in the stamp's colour,
transforms and colours pooled and set in place. A face that is not a plain
mark (the player, a playing ring, a download, an ink between looks, bigger
than the stamps, or a song changed since they were drawn) is drawn as paths,
the batch flushed first so overlap order never changes. The image is drawn
again only once the size holds still (≥ 250 ms apart) or, for changed songs,
≥ 2 s apart: a redraw is ~75 ms on the A52s. Release, A52s: axis change
median 23.6 → ~11–14 ms (thermal), frames > 16.7 ms 260 → ~20–35; find
median 20.7 → ~12.5, longest 116 → ~25 ms. The web Skia under Jest ignores
`drawAtlas` colours, so `faceAtlas.test.ts` compares pixels at full ink and
checks each look's alpha by value. What is
left is the UI thread's own work for the keystroke (the text field), which a
synchronous send (`executeOnUIRuntimeSync`) did not beat.

### Audio acts

`core/audioActs.ts` decides, from declared capabilities only, which acts a node
offers (`version`, `longer`, `hum`), whether a version shows Voice, the stage
arc, and the install hint (`doorFor`, `doorAcross`). The composer's draft
carries a `source` (a node song, a phone file, or a tune) and builds the
`audio` prompt (`audioPromptFor`); a sound on the phone travels as an outbox
`source` (`jobs/outbox.ts`), sent by `runUpload` (`backends/upload.ts`) through
`BackendConnection.uploadPort()` before the job, hashed and sliced natively
(`CantorAudio.sourceInfo` / `readSlice`). The record measure
(`features/composer/RecordMeasure.tsx`) records through `audio/tuneRecorder.ts`
and draws the pitch from `audio/pitch.ts`.

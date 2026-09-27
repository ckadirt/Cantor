# Hacking the Cantor app

The app is the React Native client in `cantor/`. It pairs with nodes, submits
generations, mirrors the library offline, downloads encrypted audio, and plays
it back. Everything it shows comes from a node it has authenticated.

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
| `src/core/` | `errors`, `text`, `validation`, `protocol` decoders and constants, `storage` primitives, `transport` (the generated manifest constants), `store`/`useStore` (the external store every shared state lives in) |
| `src/security/` | `descriptor` verification, `carrier` and `inner` codecs, `secureTunnel` orchestration, `native` channel factory, `types` |
| `src/backends/` | `BackendConnection` façade, `relaySocket` lifecycle, `requestRegistry`, `applicationResponses` decoders, `pairing`, `storage` |
| `src/runtime/` | `BackendRuntime` — a plain object publishing one store: backend records, connection lifecycles, snapshots, cache hydration, persistence, outbox flush, audio inspection, feature commands. `useBackendRuntime` starts it for a component's life |
| `src/features/` | `field/` (the canvas, camera, controller, overlays), `song/` (player surface and sheet), `composer/`, `engines/`, `curtain/`, `controls/` |
| `src/screens/` | `FieldScreen`: the one screen after onboarding — composition and wiring |
| `src/library/` | cached library repository, query helpers, and the pure `sync` reducer |
| `src/jobs/` | job repository and the submission outbox |
| `src/audio/` | `AudioRef`, the `LocalAudioStore` port, its repository implementation, and the native bridge |
| `src/identity/` | phrase derivation, mnemonic, and keychain-backed identity |
| `src/lenses/` | how a song is drawn: the lens contract (`contract.ts`), the registry (`LENSES`, `LENS_UI`, `LENS_PAIRS`), the circle (`nameLens.ts`) and the seal (`sealLens.ts`, `sealPlayer.ts`, geometry in `seal.ts`), pair morphs (`pairs.ts`), its `analysis`, and the `AnalysisStore` that measures songs once and keeps them |
| `src/motion/`, `src/onboarding/`, `src/theme/` | the motion engine and the onboarding experience |

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
   which is the two-layer rule), `player(recipe, analysis)` (JS; null if its
   player is its mark grown), `touch` (JS: `reachRatio`, `landAt`, `seekAt`, in
   coordinates about the player's centre), and `ui` — worklets and numbers only
   (`drawMark`, `drawPlayer`, `ringTicks`, `hearsPlayhead`, `clock`), because it
   is captured onto the UI thread.
2. Add it to `LENSES` in `registry.ts`. The picker lists it, the renderer draws
   it, and a change to or from it takes the generic two beats.
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
the fallback keeps the app working, but re-check with
`docs/import/log.md` § I1.

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
`songShapeArrival` runs, and the sound rises on a born clock
(`SEAL_PLAYER_KNOBS.SOUND_MS`) when a measurement lands. `seekGesture` asks the
lens drawn at the player what a touch means (`Lens.touch`): the circle scrubs by
angle; the seal scrubs by rim angle and treats a touch that starts on the dust
as a tap that jumps to the dot under it.
`analyseWindow` keeps per-bucket loudness, punch (crest factor) and width
(side/mid, from `SampleWindow.stereo`) at `ANALYSIS_BUCKETS = 729`.
`features/field/songDetailPhase.ts` separates reveal, hold, and hidden states:
the outgoing waveform keeps its ink while camera opacity fades it, and resets
only after it is hidden. Playhead mappers must include the position shared
value in their dependencies so loading a track replaces the idle clock.

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
- **The foot's line is narrower than the page.** `LedgerFoot` starts at the
  spine, so its note holds about 26 mono characters, not a page's worth. Two
  sheets have already lost a word off the right edge there; count the string.
- **An arrival stagger has to finish inside its clock.** A block's window is
  `ROWS_FROM + index * ARRIVAL_LAG` to `+ ARRIVAL_RISE`, and a window that ends
  past 1 is a row that never reaches full ink — it does not fail, it just sits
  at a fraction of its opacity forever. Adding a block means lowering the lag.
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
48 dp touch target. Header titles are centered independently of side controls.

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

`layoutField` uses a two-column browsing window, with three rows visible for
ordinary groups. Date groups start newest first. The scale depends on viewport
width, never library length. Marks form stable irregular oval clusters. Sparse
groups have room between songs; increasing membership compresses the particles
with slight internal overlap before the oval grows vertically. Group-key-seeded
variation keeps refreshes deterministic; gathered shelves retain their order.
Rows reserve at least 64 screen pixels between their mark envelopes. At overview
distance, dragging moves freely in both axes, even when all groups fit;
zooming out cannot compress all groups into the viewport. Header/footer veils
and hit testing keep off-screen marks clear of controls. Job captions appear
at shelf distance, leaving compact overview marks unobstructed.

Gathered shelves are packed separately after FIT, using their actual member
counts and the 92 px shelf row pitch. Their centers may differ vertically from
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

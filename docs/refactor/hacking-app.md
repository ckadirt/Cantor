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
| `src/core/` | `errors`, `text`, `validation`, `protocol` decoders and constants, `storage` primitives, `transport` (the generated manifest constants) |
| `src/security/` | `descriptor` verification, `carrier` and `inner` codecs, `secureTunnel` orchestration, `native` channel factory, `types` |
| `src/backends/` | `BackendConnection` façade, `relaySocket` lifecycle, `requestRegistry`, `applicationResponses` decoders, `pairing`, `storage` |
| `src/runtime/` | `useBackendRuntime` — backend records, connection lifecycles, snapshots, cache hydration, persistence, outbox flush, feature commands |
| `src/features/` | `backends/BackendCard`, `jobs/JobQueue`, `library/LibraryTimeline` and `LibrarySongRow` |
| `src/screens/` | `MainScreen`: composition, navigation, and wiring only |
| `src/library/` | cached library repository, query helpers, and the pure `sync` reducer |
| `src/jobs/` | job repository and the submission outbox |
| `src/audio/` | `AudioRef`, the `LocalAudioStore` port, its repository implementation, and the native bridge |
| `src/identity/` | phrase derivation, mnemonic, and keychain-backed identity |
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
2. Give it a feature controller hook only when it owns state; otherwise read
   from `useBackendRuntime`.
3. Wire navigation in `MainScreen`. Do not reach around the runtime to open a
   connection.

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

## Playback gestures and field lenses

`player/scrubSession.ts` owns a silent seek transaction: pause once, preview on
the shared position clock, seek on release, and resume only if playback was
running before the drag. `SongSurface` finalizes on gesture completion and
unmount. Track replacement cancels ownership so a late release cannot seek the
next song. Ordinary seeks also reconcile the visual clock after native seek.

Circle and Cantor wave share `NativeFieldContent`. Lens changes drive one
retained linear clock (`MORPH_MS = 420`); the drawing eases it once. Pure bar
geometry is shared with the fallback lens in `lenses/cantorWaveGeometry.ts`.
The field's morph module partitions the exact face polygon into 32 wedges,
then interpolates those wedges into bars at the measured Cantor intervals.
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
- **`lastVisualPlacements` is a capture *and* a source.** `useFieldCamera`
  keeps it as the poses on screen, so an interrupted re-cut resumes from where
  the eye left it — and plans the next re-cut's `before` from it. Anything left
  in it after its flight has landed gets re-planned forever. A finished exit
  that stayed there named a song `controller.presentations` no longer had,
  which held `nativeField` false for the rest of the session: the field fell
  back to `recordFieldPicture`, losing the wave morph and seaming every level
  change, until the app restarted. `stillDrawn` is the shed; keep any new
  ownership that ends at alpha zero behind it.

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

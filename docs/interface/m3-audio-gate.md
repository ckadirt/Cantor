# M3 · the audio feasibility gate

The gate defined in [`implementation_steps.md`](implementation_steps.md#audio-feasibility-gate),
run against a physical device before any player feature work.

| | |
| --- | --- |
| Library | `react-native-audio-api` |
| Version | **0.13.3** (exact, `--save-exact`) |
| Host | React Native 0.86.0, New Architecture (`newArchEnabled=true`), Hermes |
| Device | Xiaomi `6b1f6ba8629c`, Android 16 (API 36), `compileSdk`/`targetSdk` 36 |
| Build | debug, `:app:assembleDebug` |
| Date | 2026-08-25 |

The library's published compatibility table does not list RN 0.86, so every
result below is a device observation, not an API-surface reading.

Fixture: a 180.0 s stereo 48 kHz Ogg Opus tone, `libopus` at 96 kbit/s, placed at
`/data/data/com.cantor.app/files/spike-tone.opus` — a real app-private path, not
external storage.

## Results

| Gate | Verdict | Evidence |
| --- | --- | --- |
| Native build and cold launch | **pass** | `BUILD SUCCESSFUL`; JS mounted with the native module linked |
| App-private Opus decode | **pass** | 2 ch, 48 kHz, 8 640 000 frames, 180.000 s, decoded in ~1.65 s |
| Duration | **pass** | `getAudioDuration` reported 180.000 s |
| Play | **pass** | position advanced from 0 on `play()` |
| Pause | **pass** | held 2.205 s across a further 1.2 s |
| Seek | **pass** | asked 90 s, landed 90.000 s |
| Completion | **pass** | `onEnded` fired when run off the end |
| Repeated track replacement | **pass** *(functionally)* | 8 source swaps, no error and no crash — but see the memory gate |
| Screen-off / background continuation | **pass** | position 3.763 s → 66.931 s across 63 s of wall time while `mWakefulness=Dozing`; `CentralizedForegroundService` stayed `isForeground=true` |
| Lock-screen transport | **pass** | `KEYCODE_MEDIA_PAUSE`/`MEDIA_PLAY` routed to JS while dozing and actually moved the transport; a pause held the position at 7.021 s across 31 s off-screen |
| Audio-focus interruption | **partial** | `began` is delivered; nothing else is — see below |
| Bounded memory | **fail** | source replacement leaks ~1.6 MB per load — see below |

## Decision

Build `audioApiPlayer` on this library. All three failures the steps doc names
as Media3 triggers — build, background playback, lock-screen control — pass, and
they pass convincingly: audio ran 1:1 through a doze period and the lock-screen
buttons drove the real transport.

The two defects below are real and constrain the adapter, but neither is a
reason to write a native Media3 adapter instead. Both are containable in
`audioApiPlayer` behind `PlayerPort`, and `PlayerPort` is why swapping later
stays cheap if the leak proves worse in the field than it does on the bench.

## The two defects, and what the adapter must do about them

### Audio focus is reported but never resolved

`AudioManager.observeAudioInterruptions(true)` delivers
`interruption type=began shouldResume=false` when another app takes the output.
Nothing else arrives:

- the library does **not** pause or duck on its own — a competing player was
  started and Cantor kept playing straight through it, position advancing 1:1
  with wall time (11.784 s → 31.085 s over ~19 s);
- **no `ended` event is ever delivered**, even after the other app is stopped
  and focus returns.

So `usePlayer` owns the whole interruption policy: pause on `began` itself, and
treat resume as a user action or an app-resume resync. It must never wait for an
`ended` event, because that event does not come.

### Source replacement leaks; transport does not

Native heap, measured with `dumpsys meminfo` on a debug build (~219 MB baseline
is debug overhead — Skia, Hermes dev, Metro — not the audio library):

| Load/unload rounds (source swapped) | Native heap |
| --- | --- |
| 0 | 218 MB |
| 24 | 259 MB |
| 48 | 293 MB |
| 72 | 335 MB |

Linear, ~1.6 MB per load, and **not reclaimable**: `am send-trim-memory` at both
`RUNNING_CRITICAL` and `COMPLETE` freed nothing.

Transport churn on a *stable* source is flat by comparison — 50/100/150
seek+play+pause cycles gave 230 / 233 / 235 MB, roughly 0.05 MB per cycle and
plateauing. The leak is specific to swapping the element's source, not to
playing, seeking or pausing.

What that means for `audioApiPlayer`:

- Keep **one** element for the lifetime of the player. Never mount one per song
  and never re-key it from React.
- Change tracks by replacing the source exactly once per real track change.
  Never let a re-render, a retarget or a same-path reload cause a swap; compare
  the resolved local path before assigning.
- Since `PlayerPort.load()` is the only thing that may swap a source, this cost
  is bounded by real user track changes, which puts a long session in the tens
  of MB rather than the hundreds.

Worth re-measuring on a release build before shipping, and worth reporting
upstream.

## Supersedes

The M5 audio ADR's line "Use Android `MediaPlayer` for foreground local-file
playback in this milestone. There is no background playback/service claim."
M3 replaces `AudioPlayback.kt` with this library and does claim background
playback. The rest of that ADR — the Opus profile, the path layout, the digest
verification, the cache budget — is unchanged.

## What the app had to add

Bare RN gets none of the Expo config plugin's work, so `AndroidManifest.xml`
needed, and now has:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<service
  android:name="com.swmansion.audioapi.system.CentralizedForegroundService"
  android:stopWithTask="true"
  android:foregroundServiceType="mediaPlayback" />
```

Two non-obvious traps, both of which first looked like lock-screen failures:

Showing the playback notification is **not** what makes the session
remote-controllable. Until `enableControl(...)` is called the session advertises
`actions=0` and the system routes no media button to the app at all.

Worse, `show()` **resets those actions back to none**. Updating the notification
— which any honest player does on every transition — silently removes its own
controls unless the controls are re-declared afterwards. `createAudioApiPlayer`
re-declares them after every `show`, and `dumpsys media_session` reporting
`actions=262` rather than `actions=0` is how to tell the difference.

## Reproducing

The throwaway harness was `cantor/src/dev/AudioSpike.tsx`, deleted with the rest
of the console in M4 now that the player is real and verified end to end. It
logged every result as `AUDIOSPIKE <gate> <verdict> <detail>` so a run could be
read out of `adb logcat -s ReactNativeJS:*` rather than off the screen — which
is what made the screen-off gates measurable at all. Recover it from history
(`git log -- cantor/src/dev/AudioSpike.tsx`) before re-qualifying a different
audio library; the gate list above is the thing worth keeping, not the file.

One defect this file records was later found the hard way rather than by the
gate: a bare absolute path works as an element source under Metro but resolves
against bundled assets in a release build. Sources carry an explicit `file://`
scheme for that reason.

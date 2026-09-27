# Device import — implementation log

The running record of device import. Read [`plan.md`](plan.md) first. Newest
entries at the top of each section. Update it as you go: every finding,
decision, trap and commit.

## Start here (handoff)

State on 2026-09-27: I0 and I1 done. Path playback works with no copy in
every format (I0); a song's samples are now reduced natively with
audio-api's own decoders, identical to the JS path and 6–18× faster (I1).
**Next: I2** (phone database, op-sqlite). None of it is pushed;
Cesar decides when to push.

The fixtures are still on the phone in `/sdcard/Music/cantor-import-test/`
(13 album/loose/short files plus `Cover Only/` and `Folder Only/`), kept for
I1–I5; rebuild them with `cantor/scripts/import-fixtures.py`. Remove them when
import is finished (`adb shell rm -r /sdcard/Music/cantor-import-test` then
the `scan_volume` call). `READ_MEDIA_AUDIO` is granted to the app from I0,
but the manifest no longer declares it (the spike was reverted); I3 adds it
for real.

**How a step is done here** — the field rewrite's routine, unchanged
(`../refactor/field-rewrite-log.md` § "How a step is done here" has the tap
coordinates and details):

1. Read the code the step touches and write down here what it will change,
   before editing. Measure first if a measurement could show the step is not
   worth it.
2. Change the code; match the comment density and voice around it.
3. `cd cantor && npx tsc --noEmit -p . && npx jest && npm run lint` — green,
   no new lint warnings (34 pre-existing, 0 errors). Changed behaviour gets a
   test; a fix gets a test that fails on the old code. Lens goldens change only
   on purpose, regenerated with `-u` and the reason logged.
4. Release build and install (keeps the app's data):
   `cd cantor/android && ./gradlew assembleRelease -q` (run twice if
   `:app:packageRelease` fails), `adb install -r …/app-release.apk`,
   force-stop, start, wait ~10 s.
5. Verify on the Xiaomi (`6b1f6ba8629c`) with screenshots.
6. Measure with `cantor/scripts/perf-sample.sh 15 "label"` when the step is
   about cost.
7. Commit on `main`, short code-only subject, no AI trailer; then a `docs:`
   commit updating this log.
8. Tell Cesar in plain terms what changed and what to look at on the phone.
   Anything outward — his nodes, pushing, his library, **files on his phone** —
   ask first. Import only reads the user's files; it never writes, moves or
   deletes them.

## Where we are

| Step | State |
| --- | --- |
| I0 phone spike | **done** 2026-09-27 — throwaway, not committed |
| I1 native reduction | **done** 2026-09-27 |
| I2 phone database | not started |
| I3 native scanner | not started |
| I4 resolver | not started |
| I5 device source | not started |
| I6 mark and axis | not started |
| I7 import flow | not started |
| I8 300-song check | not started |

## I1 plan (native reduction)

Written before editing, 2026-09-27.

- **Who asks for samples today.** Two callers, both through
  `PlayerPort.samples` → `readSamples` in `player/createAudioApiPlayer.ts`:
  the analysis (`FieldScreen`, whole song, `ANALYSIS_BUCKETS` 729, cached per
  artifact by `AnalysisStore`) and the L3 grain (a narrow window, one column
  per pixel, re-asked on every window change). Both decode **the whole song**
  to floats in `decodeAudioData` and loop in JS; the grain does it again for
  every window.
- **The change.** `CantorAudio.reduce(path, startSeconds, endSeconds,
  buckets)` in Kotlin (`audio/AudioReduction.kt`): `MediaExtractor` seeks to
  the window's start, `MediaCodec` decodes it, and each output buffer is
  folded straight into per-bucket min/max/sum-of-squares per channel and
  mid/side energy. Memory is one codec buffer; nothing holds the song. The
  bucket edges are the JS ones (`from + floor(span·b/buckets)`, at least one
  frame), so a result means the same thing; a window shorter than its bucket
  count (deep L3) is gathered and reduced with the same overlap rule.
  Runs on its own single thread so a long decode never blocks
  `appendChunk` during a download.
- **Fallback.** `readSamples` tries native first; if the platform has no
  decoder (Android ships none for ALAC or AIFF) or anything throws, it falls
  back to today's `decodeAudioData` path. Same `SampleWindow` either way.
- **Revised during the step (see Findings): not MediaCodec but
  audio-api's own decoders, in C++.** The plan's `MediaExtractor` +
  `MediaCodec` version was built, measured and dropped.
- **What does not change.** `PlayerPort`, `SampleWindow`, the analysis
  store's keys and stored shape; analyses already on disk stay valid (a
  cached analysis is not recomputed).
- **Checks.** Unit tests for the TS side (native first, fallback on error,
  decoding of the native payload). On the phone, a throwaway comparison of
  native against JS on the fixtures (per-bucket difference) and a timing of
  both on a real 3 min song and the 24/96 fixture.

## Decisions

- **2026-09-27 — Own plan and log.** Import is a new feature, not part of the
  rewrite; it gets `docs/import/`. The rewrite log's phase 5 points here.
- **2026-09-27 — MediaStore paths, not the document picker.** The player
  opens paths only; the picker would force copies. **Confirmed by I0.**
- **2026-09-27 — Metadata comes from MediaStore plus `MediaMetadataRetriever`**
  (I0): MediaStore for the scan, the retriever as the second reader where
  MediaStore drops fields (the date of FLAC/Ogg/Opus). WAV/AIFF tags stay
  unread by both; they fall back to name and folder. A tag parser of our own
  is not worth it for those two.
- **2026-09-27 — Artwork only through `loadThumbnail`** (I0): it covers the
  embedded picture *and* `cover.jpg`/`folder.jpg`, and it is the only way in,
  since the app cannot open image files with audio permission.
- **2026-09-27 — The three design calls, settled with Cesar.** L0/L1: same
  drawn form plus an *imported* marker; L2: circle, waves, and the cover
  converted to ASCII-style ink by a cheap math function. Time axes by arrival
  for now; the song's own date is kept, shown, and may drive the axes later
  via a setting. ALBUM/ARTIST axis added. Scan everything that passes the
  filter, then a summary to untick. See plan § Decisions.
- **2026-09-27 — The ASCII cover is computed on the fly, never stored**
  (Cesar). Only the ~256 px album thumbnail is cached.
- **2026-09-27 — The Xiaomi is Cesar's to lend for import** ("all yours"):
  permission prompts and test fixtures in `Music/cantor-import-test/` are
  fine. Still ask before touching his own music files or his nodes.

## Measurements

I1, Xiaomi, release build: native reduction (as shipped) against the JS path
it replaces, same file, same request, back to back. Native runs off the JS
thread and never holds the song; JS holds the whole decode and loops on the JS
thread.

| File | Window | Native | JS |
| --- | --- | --- | --- |
| 3 min WAV 44.1 | whole, 729 buckets | 130 ms | 2.3 s |
| 3 min MP3 320k | whole | 390 ms | 2.4 s |
| 3 min FLAC 24/96 | whole | 570–650 ms | 4.2–5.2 s |
| 3 min FLAC 24/96 | 2 s at 1:00, 1080 buckets (L3) | 30–40 ms | 640–810 ms |
| 3 min MP3 | 2 s at 1:00 | 130 ms | 415–470 ms |
| 30 s fixtures, any format | whole | 40–200 ms | 380–850 ms |

Agreement with the JS path, per bucket, over 13 files × 3 windows (whole,
2 s, 10 ms): **exact (0.0000) in 37 of 39**; the two Opus seeked windows
differ by ≤ 0.0001 RMS. Whole-song results are exact in every format, so the
analyses already cached on phones stay valid.

The dropped MediaCodec version, for the record: 3 min MP3 12.4 s wall, of
which 4.6 s CPU on our thread (1.1 s of it the fold, the rest per-buffer
plumbing over 6,892 buffers) plus the system codec process; 3 min FLAC
24/96 6–15 s.

I0, Xiaomi, release build, 30 s fixtures (throwaway spike; one run each).

| What | Cost |
| --- | --- |
| Read + sha256 of a file's first 64 KB through the path | 4–12 ms (23 ms first file) |
| `MediaMetadataRetriever` per file | 18–45 ms; 68–78 ms FLAC |
| `loadThumbnail` per file | 26–34 ms; 82–119 ms first/larger |
| `getAudioDuration` (audio-api) | 25–69 ms |
| Decode + reduce to 729 buckets (`readSamples`, JS) | 400–510 ms per 30 s at 44.1/48 kHz; **818 ms** at 96 kHz. A 3 min song is ~2.5–3 s |

So a 300-song first scan with the retriever and a thumbnail per *album* is
seconds, not minutes; the per-song decode is the thing I1 exists for.

## Findings

- **2026-09-27 — I1: MediaCodec is the wrong tool for reducing audio here.**
  Built as planned (`MediaExtractor` + `MediaCodec`, fold in Kotlin), it was
  3–7× *slower* than the JS path on the phone, mostly per-buffer plumbing and
  the out-of-process software codec. It also has no ALAC decoder
  (`NAME_NOT_FOUND`), returns 24-bit FLAC as 16-bit, and after a seek its
  timestamps are unreliable (the raw WAV decoder repeats one timestamp across
  the buffers it splits an input into, which misplaced every bucket after the
  first 8,192 frames until frames were counted instead). Dropped.
- **2026-09-27 — I1: audio-api decodes with two libraries, not one.** Its
  FFmpeg build is minimal and handles only `.mp4`/`.m4a`/`.aac`
  (`needsFFmpegByPath` in `AudioDecoding.h`); every other file goes to
  **miniaudio** with its libvorbis and libopus backends. FFmpeg opening a FLAC
  fails with "Invalid data found when processing input". audio-api's library
  exports the whole miniaudio API (`ma_decoder_*`) and the two backend vtables,
  so `AudioReduction.cpp` calls them with `dlsym` and makes the same
  per-extension choice. Result: the native columns are computed from exactly
  what the player plays, which is why they match the JS path exactly.
- **2026-09-27 — I1: a seek needs pre-roll for AAC and Opus.** Their frames
  overlap, so the first frame decoded after a seek is incomplete. Landing
  100 ms early (`kPrerollSeconds`) and discarding up to the window took AAC
  from 0.009 RMS off to exact, and Opus from 0.001 to ≤ 0.0001.
- **2026-09-27 — I1: how the C++ is built.** React Native's app CMake takes a
  user file when `externalNativeBuild.cmake.path` is set
  (`android/app/build.gradle` → `src/main/jni/CMakeLists.txt`), which
  includes RN's `ReactNative-application.cmake` unchanged and adds
  `src/main/cpp/AudioReduction.cpp` to `libappmodules`. No `.cpp` may sit in
  `src/main/jni/`: RN would take it as a replacement for its default
  `OnLoad.cpp`. FFmpeg links against the `.so` files audio-api ships in
  `node_modules/react-native-audio-api/android/src/main/jniLibs/<abi>/`
  (headers in `common/cpp/audioapi/external/include_ffmpeg`); miniaudio's
  header comes from `common/cpp/audioapi/libs/miniaudio` for declarations
  only. Check a build with `llvm-readelf -d libappmodules.so | grep NEEDED`
  and `llvm-nm -D … | grep reduceNative`.

- **2026-09-27 — I0: what MediaStore says about the fixtures (Android 13,
  adb `content query`).** Fixtures: `cantor/scripts/import-fixtures.py` builds them (a 30 s
  two-sine tone per format, tagged title/artist/album/album_artist/track
  n/10/disc 1/1/date 2019/genre; cover embedded in mp3, flac, m4a; a
  `cover.jpg` beside the album), pushed to
  `/sdcard/Music/cantor-import-test/` and indexed with
  `adb shell content call --uri content://media --method scan_volume --arg external_primary`.
  - **`TRACK` is `disc × 1000 + track` even on API 33** (`1001`, `1002`, …).
    `DISC_NUMBER` is the raw tag string (`1/1`), not a number.
  - **An untagged file's `ALBUM` is its folder name** (`loose`, `short`), not
    `<unknown>`. Only `ARTIST` is `<unknown>`. `TITLE` is the file name without
    extension. So "album = folder name and artist unknown" means *no album tag*.
  - **WAV (RIFF INFO) and AIFF (ID3) tags are ignored**: both come back as the
    untagged case (title from file name, album = folder), although ffprobe
    reads full tags in them. They get their own `ALBUM_ID`, so one real album
    splits into two MediaStore albums.
  - **`YEAR` is null for FLAC, Vorbis and Opus** (Vorbis-comment `DATE=2019`),
    filled for MP3 and M4A. The song's date (plan § Decisions 2) needs a
    second reader for those.
  - Opus reports `audio/ogg`; ALAC and AAC both `audio/mp4`. MIME does not
    identify the codec.
  - `IS_MUSIC = 1` also for the 3 s blip: the minimum-duration filter is
    needed. The one call recording on the phone is `is_recording`, not music.
  - Cesar's phone holds 25 music files of his own (24 in one folder, 1 at the
    root of `Music/`). I8's 300 songs need generated fixtures or his say.
- **2026-09-27 — I0: the app side (throwaway spike, reverted).** How it was
  built, if it is ever needed again: `READ_MEDIA_AUDIO` in the manifest; an
  `ImportSpike` native module (in `CantorAudioPackage`) that queried
  MediaStore `IS_MUSIC = 1`, read each fixture's path, ran
  `MediaMetadataRetriever` and `loadThumbnail(uri, Size(256, 256))`; and an
  `IMPORT_SPIKE` lab screen in `App.tsx` that asked the permission with
  `PermissionsAndroid`, then ran `getAudioDuration`, `player.samples` and
  `load` + `play` 1.8 s on each path, reporting with `console.warn`.
  - **The permission prompt** is the system's "allow Cantor to access music
    and audio files". Granted, every path is readable (`File.canRead`, a
    64 KB read) through Android 13's file layer. No copy is needed.
  - **All formats decode and play from their path**: mp3, flac 16/44 and
    24/96, m4a AAC and ALAC, ogg Vorbis, opus, wav, aiff. The player reached
    1.76 s after 1.8 s on each. audio-api's FFmpeg covers ALAC and AIFF, so no
    format is second-class.
  - **Trap: `getAudioDuration` returns 0 for Ogg Vorbis** (Opus is fine). The
    player then reports a 0 s song. Take the duration from MediaStore
    (`DURATION`, exact here) and never from the player for device songs.
  - **`MediaMetadataRetriever` reads Vorbis comments** (FLAC, Ogg, Opus give
    `date=2019`), so it fills the year MediaStore drops. It does **not** read
    WAV INFO or AIFF ID3 either. **Its `DATE` for M4A is garbage**
    (`19040101T000000.000Z`, the MP4 epoch): use `YEAR` for MP4, `DATE` for
    Vorbis comments.
  - **`loadThumbnail` falls back to the folder's `cover.jpg` and
    `folder.jpg`** when the file has no embedded picture (verified with a red
    500×400 `cover.jpg` and a blue 400×400 `folder.jpg`: the thumbnail comes
    back at exactly those sizes). Files with neither throw
    `FileNotFoundException: No album art found`.
  - **The app cannot open `cover.jpg` itself**: `READ_MEDIA_AUDIO` grants
    audio files only (`File.canRead` false). `loadThumbnail` is the only way
    to the folder's cover without asking for image permission too.
  - **`loadThumbnail` does not honour the size**: asked for 256, it returned
    300×300 for a 600×600 cover and 500×400 unchanged. Downscale ourselves
    before caching.
  - MediaStore generation on this phone: 9019 (`getGeneration`); each row
    carries `GENERATION_MODIFIED`. Incremental re-scan (I3) can ask for rows
    above the last generation seen.

## Traps

- **A JS syntax error in a lab can ship the previous bundle.** A duplicate
  `const` in a throwaway lab left the release APK running the old bundle with
  no failing build line caught by a quick grep; the phone ran the previous
  experiment. Run `npx tsc --noEmit -p .` before building a lab too, and
  confirm the lab prints something new.
- **react-native-audio-api upgrades can break I1** (its FFmpeg paths, its
  extension rule, its exported `ma_*` symbols or the miniaudio struct layout).
  The JS fallback keeps the app working, with a `Native reduction failed`
  warning in logcat; re-run the I1 comparison after an upgrade.

- **Index new files on the phone with**
  `adb shell content call --uri content://media --method scan_volume --arg external_primary`.
  `adb push` alone leaves MediaStore unaware of the files.
- **`getAudioDuration` says 0 for Ogg Vorbis.** Never take a device song's
  length from the player.
- **Read MediaStore rows with `adb shell content query`** before writing app
  code: `--uri content://media/external/audio/media --projection _id:_data:title:…
  --where "_data LIKE '%cantor-import-test%'"` answers most "what does
  Android think this file is" questions with no build.
- **The release app's cache can't be pulled** (not debuggable). To see what a
  native step produced, report sizes and hashes through `console.warn`.

## Commits

- `43823a5` docs: device import plan and log
- `fe3e879` docs: import design calls settled
- `f40990e` scripts: device import fixtures
- `a46a14a` docs: import I0, path playback works in every format
- `45e8f53` audio: reduce samples natively with audio-api's own decoders
- `c019e85` docs: import I1, native reduction

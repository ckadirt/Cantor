# Device import — implementation log

The running record of device import. Read [`plan.md`](plan.md) first. Newest
entries at the top of each section. Update it as you go: every finding,
decision, trap and commit.

## Start here (handoff)

State on 2026-09-27: I0 and I1 done. Path playback works with no copy in
every format (I0); a song's samples are now reduced natively with
audio-api's own decoders, identical to the JS path and 6–18× faster (I1).
I2 done: the phone database (`cantor.sqlite`, op-sqlite, schema 1) exists
and is exercised by real-SQL tests. I3 done: `CantorMedia` lists, inspects
and saves album art, read only; the manifest declares the music permission.
I4 done: `device/resolve.ts` turns rows and inspections into one scan
commit, tested on the phone's own values; its phone check is I5's first real
scan. I5a done: `DeviceLibraryService` loads, publishes and scans; the phone's
database holds the 16 fixture songs from a fixture-only scan (kept for
I5b–d). I5b done: `FieldPresentation` is a node/device union and the 16 fixture
songs stand in the field, open at L2 and play (native analysis ticks drawn).
I5d done: an imported song's sheet and the player's `ON THIS PHONE`.
**I5 is finished. Next: I6** (the imported marker at L0/L1, the ASCII cover
at L2, the ALBUM/ARTIST axis). None of it is pushed;
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

## Open questions (for Cesar)

(none open; the two below were settled 2026-09-28)

## Where we are

| Step | State |
| --- | --- |
| I0 phone spike | **done** 2026-09-27 — throwaway, not committed |
| I1 native reduction | **done** 2026-09-27 |
| I2 phone database | **done** 2026-09-27 |
| I3 native scanner | **done** 2026-09-27 |
| I4 resolver | **done** 2026-09-27 (checked on the phone with I5) |
| I5 device source | **done** 2026-09-28 (I5a, I5b, I5d; I5c folded into I5b) |
| I6 mark and axis | not started |
| I7 import flow | not started |
| I8 300-song check | not started |

## I5 plan (device songs in the field)

Written before editing, 2026-09-27. Too wide for one commit — the field's
`FieldPresentation` is node-shaped (`SongHeader`, `BackendRecord`, delivery
artifact, `LocalAudio`) and ~70 sites read it — so four steps, each checked on
the phone:

- **I5a — the device library and the scan.** `device/deviceLibrary.ts`: opens
  the phone database, publishes the `DeviceLibrary` through `core/store`, and
  runs a scan: `generation` (stop if unchanged) → `list` → `rowsToInspect` →
  `inspect` each (one at a time, progress published) → `buildScanCommit` →
  `albumArt` for albums without art → `commitScan` → prune `files/artwork/`
  of files no album names (clears the I3 lab's three). No UI trigger yet (I7):
  until then a dev-only trigger scans **only `Music/cantor-import-test/`**,
  so Cesar's own 25 files are not imported while this is being built.
- **I5b — a presentation union.** `FieldPresentation` becomes
  `NodePresentation | DevicePresentation` (`source` tag). The typechecker then
  lists every site that reads node-only fields; each decides what a device
  song means there. Device entities use the reserved node key `device`
  (`FieldEntity.key = device:<id>`), `createdAtMs = addedAtMs`, the song's
  tags. Their mark draws from the song id for now (I6 gives it the imported
  marker and the metadata identity).
- **I5c — playing and measuring.** The player loads the original path; the
  analysis keys on `device`/id/`size:headSha256`; the shelf queue plays device
  songs; the lock screen shows title and artist.
- **I5d — the sheet.** Availability draws as `downloaded` (plays offline,
  always) but offers no GET/KEEP/REMOVE; rename, delete and regenerate are
  node verbs and are absent; tags and playlists write to the phone database.

## I4 plan (resolver)

Written before editing, 2026-09-27. Pure TypeScript, `device/resolve.ts`;
no native calls, no storage. The orchestration that calls `inspect`,
`albumArt` and `commitScan` is I5's.

- **What needs inspecting.** A row is *changed* when no present song has its
  path, or its `GENERATION_MODIFIED` is above the last scan's generation (or
  unknown, before Android 11). Only changed rows are inspected; an unchanged
  row's song stands as stored.
- **Fields, by source** (I0/I3 findings):
  - title: retriever tag → MediaStore title unless it equals the file name →
    the file name without a leading track number (`07 - `, `07. `, `07 `);
    `Artist - Title` names give an artist when no tag does.
  - artist: retriever → MediaStore unless `<unknown>` → file name → null.
  - album: retriever only (its null is "no album tag"; MediaStore's would be
    the folder name). albumArtist: retriever → MediaStore.
  - track/disc: retriever's `n/total` → MediaStore's `disc×1000+track` split
    → the file name's leading number (track only).
  - year: MediaStore → retriever year → the first four digits of the
    retriever date, **never** from the MP4 epoch date `1904…T…`, which is
    also not kept as `date`.
- **Album key**: `albumArtist | album | folder`, lower-cased and trimmed;
  artist is left out so a compilation without an album artist stays one
  album; the folder keeps two "Greatest Hits" apart. `CD1`/`Disc 2`
  sub-folders count as their parent. A file without an album tag belongs to
  its folder's untitled album (`title` null).
- **Identity**: an existing song matched by path keeps its id; otherwise by
  fingerprint (a moved file keeps its id, tags and first import time);
  otherwise `deviceSongId`. Two present files with one fingerprint are one
  song: the one already stored, else the lowest `mediaId`.
- **Missing**: a present song whose path is gone and whose fingerprint did
  not reappear. Excluded folders' rows are skipped; songs already imported
  from them are left alone (removing them is I7's decision, not a scan's).
- **Albums** are rebuilt for every key a changed song touches, from all its
  songs: title, the album artist or the most common artist, the most common
  year, and the stored artwork kept.
- **Tests**: tables of the fixture rows exactly as the phone reported them.

## I3 plan (native scanner)

Written before editing, 2026-09-27.

- **`CantorMedia`, a new native module** (`media/CantorMediaModule.kt`),
  reading only; it never writes, moves or deletes a user's file. All work on
  its own single thread.
  - `generation()` — `MediaStore.getGeneration` (API 30+; −1 below). Equal
    to the last scan's means nothing changed and the scan stops there.
  - `list(minDurationMs)` — every `IS_MUSIC = 1` row at least that long:
    `_ID`, `DATA`, `TITLE`, `ARTIST`, `ALBUM`, `ALBUM_ARTIST`, `TRACK`,
    `DISC_NUMBER`, `YEAR`, `GENRE`, `DURATION`, `MIME_TYPE`, `SIZE`,
    `DATE_ADDED`, `GENERATION_MODIFIED`. Always the full list (metadata only,
    cheap): it is also how a scan learns which songs went missing, which an
    incremental query cannot say.
  - `inspect(path)` — for a new or changed file only: size, sha256 of the
    first 64 KB (the fingerprint), and `MediaMetadataRetriever`'s tags. The
    retriever is the second reader (I0): its null album is how the resolver
    tells "no album tag" from MediaStore's folder-name album, and its date
    fills the year MediaStore drops for FLAC/Ogg/Opus.
  - `albumArt(mediaId, name)` — `loadThumbnail`, downscaled to at most
    256 px and saved as `files/artwork/<name>.jpg`; null when there is no
    art. Files, not cache: the album row points at it, and the system must
    not clear it behind the database's back.
- **Permission.** `READ_MEDIA_AUDIO` (API 33+) and `READ_EXTERNAL_STORAGE`
  with `maxSdkVersion 32`, in the manifest; asking is I7's.
- **JS bridge** `device/native.ts`, checking every row (the MediaStore
  `<unknown>` and `disc×1000+track` rules are the resolver's, I4, not this
  layer's: the bridge passes the raw values).
- **Checks.** Bridge decoding tests; on the phone a throwaway lab lists the
  fixtures, inspects each, and saves one album's art, timed.

## I2 plan (phone database)

Written before editing, 2026-09-27.

- **What it holds.** Device songs, their albums, tags per song (playlists,
  `p/<name>`, as for node songs), the last MediaStore generation scanned per
  volume, and the folders the user unticked. Nothing about node songs: the
  `cantor.private-library.v1` blob is untouched (plan § Scope).
- **One database file, `cantor.sqlite`**, opened with op-sqlite (decided
  2026-09-24) in its default location. Tables are prefixed `device_` so the
  node library can move in later without a clash. File name, tables and
  migrations are compatibility contracts from the first install on.
- **Layers.** `core/storage/sql.ts`: a small `SqlDatabase` port (execute,
  transaction) and the migration runner (`PRAGMA user_version`, one
  transaction per migration). `device/schema.ts`: migration 1.
  `device/repository.ts`: typed load / commit-scan / tags / exclusions, rows
  checked on the way in. `device/database.ts`: the only file importing
  op-sqlite. Repositories persist; the resolver (I4) decides what a scan
  means.
- **Identity.** A device song's id is assigned once, from its fingerprint
  (`d` + first 16 hex of sha256 of size and the 64 KB head hash), and kept
  after that, even if the file is retagged or moved. Two copies of one file
  are one song.
- **Tests** run the real schema on Node's built-in SQLite (`node:sqlite`,
  3.51) through the same port, so SQL mistakes fail in Jest, not on the
  phone.
- **Phone check.** A throwaway lab opens the database, migrates, commits a
  300-song scan and reads it back, timed.

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
- **2026-09-28 — The audio-api foreground-service race is patched locally,
  not reported upstream** (Cesar). `patches/react-native-audio-api+0.13.3.patch`
  via `patch-package` (`postinstall`): when the service starts before the
  playback notification exists, it starts on a placeholder under
  `PlaybackNotification.ID`, which the real notification replaces in place.
  **An audio-api upgrade must re-check or drop the patch.**
- **2026-09-28 — The device song's sheet (I5d), as proposed** (Cesar):
  title, `ARTIST · ALBUM`, year and genre, format and folder; tags and
  playlists edited like a node song's, written to the phone database; no
  rename, delete, download or recipe. The player's foot says `ON THIS PHONE`.
- **2026-09-27 — The Xiaomi is Cesar's to lend for import** ("all yours"):
  permission prompts and test fixtures in `Music/cantor-import-test/` are
  fine. Still ask before touching his own music files or his nodes.

## Measurements

I5a, Xiaomi, release build: a real scan of `Music/cantor-import-test/` only
(16 files) into the real database: **1.6 s** (16 inspections, 4 album arts
saved, 3 stale art files removed, one commit), 20 store changes. The same
partial scan again: 1.2 s (a partial scan records no generation, so it
re-inspects). Start (open + load): 14 ms.

I3, Xiaomi, release build, throwaway lab against the fixtures:

| What | Time |
| --- | --- |
| `generation()` | 44 ms (first call, includes module start) |
| `list(30000)`: 37 rows | 48 ms |
| `inspect` (64 KB hash + retriever) per file | 29–58 ms; 88 ms the first |
| `albumArt` (thumbnail, downscale, save) | 15–26 ms |

A first scan of 300 songs in ~30 albums: ~15 s of `inspect` on the
module's own thread and under 1 s of art. Worth showing progress for (I7).

I2, Xiaomi, release build, op-sqlite 18.2.5 (SQLite 3.53.4), throwaway lab:

| What | Time |
| --- | --- |
| Open + migrate to schema 1 (first run / later) | 52 ms / 9 ms |
| Commit a 300-song, 30-album scan (one transaction) | 345 ms |
| Commit the same 300 again (all upserts) | 199 ms |
| Load everything back | 11–17 ms |

Rows read back equal what was written, and survived a force-stop. The lab's
second run deleted them: the phone's `cantor.sqlite` is at schema 1, empty.
The APK grew from 186.7 to 192.6 MB (op-sqlite for four ABIs).

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

- **2026-09-28 — I5d on the phone.** An imported song's player foot reads
  `DETAIL · ON THIS PHONE`; play works with the patched audio-api (media
  session "Tone FLAC 16-44, Test Artist"). DETAIL opens the sheet: no
  favourite star, the name not editable, playlists and tags editable (added
  to Dusk and removed again: `1 OF 16` then `0 OF 16`, written to the phone
  database, nothing sent to a node), `On this phone · 2.5 MB · YOUR OWN
  FILE`, no foot act. The back page (RECORD): arrived date and time, length,
  artist, album, year, genre, format, size, folder; no delete.
- **2026-09-28 — I5d: how the sheet shows an imported song.** `SongSheet`
  takes `imported: ImportedFacts | null`; `FieldScreen` hands it a
  `SongHeader`-shaped view of the device song (its title, length, tags,
  `model: device`) so membership, the face and `useSongWish` work unchanged
  — a wish settles by comparing tags, not revisions, so the phone database
  fits. Tag edits go to `DeviceLibraryService.setTags`; the node's recipe
  is never asked for.

- **2026-09-27 — I5b: device songs in the field, on the phone.** The field
  counts 62 songs (46 node + 16 imported); imported marks draw solid
  (`pinned`: always plays offline). At L1 a row reads its title and artist
  and offers no GET/KEEP/REMOVE. At L2 the player shows the title,
  `TEST ARTIST · FIXTURE ALBUM`, the file's length, and the ring's ticks
  measured natively from the file; play works (media session: "Tone MP3,
  Test Artist", state playing), Opus too. Still wrong for a device song, and
  I5d's: the player's foot says `PINNED`, and DETAIL opens nothing (the sheet
  is node-only for now).
- **2026-09-27 — I5b folded most of I5c in.** Once the union existed the
  typechecker required every play and measure path to decide, so playing
  (`fetchPath` → the file's path), the shelf queue (`audioRefOf`,
  `playable`), the analysis (`AnalysisSource` node | device, keyed
  `device`/id/`size:headSha256`), the L3 grain and the lock-screen words
  landed with it.
- **2026-09-27 — A crash that is not import's: audio-api's foreground
  service race.** Once, on the first play after a fresh install, the app died
  with `ForegroundServiceDidNotStartInTimeException` for
  `com.swmansion.audioapi.system.CentralizedForegroundService`. Not
  reproduced in three more fresh launches. Cause, from its source
  (`CentralizedForegroundService.startForegroundWithNotification`): when
  the service starts before the playback notification is built,
  `findExistingNotification()` is null and it returns **without calling
  `startForeground`**, which Android punishes with a crash seconds later. It
  can hit any song. Not fixed here (it is inside `node_modules`); for Cesar
  to decide: a `patch-package` patch that posts a placeholder notification
  instead of returning, or raise it upstream.

- **2026-09-27 — I5a: the fixtures after a real scan.** Six albums:
  Fixture Album (9 → 7 tagged songs, art), Cover Only Album and Folder Only
  Album (art from the folder's image), an untitled album for the untagged
  WAV and AIFF in the Fixture Album folder (art from `cover.jpg`), and
  untitled `loose` and `long`. All titles, artists, discs, tracks and years as
  I4's tests say. The I3 lab's three art files were pruned.
- **2026-09-27 — Known limit, not built: untagged files beside a tagged
  album form their own untitled album.** Joining them to the folder's one
  titled album is a sensible rule, but it makes a song's album depend on its
  siblings (a stored untagged song would have to move when a tagged sibling
  arrives). Revisit if real libraries show it.

- **2026-09-27 — I4: Bandcamp's WAV/AIFF are named, not tagged, as far as
  Android can tell.** Neither reader parses their tags (I0), so the file name
  is all there is. Bandcamp names downloads `Artist - Album - 01 Title`;
  `parseFileName` reads that pattern, and an untagged file takes its album
  from the name (a tagged single never does). Without it, a Bandcamp WAV album
  imported as "Album - 01 Title" by "Artist" in an untitled folder album.
- **2026-09-27 — I4: the album title is not in the song row.** The key keeps
  it lower-cased; the spelling comes from the changed files' tags (or name)
  during a scan, else from the stored album row. No schema change was needed.
- **2026-09-27 — I4: known limits of the name parser.** A title starting with
  one to three digits and a space (`100 Years.mp3`) loses them to the track
  number; four digits (`2001 A Space Odyssey`) are kept. Only when the file
  has no title tag.

- **2026-09-27 — I3: the scanner on the phone** (fixtures; Cesar's own files
  only counted). What the resolver (I4) receives:
  - MediaStore `track` is `1001…` (disc × 1000 + track); the retriever's is
    the tag text, `"7/10"`. `disc` is `"1/1"` from both.
  - Untagged files: MediaStore gives `artist "<unknown>"`, `album` = folder
    name, `title` = file name; the retriever gives **all nulls** — the
    reliable "no tag" signal. WAV and AIFF look the same way even though
    they are tagged (neither reader parses their tags).
  - `year`: MediaStore null for FLAC/Ogg/Opus, the retriever's `date` is
    `"2019"` there; for MP3 the retriever has `year "2019"`, `date` null; for
    M4A its `date` is the MP4 epoch `19040101T000000.000Z` and `year` is right.
  - `albumArtist` null from both when the file has none (Cover Only).
  - `list(0)` includes the 3 s blip, `list(30000)` does not.
  - Files pushed without `scan_volume` are absent from `list` (the `long/`
    folder): MediaStore is the only source of truth for what exists.
- **2026-09-27 — I3: the lab left three files in the app's
  `files/artwork/`** (`lab-1000000769.jpg`, `lab-1000000774.jpg`,
  `lab-1000000779.jpg`, ~5 KB each), which a release build cannot delete from
  adb. **Requirement for I5:** a scan removes every file in `files/artwork/`
  that no album row names; that also clears these.

- **2026-09-27 — I2: Node 22's built-in SQLite runs the schema in Jest.**
  `jest/nodeSqlite.ts` binds the `SqlDatabase` port to `node:sqlite`
  (3.51, in memory). It declares the few `node:sqlite` types it needs
  locally: adding Node's types to `tsconfig` (`types: ["jest"]` only) would
  change `setTimeout`'s return type across the app. It also throws if a
  statement runs on the database instead of the transaction inside
  `transaction`, which op-sqlite would deadlock or interleave.
- **2026-09-27 — I2: nothing imports op-sqlite outside `device/database.ts`
  yet.** When I5 wires the database into the runtime, Jest needs a
  `moduleNameMapper` entry for `@op-engineering/op-sqlite` (a mock, or the
  Node binding) like the other native modules in `jest.config.js`.

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
- **2026-09-27 — Follow-up for I8: `ANALYSIS_STORE_KNOBS.BACKGROUND_GAP_MS`**
  (1.5 s rest between background measurements) was sized for the JS decode
  (~1.5 s of the JS thread per song). After I1 a measurement is 0.1–0.6 s off
  the JS thread; the rest and its comment should be re-tuned with 300 songs.
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

- **`patch-package` without `--include` captures build output.** The first
  patch of react-native-audio-api swept in `android/.cxx/` CMake caches
  (megabytes). Always `npx patch-package <pkg> --include '<file regex>'`.
- **audio-api's `CentralizedForegroundService` is not exported**, so
  `adb shell am start-foreground-service` is refused: the race it had cannot
  be forced from adb. The patch is verified by reading, not by reproduction.

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
- `68b51e0` player: format nativeSamples
- `2fa88e8` device: phone database for imported songs
- `15a2618` docs: import I2, phone database
- `a220179` media: read the phone's music
- `770dfdc` docs: import I3, native scanner
- `041da3e` device: resolve a scan into songs and albums
- `be18d23` docs: import I4, resolver
- `19ec171` device: the device library and its scan
- `af3dcb8` docs: import I5a, device library
- `f48c4b8` field: device songs join the field
- `96ee904` docs: import I5b, device songs in the field
- `fdac1df` audio: start audio-api's foreground service on a placeholder
- `e149691` song: an imported song's sheet and player words

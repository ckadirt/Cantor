# Device import — plan

Bring the songs already on the phone into Cantor: purchased downloads
(Bandcamp, Qobuz, iTunes), CD rips and loose files. Offline streaming caches
(Spotify, YouTube Music) are not imports and are out of scope.

This is a new feature built on the finished field rewrite
([`../refactor/field-rewrite-log.md`](../refactor/field-rewrite-log.md), phases
1–4). The design it follows is `field-redesign.html` § "Songs, homes and
copies": an imported song has `home = device` and a device-original copy that
is never evicted. The running record is [`log.md`](log.md).

## Scope

- **Device only.** No protocol change: `SongHeader` requires `model` and has no
  artist or album. Offload to a node and node-side import come after alpha
  (decided 2026-09-24).
- **300 songs on day one** is the realistic target; nothing may be O(N) per
  frame or per event.
- **Storage contracts hold.** `cantor.private-library.v1` keeps loading
  unchanged; imports live in new storage only.

## What arrives

A downloaded album is a package, not N audio blobs: audio, tags, track order
and artwork. Cantor keeps that structure.

| Source | Typical files |
| --- | --- |
| Bandcamp | ZIP of MP3 (default), FLAC, AAC, Ogg, ALAC, WAV or AIFF, plus `cover.jpg`; FLAC also embeds the cover |
| Qobuz | FLAC/ALAC/WAV/AIFF up to 24-bit/192 kHz; MP3/AAC |
| iTunes | 256 kbps AAC `.m4a`, DRM-free |
| CD rips | FLAC (Windows/Linux), ALAC `.m4a` (Apple); tidied with Picard or beets |
| Loose files | old MP3s, copies from a PC or NAS, own recordings, anywhere under `Music/`, `Download/`, an SD card |

Layouts seen: `Artist/Album/NN - Title.ext`, `Artist/YEAR - Album/CD1/…`, and
flat `Download/12345.flac` with perfect tags. **Tags are the data; folders are a
hint.** Artwork is embedded, beside the tracks (`cover`, `folder`, `albumart` ×
jpg/png), or both, and belongs to the album, not the track.

## How Cantor reads the device

**MediaStore, not a folder walk and not the document picker.** The player
(`react-native-audio-api`) opens file paths through FFmpeg and never touches a
`ContentResolver` (`toFileUri`, `player/audioApiPlayer.ts`). The document
picker only yields `content://` URIs, which would force a copy of every file.
MediaStore's `DATA` column gives a path that an app holding
`READ_MEDIA_AUDIO` (API 33+; `READ_EXTERNAL_STORAGE` below, minSdk is 24) may
open directly since Android 11. **Confirmed on the Xiaomi in I0.**

Formats: audio-api is built with FFmpeg (`disableAudioapiFFmpeg` unset). I0
decoded and played mp3, flac 16/44 and 24/96, m4a AAC and ALAC, ogg, opus, wav
and aiff from their paths.

### MediaStore traps

- Filter `IS_MUSIC = 1` and a minimum duration: ringtones, alarms,
  notification sounds, WhatsApp voice notes and call recordings are all in
  MediaStore too.
- `"<unknown>"` (`MediaStore.UNKNOWN_STRING`) for artist and album means
  *missing*; a title equal to the file name means *no title tag*.
- `TRACK` is `disc × 1000 + track` (still on API 33); `DISC_NUMBER` is the raw
  tag string (`1/1`).
- An untagged file's `ALBUM` is its **folder name**, not `<unknown>`; only
  `ARTIST` is `<unknown>`. WAV and AIFF tags are never read, so they always
  look untagged.
- `YEAR` is null for FLAC, Ogg and Opus; `MediaMetadataRetriever`'s `DATE`
  fills it (but its `DATE` is garbage for M4A — use `YEAR` there).
- The duration comes from MediaStore; audio-api's `getAudioDuration` returns 0
  for Ogg Vorbis.
- `ALBUM_ID` is not an identity: two "Greatest Hits" merge. Cantor builds its
  own album key.
- `_ID` can change when a file is moved or re-indexed. Each song also carries a
  fingerprint to re-attach.

## The model

```
DeviceSong   id · mediaId · path · fingerprint (size, duration, sha256 of first 64 KB)
             · title · artist · album · albumArtist · disc · track · year · genre
             · durationMs · mime · addedAtMs · date (year/date tag, kept) · albumKey · missing
Album        key = normalize(albumArtist ?? artist) + normalize(album) + folder
             · title · artist · year · artwork (cached thumbnail path | none)
Tags         per song, as today (playlists = p/<name>)
```

Resolution order:

- **Title / artist / album / numbers:** tags (via MediaStore) → file name
  (`NN - Title`, `Artist - Title`) → folder names.
- **Artwork:** `loadThumbnail` (API 29+) alone — it returns the embedded
  picture, else the folder's `cover.jpg`/`folder.jpg` (I0), which the app
  cannot open directly with audio permission → none. Downscaled by us (it
  ignores the requested size) to one ~256 px file per album in the app cache;
  never the full image, never per track.

A file that disappears marks its song `missing`; it is not deleted, and it
re-attaches by fingerprint if it reappears elsewhere.

## Decisions

Settled with Cesar on 2026-09-27.

1. **The imported mark.** L0/L1: the same drawn form as a generated mark, its
   identity from a hash of the metadata (`field-redesign.html`: "a hash of the
   metadata"), plus a marker that says *imported*. Both lenses keep the
   grey/black/filled ink order. L2 offers the circle, the waves, **and the
   cover** — the cover not as a photo but converted by a cheap math/ASCII
   function (brightness → glyph density) into ink, so it matches the app's
   aesthetic. **The ASCII is never stored** (Cesar, 2026-09-27): it is
   computed on the fly from the album's small cached thumbnail — a grid of
   ~50×50 brightness cells mapped to glyphs is microseconds of work. Only the
   thumbnail is kept.
2. **Grouping.** Time axes (WEEK/MONTH/YEAR) use arrival on the phone
   (`DATE_ADDED`) for now; an album arrives together, so it clusters. **The
   song's own date (year/date tag) is stored too**: it is shown to the user
   and a later setting may let the time axes use it instead of arrival. A new
   ALBUM/ARTIST axis joins the dial as an arrangement beside `byTime` and
   `byPlaylist`.
3. **What a scan takes in:** everything passing the filter, shown as a summary
   (folders, albums, track counts) the user can untick before anything is
   imported.

## Steps

Each ships alone and follows the routine in `log.md`.

| Step | What | Why here |
| --- | --- | --- |
| **I0 phone spike** | Throwaway: permission, MediaStore query, play the `DATA` path with our player, `loadThumbnail`; one fixture per format (mp3, flac 16/44 and 24/96, m4a AAC, m4a ALAC, ogg, opus, wav, aiff). | Decides path playback with no copy. Everything below leans on it. |
| **I1 native reduction** | **Done.** C++ on audio-api's own decoders (FFmpeg for MP4/AAC, its miniaudio for the rest) streaming min/max/rms buckets, replacing `readSamples`' JS loop; the JS path stays as fallback. MediaCodec was tried and dropped (log § Findings). | Today: ~1.5 s of a core per song, and a whole-song float buffer (~69 MB for 3 min at 44.1 kHz, ~230 MB for 5 min at 96 kHz). |
| **I2 phone database** | **Done.** `cantor.sqlite` via op-sqlite: device songs, albums, tags, scan generations, excluded folders (`device/schema.ts`). The AsyncStorage blob is untouched. | Decided 2026-09-24; imports are its first user. |
| **I3 native scanner** | **Done.** `CantorMedia`: `generation`, the full `IS_MUSIC` list (metadata only), `inspect` (fingerprint + retriever tags) and `albumArt` (≤256 px in `files/artwork/`). Read only. | Keeps the scan native and re-scans cheap. |
| **I4 resolver** | **Done.** Pure TS (`device/resolve.ts`): retriever tags → MediaStore → file name (incl. Bandcamp's `Artist - Album - 01 Title`), the `<unknown>`/folder-album rules, disc/track split, album key, identity by path then fingerprint, duplicates, moves, missing. | All policy in one testable place. |
| **I5 device source** | **Done.** `DeviceLibraryService` (scan, store); `FieldPresentation` is a node/device union; device entities under the reserved key `device`; GET/KEEP/REMOVE absent; the player plays the original path; the sheet shows the file's facts and edits tags in the phone database. | Songs appear in the field with no renderer change. |
| **I6 mark and axis** | Decisions 1 and 2: the imported marker in both lenses (goldens updated on purpose), the ASCII cover at L2, the song's date shown, the ALBUM/ARTIST arrangement. | |
| **I7 import flow** | Entry point, permission, scan summary, progress, re-scan. | The only new UI. |
| **I8 300-song check** | ~300 real files on the Xiaomi: L0 idle, panning, a re-group, memory. | The thousands-of-songs goal. |

## Out of scope

Offload to a node, node-side import, CUE sheets, DRM-protected files (counted
and skipped), editing tags, writing anything to the user's files.

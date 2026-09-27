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
open directly since Android 11. **I0 must confirm this on the Xiaomi.**

Formats: audio-api is built with FFmpeg (`disableAudioapiFFmpeg` unset), so
mp3, flac, m4a AAC/ALAC, ogg, opus, wav and aiff are expected to decode.
Measured per format in I0, not assumed.

### MediaStore traps

- Filter `IS_MUSIC = 1` and a minimum duration: ringtones, alarms,
  notification sounds, WhatsApp voice notes and call recordings are all in
  MediaStore too.
- `"<unknown>"` (`MediaStore.UNKNOWN_STRING`) for artist and album means
  *missing*; a title equal to the file name means *no title tag*.
- `TRACK` may hold `disc × 1000 + track` on older rows; `DISC_NUMBER` and
  `GENRE` exist only on newer APIs.
- `ALBUM_ID` is not an identity: two "Greatest Hits" merge. Cantor builds its
  own album key.
- `_ID` can change when a file is moved or re-indexed. Each song also carries a
  fingerprint to re-attach.

## The model

```
DeviceSong   id · mediaId · path · fingerprint (size, duration, sha256 of first 64 KB)
             · title · artist · album · albumArtist · disc · track · year · genre
             · durationMs · mime · addedAtMs · albumKey · missing
Album        key = normalize(albumArtist ?? artist) + normalize(album) + folder
             · title · artist · year · artwork (cached thumbnail path | none)
Tags         per song, as today (playlists = p/<name>)
```

Resolution order:

- **Title / artist / album / numbers:** tags (via MediaStore) → file name
  (`NN - Title`, `Artist - Title`) → folder names.
- **Artwork:** embedded or MediaStore thumbnail (`loadThumbnail`, API 29+) →
  `cover|folder|albumart.(jpg|png)` beside the tracks → none. One ~256 px file per
  album in the app cache; never the full image, never per track.

A file that disappears marks its song `missing`; it is not deleted, and it
re-attaches by fingerprint if it reappears elsewhere.

## Decisions

Cesar delegated these on 2026-09-27 ("all yours"); revisit if the phone says
otherwise.

1. **The imported mark** is the same drawn form as a generated one, its identity
   from a hash of the metadata (`field-redesign.html`: "a hash of the
   metadata"), with a distinct imported cue. The field stays ink: the cover is
   shown only where one song owns the screen (L2 / the player). Both lenses
   keep the grey/black/filled ink order.
2. **Grouping.** Time axes (WEEK/MONTH/YEAR) use arrival on the phone
   (`DATE_ADDED`); an album arrives together, so it clusters. A new
   ALBUM/ARTIST axis joins the dial as an arrangement beside `byTime` and
   `byPlaylist`. The release year is kept as data, not used as a time axis.
3. **What a scan takes in:** everything passing the filter, shown as a summary
   (folders, albums, track counts) the user can untick before anything is
   imported.

## Steps

Each ships alone and follows the routine in `log.md`.

| Step | What | Why here |
| --- | --- | --- |
| **I0 phone spike** | Throwaway: permission, MediaStore query, play the `DATA` path with our player, `loadThumbnail`; one fixture per format (mp3, flac 16/44 and 24/96, m4a AAC, m4a ALAC, ogg, opus, wav, aiff). | Decides path playback with no copy. Everything below leans on it. |
| **I1 native reduction** | Kotlin `MediaExtractor` + `MediaCodec` streaming min/max/rms buckets, replacing `readSamples`' JS loop; the old path stays as fallback for what the platform decoder refuses. Measured. | Today: ~1.5 s of a core per song, and a whole-song float buffer (~69 MB for 3 min at 44.1 kHz, ~230 MB for 5 min at 96 kHz). |
| **I2 phone database** | op-sqlite: device songs, albums, tags. The AsyncStorage blob is untouched. | Decided 2026-09-24; imports are its first user. |
| **I3 native scanner** | `CantorMediaModule`: paged MediaStore rows, album thumbnails to cache, incremental re-scan via `MediaStore.getGeneration` (API 30+). | Keeps the scan native and re-scans cheap. |
| **I4 resolver** | Pure TS: tags → name → folder, the `<unknown>` rule, disc/track split, album key, fingerprint, duplicates. Table tests of messy real cases. | All policy in one testable place. |
| **I5 device source** | A second producer into the library store; `FieldEntity` gets a reserved device home key; GET/KEEP hidden; the player plays the original path. | Songs appear in the field with no renderer change. |
| **I6 mark and axis** | Decisions 1 and 2: the imported cue in both lenses (goldens updated on purpose), the cover at L2, the ALBUM/ARTIST arrangement. | |
| **I7 import flow** | Entry point, permission, scan summary, progress, re-scan. | The only new UI. |
| **I8 300-song check** | ~300 real files on the Xiaomi: L0 idle, panning, a re-group, memory. | The thousands-of-songs goal. |

## Out of scope

Offload to a node, node-side import, CUE sheets, DRM-protected files (counted
and skipped), editing tags, writing anything to the user's files.

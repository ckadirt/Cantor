# The import flow — build log

The working record for building [`flow-plan.md`](flow-plan.md) (step I7 of
[`plan.md`](plan.md)). The plan says *what*; this page says *where we are*,
what happened on the way, and what the next session needs to know before
touching anything. Read it top to bottom before starting, and add to it in the
same `docs:` commit that follows the work.

- **Status** mirrors the table in `flow-plan.md`, with one line on what is
  actually left.
- **Deviations** are every place the build differs from
  [`flow.html`](flow.html) or the plan, with why.
- **Findings** are facts learned from the code or the phone. **Traps** are
  things that cost time. Keep both short and concrete.
- **Session log** is newest first.

The routine for each step is [`log.md`](log.md) § "How a step is done here".

---

## Next session starts here

**I7a–I7d are built and tested (logic only, no UI yet). Next: I7e**, the
phone in the roster, then I7f.

The test phone is now **Cesar's own Samsung A52s** (`R5CRC0VVK1M`, Android 14,
API 34, 1080×2400 at density 450 → **384 dp wide**, not the Xiaomi's 392; the
drawing is 392, so compare proportions, not pixels). It is his real phone:
uninstalling/reinstalling Cantor and new seeds are fine; **never touch other
apps or his files** — no fixtures are pushed to it. Its MediaStore is the real
test (see Findings). `READ_MEDIA_AUDIO` is **not granted** on it, so the ask
(`f-ask`) can be tested for real; to re-test it later:
`adb shell pm revoke com.cantor.app android.permission.READ_MEDIA_AUDIO`.

Before the first line of UI, read:

1. `flow-plan.md`, then the frames in `flow.html` (serve it as in the plan's
   "Comparing against the drawing").
2. `cantor/src/device/deviceLibrary.ts` (the store the UI reads: `permission`,
   `folders`, `scan`, `result`, `lookedAtMs`), `folders.ts`, `permission.ts`.
3. `cantor/src/features/engines/EnginesSheet.tsx` and `SettingsSheet.tsx`: the
   roster and the page kinds the phone joins.
4. `docs/interfacealpha/folio-steps.md` and `folio-log.md` (on disk only) for
   the controls (`Folio`, `Measure`, `Rest`, `Coda`, `Underway`, `Strike`,
   `Clef`).

## Status

| # | State | What is left |
| --- | --- | --- |
| I7a | **done** 2026-10-02 | — |
| I7b | **done** 2026-10-02 (logic) | the phone check of a real bring-in waits for the UI (I7f/g) |
| I7c | **done** 2026-10-02 (logic) | revoke/grant cycle on the phone, through `f-ask` (I7f) |
| I7d | **done** 2026-10-02 (logic) | timings of a no-change and a 1-new-file look, once something is brought in |
| I7e | not started | everything |
| I7f | not started | everything |
| I7g | not started | everything |
| I7h | not started | everything |
| I7i | not started | everything |
| I7j | not started | everything |

### The API the UI builds on (I7b–I7d)

- `DeviceLibraryService.look(options?)` → `{ changed, folders }`. Lists and
  sums up (`summarize`); the same generation answers from memory (no list).
  `changed` is false when the generation equals the one stored by the last
  bring-in — `Nothing new`.
- `bringIn(leftOut: Set<folderPath>)` → `ScanResult` (now with
  `importedIds`). Saves the choice first: stored exclusions ∪ `leftOut`, minus
  listed folders not left out (a grey folder tapped back to ink comes back).
- `refresh()` — the automatic look: needs the permission granted and at least
  one `kept` folder; brings in changed rows of kept folders only.
- `scan(options?)` — kept for old callers: look, then bring in the summary's
  starting choice (voice notes out). Returns `changed: false` with no work
  when the generation has not moved.
- `checkPermission()`, `requestPermission()`, `openSettings()`; the store's
  `permission` is `unknown | granted | denied | blocked`.
- Progress: `scan.phase === 'inspecting'` carries `done/total` over files
  **then** album art, `current` (`ReadingAlbum`: key, title, artist, mediaId)
  and `folders` (per-folder `{done,total}` of files).
- `nativeMedia.thumbnailLuma(mediaId, cells)` — the clef's picture of the
  album being read, straight from MediaStore, never written.
- `startLookingAgain` (`device/lookAgain.ts`) runs `refresh` after `start()`
  and on each return to the foreground, debounced 2 s; wired in `FieldScreen`.

## Open questions (for Cesar)

Mirrors `flow-plan.md` § "Open questions"; move each here into a decision with
its date when answered.

- DRM: folded into `Couldn't read` for now (see Deviations); a separate
  `Protected` count only if Cesar wants one.
- Leaving a folder out drops its tags: is `HOLD · 168 LEAVE · FILES STAY`
  enough warning?

## Deviations

- **2026-10-02 — No `Protected` count.** `inspect` hashes the head and runs
  `MediaMetadataRetriever`; a protected file and an unreadable one both just
  throw (or read with no tags), and DRM'd local audio is essentially extinct
  on Android. Everything that fails is `failed` → `Couldn't read`.
- **2026-10-02 — The clef's luma: native `thumbnailLuma`.** Chosen over saving
  each album's art early: the album key is only known after resolving, so
  early saving would mean resolving per file; the native call is one
  `loadThumbnail` per album change, display only, and shares `artworkLuma`'s
  reduction (`lumaGrid`).
- **2026-10-02 — The first look of a run always lists**, even when the
  generation matches the stored one: the roster needs the summary (new
  folders) and nothing in memory has it. Every later look is generation-gated
  (one native call). Listing is metadata only; it opens no file.
- **2026-10-02 — Withdrawn permission reads `denied`, not `blocked`.** Android
  asks again after a revoke in settings, so the page is `f-ask`, and the roster
  says `NOT ALLOWED NOW` because songs exist. `blocked` comes only from a
  `never_ask_again` answer. Android's check cannot tell denied from blocked,
  so after a restart a blocked phone reads `unknown` until `Allow music`
  (which then returns at once, with no dialog, as `blocked` → `f-denied`).
- **2026-10-02 — Progress `total` may move once:** albums needing art are
  estimated from MediaStore's albums until the files are resolved. The
  measured rule should never draw backwards (take the max in the UI).

## Findings

- **2026-10-02 — Cesar's Samsung, MediaStore as it is** (`IS_MUSIC = 1`,
  counted read-only with `content query`): `Music/clasic` 104,
  `Music/rp-clone` 51, `Music/P2P/Soulseek Complete/<3 albums>` 35,
  **`Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio` 70 (50 of
  them ≥ 30 s)**, four audiobooks each alone in
  `Documents/Audiolibro/<Book [ASIN]>/`, a few loose files in `Music/`,
  `Music/Samsung`, `Download`. So **WhatsApp audio does pass `IS_MUSIC` on
  Samsung** (the open question): the voice-note guess matters. Recordings,
  Notifications and Slack sounds are `IS_MUSIC = 0` and never listed.
- **2026-10-02 — Audiobooks become one folder per book** under the parent
  rule (`Documents/Audiolibro/Fluir [B094Y7YLRY]`). Correct by the rule, but
  four one-song folders; watch how `f-sum` reads with them. Not voice notes.
- **2026-10-02 — Correction: the resolver did honour `excludedFolders`**
  (`rowsToInspect` and `buildScanCommit` skip them, and songs under them never
  read as missing). What was missing was anything that *wrote* the set; I7b's
  `bringIn` does.

- **2026-10-01 — The scan ignores `excludedFolders`.** The table
  (`device_excluded_folder`), `DeviceLibrary.excludedFolders` and
  `repository.setExcludedFolders` exist since I2, but nothing in `resolve.ts`
  or `deviceLibrary.ts` reads them. I7b wires them; until then a folder can't
  be left out.
- **2026-10-01 — Nothing asks for the permission.** No `PermissionsAndroid`
  call exists in `src/`; the manifest declares `READ_MEDIA_AUDIO` (and
  `READ_EXTERNAL_STORAGE` below API 33), and the Xiaomi holds the grant from the
  I0 spike. A fresh install has never been asked. I7c.
- **2026-10-01 — Nothing calls `scan()` in the product.** `FieldScreen`
  creates `DeviceLibraryService` and calls `start()` only; the songs in the
  phone database came from fixture scans. I7d adds the automatic look.
- **2026-10-01 — Art is saved only after every file is inspected**
  (`withArtwork` runs after the inspect loop), so the bringing-in clef can't
  use saved art for the album being read. `flow-plan.md` I7b gives the two
  routes.
- **2026-10-01 — Reusable pieces already exist:** `coverPath(art, side)` in
  `lenses/coverLens.ts` draws a `CoverArt` as a Skia path at any size;
  `coverArtOf` in `lenses/cover.ts` turns luma into glyph levels;
  `nativeMedia.artworkLuma(file, cells)` reduces a saved art file. The roster
  page kinds live in `EnginesSheet`'s `Page` union.
- **2026-10-01 — `CantorMediaModule.list` filters `IS_MUSIC = 1` and the
  minimum duration.** Files under `Recordings/` or messenger folders may not
  reach the summary at all on some phones; the voice-note guess is for the
  ones that do.

## Traps

(none yet)

## Session log

### 2026-10-02 — I7a–I7d, logic; moved to the Samsung

- I7a: `device/folders.ts` (`folderOf`, `isUnder`, `looksLikeVoiceNotes`,
  `summarize`, `songsKept`), tested on this phone's real layouts.
- I7b: `look` / `bringIn` / `refresh` / `scan` over one job queue; progress
  over files then art, current album, per-folder counts; `importedIds`;
  native `thumbnailLuma`.
- I7c: `device/permission.ts` and the store's `permission`; the list failing
  re-checks it.
- I7d: `device/lookAgain.ts`, wired in `FieldScreen`.
- Release build installed over the old app on the Samsung (data kept); it
  boots to the field with its 2 node songs; no permission yet, so the
  automatic look does nothing, as designed.

### 2026-10-01 — the flow drawn and planned

- Proposed the flow in text; Cesar settled it: the phone first in the roster,
  voice notes grey, looking again on every open (VLC), the cover clef kept, and
  the words left to the drawing.
- Drew [`flow.html`](flow.html): 14 frames, three summary variants (by folder
  chosen), two bringing-in variants (in the blind chosen). Checked in headless
  Chromium; `?still` added so screenshots show finished frames.
- Wrote `flow-plan.md` (I7a–I7j) and this log.

## Commits

- `9656528` docs: the import flow drawn and planned (I7)
- `e15f583` device: folders and the summary a person keeps or leaves out (I7a)
- `372fe0a` device: look and bring in as two halves, the music permission,
  and a look on every open (I7b–I7d)

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

**All of I7 (I7a–I7j) is built and checked on the Samsung, 2026-10-03,**
including a fresh install run end to end: onboarding → the empty field →
`Bring it in` → `f-ask` → Android's dialog → summary → bring-in → arrival.
What is left is in the Status table (mostly reduced-motion and L0 checks, a
perf sample, a 1-new-file timing) and in **Open issues**. The vanishing
cluster labels are fixed (see Resolved).

**State of the Samsung after this session** (`R5CRC0VVK1M`, Cesar's own
phone): Cantor was **uninstalled and reinstalled** for the I7i check, as Cesar
allowed. It has a **new identity** (its words were not written down anywhere
but on the phone's own onboarding screen) and **no node is paired** — the old
agentbox pairing went with the old install; re-pairing needs Cesar to scan a
`cantor pair` QR. The phone library holds 198 songs (`Music/Samsung`,
`Data_transfer` and the two WhatsApp folders left out). `READ_MEDIA_AUDIO` is
granted. AppLock PRO asked to lock the new install; answered *Not Now*.

To build on it next:

1. The label problem is fixed (Resolved, below). Read Open issues.
2. `I8` (the 300-song check) waits: Cesar said not yet.
3. Remaining I7 checks: reduced motion (Android's *Remove animations*) for the
   reading clef and the arrival; L0 arrival; `perf-sample.sh` during a
   200-song arrival; a 1-new-file look (needs a file copied in — ask Cesar).

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
| I7b | **done** 2026-10-02 | — (real bring-in of 204 files on the Samsung) |
| I7c | **done** 2026-10-02 | — (deny, deny-for-good, grant-and-return checked on the Samsung) |
| I7d | **done** 2026-10-02 | timing of a 1-new-file look (needs a file added; Cesar's call) |
| I7e | **done** 2026-10-02 | the seal's wave while bringing in not yet seen on the phone (blind closed mid-way) |
| I7f | **done** 2026-10-02 | `f-new` and `f-none` seen only in tests; `FOUND n` counting up (see Deviations) |
| I7g | **done** 2026-10-02 | cell-by-cell clef change not captured mid-flight; reduced-motion crossfade unchecked |
| I7h | **done** 2026-10-03 | — (wall, album tap into ALBUM, strike: all on the Samsung) |
| I7i | **done** 2026-10-03 | — (fresh install on the Samsung) |
| I7j | **done** 2026-10-03 | L0 "cluster by cluster" not seen on the phone (the camera goes to L1); reduced motion unchecked; perf sample of a 300-song arrival not taken |

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

## Open issues

- **Audiobook folders found excluded, cause not found (2026-10-03).** After
  a session of strikes and bring-ins, the four `Documents/Audiolibro/*`
  folders were in `device_excluded_folder` (each one, by its own path)
  though nobody had left them out. The only writers are the folder strike
  (`leaveOut`, one folder) and `bringIn` (its `leftOut` set). Logged both on
  the phone through the same sequence twice: every write was exactly right,
  so it did not come back. Suspect the page's `taps` (a folder's ink, kept
  by path across the summary, the chooser and `f-new`) leaking from one
  choice into another. If it shows again, log `leftOut` at `bringIn` first.
- **`2 BEING MADE` on a week of two finished node songs at a cold start
  (2026-10-03).** `groupContents` says *being made* when a cluster's entities
  are not songs (`songCount` 0): at launch the node songs were briefly jobs.
  Not seen since (no node is paired on the Samsung now); it needs a paired
  node to look at. Runtime, not import.
- **Byte-identical copies are re-inspected on every scan.** A duplicate never
  becomes a stored song, so its path always reads as new to `rowsToInspect`:
  5 files in `Music/clasic` are hashed on every bring-in and on every
  automatic look whose generation moved, and the folder gets a `DONE` line in
  `f-bring` though nothing comes from it. Cheap at 5; a stored "seen paths"
  set (or treating a known fingerprint as present) would end it.

## Resolved

- **2026-10-03 — Cluster labels vanishing (fixed, `e37d819`).** Logged every
  label plan on the phone: when a re-cut moved, added or removed some
  clusters, `planShelfLabels` returned flights only for those, and the
  native renderer draws *only* flights, so every cluster that stood still
  lost its name until a later re-cut happened to cover it. Imports re-cut
  often, so they showed it most; a cold start with node sync and the phone
  library landing one after the other did too. Now a standing cluster gets a
  standing flight in any plan that changes something (a plan where nothing
  changes still answers null, and the settled flights draw). Regression
  test in `labelMorph.test.ts`, which fails on the old code; checked on the
  phone with the exact sequence that lost them.

## Open questions (for Cesar)

Mirrors `flow-plan.md` § "Open questions"; move each here into a decision with
its date when answered.

- DRM: folded into `Couldn't read` for now (see Deviations); a separate
  `Protected` count only if Cesar wants one.
- ~~Leaving a folder out drops its tags: is the note enough?~~ **No**
  (Cesar, 2026-10-03): the folder page's coda now says, before the hold,
  *Their tags and playlists go with them. The files stay where they are.*
  (`5360df6`). The mono note stays `HOLD · 168 LEAVE · FILES STAY`.
- I8 on the Samsung: **not yet** (Cesar, 2026-10-03).

## I7j proposal: an opening clock (2026-10-03)

The renderer has **no per-entity opening clock**. A re-cut's `enter` flights
only fade in, all on the one re-cut clock (`flightOwnerAlpha`), and the
songs' commit lands while the blind is still up, so by `See them` that re-cut
is long over. The smallest thing that does the drawing:

- **`features/field/opening.ts`, pure:** `planOpening(ids, placements,
  albumOf)` groups the new ids by album, orders the albums as the layout
  reads (top to bottom, then left to right), and gives each album a start
  offset in ms. Tested.
- **`FaceFlight.openAt`** (−1 when not opening), filled in `faceFlightsOf`
  from the plan. The faces are rebuilt once when an opening is armed and
  once when it is cleared, which is what any presentation change costs today.
- **One clock, `openingMs`** (a shared value, elapsed ms, linear), read once
  per frame in `drawFieldFaces`; per mark, one compare when `openAt < 0` and
  a smootherstep otherwise, multiplying the size the lens beats already
  multiply (`comingScale`). No new pass over the field; nothing at rest.
  Reduced motion multiplies ink instead (a crossfade), as the lens change
  does.
- **Armed at commit, run when the blind lifts.** `FieldScreen` follows the
  device store's `result`: new `importedIds` arm the plan with the clock at
  0, which holds the new marks at a point behind the blind; the clock runs
  when the blind is closed (or at once if it already is, the "you can close
  this" case), and the plan is cleared when it has run.
- **Deviation from "~520 ms apart" (kept as built):** the step is `min(520,
  3000 / albums)`. With this phone's 169 albums 520 ms would be a 90 s arrival; a
  handful of albums still get the full 520.
- The camera goes to the group holding the first new song (the same
  pending-group mechanism as I7h's album tap), and the field's meta line says
  `N ARRIVED FROM THIS PHONE` until the blind is next opened.

## Deviations

- **2026-10-02 — Listing says `READING`, not `FOUND n` counting up.** The
  native list returns every row at once (~0.3 s for 260 rows here), so there
  is no count to show while it runs; the stave fills when the summary lands.
- **2026-10-02 — `Looks in: Music, Download and the rest`.** The drawing
  promises *Music, Download*, but the list is every `IS_MUSIC` row of the
  primary volume (WhatsApp Audio, `Documents/Audiolibro` here). The words say
  so rather than promise less than the code reads.
- **2026-10-02 — `f-none` has no *Passed over* row.** The native list filters
  short sounds itself, so their count is not known.
- **2026-10-02 — A folder outside the music roots shows its last segment
  only** (`Fluir [B094Y7YLRY]`, `Data_transfer`); its parent path is not
  drawn. As the plan says; it reads fine with this phone's audiobooks.
- **2026-10-03 — A folder's wall labels long artist names in the value
  column** (`LUDOVICO EINAUDI` is past the label column's 12 characters):
  the Ledger's own rule for long labels, not drawn in `f-folder`.
- **2026-10-03 — The folder page's meta counts stored songs** (`MUSIC/CLASIC
  · 102 SONGS`) while the phone page's folder line counts MediaStore rows
  (`107 SONGS`): duplicates merged and unreadable files are the difference.
- **2026-10-02 — "Brought in before" means a song is stored**, not "a song or
  an excluded folder" (plan I7d): a first bring-in that failed after saving
  its exclusions read as `f-new` with `Bring in 204 more` and the roster said
  `10 NEW FOLDERS`. Exclusions alone now count as a first visit.

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

- **2026-10-02 — First real bring-in (Samsung):** 204 files in 10 folders
  (`Data_transfer` and both WhatsApp folders left out) → **199 songs, 169
  albums, 120 artists, 7.4 GB**; 0 unreadable; 5 files were byte-identical
  copies and merged into one song each. Reading ran at ~13 files/s (about
  16 s for the files, then album art). The field shows 201 songs over 7
  weeks; 157 arrived "this week" by `DATE_ADDED`.
- **2026-10-02 — `Music/clasic` is 107 files in 99 MediaStore albums**: loose
  tagged singles in one folder. The summary's album count is MediaStore's
  hint and reads oddly high there; Cantor's own albums (169 overall) come from
  the resolver.
- **2026-10-02 — A look with nothing changed costs one native call**: `Look
  again` answers `Nothing new` in under 0.6 s, end to end.

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

- **2026-10-03 — A re-cut stays in `fieldCamera.recut` after it lands.** To
  act after one (the album tap: switch to ALBUM, then descend), wait for
  `recut !== null && relayoutLinear < 1` to be seen, then for
  `relayoutLinear` to reach 1. An effect in the same commit as the layout
  change sees `recut === null` (the camera hook starts it a commit later),
  descends, and the re-cut then flies the camera home over it.

- **2026-10-02 — `Maximum update depth exceeded` killed the first real
  bring-in** after the files were read (no commit; exclusions were saved).
  React throws it from `scheduleUpdateOnFiber`, i.e. *inside the service's
  `store.set`*, so a page watching progress could abort the import. Two
  causes fixed: an effect in the phone page that set state on every progress
  tick, and progress published for every album-art save (milliseconds
  apart). Now progress is paced (`PROGRESS_MS` 100) and `setProgress`
  catches a throwing watcher (tested). If it ever comes back, the import
  still commits.
- **2026-10-02 — `npx prettier --write <folder>` reformats files you did not
  touch** (`SettingsSheet.tsx`, `RecoveryGrid.tsx` are not prettier-clean).
  Format only the files you changed.
- **2026-10-02 — Samsung: `Linking.openSettings()` can land on a secure
  window** (a biometrics check, `screencap` comes back empty) and *Back* then
  drops into whatever Settings page Cesar last had open. Do not drive
  Settings: grant with `adb shell pm grant com.cantor.app
  android.permission.READ_MEDIA_AUDIO` and bring Cantor back with `am start`
  — that is an `AppState` return, which is what the page listens for.
- **2026-10-02 — Permission race:** the foreground re-check started as
  Android's dialog closed and finished after the request's answer, writing
  `unknown` over `denied`. The check now applies its answer to the state as
  it is when it resolves (`afterCheck`, tested).

## Session log

### 2026-10-03 — I7i, and a fresh install end to end

- `features/field/EmptyField.tsx` (seal faint, the sentence, two doors),
  shown by `FieldScreen` when backends and the phone library have loaded and
  there is no song and no job, held 600 ms so a late load never flashes it;
  `NO SONGS YET` in the meta; `startOn: 'phone'` opens the nodes blind on the
  phone's page (layout effect, so the roster never shows on the way). Tested.
- Uninstalled and reinstalled on the Samsung (Cesar's go-ahead): AppLock PRO
  asked to lock the new app (*Not Now*), onboarding made a new identity, the
  field came up empty with the lattice running through the words → the
  lattice is now skipped when a re-cut holds no flight (`ground` in
  `FieldCanvas`), matching `f-empty`'s paper.
- `Bring it in` → `f-ask` → *Allow* → summary of 13 folders → 204 files in →
  198 songs. The arrival's camera went to the 4 audiobooks (*Jun 16–22*),
  the first id in commit order, and waited ~3 s for them to open last →
  now it goes to the first arriving placement in reading order (checked with
  two folders in two weeks: it lands on the upper one, which opens first).
- `lens analysis failed … miniaudio … Invalid file (-10)` warnings during
  the bring-in: the lens analysis (I1's native reduction) cannot decode some
  of these files — likely the `.m4b` audiobooks. Not the import; worth a
  look under I8.

### 2026-10-03 — I7j

- Proposed the opening clock first (above), then built it:
  `features/field/opening.ts` (`planOpening`, `openedAt`, tested),
  `FaceFlight.openAt` and `NativeRowFlight.openAt`, one `openingMs` clock read
  in `drawFieldFaces` and `drawNativeRows`, `FieldOpening` threaded through
  `FieldCanvas`, and in `FieldScreen` the arming on a new `result`, the run
  when the blind lifts, the descent, and `N ARRIVED FROM THIS PHONE`.
- On the Samsung: `Music / P2P` left out and brought back (35 songs, 13
  albums) → `See them` → the camera in *Jun 30 – Jul 6* at L1, the Wos
  singles opening one after another top to bottom, names with their marks
  (first build drew the names early; fixed); Back → `35 ARRIVED FROM THIS
  PHONE`. Then the label issue above, chased with two A/B builds.
- Trap within it: the arrival's descent must not fire mid re-cut; it reads
  whether the commit's re-cut is still in the air when the result lands.

### 2026-10-03 — I7h

- `repository.leaveOut` (one transaction; prefix matched in JS so `%`/`_`
  in paths need no escaping), `DeviceLibraryService.leaveOut`, the folder
  wall as a pure function (`folderWall`), `useFolderPage`, `AlbumCover`
  (saved art through `artworkLuma`), `showAlbum` in `FieldScreen`.
- On the Samsung: `Music / clasic`'s wall (Yann Tiersen, Mammal Hands and
  Ludovico Einaudi measures); a cover tap closed the blind and landed inside
  *2 Tracks from EUSA* at L1 (second try: see Traps); `Music / Samsung` left
  out with the strike → 198 songs, the folder under the left-out door.

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
- I7e–I7g: `features/engines/phoneState.ts` (page choice, roster line, words;
  pure, tested), `PhoneSheet.tsx` (`usePhonePage`: the head's clef and meta,
  the stave and coda of every frame), `PhoneMarks.tsx` (folder covers and the
  reading clef from `thumbnailLuma`), `controls/Fermata.tsx`, the seal's
  spindle variant (golden added). Rendered `flow.html`'s frames locally with
  playwright-core's headless shell instead of the phone's browser (see
  Comparing, below).
- On the Samsung: roster → `f-ask` → Android's dialog → *Don't allow* (stays
  on `f-ask`, `NOT ALLOWED YET`) → again *Don't allow* (`f-denied`) → granted
  over adb, back in the app → summary of 13 folders, voice notes grey → one
  folder tapped out → bring-in (first run hit the update-depth trap; second
  run committed) → `See them` → field. `Look again` → `Nothing new`.

#### Comparing against the drawing without the phone's browser

The Samsung is Cesar's own phone; don't open its browser. Render frames on
the desktop instead (Chromium headless shell from the Playwright cache, driven
by `playwright-core` from `~/.hermes/hermes-agent/node_modules`):

`cantor/scripts/frame-shots.cjs` (usage in its header) writes
`/tmp/frame-<id>.png` for each frame id.

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
- `fa74c77` the phone in the nodes roster, its page, and bringing music in
  (I7e–I7g)
- `bd34ba4` a kept folder's page: its albums as covers, and leaving it out
  held (I7h)
- `59c1bb2` songs from the phone arrive album by album (I7j)
- `3600914` the empty field offers the phone's music and a node (I7i)
- `a11a1db` no lattice under an empty field; an arrival's camera goes where
  it starts
- `5360df6` leaving a folder out says its tags and playlists go with it
- `e37d819` cluster names that stand still keep a flight when others move

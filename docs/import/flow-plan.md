# The import flow — plan

Step **I7** of [`plan.md`](plan.md): the only new UI device import needs. The
drawing is [`flow.html`](flow.html); every milestone below names the frames it
builds. The running record is [`flow-log.md`](flow-log.md).

This file is written so it can be handed to a session cold: read this page,
then `flow-log.md` (where the build stands), then the linked frames in
`flow.html`, then [`folio-steps.md`](../interfacealpha/folio-steps.md) for the
grammar every blind is drawn in, then start the next unchecked milestone.

---

## The idea in one paragraph

Bringing music in is not a wizard. **The phone is a home, the way a node is**,
and it gets the page a node gets: a clef, a stave of facts, one act in the coda.
It is the first entry in the nodes roster. The first act on its page brings the
music in; every later visit — looking again, leaving a folder out, a file gone
missing — happens on the same page. Nothing in the flow is a new kind of
control: it is Folio's roster, three inks, working rule, fermata and strike,
pointed at the phone.

## Status

| # | Milestone | Frames | State |
| --- | --- | --- | --- |
| I7a | [Folders and the summary, pure](#i7a--folders-and-the-summary-pure) | — | not started |
| I7b | [The scan, split](#i7b--the-scan-split) | — | not started |
| I7c | [Permission](#i7c--permission) | — | not started |
| I7d | [Looking again](#i7d--looking-again) | — | not started |
| I7e | [The phone in the roster](#i7e--the-phone-in-the-roster) | `f-roster` | not started |
| I7f | [The phone's page](#i7f--the-phones-page) | `f-ask` `f-denied` `f-sum` `f-new` `f-phone` `f-none` | not started |
| I7g | [Bringing in](#i7g--bringing-in) | `f-bring` | not started |
| I7h | [A folder's page](#i7h--a-folders-page) | `f-folder` | not started |
| I7i | [The empty field](#i7i--the-empty-field) | `f-empty` | not started |
| I7j | [Arrival in the field](#i7j--arrival-in-the-field) | `f-arrived` | not started |

Update this table, the milestone's checklist and `flow-log.md` in the same
commit that lands the work.

## Order

```
I7a folders ─→ I7b scan split ─┬─→ I7d looking again
I7c permission ────────────────┤
                               ├─→ I7e roster ─→ I7f phone page ─→ I7g bringing in ─→ I7h folder page
                               │                                └─→ I7i empty field
                               └────────────────────────────────────→ I7j arrival (last)
```

I7a–I7d are logic with tests and no UI; I7e onward draw. I7j goes last: it
touches the field renderer, and everything else is usable without it (the
songs simply appear, as they do today after a scan).

---

## Decisions already made

Settled with Cesar on 2026-10-01 while drawing `flow.html`. Do not reopen them
in code; if one seems wrong, change `flow.html` first.

1. **Entry: the phone is the first entry in the nodes roster**, set apart from
   the nodes by a `Rest`. Its mark is the settings seal (`marks/seal.ts`) with
   the **spindle** ring at its centre in place of the dot — the ring every
   imported song carries. A second way in exists only when the field is empty
   (I7i). Not in onboarding: the permission is asked at the moment of intent.
   → `f-roster`, `f-empty`
2. **The words** (F0's rule, one word per thing). "Import", "scan", "library"
   and "sync" never reach the screen.

   | Thing | On screen |
   | --- | --- |
   | the place | `This phone` (Settings already titles itself so) |
   | the first act | `Bring in 310 songs` — the count is in the act and morphs |
   | working | `Bringing them in`; meta `READING 142 OF 310` |
   | listing | `Reading`; meta `FOUND 168` counting up |
   | finished, still on the page | `See them` |
   | a later look | `Look again`; `Looking`; `Nothing new` |
   | new folders since last time | `Bring in 23 more` |
   | a folder not taken | `LEFT OUT` (soft grey, never struck) |
   | a voice-note folder | `LOOKS LIKE VOICE NOTES` |
   | a file gone | `MISSING` with the fermata; `FILE MOVED OR REMOVED` |
   | DRM | `PROTECTED` · `LEFT ALONE` |
   | no permission | `NOT ALLOWED YET` with the fermata; later withdrawn: `NOT ALLOWED NOW` |
   | an imported song | `YOUR OWN FILE` (already on the song sheet) |
3. **The promise comes before Android's dialog**: *Cantor plays your music
   where it lies. Nothing is copied, moved or sent anywhere.* The act is
   `Allow music`; it opens the system prompt. → `f-ask`
4. **The summary is by folder** (`f-sum`, variant 3A). Folders are what Cantor
   remembers (`device_excluded_folder`), and *tags are the data, folders are a
   hint*: the summary never claims an album split the resolver might merge. The
   cover wall (3B) moves to the folder page (I7h); the by-source variant (3C) is
   ruled out. Drawn **before any file is opened**: listing is MediaStore
   metadata only.
5. **Leaving out is ink, not a checkbox.** A tap turns a folder row from ink to
   soft grey and back; the coda's count morphs. That is the app-wide control
   state vocabulary (disabled = soft grey, text change = morph).
6. **Voice notes start grey.** WhatsApp, Telegram, Recordings and the like are
   left out by default, with their reason, and one tap brings them back.
   ("Nobody wants voice notes on their music app.")
7. **Bringing in stays in the blind** (`f-bring`, variant 4A): F6's
   **measured** rule under the act, each folder's line `WAITING` → `42 OF 168`
   → `DONE`, and the coda note `YOU CAN CLOSE THIS`. Closing does not stop it;
   the roster's phone seal waves meanwhile, as a node's station does while it
   makes a song. The row-in-the-field variant (4B) is not built.
8. **The clef shows the record being read**: each album's thumbnail through the
   cover lens's glyphs, changing cell by cell to the next album. Kept
   ("let's keep it"). Computed, never stored, like the cover lens.
9. **Looking again is like VLC: every time Cantor opens** (and when it comes
   back to the foreground), it compares MediaStore's generation; the same
   number costs nothing. New files in kept folders come in silently. **A new
   folder is asked about, never taken.** A vanished file is held as
   `MISSING`, never deleted, and re-attaches by fingerprint. `Look again`
   exists for someone who just copied files over and won't restart.
10. **Leaving a kept folder out later is held** (F7's strike), with the
    consequence written before the touch: `HOLD · 168 LEAVE · FILES STAY`.
11. **Arrival is shown in order**: the songs are committed at once, but when
    the blind lifts (or on `See them`) the field opens them album by album, and
    its meta line says `310 ARRIVED FROM THIS PHONE` once. No toast.

## Things that must not change

- **Storage contracts** ([`CLAUDE.md`](../../CLAUDE.md)): `cantor.sqlite`'s
  schema 1 tables keep their shape. If the flow needs new state, it is a new
  migration that only adds (see I7a's note on kept folders: the plan avoids
  one). `cantor.private-library.v1` is untouched.
- **The user's files are read only.** Nothing in this flow writes, moves,
  renames or deletes a file. Leaving a folder out removes Cantor's *records*.
- **The resolver's policy** (`device/resolve.ts`) is not re-decided in UI code.
  Folder grouping for the summary (I7a) is its own pure function and does not
  change album keys.
- **Folio** ([`folio-steps.md`](../interfacealpha/folio-steps.md)): the frame,
  three inks, the working rule as the only "working" mark, the fermata as
  "held", no red, no toasts, the Flicker Law, reduced motion crossfades.
- **The recovery words and the nodes' own flow** in `EnginesSheet` are not
  reordered; the phone is added before them.

## Rules for every milestone

The routine in [`log.md`](log.md) § "How a step is done here", unchanged:
read and write down first; `npx tsc --noEmit -p . && npx jest && npm run lint`
green from `cantor/`; release build on the Xiaomi; screenshots; commit on
`main` with a short code-only subject and no AI trailer; then a `docs:` commit
updating `flow-log.md`. Plus:

- **Compare each drawn milestone side by side with its frame**, at 1:1 on the
  phone (see [below](#comparing-against-the-drawing)).
- Anything that differs from `flow.html` gets a line in `flow-log.md` §
  Deviations, with why.
- **Never scan Cesar's own music without asking.** Build against the fixtures
  (`cantor/scripts/import-fixtures.py`, `/sdcard/Music/cantor-import-test/`)
  and `ScanOptions.onlyUnder`; ask before the first real full scan.

---

## I7a · Folders and the summary, pure

New `device/folders.ts`, pure TS with tests. No UI, no native change.

- **`folderOf(path)`** — the unit a person keeps or leaves out:
  - under a *music root* (`Music/`, `Download/`, `Podcasts/`, `Audiobooks/`
    at the storage root): the root plus **one** level (`Music/Bandcamp`, so
    `Music/Bandcamp/Artist/Album/…` belongs to `Music/Bandcamp`); a file
    directly in the root belongs to the root (`Music`, "12 loose songs");
  - anywhere else: the file's **parent directory** (so
    `Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio/…` is one folder,
    shown by its last segment, `WhatsApp Audio`).

  Paths are compared as absolute prefixes with a trailing slash; the label is
  the path below the storage root, drawn as `Music / Bandcamp` with the root in
  faint ink. Check the rule on the fixtures and on the layouts in `plan.md` §
  "What arrives"; record surprises in the log.
- **`looksLikeVoiceNotes(folder)`** — folder-name words (`whatsapp`, `telegram`,
  `signal`, `recordings`, `voice`, `call`, `recorder`, `voice notes`),
  case-insensitive. It only decides a folder's **starting** ink.
- **`summarize(rows, library)`** → `FolderSummary[]`: per folder its path,
  label, song count, distinct MediaStore `album` count (a hint), the `mediaId`
  of one row whose album has the most rows (for the 34 px cover), and its
  status: `kept` (some stored song lives under it), `excluded` (in
  `excludedFolders`), or `new` (neither). Ordered by root, then by count. A
  `new` folder's starting choice is *kept* unless it looks like voice notes.
- **Kept folders need no new table**: a folder is kept when a stored song lives
  under it, excluded when listed in `device_excluded_folder`, new otherwise.
  The one edge — every song of a kept folder went missing — still counts as
  kept, because missing songs are stored. Write that in a test.

- [ ] `folderOf`, `looksLikeVoiceNotes`, `summarize`, with tests on fixture
      paths, Bandcamp/CD/flat layouts and WhatsApp/Recordings paths
- [ ] the kept/excluded/new rule tested, including the all-missing folder

## I7b · The scan, split

`device/deviceLibrary.ts`. Today `scan()` lists and inspects in one pass and
**never reads `excludedFolders`**. Split it, without changing what a commit
writes.

- **`look()`** — generation check, then `media.list`, then `summarize` (I7a).
  Publishes `phase: 'listing'`, then a `summary` in the store. Opens no file.
- **`bringIn(choice)`** — `choice` is the set of folders left out. Persists
  them (`setExcludedFolders`: the stored set plus the new ones, minus any
  brought back), then runs today's inspect → resolve → art → commit over rows
  **not** under an excluded folder. Rows under excluded folders are treated as
  absent from the scan *for the resolver*, but must **not** read as missing for
  songs already stored there — those are handled by `leaveOut` (I7h).
- **Every scan honours `excludedFolders`** from now on, including the
  automatic one (I7d).
- **New folders are never brought in silently**: an automatic scan inspects
  rows in kept folders only; rows in `new` folders wait in the summary.
- **Progress is measured over the whole job**: `inspecting` gains the work
  units of art saving, so the fraction is `(files inspected + albums given
  art) / (files + albums without art)`, and a `current` field —
  `{ title, artist, mediaId }` of the album now being read — for the clef and
  the `Now` row. The folder lines need per-folder done/total: publish a small
  map keyed by folder, updated at most once per file.
- **The clef's picture cannot wait for `withArtwork`**: art is saved only
  after every file is inspected. Add a read-only native call that returns a
  thumbnail's brightness cells straight from MediaStore (`thumbnailLuma(mediaId,
  cells)`, `loadThumbnail` + the same reduction as `artworkLuma`), used only for
  display and never written. Alternatively save each album's art as soon as its
  first file is inspected; pick one in the log, with why.
- **Result counts** gain `protected` (if the inspection can tell DRM apart from
  unreadable; if not, everything is `couldn't read`, and the log says so).

- [ ] `look()` and `bringIn()`, with `scan()` kept as `look` + `bringIn` of
      kept folders for existing callers
- [ ] excluded folders honoured, tested; new folders never inspected by an
      automatic scan, tested
- [ ] progress fraction, `current` album, per-folder counts
- [ ] the clef's luma source chosen and built (native, if that route)
- [ ] fixture scan on the phone through `onlyUnder`, log updated

## I7c · Permission

Nothing in `src/` asks for the permission today; the phone holds it from I0.

- `device/permission.ts`: `check()` and `request()` over `PermissionsAndroid`
  with `READ_MEDIA_AUDIO` on API 33+ and `READ_EXTERNAL_STORAGE` below
  (minSdk 24; the manifest already declares both). States: `unknown`,
  `granted`, `denied` (may ask again), `blocked` (`never_ask_again`).
  `openSettings()` via `Linking.openSettings()`.
- Re-check on `AppState` `active`, so returning from Android settings with the
  permission granted reads by itself (`f-denied`'s promise).
- **Withdrawn later**: a list that throws a `SecurityException` sets `blocked`.
  The songs stay in the field, faint, as the offline state does (F9c), and the
  roster line says `NOT ALLOWED NOW` with the fermata.
- To test a fresh ask on the Xiaomi: `adb shell pm revoke com.cantor.app
  android.permission.READ_MEDIA_AUDIO` (and `pm reset-permissions` is too wide;
  do not use it).

- [ ] permission module with tests (mocked `PermissionsAndroid`)
- [ ] state in `DeviceLibraryService`'s store, re-checked on foreground
- [ ] revoke / grant cycle checked on the phone

## I7d · Looking again

- After `start()`, when the permission is `granted` **and the person has
  brought music in at least once** (any stored song or excluded folder), run
  the automatic scan: `look()` then `bringIn` over kept folders. On first run it
  does nothing until the person opens the phone's page.
- Again on each `AppState` → `active`, debounced (~2 s), skipped while one
  runs. The generation check makes the common case one native call.
- New folders found → the roster line and the page say so (I7e, I7f); nothing
  is imported from them.
- A `ContentObserver` on the audio table while the app is open is **optional**
  and deferred; write it down if it turns out to be wanted.
- Protect the measured baseline: an automatic scan must not run during a
  curtain pull or a camera flight; it runs off the JS thread's hot path (the
  native list is already off it; the JS resolve over 300 rows is the part to
  time).

- [ ] scan on start and on foreground, debounced, guarded
- [ ] timing of a no-change look and of a 1-new-file look recorded in the log

## I7e · The phone in the roster

**Builds** `f-roster` (all five states, with the switch under the frame).

- `src/marks/seal.ts` gains the spindle variant: the settings seal with the
  spindle ring (`NAME_LENS_KNOBS.SPINDLE_RATIO`) where the centre dot was. A
  golden, like the others.
- `EnginesSheet`: a first measure holding *This phone* (its mark in the label
  column at 34 px, the name as a door, one state line), then a `Rest`, then the
  nodes as today. The title stays `Four nodes` and its meta stays about nodes.
- The state line, from the device store:

  | State | Line | Ink |
  | --- | --- | --- |
  | no permission asked / nothing brought in | `NOT READ YET` | muted |
  | bringing in | `BRINGING IN · 46%`, seal waves (sine rule under it) | muted |
  | read | `310 SONGS · 24 ALBUMS` | muted |
  | new folders | `2 NEW FOLDERS` | **ink** (needs you) |
  | missing files | fermata + `2 MISSING · 310 SONGS` | muted |
  | not allowed | fermata + `NOT ALLOWED YET` / `NOW` | muted |
  | database unavailable | fermata + `UNAVAILABLE` | muted |

- [ ] seal with spindle + golden
- [ ] roster entry and every state line
- [ ] device pass against `f-roster`

## I7f · The phone's page

**Builds** `f-ask`, `f-denied`, `f-sum`, `f-new`, `f-phone`, `f-none`. A new
page kind in `EnginesSheet` (`phone`), one level in, back word `‹ NODES`,
drawn in Folio (head, stave, coda). Its clef is the phone seal with spindle at
64 px (faint when not allowed or nothing found).

Which page shows is a pure function of the store, tested:

| Store | Page | Coda |
| --- | --- | --- |
| permission `unknown`/`denied` | `f-ask`: the promise; *Looks in*, *Leaves out*, *Never* | `Allow music` · `ANDROID WILL ASK` |
| permission `blocked` | `f-denied`: sentence; *Where* = the settings path | `Open Android settings` · `COMES BACK HERE AFTER` |
| listing | the stave fills as folders are found (rows land as the spine reaches them, F10's rule); meta `FOUND n` | `Reading`, sine rule |
| summary, first time | `f-sum`: one measure per root, voice-note folders last | `Bring in N songs` · `TAP A FOLDER TO LEAVE IT OUT` |
| summary, new folders only | `f-new`: the new folders first, then *Songs* and *Folders* | `Bring in N more` |
| bringing in | I7g | |
| read | `f-phone`: *Songs*; folders as doors (cover at 26 px), left-out ones grey; *Missing*, *Protected*, *Couldn't read* only when non-zero | `Look again` · `LOOKED AT 14:02` |
| nothing found | `f-none`: sentence; *Looked in*, *Passed over* | `Look again` · `AND ON EVERY OPEN` |

- **Folder rows** (`f-sum`, `f-new`): cover in the label column at 34 px (the
  cover lens's glyphs from the folder's representative `mediaId`; the bare
  `·` grain in faint when it has none), the label in display 18 with the root
  faint, and a mono line `14 ALBUMS · 168 SONGS` / `12 LOOSE SONGS` /
  `LOOKS LIKE VOICE NOTES` / `LEFT OUT · 38 FILES`. A tap swaps ink ↔ soft grey
  and morphs the coda's count; a light haptic tick (F7's ration allows one per
  step of a choice).
- `Nothing to bring in` when every folder is left out; the act is disabled
  (soft grey).
- *Look again* runs `look()`; the act morphs `Looking` with the sine rule, then
  `Nothing new` for ~2 s if the generation matched, else goes on to `f-new` or
  brings in silently, as I7d does.
- A grey folder on `f-phone` opens the summary for that folder alone, whose
  act is `Bring in N songs`.
- Mono stays four words or fewer; sentences are Spectral 13/15 (F2).

- [ ] page selection as a tested pure function
- [ ] each of the six frames built
- [ ] the reading fill and the count morph
- [ ] device pass against each frame, in both lenses where a song mark shows

## I7g · Bringing in

**Builds** `f-bring`.

- The coda's act is `Underway` (F6) with the **measured** fraction from I7b:
  straight from the left to the fraction, waving after it; at 100% a straight
  hairline that retracts; the word morphs to `See them`. Coda note:
  `YOU CAN CLOSE THIS`, then `310 SONGS · 24 ALBUMS`.
- Meta: `READING 142 OF 310`, then `310 SONGS · 24 ALBUMS`.
- Stave: a *Now* measure (album title in display 18, artist in mono), then the
  kept folders with `WAITING` / `42 OF 168` (ink while active) / `DONE`; at the
  end `Protected` / `Couldn't read` rows land if non-zero.
- **The clef**: the current album's luma (I7b) through `coverPath`
  (`lenses/coverLens.ts`) at 64 px, 20 cells. On a new album the cells change
  **cell by cell**, top to bottom with a little jitter (~14 ms per row + up to
  160 ms), never a crossfade — each cell owns its glyph (Flicker Law). Loose
  songs with no art: the clef holds its last picture. Reduced motion: the new
  picture replaces the old in one crossfade.
- Closing the blind does not cancel; the roster's seal waves (I7e). Reopening
  the page shows the same state.
- `See them` closes the blind and hands I7j the new ids. Until I7j lands it just
  closes the blind.
- Haptics: none beyond the firm pulse rules already in F7 (none here).

- [ ] measured act, meta, folder lines, end rows
- [ ] cover clef with the cell-by-cell change, reduced motion crossfade
- [ ] close mid-way and reopen; roster waves meanwhile
- [ ] device pass against `f-bring` with the fixtures

## I7h · A folder's page

**Builds** `f-folder`. Two levels in, back word `‹ THIS PHONE`.

- Clef: the folder's first album cover at 64 px. Title: the folder's last
  segment; meta `MUSIC/BANDCAMP · 168 SONGS`.
- Stave: albums as a wall of covers (64 px, 18 cells, three across, mono name
  under each), grouped by album artist when one artist has more than two
  albums, else under `Others`; `AND 5 MORE` past nine. A cover tap closes the
  blind and takes the camera to that album in the ALBUM arrangement.
- Coda: `Leave this folder out` as a **strike** (F7), note
  `HOLD · 168 LEAVE · FILES STAY`. Completing it adds the folder to
  `device_excluded_folder` and **removes its songs' records and tags** from the
  phone database (a new repository method, `leaveOut(folder)`, in one
  transaction; files untouched). Bringing it back later imports it fresh; its
  tags do not return. Say so in the note if Cesar wants it said.
- Covers here come from the saved album art (`artworkLuma`), not the thumbnail
  call.

- [ ] page, wall, album tap
- [ ] `leaveOut` in the repository, tested; strike wired
- [ ] device pass against `f-folder`

## I7i · The empty field

**Builds** `f-empty`.

- Only when the field has **no songs at all** (no node songs, no device songs,
  no jobs). Centre: the phone seal faint at 64 px, the sentence *Your music is
  already on this phone. Cantor can play it where it lies.*, and two doors:
  `Bring it in` (opens the nodes blind at the phone's page) and `Pair a node`
  (the pairing flow, in muted ink). Meta: `NO SONGS YET`.
- Gone as soon as there is one song. Laid out from the same measurement the
  canvas uses; nothing here moves with the camera (there is nothing to move).

- [ ] empty state and its two doors
- [ ] device pass against `f-empty` (fresh install or a cleared app)

## I7j · Arrival in the field

**Builds** `f-arrived` (and its L0 sentence in the notes above it).

- `bringIn` returns the ids that are new in this commit. When the blind lifts
  after a bring-in (or on `See them`), the camera goes to the newest time
  cluster and **each album's marks open out of a point together, album after
  album** — the open-from-a-point half of a lens change, on a retained linear
  clock, ~520 ms apart. At L0 the same sentence, cluster by cluster.
- The field's meta line says `310 ARRIVED FROM THIS PHONE` once (morph in,
  morph back to the count on the next open).
- **First check whether the renderer has a per-entity "opening" clock** it can
  give a set of ids (`nativeMap.ts`, `nativeRows.ts`, `lensClock.ts`). If it
  does not, propose the smallest one in the log before building; it must not
  add O(N) work per frame (I8's 300 songs).
- Protect the measured baseline: profile a 300-song arrival in one session
  (`cantor/scripts/perf-sample.sh`).

- [ ] new ids from the commit
- [ ] album-by-album opening at L1 and L0, reduced motion crossfade
- [ ] meta line once
- [ ] before/after frame timing in the log

---

## Comparing against the drawing

`flow.html` is drawn at 392 × 764, the phone's width in dp. From the repository
root:

```sh
python3 -m http.server 8099 &
adb reverse tcp:8099 tcp:8099
adb shell "am start -a android.intent.action.VIEW -d 'http://localhost:8099/docs/import/flow.html?phone&still&lens=seal#f-sum'"
adb exec-out screencap -p > /tmp/frame.png
```

- `?phone` removes the page margin; `?still` skips the arrival animation so a
  screenshot shows the finished frame; `lens=seal` draws song marks in the seal
  (default circle). Quote the whole `am start` command (an unquoted `&` is
  eaten by the phone's shell).
- Frame ids: `f-roster`, `f-empty`, `f-ask`, `f-denied`, `f-sum`, `f-sum-wall`
  (ruled out, kept for reference), `f-sum-src` (ruled out), `f-bring`,
  `f-bring-field` (ruled out), `f-arrived`, `f-phone`, `f-new`, `f-folder`,
  `f-none`.
- Interactive in the page: the roster state switch, `Allow music` (a mock
  system dialog), `REPLAY READING` and the folder taps on `f-sum`, the bringing
  in replay, `Look again`, the strike on `f-folder`, the lens switch.
- Stop the server and `adb reverse --remove tcp:8099` when done.

The covers in `flow.html` are procedural stand-ins drawn from album names;
the app's come from the real thumbnails through `cover.ts`.

## Open questions

- **DRM**: can `inspect` tell a protected file from an unreadable one? If not,
  `Protected` folds into `Couldn't read` (I7b).
- **The clef's luma source**: a native `thumbnailLuma(mediaId, cells)`, or
  saving each album's art as soon as its first file is inspected (I7b).
- **Folders under `Android/media`**: does `IS_MUSIC = 1` let WhatsApp/Telegram
  audio through on the Xiaomi at all? If not, the voice-note guess matters less
  than drawn; keep it anyway for phones that do.
- **SD cards**: `DEVICE_LIBRARY_KNOBS.VOLUME` is `external_primary` only. The
  copy says *Music, Download* and promises nothing about a card. Adding volumes
  is a later step.
- **Leaving a folder out drops its tags** (I7h). Confirm with Cesar that the
  note should not say so in more words.

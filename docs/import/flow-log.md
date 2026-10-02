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

The design is drawn and settled (2026-10-01): `flow.html`, with the decisions
in `flow-plan.md` § "Decisions already made". No code yet. **Start with I7a**
(pure TS, `device/folders.ts`), then I7b and I7c, which can go in either
order.

Before the first line of code, read:

1. `flow-plan.md`, then the frames in `flow.html` (serve it as in the plan's
   "Comparing against the drawing").
2. `cantor/src/device/deviceLibrary.ts`, `resolve.ts`, `repository.ts`,
   `native.ts`: the scan the flow splits.
3. `cantor/src/features/engines/EnginesSheet.tsx` and `SettingsSheet.tsx`: the
   roster and the page kinds the phone joins.
4. `docs/interfacealpha/folio-steps.md` and `folio-log.md` for the controls
   (`Folio`, `Measure`, `Rest`, `Coda`, `Underway`, `Strike`, `Clef`).

The import fixtures are still on the phone in
`/sdcard/Music/cantor-import-test/` (see `log.md` § "Start here"). Build against
them; **ask Cesar before the first full scan of his own music**.

## Status

| # | State | What is left |
| --- | --- | --- |
| I7a | not started | everything |
| I7b | not started | everything |
| I7c | not started | everything |
| I7d | not started | everything |
| I7e | not started | everything |
| I7f | not started | everything |
| I7g | not started | everything |
| I7h | not started | everything |
| I7i | not started | everything |
| I7j | not started | everything |

## Open questions (for Cesar)

Mirrors `flow-plan.md` § "Open questions"; move each here into a decision with
its date when answered.

- DRM: a separate `Protected` count, or folded into `Couldn't read`?
- Leaving a folder out drops its tags: is `HOLD · 168 LEAVE · FILES STAY`
  enough warning?

## Deviations

(none yet)

## Findings

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

### 2026-10-01 — the flow drawn and planned

- Proposed the flow in text; Cesar settled it: the phone first in the roster,
  voice notes grey, looking again on every open (VLC), the cover clef kept, and
  the words left to the drawing.
- Drew [`flow.html`](flow.html): 14 frames, three summary variants (by folder
  chosen), two bringing-in variants (in the blind chosen). Checked in headless
  Chromium; `?still` added so screenshots show finished frames.
- Wrote `flow-plan.md` (I7a–I7j) and this log.

## Commits

(none yet)

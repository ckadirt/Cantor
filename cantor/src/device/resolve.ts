import type { MediaInspection, MediaRow } from './native';
import {
  deviceSongId,
  type DeviceAlbum,
  type DeviceLibrary,
  type DeviceScanCommit,
  type DeviceSong,
} from './repository';

/**
 * What a scan of the phone means: raw MediaStore rows and file inspections in,
 * songs, albums and one commit out.
 *
 * Every rule here answers something measured on the phone
 * (docs/import/log.md, I0 and I3): MediaStore substitutes the folder's name for
 * a missing album and `<unknown>` for a missing artist, packs the disc into the
 * track number, drops the year of FLAC, Ogg and Opus, and reads no WAV or AIFF
 * tags; `MediaMetadataRetriever` (the inspection's tags) says null when a tag
 * is absent, and reports the MP4 epoch as an M4A's date. Pure: no native calls
 * and no storage, so all of it is tested with the phone's own values.
 */

/** MediaStore's placeholder for an artist or album the file does not name. */
const UNKNOWN = '<unknown>';

/** An M4A's creation time where the date tag should be: the MP4 epoch. */
const MP4_EPOCH_DATE = /^1904-?01-?01T/;

/** Sub-folders that are part of their parent's album: `CD1`, `Disc 2`, `disk3`. */
const DISC_FOLDER = /^(cd|disc|disk)\s*\d+$/i;

/**
 * Bandcamp's download name, `Artist - Album - 01 Title`. It matters most for
 * WAV and AIFF, which Bandcamp offers and whose tags neither Android reader
 * parses: the name is all Cantor gets.
 */
const BANDCAMP_NAME = /^(.+?) - (.+) - (\d{1,3}) (.+)$/;

/** A file name's leading track number: `07 - `, `07. `, `07 `, `7_`. */
const LEADING_TRACK = /^(\d{1,3})\s*(?:[-._)]\s*|\s+)(?=\S)/;

export type ScanInput = Readonly<{
  rows: readonly MediaRow[];
  library: DeviceLibrary;
  /** The generation the previous scan of this volume ended at; −1 for none. */
  lastGeneration: number;
}>;

/**
 * Which rows need their files inspected: new paths, and rows MediaStore
 * changed since the last scan (every row when there is no generation to go by).
 * Rows in excluded folders are left out.
 */
export function rowsToInspect(input: ScanInput): MediaRow[] {
  const present = new Map<string, DeviceSong>();
  for (const song of input.library.songs) {
    if (song.missingSinceMs === null) present.set(song.path, song);
  }
  return input.rows.filter(row => {
    if (isExcluded(row.path, input.library.excludedFolders)) return false;
    if (!present.has(row.path)) return true;
    return (
      row.generation === null ||
      input.lastGeneration < 0 ||
      row.generation > input.lastGeneration
    );
  });
}

/**
 * The commit a scan makes.
 *
 * `inspections` holds the rows `rowsToInspect` chose, by path; a row without
 * one is unchanged and its stored song stands. A song whose file is gone is
 * marked missing, not deleted, unless its content reappeared under another
 * path (a move), which keeps its id, tags and first import time.
 */
export function buildScanCommit(
  input: ScanInput &
    Readonly<{
      inspections: ReadonlyMap<string, MediaInspection>;
      volume: string;
      generation: number;
      nowMs: number;
    }>,
): DeviceScanCommit {
  const { library } = input;
  const byPath = new Map<string, DeviceSong>();
  const byFingerprint = new Map<string, DeviceSong>();
  for (const song of library.songs) {
    // A present song owns its path over a missing one that once had it.
    if (song.missingSinceMs === null || !byPath.has(song.path)) {
      byPath.set(song.path, song);
    }
    byFingerprint.set(fingerprint(song.size, song.headSha256), song);
  }

  const rows = input.rows
    .filter(row => !isExcluded(row.path, library.excludedFolders))
    .slice()
    .sort((a, b) => a.mediaId - b.mediaId);

  const upserts = new Map<string, DeviceSong>();
  /** Album titles as the changed files spell them, by album key. */
  const titles = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const inspection = input.inspections.get(row.path);
    if (inspection === undefined) {
      const stored = byPath.get(row.path);
      if (stored !== undefined) {
        seen.add(stored.id);
        if (stored.missingSinceMs !== null) {
          upserts.set(stored.id, { ...stored, missingSinceMs: null });
        }
      }
      continue;
    }
    const existing =
      byPath.get(row.path) ??
      byFingerprint.get(fingerprint(inspection.size, inspection.headSha256));
    const song = resolveSong(row, inspection, existing, input.nowMs);
    // Two files with one content are one song: the stored one's, else the
    // first by MediaStore id (rows are in that order).
    if (seen.has(song.id)) continue;
    seen.add(song.id);
    upserts.set(song.id, song);
    const album =
      clean(inspection.tags.album) ??
      (song.titleFromTag ? null : parseFileName(baseName(row.path)).album);
    if (album !== null && !titles.has(song.albumKey)) {
      titles.set(song.albumKey, album);
    }
  }

  const missing: { id: string; sinceMs: number }[] = [];
  for (const song of library.songs) {
    if (song.missingSinceMs !== null || seen.has(song.id)) continue;
    if (isExcluded(song.path, library.excludedFolders)) continue;
    missing.push({ id: song.id, sinceMs: input.nowMs });
  }

  return {
    volume: input.volume,
    generation: input.generation,
    scannedAtMs: input.nowMs,
    songs: [...upserts.values()],
    albums: rebuildAlbums(library, [...upserts.values()], titles),
    missing,
  };
}

/** One song from its MediaStore row and its file's inspection. */
export function resolveSong(
  row: MediaRow,
  inspection: MediaInspection,
  existing: DeviceSong | undefined,
  nowMs: number,
): DeviceSong {
  const tags = inspection.tags;
  const fileName = baseName(row.path);
  const name = parseFileName(fileName);
  const mediaTitle =
    row.title !== null && row.title !== stripExtension(fileName)
      ? clean(row.title)
      : null;
  const tagTitle = clean(tags.title) ?? mediaTitle;
  const artist =
    clean(tags.artist) ??
    (row.artist === UNKNOWN ? null : clean(row.artist)) ??
    (tagTitle === null ? name.artist : null);
  const albumArtist = clean(tags.albumArtist) ?? clean(row.albumArtist);
  // A name's album only when the file names no title either: a tagged file
  // without an album tag is a single, not a guess from its name.
  const album = clean(tags.album) ?? (tagTitle === null ? name.album : null);
  const packed = packedTrack(row.track);
  const date = clean(tags.date);
  const keptDate = date !== null && MP4_EPOCH_DATE.test(date) ? null : date;

  return {
    id: existing?.id ?? deviceSongId(inspection.size, inspection.headSha256),
    mediaId: row.mediaId,
    path: row.path,
    size: inspection.size,
    headSha256: inspection.headSha256,
    durationMs: row.durationMs,
    mime: row.mime,
    title: tagTitle ?? name.title,
    titleFromTag: tagTitle !== null,
    artist,
    albumArtist,
    disc: leadingNumber(tags.disc) ?? leadingNumber(row.disc) ?? packed.disc,
    track: leadingNumber(tags.track) ?? packed.track ?? name.track,
    year: row.year ?? leadingYear(tags.year) ?? leadingYear(keptDate),
    date: keptDate,
    genre: clean(tags.genre) ?? clean(row.genre),
    albumKey: albumKeyOf(albumArtist, album, row.path),
    addedAtMs: row.addedAtMs,
    importedAtMs: existing?.importedAtMs ?? nowMs,
    missingSinceMs: null,
  };
}

/**
 * An album as Cantor keys it: album artist, album and folder.
 *
 * The artist is left out, so a compilation without an album artist stays one
 * album; the folder keeps two albums of one name apart. A disc sub-folder
 * counts as its parent. With no album tag, the key is the folder's untitled
 * album.
 */
export function albumKeyOf(
  albumArtist: string | null,
  album: string | null,
  path: string,
): string {
  return [norm(albumArtist), norm(album), albumFolderOf(path)].join('|');
}

/** The folder an album lives in: the file's, or its parent's for `CD1`-style. */
export function albumFolderOf(path: string): string {
  const folder = dirName(path);
  return DISC_FOLDER.test(baseName(folder)) ? dirName(folder) : folder;
}

/**
 * What a file's name says when its tags do not: `07 - Title.mp3`,
 * `Artist - Title.flac`, `07. Artist - Title.m4a`, and Bandcamp's
 * `Artist - Album - 07 Title.wav`.
 */
export function parseFileName(fileName: string): {
  title: string;
  artist: string | null;
  album: string | null;
  track: number | null;
} {
  let rest = stripExtension(fileName).trim();
  const bandcamp = BANDCAMP_NAME.exec(rest);
  if (bandcamp !== null) {
    return {
      artist: bandcamp[1].trim(),
      album: bandcamp[2].trim(),
      track: Number(bandcamp[3]),
      title: bandcamp[4].trim(),
    };
  }
  let track: number | null = null;
  const leading = LEADING_TRACK.exec(rest);
  if (leading !== null) {
    track = Number(leading[1]);
    rest = rest.slice(leading[0].length);
  }
  const split = rest.indexOf(' - ');
  if (split > 0 && split < rest.length - 3) {
    return {
      artist: rest.slice(0, split).trim(),
      album: null,
      title: rest.slice(split + 3).trim(),
      track,
    };
  }
  return {
    title: rest.length > 0 ? rest : stripExtension(fileName),
    artist: null,
    album: null,
    track,
  };
}

function rebuildAlbums(
  library: DeviceLibrary,
  upserts: readonly DeviceSong[],
  titles: ReadonlyMap<string, string>,
): DeviceAlbum[] {
  const touched = new Set(upserts.map(song => song.albumKey));
  if (touched.size === 0) return [];
  const songs = new Map<string, DeviceSong>();
  for (const song of library.songs) songs.set(song.id, song);
  for (const song of upserts) songs.set(song.id, song);
  const stored = new Map(library.albums.map(album => [album.key, album]));

  const members = new Map<string, DeviceSong[]>();
  for (const song of songs.values()) {
    if (!touched.has(song.albumKey)) continue;
    const list = members.get(song.albumKey) ?? [];
    list.push(song);
    members.set(song.albumKey, list);
  }
  return [...members.entries()].map(([key, list]) => {
    const albumArtist = mostCommon(list.map(song => song.albumArtist));
    return {
      key,
      // The key holds the title lower-cased; the spelling is the files'.
      title: titles.get(key) ?? stored.get(key)?.title ?? null,
      artist: albumArtist ?? mostCommon(list.map(song => song.artist)),
      year: mostCommon(list.map(song => song.year)),
      folder: albumFolderOf(list[0].path),
      artwork: stored.get(key)?.artwork ?? null,
    };
  });
}

function mostCommon<T extends string | number>(
  values: readonly (T | null)[],
): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const value of values) {
    if (value === null) continue;
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    if (next > bestCount) {
      best = value;
      bestCount = next;
    }
  }
  return best;
}

function packedTrack(value: number | null): {
  disc: number | null;
  track: number | null;
} {
  if (value === null || value <= 0) return { disc: null, track: null };
  if (value < 1000) return { disc: null, track: value };
  const track = value % 1000;
  return { disc: Math.floor(value / 1000), track: track > 0 ? track : null };
}

function leadingNumber(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*(\d+)/.exec(value);
  if (match === null) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}

function leadingYear(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*(\d{4})/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  return year > 0 ? year : null;
}

function isExcluded(path: string, folders: readonly string[]): boolean {
  return folders.some(folder =>
    path.startsWith(folder.endsWith('/') ? folder : `${folder}/`),
  );
}

function fingerprint(size: number, headSha256: string): string {
  return `${size}:${headSha256}`;
}

function clean(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function norm(value: string | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

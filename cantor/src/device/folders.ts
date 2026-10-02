import type { MediaRow } from './native';
import type { DeviceLibrary } from './repository';

/**
 * The folders a person keeps or leaves out, and the summary drawn before any
 * file is opened (docs/import/flow-plan.md, I7a).
 *
 * A folder here is a hint, never an album: the summary counts what MediaStore
 * lists under it and claims nothing about how the resolver will group it.
 * Kept folders need no table of their own: a folder is kept while a stored
 * song lives under it, excluded while `device_excluded_folder` names it, and
 * new otherwise. Pure: rows and the stored library in, the summary out.
 */

/**
 * Top-level folders that hold music by convention. A folder under one is the
 * root plus one level (`Music/Bandcamp`), however deep its files sit.
 */
const MUSIC_ROOTS = ['Music', 'Download', 'Podcasts', 'Audiobooks'] as const;

/** Where a volume's files start: `/storage/emulated/0/`, `/storage/1A2B-3C4D/`. */
const STORAGE_ROOT = /^\/storage\/(?:emulated\/\d+|[^/]+)\//;

/**
 * Words in a folder's path that say "messages, not music". They only decide a
 * new folder's starting ink: one tap brings it back.
 */
const VOICE_NOTE_WORDS =
  /(?:^|[^a-z])(whatsapp|telegram|signal|recordings?|voice|calls?|recorder)(?:$|[^a-z])/;

export type FolderStatus = 'kept' | 'excluded' | 'new';

export type FolderSummary = Readonly<{
  /** Absolute, without a trailing slash: the unit stored when left out. */
  path: string;
  /** The path below the storage root: `Music/Bandcamp`, `Recordings/Voice Recorder`. */
  label: string;
  /** The music root it sits in (`Music`), or null elsewhere. */
  root: string | null;
  /** The last segment: what a folder outside the music roots is called. */
  name: string;
  /** Rows MediaStore lists under it now. */
  songs: number;
  /** Distinct MediaStore albums among them; a hint, not Cantor's albums. */
  albums: number;
  /** Rows lying directly in a music root, not in a sub-folder of it. */
  loose: boolean;
  /** One row of its biggest album, for the cover; null when it has no rows. */
  coverMediaId: number | null;
  status: FolderStatus;
  voiceNotes: boolean;
  /** Whether it starts in ink: kept, or new and not voice notes. */
  keep: boolean;
}>;

/**
 * The folder a file belongs to: under a music root, the root plus one level
 * (a file directly in the root belongs to the root); anywhere else, the file's
 * own directory.
 */
export function folderOf(path: string): string {
  const base = storageRootOf(path);
  const below = path.slice(base.length).split('/');
  below.pop();
  if (below.length === 0) return trimSlash(base);
  if (isMusicRoot(below[0])) {
    return base + below.slice(0, Math.min(2, below.length)).join('/');
  }
  return base + below.join('/');
}

/** True when `path` lies at any depth under `folder`. */
export function isUnder(path: string, folder: string): boolean {
  return path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

/** True when a folder's own words say it holds messages or recordings. */
export function looksLikeVoiceNotes(folder: string): boolean {
  return VOICE_NOTE_WORDS.test(labelOf(folder).toLowerCase());
}

/**
 * One line per folder, from MediaStore's rows and the stored library: every
 * folder with a row now, plus every folder a stored song still lives in (so a
 * kept folder whose files all went missing is still listed, and still kept).
 *
 * Ordered as the summary draws them: voice-note folders last; then the music
 * roots in their order, others after; then the most songs first.
 */
export function summarize(
  rows: readonly MediaRow[],
  library: DeviceLibrary,
): FolderSummary[] {
  const byFolder = new Map<string, MediaRow[]>();
  for (const row of rows) {
    const folder = folderOf(row.path);
    const list = byFolder.get(folder);
    if (list === undefined) byFolder.set(folder, [row]);
    else list.push(row);
  }
  const stored = new Set<string>();
  for (const song of library.songs) {
    const folder = folderOf(song.path);
    stored.add(folder);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
  }

  const summaries = [...byFolder.entries()].map(([path, members]) => {
    const status: FolderStatus = library.excludedFolders.some(
      folder => folder === path || isUnder(path, folder),
    )
      ? 'excluded'
      : stored.has(path)
      ? 'kept'
      : 'new';
    const voiceNotes = looksLikeVoiceNotes(path);
    const label = labelOf(path);
    const segments = label.split('/');
    const root = isMusicRoot(segments[0]) ? segments[0] : null;
    return {
      path,
      label,
      root,
      name: segments[segments.length - 1],
      songs: members.length,
      albums: new Set(members.map(row => row.album ?? '')).size,
      loose: root !== null && segments.length === 1,
      coverMediaId: coverOf(members),
      status,
      voiceNotes,
      keep: status === 'kept' || (status === 'new' && !voiceNotes),
    };
  });
  return summaries.sort(
    (a, b) =>
      Number(a.voiceNotes) - Number(b.voiceNotes) ||
      rootRank(a.root) - rootRank(b.root) ||
      b.songs - a.songs ||
      a.label.localeCompare(b.label),
  );
}

/** The songs a choice brings in: every row in a folder kept in ink. */
export function songsKept(
  summaries: readonly FolderSummary[],
  leftOut: ReadonlySet<string>,
): number {
  let total = 0;
  for (const folder of summaries) {
    if (!leftOut.has(folder.path)) total += folder.songs;
  }
  return total;
}

function storageRootOf(path: string): string {
  return STORAGE_ROOT.exec(path)?.[0] ?? '/';
}

function labelOf(folder: string): string {
  return folder.slice(storageRootOf(`${folder}/`).length);
}

function isMusicRoot(segment: string): boolean {
  return (MUSIC_ROOTS as readonly string[]).includes(segment);
}

function rootRank(root: string | null): number {
  return root === null
    ? MUSIC_ROOTS.length
    : (MUSIC_ROOTS as readonly string[]).indexOf(root);
}

/** The first row, by MediaStore id, of the album with the most rows. */
function coverOf(members: readonly MediaRow[]): number | null {
  const counts = new Map<string, { count: number; mediaId: number }>();
  for (const row of members) {
    const key = row.album ?? '';
    const entry = counts.get(key);
    if (entry === undefined)
      counts.set(key, { count: 1, mediaId: row.mediaId });
    else {
      entry.count += 1;
      entry.mediaId = Math.min(entry.mediaId, row.mediaId);
    }
  }
  let best: { count: number; mediaId: number } | null = null;
  for (const entry of counts.values()) {
    if (
      best === null ||
      entry.count > best.count ||
      (entry.count === best.count && entry.mediaId < best.mediaId)
    ) {
      best = entry;
    }
  }
  return best?.mediaId ?? null;
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

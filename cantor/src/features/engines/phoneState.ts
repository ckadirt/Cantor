import type { DeviceLibraryState } from '../../device/deviceLibrary';
import type { FolderSummary } from '../../device/folders';

/**
 * What the phone's page and its roster line say, from the device store alone
 * (docs/import/flow-plan.md, I7e and I7f). Pure, so every life of the page is
 * tested without drawing it.
 */

/** Which frame of `flow.html` the phone's page is. */
export type PhonePageKind =
  /** `f-ask`: the promise, before Android's question. */
  | 'ask'
  /** `f-denied`: refused for good; only Android's settings can change it. */
  | 'denied'
  /** The phone database could not be opened. */
  | 'unavailable'
  /** Listing: the summary is not here yet. */
  | 'listing'
  /** `f-sum`: the first summary, every folder. */
  | 'summary'
  /** `f-new`: music was brought in before; new folders are asked about. */
  | 'new'
  /** `f-bring`: reading, or just finished reading. */
  | 'bringing'
  /** `f-phone`: read, nothing waiting. */
  | 'read'
  /** `f-none`: nothing on the phone passes the filter. */
  | 'none';

export type PhonePageInput = Readonly<{
  device: DeviceLibraryState;
  /**
   * A bring-in started on this page and not yet left: the page stays on
   * `f-bring` with `See them` until the person moves on.
   */
  broughtIn: boolean;
  /** The person asked to choose again (a grey folder, `FOLDERS`). */
  choosing: boolean;
}>;

export function phonePage({
  device,
  broughtIn,
  choosing,
}: PhonePageInput): PhonePageKind {
  if (device.status === 'unavailable') return 'unavailable';
  const { permission, scan, folders } = device;
  if (permission === 'blocked') return 'denied';
  if (permission !== 'granted') return 'ask';
  if (broughtIn || scan.phase === 'inspecting' || scan.phase === 'saving') {
    return 'bringing';
  }
  if (folders === null) return 'listing';
  if (folders.length === 0) return 'none';
  if (choosing || !hasBroughtIn(device)) return 'summary';
  return newFolders(folders).length > 0 ? 'new' : 'read';
}

/**
 * Music was brought in: a song is stored. Folders left out alone do not
 * count — a first bring-in that failed, or left everything out, is asked
 * again as a first summary.
 */
export function hasBroughtIn(device: DeviceLibraryState): boolean {
  return device.library.songs.length > 0;
}

export function newFolders(folders: readonly FolderSummary[]): FolderSummary[] {
  return folders.filter(folder => folder.status === 'new');
}

/** Songs whose files are here now, and their albums and artists. */
export function phoneCounts(device: DeviceLibraryState): {
  songs: number;
  albums: number;
  artists: number;
  bytes: number;
  missing: number;
} {
  let songs = 0;
  let missing = 0;
  let bytes = 0;
  const albums = new Set<string>();
  const artists = new Set<string>();
  for (const song of device.library.songs) {
    if (song.missingSinceMs !== null) {
      missing += 1;
      continue;
    }
    songs += 1;
    bytes += song.size;
    albums.add(song.albumKey);
    const artist = song.albumArtist ?? song.artist;
    if (artist !== null) artists.add(artist.toLowerCase());
  }
  return { songs, albums: albums.size, artists: artists.size, bytes, missing };
}

/** A line of state, and whether it carries the fermata or needs ink. */
export type PhoneLine = Readonly<{
  words: string;
  /** Held, not broken (`folio-steps.md` rule 7). */
  fermata: boolean;
  /** Needs the person: drawn in ink rather than muted. */
  ink: boolean;
  /** Reading: the seal waves under it. */
  working: boolean;
  /** Nothing to show yet, or out of reach: the seal is faint. */
  faint: boolean;
}>;

const line = (words: string, extra: Partial<PhoneLine> = {}): PhoneLine => ({
  words,
  fermata: false,
  ink: false,
  working: false,
  faint: false,
  ...extra,
});

/** The roster's one line for the phone (`f-roster`'s five states, and three more). */
export function rosterLine(device: DeviceLibraryState): PhoneLine {
  if (device.status === 'unavailable') {
    return line('UNAVAILABLE', { fermata: true, faint: true });
  }
  const counts = phoneCounts(device);
  const { scan, permission, folders } = device;
  if (permission !== 'granted' && permission !== 'unknown') {
    return line(counts.songs > 0 ? 'NOT ALLOWED NOW' : 'NOT ALLOWED YET', {
      fermata: true,
      faint: true,
    });
  }
  if (scan.phase === 'inspecting' || scan.phase === 'saving') {
    return line(`BRINGING IN · ${percent(device)}%`, { working: true });
  }
  if (!hasBroughtIn(device)) {
    return line('NOT READ YET');
  }
  const fresh = folders === null ? 0 : newFolders(folders).length;
  if (fresh > 0) {
    return line(`${fresh} NEW FOLDER${fresh === 1 ? '' : 'S'}`, { ink: true });
  }
  if (counts.missing > 0) {
    return line(`${counts.missing} MISSING · ${songsWord(counts.songs)}`, {
      fermata: true,
    });
  }
  return line(`${songsWord(counts.songs)} · ${albumsWord(counts.albums)}`);
}

/** How far a bring-in is, 0..100, never past 99 before it has finished. */
export function percent(device: DeviceLibraryState): number {
  const { scan } = device;
  if (scan.phase === 'saving') return 99;
  if (scan.phase !== 'inspecting' || scan.total === 0) return 0;
  return Math.min(99, Math.floor((scan.done / scan.total) * 100));
}

/** Files read so far and in all, over every folder of this bring-in. */
export function filesRead(device: DeviceLibraryState): {
  done: number;
  total: number;
} {
  const { scan } = device;
  if (scan.phase !== 'inspecting') return { done: 0, total: 0 };
  let done = 0;
  let total = 0;
  for (const folder of scan.folders.values()) {
    done += folder.done;
    total += folder.total;
  }
  return { done, total };
}

export function songsWord(count: number): string {
  return `${count} SONG${count === 1 ? '' : 'S'}`;
}

export function albumsWord(count: number): string {
  return `${count} ALBUM${count === 1 ? '' : 'S'}`;
}

/** A folder's mono line on the summary: what is in it, or why it starts grey. */
export function folderNote(
  folder: FolderSummary,
  leftOut: boolean,
  /** Say `NEW`: on `f-new`, where the rest were brought in before. */
  markNew = false,
): string {
  if (leftOut && folder.voiceNotes && folder.status !== 'excluded') {
    return 'LOOKS LIKE VOICE NOTES';
  }
  if (leftOut)
    return `LEFT OUT · ${folder.songs} FILE${folder.songs === 1 ? '' : 'S'}`;
  const fresh = markNew && folder.status === 'new' ? 'NEW · ' : '';
  if (folder.loose) {
    return `${fresh}${folder.songs} LOOSE SONG${folder.songs === 1 ? '' : 'S'}`;
  }
  if (folder.albums <= 1) return `${fresh}${songsWord(folder.songs)}`;
  return `${fresh}${albumsWord(folder.albums)} · ${songsWord(folder.songs)}`;
}

/** The folders as the summary groups them: one measure per root, voice notes last. */
export function measuresOf(
  folders: readonly FolderSummary[],
): FolderSummary[][] {
  const measures: FolderSummary[][] = [];
  let key: string | null = null;
  for (const folder of folders) {
    const next = folder.voiceNotes
      ? '\u0000voice'
      : folder.root ?? '\u0000other';
    if (next !== key) {
      measures.push([]);
      key = next;
    }
    measures[measures.length - 1].push(folder);
  }
  return measures;
}

/** `1.9 GB`, `640 MB`. */
export function sizeWord(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** `Four nodes`: a count said as a word while it is small enough to read as one. */
const NUMBER_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

export function countWord(count: number): string {
  return count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
}

export function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** KNOBS — a folder's wall of covers (`f-folder`). */
export const FOLDER_WALL_KNOBS = {
  /** Covers shown before `AND n MORE`. */
  SHOWN: 9,
  /** An artist with more albums than this in the folder gets a measure. */
  OWN_MEASURE_PAST: 2,
} as const;

export type WallAlbum = Readonly<{
  key: string;
  title: string | null;
  artist: string | null;
  artwork: string | null;
  songs: number;
}>;

export type FolderWall = Readonly<{
  /** By album artist when one has more than two albums here, else `Others`. */
  groups: readonly Readonly<{ label: string; albums: readonly WallAlbum[] }>[];
  songs: number;
  /** Albums past the ones shown. */
  more: number;
}>;

/** A kept folder's albums, as its page's wall draws them. */
export function folderWall(
  device: DeviceLibraryState,
  folder: string,
): FolderWall {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  const counts = new Map<string, number>();
  let songs = 0;
  for (const song of device.library.songs) {
    if (!song.path.startsWith(prefix)) continue;
    songs += 1;
    counts.set(song.albumKey, (counts.get(song.albumKey) ?? 0) + 1);
  }
  const albums: WallAlbum[] = device.library.albums
    .filter(album => counts.has(album.key))
    .map(album => ({
      key: album.key,
      title: album.title,
      artist: album.artist,
      artwork: album.artwork,
      songs: counts.get(album.key) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.songs - a.songs || (a.title ?? '').localeCompare(b.title ?? ''),
    );
  const perArtist = new Map<string, WallAlbum[]>();
  for (const album of albums) {
    if (album.artist === null) continue;
    const list = perArtist.get(album.artist) ?? [];
    list.push(album);
    perArtist.set(album.artist, list);
  }
  const groups: { label: string; albums: WallAlbum[] }[] = [];
  const grouped = new Set<string>();
  for (const [artist, list] of perArtist) {
    if (list.length <= FOLDER_WALL_KNOBS.OWN_MEASURE_PAST) continue;
    groups.push({ label: artist, albums: list });
    for (const album of list) grouped.add(album.key);
  }
  const others = albums.filter(album => !grouped.has(album.key));
  if (others.length > 0) groups.push({ label: 'Others', albums: others });

  // Nine covers in all, taken in the order the groups are drawn.
  let room: number = FOLDER_WALL_KNOBS.SHOWN;
  const shown = groups
    .map(group => {
      const albumsShown = group.albums.slice(0, Math.max(0, room));
      room -= albumsShown.length;
      return { label: group.label, albums: albumsShown };
    })
    .filter(group => group.albums.length > 0);
  return {
    groups: shown,
    songs,
    more: Math.max(0, albums.length - FOLDER_WALL_KNOBS.SHOWN),
  };
}

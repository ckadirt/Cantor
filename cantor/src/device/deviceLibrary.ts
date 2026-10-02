import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { createStore, type Store } from '../core/store';
import { folderOf, isUnder, summarize, type FolderSummary } from './folders';
import type { MediaInspection, MediaRow, nativeMedia } from './native';
import {
  afterCheck,
  musicPermissionName,
  requestMusic,
  type MusicPermission,
  type PermissionPort,
} from './permission';
import type {
  DeviceAlbum,
  DeviceLibrary,
  DeviceRepository,
  DeviceScanCommit,
} from './repository';
import { albumFolderOf, buildScanCommit, rowsToInspect } from './resolve';

/** KNOBS */
export const DEVICE_LIBRARY_KNOBS = {
  /**
   * Shorter than this is not a song: `IS_MUSIC` lets 3 s blips through (I0),
   * and a voice memo or a jingle has no place in the field.
   */
  MIN_DURATION_MS: 30_000,
  /** The MediaStore volume scanned; the phone's own storage. */
  VOLUME: 'external_primary',
  /**
   * Progress is published at most this often while files are read: album
   * art saves in a few milliseconds each, and every publication is a render
   * of whatever page is watching.
   */
  PROGRESS_MS: 100,
} as const;

/** The album a bring-in is reading now, as MediaStore names it. */
export type ReadingAlbum = Readonly<{
  /** Changes when the next album starts: its folder and MediaStore album. */
  key: string;
  title: string | null;
  artist: string | null;
  /** A row of it, for its thumbnail (`nativeMedia.thumbnailLuma`). */
  mediaId: number;
}>;

export type FolderProgress = Readonly<{ done: number; total: number }>;

export type ScanProgress =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'listing' }>
  | Readonly<{
      phase: 'inspecting';
      /**
       * Over the whole job: files inspected, then albums given art. The art
       * count is estimated until the files are resolved, so the total may
       * move once.
       */
      done: number;
      total: number;
      current: ReadingAlbum | null;
      /** Files inspected per folder (`folders.ts` paths). */
      folders: ReadonlyMap<string, FolderProgress>;
    }>
  | Readonly<{ phase: 'saving' }>;

export type DeviceLibraryState = Readonly<{
  /** `unavailable`: the database could not be opened; nothing imported shows. */
  status: 'loading' | 'ready' | 'unavailable';
  library: DeviceLibrary;
  scan: ScanProgress;
  permission: MusicPermission;
  /** The folders as the last look found them; null before the first. */
  folders: readonly FolderSummary[] | null;
  /** When the last look finished. */
  lookedAtMs: number | null;
  /** What the last bring-in did; null before the first in this run. */
  result: ScanResult | null;
}>;

export type LookResult = Readonly<{
  /** False when MediaStore's generation is the one the last scan ended at. */
  changed: boolean;
  folders: readonly FolderSummary[];
}>;

export type ScanResult = Readonly<{
  /** False when MediaStore's generation said nothing changed. */
  changed: boolean;
  inspected: number;
  /** Files that could not be read; a stored song for one stands as it was. */
  failed: number;
  imported: number;
  /** The songs new in this commit, for the field to open (I7j). */
  importedIds: readonly string[];
  missing: number;
  artworkSaved: number;
  artworkRemoved: number;
}>;

export type ScanOptions = Readonly<{
  /**
   * Scan only files under this folder, and leave songs elsewhere alone. For
   * building the feature against test fixtures without importing a person's
   * own music; the product scan passes nothing.
   */
  onlyUnder?: string;
}>;

type Media = Pick<
  typeof nativeMedia,
  'generation' | 'list' | 'inspect' | 'albumArt' | 'pruneArtwork'
>;

const EMPTY_LIBRARY: DeviceLibrary = {
  songs: [],
  albums: [],
  tags: new Map(),
  generations: new Map(),
  excludedFolders: [],
};

const IDLE: ScanProgress = { phase: 'idle' };

type Job = 'look' | 'bringIn' | 'refresh';

const UNCHANGED: ScanResult = {
  changed: false,
  inspected: 0,
  failed: 0,
  imported: 0,
  importedIds: [],
  missing: 0,
  artworkSaved: 0,
  artworkRemoved: 0,
};

/**
 * The songs whose files live on this phone: loaded from the phone database,
 * published through one store, and brought up to date in two halves.
 *
 * `look` reads MediaStore's list — metadata only, no file opened — and sums it
 * up by folder (`folders.ts`). `bringIn` inspects only new and changed files
 * in the folders taken, resolves (`resolve.ts`), saves art for albums that
 * have none, commits once, and removes art no album names. Folders left out
 * are remembered and skipped by every later scan. `refresh` is the automatic
 * pair: it brings in what changed in kept folders and never takes a new
 * folder, which waits in the summary to be asked about.
 *
 * One job runs at a time; asking for the same job while it runs returns it,
 * and a different one waits its turn.
 */
export class DeviceLibraryService {
  readonly store: Store<DeviceLibraryState> = createStore<DeviceLibraryState>({
    status: 'loading',
    library: EMPTY_LIBRARY,
    scan: IDLE,
    permission: 'unknown',
    folders: null,
    lookedAtMs: null,
    result: null,
  });
  private repository: DeviceRepository | null = null;
  private job: { kind: Job; promise: Promise<unknown> } | null = null;
  private publishedAtMs = -Infinity;
  /** The last look's rows and generation, for the bring-in that follows it. */
  private looked: {
    rows: readonly MediaRow[];
    generation: number;
    under: string | null;
  } | null = null;

  constructor(
    private readonly deps: Readonly<{
      openRepository: () => Promise<DeviceRepository>;
      media: Media;
      now: () => number;
      /** Android's permission; absent, reading is always allowed (tests). */
      permissions?: PermissionPort;
    }>,
  ) {}

  async start(): Promise<void> {
    try {
      this.repository = await this.deps.openRepository();
      const library = await this.repository.load();
      this.store.set(state => ({ ...state, status: 'ready', library }));
    } catch (error) {
      this.store.set(state => ({ ...state, status: 'unavailable' }));
      throw error;
    }
    await this.checkPermission();
  }

  /** Read the permission again: on start, and each time the app is back. */
  async checkPermission(): Promise<MusicPermission> {
    const { permissions } = this.deps;
    const granted =
      permissions === undefined ||
      (await permissions.check(musicPermissionName(permissions.sdk)));
    // Read what a request learned *after* the check: Android's dialog answers
    // while the check for the app coming back is still in flight.
    this.store.set(state => {
      const next = afterCheck(granted, state.permission);
      return state.permission === next ? state : { ...state, permission: next };
    });
    return this.store.get().permission;
  }

  /** Ask Android for the permission; its dialog shows unless already final. */
  async requestPermission(): Promise<MusicPermission> {
    const { permissions } = this.deps;
    const next =
      permissions === undefined ? 'granted' : await requestMusic(permissions);
    this.store.set(state =>
      state.permission === next ? state : { ...state, permission: next },
    );
    return next;
  }

  openSettings(): Promise<void> {
    return this.deps.permissions?.openSettings() ?? Promise.resolve();
  }

  /**
   * List and sum up by folder. An unchanged generation answers from the last
   * look without listing again.
   */
  look(options: ScanOptions = {}): Promise<LookResult> {
    return this.exclusive('look', () => this.runLook(options));
  }

  /**
   * Bring in every folder the last look found except `leftOut` (folder
   * paths), and remember the choice: those are added to the excluded folders,
   * and a listed folder not left out is taken off them.
   */
  bringIn(
    leftOut: ReadonlySet<string>,
    options: ScanOptions = {},
  ): Promise<ScanResult> {
    return this.exclusive('bringIn', async () => {
      if (this.looked === null || this.looked.under !== underOf(options)) {
        await this.runLook(options);
      }
      return this.runBringIn({ leftOut });
    });
  }

  /**
   * The automatic look: when the list changed, bring in what changed in kept
   * folders. New folders are summed up, never inspected.
   */
  refresh(): Promise<LookResult> {
    return this.exclusive('refresh', async () => {
      if ((await this.checkPermission()) !== 'granted') {
        return { changed: false, folders: this.store.get().folders ?? [] };
      }
      const look = await this.runLook({});
      const kept = look.folders.some(folder => folder.status === 'kept');
      if (look.changed && kept) {
        await this.runBringIn({ leftOut: null });
        return { ...look, folders: this.store.get().folders ?? [] };
      }
      return look;
    });
  }

  /**
   * Look, then bring in what the summary starts in ink: kept and new folders,
   * voice notes left out.
   */
  scan(options: ScanOptions = {}): Promise<ScanResult> {
    return this.exclusive('bringIn', async () => {
      const { changed, folders } = await this.runLook(options);
      if (!changed) return UNCHANGED;
      const leftOut = new Set(
        folders.filter(folder => !folder.keep).map(folder => folder.path),
      );
      return this.runBringIn({ leftOut });
    });
  }

  async setTags(songId: string, tags: readonly string[]): Promise<void> {
    const repository = this.ready();
    await repository.setTags(songId, tags);
    await this.reload(repository);
  }

  private exclusive<T>(kind: Job, work: () => Promise<T>): Promise<T> {
    const running = this.job;
    if (running?.kind === kind) return running.promise as Promise<T>;
    const after = running?.promise.catch(() => undefined) ?? Promise.resolve();
    const promise = after.then(work).finally(() => {
      if (this.job?.promise !== promise) return;
      this.job = null;
      this.setProgress(IDLE);
    });
    this.job = { kind, promise };
    return promise;
  }

  private async runLook(options: ScanOptions): Promise<LookResult> {
    const { media } = this.deps;
    const { VOLUME, MIN_DURATION_MS } = DEVICE_LIBRARY_KNOBS;
    const generation = await media.generation();
    const under = underOf(options);
    const storedGeneration = this.store.get().library.generations.get(VOLUME);
    const changed =
      under !== null || generation < 0 || generation !== storedGeneration;
    const folders = this.store.get().folders;
    if (
      folders !== null &&
      this.looked !== null &&
      this.looked.under === under &&
      generation >= 0 &&
      generation === this.looked.generation
    ) {
      this.store.set(state => ({ ...state, lookedAtMs: this.deps.now() }));
      return { changed, folders };
    }

    this.setProgress({ phase: 'listing' });
    let listed: MediaRow[];
    try {
      listed = await media.list(MIN_DURATION_MS);
    } catch (error) {
      // Most often the permission, withdrawn in Android's settings.
      await this.checkPermission();
      throw error;
    }
    const rows = listed.filter(
      row => under === null || row.path.startsWith(under),
    );
    this.looked = { rows, generation, under };
    const summary = summarize(rows, this.scoped(under));
    this.store.set(state => ({
      ...state,
      folders: summary,
      lookedAtMs: this.deps.now(),
    }));
    return { changed, folders: summary };
  }

  /**
   * Bring in the last look's rows. `leftOut` is a person's choice, saved
   * before anything is read; null is the automatic scan, which takes kept
   * folders only and saves nothing.
   */
  private async runBringIn(
    choice: Readonly<{ leftOut: ReadonlySet<string> | null }>,
  ): Promise<ScanResult> {
    const repository = this.ready();
    const { media } = this.deps;
    const { VOLUME } = DEVICE_LIBRARY_KNOBS;
    const looked = this.looked!;
    const folders = this.store.get().folders ?? [];
    let stored = this.store.get().library;

    if (choice.leftOut !== null) {
      const leftOut = choice.leftOut;
      const listed = new Set(folders.map(folder => folder.path));
      const excluded = [
        ...stored.excludedFolders.filter(
          folder => !listed.has(folder) || leftOut.has(folder),
        ),
        ...[...leftOut].filter(
          folder => !stored.excludedFolders.includes(folder),
        ),
      ];
      if (!sameFolders(excluded, stored.excludedFolders)) {
        await repository.setExcludedFolders(excluded);
        stored = await this.reload(repository);
      }
    }
    const taken = new Set(
      folders
        .filter(folder =>
          choice.leftOut === null
            ? folder.status === 'kept'
            : !choice.leftOut.has(folder.path),
        )
        .map(folder => folder.path),
    );
    const order = new Map(folders.map((folder, index) => [folder.path, index]));
    const rows = looked.rows
      .filter(
        row =>
          taken.has(folderOf(row.path)) &&
          !stored.excludedFolders.some(folder => isUnder(row.path, folder)),
      )
      .slice()
      .sort(
        (a, b) =>
          (order.get(folderOf(a.path)) ?? 0) -
            (order.get(folderOf(b.path)) ?? 0) || a.path.localeCompare(b.path),
      );

    // A partial scan resolves against the songs under its folder only, so
    // nothing elsewhere reads as missing, and it records no generation (a
    // later full scan must not think it saw everything).
    const partial = looked.under !== null;
    const library = this.scoped(looked.under);
    const lastGeneration = partial ? -1 : stored.generations.get(VOLUME) ?? -1;
    const scanGeneration = partial ? -1 : looked.generation;

    const toInspect = rowsToInspect({ rows, library, lastGeneration });
    const perFolder = new Map<string, FolderProgress>();
    const albumsSeen = new Set<string>();
    for (const row of toInspect) {
      const folder = folderOf(row.path);
      const entry = perFolder.get(folder) ?? { done: 0, total: 0 };
      perFolder.set(folder, { ...entry, total: entry.total + 1 });
      albumsSeen.add(readingKey(row));
    }
    let total = toInspect.length + albumsSeen.size;
    let current: ReadingAlbum | null = null;
    const inspections = new Map<string, MediaInspection>();
    const unreadable = new Set<string>();
    for (let index = 0; index < toInspect.length; index += 1) {
      const row = toInspect[index];
      if (current === null || current.key !== readingKey(row)) {
        current = readingAlbum(row);
      }
      this.setProgress({
        phase: 'inspecting',
        done: index,
        total,
        current,
        folders: new Map(perFolder),
      });
      try {
        inspections.set(row.path, await media.inspect(row.path));
      } catch {
        unreadable.add(row.path);
      }
      const folder = folderOf(row.path);
      const entry = perFolder.get(folder)!;
      perFolder.set(folder, { ...entry, done: entry.done + 1 });
    }

    // A file that could not be read this time is left out of the scan: a new
    // one is not imported, and a known one stands as stored rather than
    // reading as missing.
    const readable = rows.filter(row => !unreadable.has(row.path));
    const draft = buildScanCommit({
      rows: readable,
      library: {
        ...library,
        songs: library.songs.filter(song => !unreadable.has(song.path)),
      },
      lastGeneration,
      inspections,
      volume: VOLUME,
      generation: scanGeneration,
      nowMs: this.deps.now(),
    });

    const needArt = draft.albums.filter(album => album.artwork === null).length;
    total = toInspect.length + needArt;
    const { albums, saved } = await this.withArtwork(draft, given =>
      this.setProgress({
        phase: 'inspecting',
        done: toInspect.length + given,
        total,
        current,
        folders: perFolder,
      }),
    );
    this.setProgress({ phase: 'saving' });
    const commit: DeviceScanCommit = { ...draft, albums };
    await repository.commitScan(commit);
    const next = await this.reload(repository);
    this.store.set(state => ({
      ...state,
      folders: summarize(looked.rows, this.scoped(looked.under)),
    }));

    const names = next.albums
      .map(album => album.artwork)
      .filter((name): name is string => name !== null);
    const removed = await media.pruneArtwork(names);

    const knownIds = new Set(stored.songs.map(song => song.id));
    const importedIds = commit.songs
      .filter(song => !knownIds.has(song.id))
      .map(song => song.id);
    const result: ScanResult = {
      changed: true,
      inspected: inspections.size,
      failed: unreadable.size,
      imported: importedIds.length,
      importedIds,
      missing: commit.missing.length,
      artworkSaved: saved,
      artworkRemoved: removed.length,
    };
    this.store.set(state => ({ ...state, result }));
    return result;
  }

  /** The stored library, narrowed to a partial scan's folder. */
  private scoped(under: string | null): DeviceLibrary {
    const stored = this.store.get().library;
    return under === null
      ? stored
      : {
          ...stored,
          songs: stored.songs.filter(song => song.path.startsWith(under)),
        };
  }

  /** Save art for every album in the commit that has none, from one of its songs. */
  private async withArtwork(
    commit: DeviceScanCommit,
    onAlbum: (given: number) => void,
  ): Promise<{ albums: DeviceAlbum[]; saved: number }> {
    let saved = 0;
    let given = 0;
    const albums: DeviceAlbum[] = [];
    for (const album of commit.albums) {
      if (album.artwork !== null) {
        albums.push(album);
        continue;
      }
      const song = commit.songs.find(
        member => member.albumKey === album.key && member.mediaId !== null,
      );
      let artwork: string | null = null;
      if (song !== undefined) {
        try {
          artwork = await this.deps.media.albumArt(
            song.mediaId!,
            artworkName(album.key),
          );
        } catch {
          artwork = null;
        }
      }
      if (artwork !== null) saved += 1;
      albums.push({ ...album, artwork });
      given += 1;
      onAlbum(given);
    }
    return { albums, saved };
  }

  private async reload(repository: DeviceRepository): Promise<DeviceLibrary> {
    const library = await repository.load();
    this.store.set(state => ({ ...state, library }));
    return library;
  }

  private setProgress(scan: ScanProgress): void {
    // Reading files publishes at a pace; a change of phase always goes out.
    const now = this.deps.now();
    const reading =
      scan.phase === 'inspecting' &&
      this.store.get().scan.phase === 'inspecting';
    if (
      reading &&
      now - this.publishedAtMs < DEVICE_LIBRARY_KNOBS.PROGRESS_MS
    ) {
      return;
    }
    this.publishedAtMs = now;
    try {
      this.store.set(state =>
        sameProgress(state.scan, scan) ? state : { ...state, scan },
      );
    } catch (error) {
      // Progress is for watching: a watcher that fails must not stop the
      // work, which commits on its own.
      console.warn('device progress listener failed', error);
    }
  }

  private ready(): DeviceRepository {
    if (this.repository === null) {
      throw new Error('The device library is not open.');
    }
    return this.repository;
  }
}

/** An album's art file name: stable for its key, safe for a file system. */
export function artworkName(albumKey: string): string {
  return `a${bytesToHex(sha256(utf8ToBytes(albumKey))).slice(0, 24)}`;
}

function withSlash(folder: string): string {
  return folder.endsWith('/') ? folder : `${folder}/`;
}

function underOf(options: ScanOptions): string | null {
  return options.onlyUnder === undefined ? null : withSlash(options.onlyUnder);
}

function sameFolders(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length && left.every(folder => right.includes(folder))
  );
}

/** Rows of one album share this: its folder and MediaStore's album. */
function readingKey(row: MediaRow): string {
  return `${albumFolderOf(row.path)}|${row.album ?? ''}`;
}

function readingAlbum(row: MediaRow): ReadingAlbum {
  const artist = row.albumArtist ?? row.artist;
  return {
    key: readingKey(row),
    title: row.album,
    artist: artist === null || artist === '<unknown>' ? null : artist,
    mediaId: row.mediaId,
  };
}

function sameProgress(left: ScanProgress, right: ScanProgress): boolean {
  if (left.phase !== right.phase) return false;
  if (left.phase === 'inspecting' && right.phase === 'inspecting') {
    return (
      left.done === right.done &&
      left.total === right.total &&
      left.current === right.current &&
      left.folders === right.folders
    );
  }
  return true;
}

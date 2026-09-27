import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { createStore, type Store } from '../core/store';
import type { MediaInspection, nativeMedia } from './native';
import type {
  DeviceAlbum,
  DeviceLibrary,
  DeviceRepository,
  DeviceScanCommit,
} from './repository';
import { buildScanCommit, rowsToInspect } from './resolve';

/** KNOBS */
export const DEVICE_LIBRARY_KNOBS = {
  /**
   * Shorter than this is not a song: `IS_MUSIC` lets 3 s blips through (I0),
   * and a voice memo or a jingle has no place in the field.
   */
  MIN_DURATION_MS: 30_000,
  /** The MediaStore volume scanned; the phone's own storage. */
  VOLUME: 'external_primary',
} as const;

export type ScanProgress =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'listing' }>
  | Readonly<{ phase: 'inspecting'; done: number; total: number }>
  | Readonly<{ phase: 'saving' }>;

export type DeviceLibraryState = Readonly<{
  /** `unavailable`: the database could not be opened; nothing imported shows. */
  status: 'loading' | 'ready' | 'unavailable';
  library: DeviceLibrary;
  scan: ScanProgress;
}>;

export type ScanResult = Readonly<{
  /** False when MediaStore's generation said nothing changed. */
  changed: boolean;
  inspected: number;
  /** Files that could not be read; a stored song for one stands as it was. */
  failed: number;
  imported: number;
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

/**
 * The songs whose files live on this phone: loaded from the phone database,
 * published through one store, and brought up to date by a scan.
 *
 * A scan reads MediaStore, inspects only new and changed files, resolves
 * (`resolve.ts`), saves art for albums that have none, commits once, and
 * removes art no album names. One runs at a time; asking again while one runs
 * returns the same scan.
 */
export class DeviceLibraryService {
  readonly store: Store<DeviceLibraryState> = createStore<DeviceLibraryState>({
    status: 'loading',
    library: EMPTY_LIBRARY,
    scan: IDLE,
  });
  private repository: DeviceRepository | null = null;
  private scanning: Promise<ScanResult> | null = null;

  constructor(
    private readonly deps: Readonly<{
      openRepository: () => Promise<DeviceRepository>;
      media: Media;
      now: () => number;
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
  }

  scan(options: ScanOptions = {}): Promise<ScanResult> {
    if (this.scanning === null) {
      this.scanning = this.runScan(options).finally(() => {
        this.scanning = null;
        this.setProgress(IDLE);
      });
    }
    return this.scanning;
  }

  async setTags(songId: string, tags: readonly string[]): Promise<void> {
    const repository = this.ready();
    await repository.setTags(songId, tags);
    await this.reload(repository);
  }

  private async runScan(options: ScanOptions): Promise<ScanResult> {
    const repository = this.ready();
    const { media } = this.deps;
    const { VOLUME, MIN_DURATION_MS } = DEVICE_LIBRARY_KNOBS;
    const stored = this.store.get().library;
    const lastGeneration = stored.generations.get(VOLUME) ?? -1;

    this.setProgress({ phase: 'listing' });
    const generation = await media.generation();
    const partial = options.onlyUnder !== undefined;
    if (!partial && generation >= 0 && generation === lastGeneration) {
      return { ...NOTHING, changed: false };
    }
    const under = partial ? withSlash(options.onlyUnder!) : null;
    const rows = (await media.list(MIN_DURATION_MS)).filter(
      row => under === null || row.path.startsWith(under),
    );
    // A partial scan resolves against the songs under its folder only, so
    // nothing elsewhere reads as missing, and it records no generation (a
    // later full scan must not think it saw everything).
    const library =
      under === null
        ? stored
        : {
            ...stored,
            songs: stored.songs.filter(song => song.path.startsWith(under)),
          };
    const scanGeneration = partial ? -1 : generation;

    const toInspect = rowsToInspect({
      rows,
      library,
      lastGeneration: partial ? -1 : lastGeneration,
    });
    const inspections = new Map<string, MediaInspection>();
    const unreadable = new Set<string>();
    for (let index = 0; index < toInspect.length; index += 1) {
      this.setProgress({
        phase: 'inspecting',
        done: index,
        total: toInspect.length,
      });
      const row = toInspect[index];
      try {
        inspections.set(row.path, await media.inspect(row.path));
      } catch {
        unreadable.add(row.path);
      }
    }
    this.setProgress({ phase: 'saving' });

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
      lastGeneration: partial ? -1 : lastGeneration,
      inspections,
      volume: VOLUME,
      generation: scanGeneration,
      nowMs: this.deps.now(),
    });

    const { albums, saved } = await this.withArtwork(draft);
    const commit: DeviceScanCommit = { ...draft, albums };
    await repository.commitScan(commit);
    const next = await this.reload(repository);

    const names = next.albums
      .map(album => album.artwork)
      .filter((name): name is string => name !== null);
    const removed = await media.pruneArtwork(names);

    const knownIds = new Set(stored.songs.map(song => song.id));
    return {
      changed: true,
      inspected: inspections.size,
      failed: unreadable.size,
      imported: commit.songs.filter(song => !knownIds.has(song.id)).length,
      missing: commit.missing.length,
      artworkSaved: saved,
      artworkRemoved: removed.length,
    };
  }

  /** Save art for every album in the commit that has none, from one of its songs. */
  private async withArtwork(
    commit: DeviceScanCommit,
  ): Promise<{ albums: DeviceAlbum[]; saved: number }> {
    let saved = 0;
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
    }
    return { albums, saved };
  }

  private async reload(repository: DeviceRepository): Promise<DeviceLibrary> {
    const library = await repository.load();
    this.store.set(state => ({ ...state, library }));
    return library;
  }

  private setProgress(scan: ScanProgress): void {
    this.store.set(state =>
      sameProgress(state.scan, scan) ? state : { ...state, scan },
    );
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

const NOTHING: ScanResult = {
  changed: true,
  inspected: 0,
  failed: 0,
  imported: 0,
  missing: 0,
  artworkSaved: 0,
  artworkRemoved: 0,
};

function withSlash(folder: string): string {
  return folder.endsWith('/') ? folder : `${folder}/`;
}

function sameProgress(left: ScanProgress, right: ScanProgress): boolean {
  if (left.phase !== right.phase) return false;
  if (left.phase === 'inspecting' && right.phase === 'inspecting') {
    return left.done === right.done && left.total === right.total;
  }
  return true;
}

import { openTestDatabase } from '../../../jest/nodeSqlite';
import { migrate } from '../../core/storage/sql';
import { artworkName, DeviceLibraryService } from '../deviceLibrary';
import type { MediaInspection, MediaRow, RetrieverTags } from '../native';
import { createDeviceRepository } from '../repository';
import { DEVICE_MIGRATIONS } from '../schema';

const ROOT = '/storage/emulated/0/Music';
const TEST = `${ROOT}/cantor-import-test`;
const ALBUM = `${TEST}/Test Artist/Fixture Album`;

const NO_TAGS: RetrieverTags = {
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  track: null,
  disc: null,
  year: null,
  date: null,
  genre: null,
};

function row(
  mediaId: number,
  path: string,
  extra: Partial<MediaRow> = {},
): MediaRow {
  return {
    mediaId,
    path,
    title: null,
    artist: '<unknown>',
    album: null,
    albumArtist: null,
    track: null,
    disc: null,
    year: null,
    genre: null,
    durationMs: 30000,
    mime: 'audio/mpeg',
    size: 1000 + mediaId,
    addedAtMs: 1_790_542_056_000,
    generation: 10,
    ...extra,
  };
}

/** A fake CantorMedia over a mutable set of files. */
function fakeMedia(
  files: Map<
    string,
    { row: MediaRow; tags: Partial<RetrieverTags>; art: boolean }
  >,
) {
  const artwork = new Set<string>(['lab-1000000769.jpg']);
  let generation = 10;
  const media = {
    inspected: [] as string[],
    artwork,
    bump: () => {
      generation += 1;
    },
    generation: jest.fn(async () => generation),
    list: jest.fn(async () => [...files.values()].map(file => file.row)),
    inspect: jest.fn(async (path: string): Promise<MediaInspection> => {
      const file = files.get(path);
      if (file === undefined) throw new Error('ENOENT');
      media.inspected.push(path);
      return {
        size: file.row.size,
        headSha256: String(file.row.mediaId).padStart(64, '0'),
        tags: { ...NO_TAGS, ...file.tags },
      };
    }),
    albumArt: jest.fn(async (mediaId: number, name: string) => {
      const file = [...files.values()].find(f => f.row.mediaId === mediaId);
      if (!file?.art) return null;
      artwork.add(`${name}.jpg`);
      return `${name}.jpg`;
    }),
    pruneArtwork: jest.fn(async (keep: readonly string[]) => {
      const removed = [...artwork].filter(name => !keep.includes(name));
      for (const name of removed) artwork.delete(name);
      return removed;
    }),
  };
  return media;
}

async function service(files: Parameters<typeof fakeMedia>[0], now = 5000) {
  const db = openTestDatabase();
  await migrate(db, DEVICE_MIGRATIONS);
  const media = fakeMedia(files);
  const library = new DeviceLibraryService({
    openRepository: async () => createDeviceRepository(db),
    media,
    now: () => now,
  });
  await library.start();
  return { library, media, db };
}

const tagged = {
  artist: 'Test Artist',
  album: 'Fixture Album',
  albumArtist: 'Test Artist',
};

function fixtures() {
  return new Map([
    [
      `${ALBUM}/01 - Tone MP3.mp3`,
      {
        row: row(776, `${ALBUM}/01 - Tone MP3.mp3`, {
          title: 'Tone MP3',
          track: 1001,
        }),
        tags: { ...tagged, title: 'Tone MP3', track: '1/10' },
        art: true,
      },
    ],
    [
      `${ALBUM}/02 - Tone FLAC.flac`,
      {
        row: row(775, `${ALBUM}/02 - Tone FLAC.flac`, {
          title: 'Tone FLAC',
          track: 1002,
        }),
        tags: { ...tagged, title: 'Tone FLAC', track: '2/10', date: '2019' },
        art: true,
      },
    ],
    [
      `${TEST}/loose/07 - Untagged Tone.mp3`,
      {
        row: row(765, `${TEST}/loose/07 - Untagged Tone.mp3`),
        tags: {},
        art: false,
      },
    ],
    [
      `${ROOT}/Cesar/own song.mp3`,
      {
        row: row(10, `${ROOT}/Cesar/own song.mp3`, { title: 'Own' }),
        tags: { title: 'Own' },
        art: false,
      },
    ],
  ]);
}

describe('DeviceLibraryService', () => {
  it('imports, saves album art once, and prunes art no album names', async () => {
    const { library, media } = await service(fixtures());
    const result = await library.scan();

    expect(result).toMatchObject({
      changed: true,
      inspected: 4,
      failed: 0,
      imported: 4,
      missing: 0,
      artworkSaved: 1,
      artworkRemoved: 1,
    });
    const state = library.store.get();
    expect(state.status).toBe('ready');
    expect(state.scan).toEqual({ phase: 'idle' });
    expect(state.library.songs.map(song => song.title).sort()).toEqual([
      'Own',
      'Tone FLAC',
      'Tone MP3',
      'Untagged Tone',
    ]);
    const album = state.library.albums.find(a => a.title === 'Fixture Album');
    expect(album?.artwork).toBe(`${artworkName(album!.key)}.jpg`);
    // The I3 lab's leftover is gone; the album's art is kept.
    expect([...media.artwork]).toEqual([album!.artwork]);
  });

  it('does nothing when MediaStore’s generation has not moved', async () => {
    const { library, media } = await service(fixtures());
    await library.scan();
    media.inspected.length = 0;
    const again = await library.scan();
    expect(again.changed).toBe(false);
    expect(media.list).toHaveBeenCalledTimes(1);
    expect(media.inspected).toEqual([]);
  });

  it('inspects only what changed, and marks a deleted file missing', async () => {
    const files = fixtures();
    const { library, media } = await service(files);
    await library.scan();
    media.inspected.length = 0;

    files.delete(`${TEST}/loose/07 - Untagged Tone.mp3`);
    const flac = files.get(`${ALBUM}/02 - Tone FLAC.flac`)!;
    flac.row = { ...flac.row, generation: 11 };
    flac.tags = { ...flac.tags, title: 'Tone FLAC (retitled)' };
    media.bump();

    const result = await library.scan();
    expect(media.inspected).toEqual([`${ALBUM}/02 - Tone FLAC.flac`]);
    expect(result).toMatchObject({ imported: 0, missing: 1 });
    const songs = library.store.get().library.songs;
    expect(
      songs.find(s => s.path.endsWith('Untagged Tone.mp3'))?.missingSinceMs,
    ).toBe(5000);
    expect(songs.find(s => s.path.endsWith('Tone FLAC.flac'))?.title).toBe(
      'Tone FLAC (retitled)',
    );
  });

  it('keeps a known song whose file could not be read this time', async () => {
    const files = fixtures();
    const { library, media } = await service(files);
    await library.scan();
    const mp3 = `${ALBUM}/01 - Tone MP3.mp3`;
    files.get(mp3)!.row = { ...files.get(mp3)!.row, generation: 12 };
    media.bump();
    media.inspect.mockImplementationOnce(async () => {
      throw new Error('EBUSY');
    });
    const result = await library.scan();
    expect(result).toMatchObject({ failed: 1, missing: 0 });
    const song = library.store.get().library.songs.find(s => s.path === mp3);
    expect(song).toMatchObject({ title: 'Tone MP3', missingSinceMs: null });
  });

  it('scans only a folder when asked, leaving everything else alone', async () => {
    const { library } = await service(fixtures());
    const result = await library.scan({ onlyUnder: TEST });
    expect(result.imported).toBe(3);
    const paths = library.store.get().library.songs.map(song => song.path);
    expect(paths.every(path => path.startsWith(TEST))).toBe(true);
    // No generation is recorded, so a full scan still looks at everything.
    expect(
      library.store.get().library.generations.get('external_primary'),
    ).toBe(-1);
  });

  it('runs one scan at a time', async () => {
    const { library, media } = await service(fixtures());
    const [first, second] = await Promise.all([library.scan(), library.scan()]);
    expect(first).toBe(second);
    expect(media.list).toHaveBeenCalledTimes(1);
  });

  it('publishes progress while inspecting', async () => {
    const { library } = await service(fixtures());
    const phases: string[] = [];
    library.store.subscribe(() => {
      const scan = library.store.get().scan;
      phases.push(
        scan.phase === 'inspecting'
          ? `inspecting ${scan.done}/${scan.total}`
          : scan.phase,
      );
    });
    await library.scan();
    expect(phases).toEqual([
      'listing',
      'inspecting 0/4',
      'inspecting 1/4',
      'inspecting 2/4',
      'inspecting 3/4',
      'saving',
      'saving',
      'idle',
    ]);
  });

  it('writes tags to the phone database', async () => {
    const { library } = await service(fixtures());
    await library.scan();
    const id = library.store.get().library.songs[0].id;
    await library.setTags(id, ['p/road']);
    expect(library.store.get().library.tags.get(id)).toEqual(['p/road']);
  });
});

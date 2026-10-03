import { openTestDatabase } from '../../../jest/nodeSqlite';
import { migrate } from '../../core/storage/sql';
import { artworkName, DeviceLibraryService } from '../deviceLibrary';
import type { MediaInspection, MediaRow, RetrieverTags } from '../native';
import type { PermissionPort } from '../permission';
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

async function service(
  files: Parameters<typeof fakeMedia>[0],
  now: number | (() => number) = 5000,
  permissions?: PermissionPort,
) {
  const db = openTestDatabase();
  await migrate(db, DEVICE_MIGRATIONS);
  const media = fakeMedia(files);
  const library = new DeviceLibraryService({
    openRepository: async () => createDeviceRepository(db),
    media,
    now: typeof now === 'number' ? () => now : now,
    permissions,
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

  it('publishes progress over files and then album art', async () => {
    let clock = 0;
    const { library } = await service(fixtures(), () => (clock += 1000));
    const phases: string[] = [];
    library.store.subscribe(() => {
      const scan = library.store.get().scan;
      const line =
        scan.phase === 'inspecting'
          ? `inspecting ${scan.done}/${scan.total} ${
              scan.current?.title ?? '-'
            }`
          : scan.phase;
      if (phases[phases.length - 1] !== line) phases.push(line);
    });
    await library.scan();
    // Four files in three folders, then art for three albums (one saved).
    // Albums are read together, folder by folder in the summary's order.
    expect(phases).toEqual([
      'listing',
      'inspecting 0/7 -',
      'inspecting 1/7 -',
      'inspecting 2/7 -',
      'inspecting 3/7 -',
      'inspecting 5/7 -',
      'inspecting 6/7 -',
      'inspecting 7/7 -',
      'saving',
      'idle',
    ]);
  });

  it('counts files per folder as it reads them', async () => {
    let clock = 0;
    const { library } = await service(fixtures(), () => (clock += 1000));
    const seen: string[] = [];
    library.store.subscribe(() => {
      const scan = library.store.get().scan;
      if (scan.phase !== 'inspecting') return;
      const test = scan.folders.get(`${ROOT}/cantor-import-test`);
      if (test !== undefined) seen.push(`${test.done}/${test.total}`);
    });
    await library.scan();
    expect(seen[0]).toBe('0/3');
    expect(seen[seen.length - 1]).toBe('3/3');
  });

  it('looks without opening a file', async () => {
    const { library, media } = await service(fixtures());
    const look = await library.look();
    expect(look.changed).toBe(true);
    expect(media.inspected).toEqual([]);
    expect(look.folders.map(f => [f.label, f.songs, f.status])).toEqual([
      ['Music/cantor-import-test', 3, 'new'],
      ['Music/Cesar', 1, 'new'],
    ]);
    expect(library.store.get().folders).toBe(look.folders);
    expect(library.store.get().lookedAtMs).toBe(5000);
    // The same generation answers from memory.
    await library.look();
    expect(media.list).toHaveBeenCalledTimes(1);
  });

  it('leaves a folder out, remembers it, and takes it back', async () => {
    const files = fixtures();
    const { library, media } = await service(files);
    await library.look();
    const result = await library.bringIn(new Set([`${ROOT}/Cesar`]));
    expect(result.imported).toBe(3);
    expect(result.importedIds).toHaveLength(3);
    expect(media.inspected).not.toContain(`${ROOT}/Cesar/own song.mp3`);
    let state = library.store.get();
    expect(state.library.excludedFolders).toEqual([`${ROOT}/Cesar`]);
    expect(state.folders!.map(f => f.status)).toEqual(['kept', 'excluded']);
    expect(state.result).toBe(result);

    // A later look and refresh skip it too.
    media.bump();
    await library.refresh();
    expect(media.inspected).not.toContain(`${ROOT}/Cesar/own song.mp3`);

    // Tapped back to ink, it comes in.
    const back = await library.bringIn(new Set());
    expect(back.imported).toBe(1);
    state = library.store.get();
    expect(state.library.excludedFolders).toEqual([]);
    expect(state.library.songs).toHaveLength(4);
  });

  it('never reads a song in a folder left out as missing', async () => {
    const { library, media } = await service(fixtures());
    await library.scan();
    await library.bringIn(new Set([`${ROOT}/Cesar`]));
    media.bump();
    await library.refresh();
    const own = library.store
      .get()
      .library.songs.find(song => song.path.endsWith('own song.mp3'));
    expect(own?.missingSinceMs).toBeNull();
  });

  it('refreshes kept folders and only asks about a new one', async () => {
    const files = fixtures();
    const { library, media } = await service(files);
    // Nothing brought in yet: the automatic look takes nothing.
    await library.refresh();
    expect(media.inspected).toEqual([]);
    expect(library.store.get().library.songs).toEqual([]);

    await library.bringIn(new Set([`${ROOT}/Cesar`]));
    files.set(`${TEST}/new.mp3`, {
      row: row(900, `${TEST}/new.mp3`, { generation: 11 }),
      tags: {},
      art: false,
    });
    files.set(`${ROOT}/Band/a.mp3`, {
      row: row(901, `${ROOT}/Band/a.mp3`, { generation: 11 }),
      tags: {},
      art: false,
    });
    media.bump();
    media.inspected.length = 0;
    const look = await library.refresh();
    expect(media.inspected).toEqual([`${TEST}/new.mp3`]);
    expect(look.folders.find(f => f.label === 'Music/Band')?.status).toBe(
      'new',
    );
    // Unchanged after that: one native call.
    media.inspected.length = 0;
    const again = await library.refresh();
    expect(again.changed).toBe(false);
    expect(media.list).toHaveBeenCalledTimes(2);
  });

  it('starts voice notes left out', async () => {
    const files = fixtures();
    const whatsapp =
      '/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio';
    files.set(`${whatsapp}/AUD-1.opus`, {
      row: row(902, `${whatsapp}/AUD-1.opus`),
      tags: {},
      art: false,
    });
    const { library } = await service(files);
    const result = await library.scan();
    expect(result.imported).toBe(4);
    expect(library.store.get().library.excludedFolders).toEqual([whatsapp]);
  });

  it('reads nothing automatically without the permission', async () => {
    let granted = false;
    const permissions: PermissionPort = {
      sdk: 34,
      check: async () => granted,
      request: async () => 'never_ask_again',
      openSettings: async () => undefined,
    };
    const { library, media } = await service(fixtures(), 5000, permissions);
    expect(library.store.get().permission).toBe('unknown');
    await library.refresh();
    expect(media.list).not.toHaveBeenCalled();
    expect(await library.requestPermission()).toBe('blocked');
    // Granted in Android's settings, then back in the app.
    granted = true;
    expect(await library.checkPermission()).toBe('granted');

    // Withdrawn while the app runs: the list fails and the check says so.
    await library.scan();
    granted = false;
    media.bump();
    media.list.mockImplementationOnce(async () => {
      throw new Error('SecurityException');
    });
    await expect(library.look()).rejects.toThrow('SecurityException');
    expect(library.store.get().permission).toBe('denied');
    expect(library.store.get().scan).toEqual({ phase: 'idle' });
  });

  it('keeps a refusal that lands while a check is in flight', async () => {
    let answerCheck: (granted: boolean) => void = () => undefined;
    const permissions: PermissionPort = {
      sdk: 34,
      check: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(
          () => new Promise<boolean>(resolve => (answerCheck = resolve)),
        ),
      request: async () => 'denied',
      openSettings: async () => undefined,
    };
    const { library } = await service(fixtures(), 5000, permissions);
    const checking = library.checkPermission();
    await library.requestPermission();
    answerCheck(false);
    await checking;
    expect(library.store.get().permission).toBe('denied');
  });

  it('publishes reading at a pace, and every change of phase', async () => {
    const { library } = await service(fixtures());
    const phases: string[] = [];
    library.store.subscribe(() => {
      const { phase } = library.store.get().scan;
      if (phases[phases.length - 1] !== phase) phases.push(phase);
    });
    let ticks = 0;
    library.store.subscribe(() => {
      if (library.store.get().scan.phase === 'inspecting') ticks += 1;
    });
    await library.scan();
    // The clock stands still: one reading tick, then the phases.
    expect(ticks).toBe(1);
    expect(phases).toEqual(['listing', 'inspecting', 'saving', 'idle']);
  });

  it('commits even when a progress watcher throws', async () => {
    const { library } = await service(fixtures());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    library.store.subscribe(() => {
      if (library.store.get().scan.phase === 'inspecting') {
        throw new Error('Maximum update depth exceeded');
      }
    });
    const result = await library.scan();
    expect(result.imported).toBe(4);
    expect(library.store.get().library.songs).toHaveLength(4);
    warn.mockRestore();
  });

  it('leaves a kept folder out for good, its files untouched', async () => {
    const { library, media } = await service(fixtures());
    await library.scan();
    await library.leaveOut(`${ROOT}/cantor-import-test`);
    let state = library.store.get();
    expect(state.library.songs.map(song => song.path)).toEqual([
      `${ROOT}/Cesar/own song.mp3`,
    ]);
    expect(
      state.folders!.find(f => f.label === 'Music/cantor-import-test'),
    ).toMatchObject({ status: 'excluded', keep: false });
    // The album's art went with its last song.
    expect([...media.artwork]).toEqual([]);
    // Later looks neither bring it back nor count it missing.
    media.bump();
    await library.refresh();
    state = library.store.get();
    expect(state.library.songs).toHaveLength(1);
    expect(state.library.songs[0].missingSinceMs).toBeNull();
  });

  it('writes tags to the phone database', async () => {
    const { library } = await service(fixtures());
    await library.scan();
    const id = library.store.get().library.songs[0].id;
    await library.setTags(id, ['p/road']);
    expect(library.store.get().library.tags.get(id)).toEqual(['p/road']);
  });
});

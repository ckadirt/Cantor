import { openTestDatabase } from '../../../jest/nodeSqlite';
import { migrate } from '../../core/storage/sql';
import {
  createDeviceRepository,
  deviceSongId,
  type DeviceAlbum,
  type DeviceSong,
} from '../repository';
import { DEVICE_MIGRATIONS } from '../schema';

const album: DeviceAlbum = {
  key: 'test artist|fixture album|/Music/Test Artist/Fixture Album',
  title: 'Fixture Album',
  artist: 'Test Artist',
  year: 2019,
  folder: '/Music/Test Artist/Fixture Album',
  artwork: null,
};

function song(overrides: Partial<DeviceSong> = {}): DeviceSong {
  const size = overrides.size ?? 730681;
  const headSha256 = overrides.headSha256 ?? 'c74c0282eaa2';
  return {
    id: deviceSongId(size, headSha256),
    mediaId: 1000000776,
    path: '/Music/Test Artist/Fixture Album/01 - Tone MP3.mp3',
    size,
    headSha256,
    durationMs: 30041,
    mime: 'audio/mpeg',
    title: 'Tone MP3',
    titleFromTag: true,
    artist: 'Test Artist',
    albumArtist: 'Test Artist',
    disc: 1,
    track: 1,
    year: 2019,
    date: null,
    genre: 'Ambient',
    albumKey: album.key,
    addedAtMs: 1_790_000_000_000,
    importedAtMs: 1_790_000_100_000,
    missingSinceMs: null,
    ...overrides,
  };
}

async function setup() {
  const db = openTestDatabase();
  await migrate(db, DEVICE_MIGRATIONS);
  return { db, repository: createDeviceRepository(db) };
}

describe('device repository', () => {
  it('starts empty', async () => {
    const { repository } = await setup();
    const library = await repository.load();
    expect(library.songs).toEqual([]);
    expect(library.albums).toEqual([]);
    expect(library.tags.size).toBe(0);
    expect(library.generations.size).toBe(0);
    expect(library.excludedFolders).toEqual([]);
  });

  it('round-trips a scan exactly', async () => {
    const { repository } = await setup();
    const untagged = song({
      size: 481114,
      headSha256: '528822ff35d3',
      path: '/Music/loose/07 - Untagged Tone.mp3',
      title: '07 - Untagged Tone',
      titleFromTag: false,
      artist: null,
      albumArtist: null,
      disc: null,
      track: null,
      year: null,
      genre: null,
      mime: null,
      mediaId: null,
      albumKey: 'loose',
    });
    const loose: DeviceAlbum = {
      key: 'loose',
      title: null,
      artist: null,
      year: null,
      folder: '/Music/loose',
      artwork: 'loose.jpg',
    };
    await repository.commitScan({
      volume: 'external_primary',
      generation: 9019,
      scannedAtMs: 1_790_000_200_000,
      songs: [song(), untagged],
      albums: [album, loose],
      missing: [],
    });

    const library = await repository.load();
    expect(library.songs).toEqual([song(), untagged]);
    expect(library.albums).toEqual([loose, album]);
    expect(library.generations.get('external_primary')).toBe(9019);
  });

  it('keeps the first import time and follows everything else', async () => {
    const { repository } = await setup();
    const commit = {
      volume: 'external_primary',
      generation: 1,
      scannedAtMs: 1,
      albums: [album],
      missing: [],
    };
    await repository.commitScan({ ...commit, songs: [song()] });
    await repository.commitScan({
      ...commit,
      generation: 2,
      songs: [
        song({ path: '/Music/moved.mp3', importedAtMs: 999, mediaId: 5 }),
      ],
    });

    const [stored] = (await repository.load()).songs;
    expect(stored.path).toBe('/Music/moved.mp3');
    expect(stored.mediaId).toBe(5);
    expect(stored.importedAtMs).toBe(song().importedAtMs);
  });

  it('marks a missing song once and brings it back when it is seen again', async () => {
    const { repository } = await setup();
    const base = {
      volume: 'external_primary',
      generation: 1,
      scannedAtMs: 1,
      albums: [album],
    };
    await repository.commitScan({ ...base, songs: [song()], missing: [] });
    await repository.commitScan({
      ...base,
      songs: [],
      missing: [{ id: song().id, sinceMs: 100 }],
    });
    await repository.commitScan({
      ...base,
      songs: [],
      missing: [{ id: song().id, sinceMs: 200 }],
    });
    expect((await repository.load()).songs[0].missingSinceMs).toBe(100);

    await repository.commitScan({ ...base, songs: [song()], missing: [] });
    expect((await repository.load()).songs[0].missingSinceMs).toBeNull();
  });

  it('drops an album once no song points at it', async () => {
    const { repository } = await setup();
    const base = {
      volume: 'external_primary',
      generation: 1,
      scannedAtMs: 1,
      missing: [],
    };
    await repository.commitScan({ ...base, songs: [song()], albums: [album] });
    const other: DeviceAlbum = { ...album, key: 'other', title: 'Other' };
    await repository.commitScan({
      ...base,
      songs: [song({ albumKey: 'other' })],
      albums: [other],
    });
    expect((await repository.load()).albums).toEqual([other]);
  });

  it('commits a scan whole or not at all', async () => {
    const { repository } = await setup();
    await expect(
      repository.commitScan({
        volume: 'external_primary',
        generation: 1,
        scannedAtMs: 1,
        albums: [album],
        // A text size breaks the STRICT table on the second song.
        songs: [
          song(),
          song({ id: 'dbroken', size: 'big' as unknown as number }),
        ],
        missing: [],
      }),
    ).rejects.toThrow();
    const library = await repository.load();
    expect(library.songs).toEqual([]);
    expect(library.albums).toEqual([]);
    expect(library.generations.size).toBe(0);
  });

  it('replaces a song’s tags and the excluded folders as sets', async () => {
    const { repository } = await setup();
    await repository.setTags('d1', ['p/road', 'p/night', 'p/road']);
    await repository.setTags('d2', ['p/night']);
    await repository.setTags('d1', ['p/night']);
    await repository.setExcludedFolders([
      '/Music/WhatsApp',
      '/Music/Podcasts',
      '/Music/WhatsApp',
    ]);

    const library = await repository.load();
    expect(library.tags.get('d1')).toEqual(['p/night']);
    expect(library.tags.get('d2')).toEqual(['p/night']);
    expect(library.excludedFolders).toEqual([
      '/Music/Podcasts',
      '/Music/WhatsApp',
    ]);
  });
});

describe('deviceSongId', () => {
  it('is stable for a file’s content and differs between files', () => {
    expect(deviceSongId(730681, 'c74c0282eaa2')).toBe(
      deviceSongId(730681, 'c74c0282eaa2'),
    );
    expect(deviceSongId(730681, 'c74c0282eaa2')).not.toBe(
      deviceSongId(730682, 'c74c0282eaa2'),
    );
    expect(deviceSongId(730681, 'c74c0282eaa2')).toMatch(/^d[0-9a-f]{16}$/);
  });
});

describe('migrate', () => {
  it('is idempotent and refuses a newer database', async () => {
    const db = openTestDatabase();
    expect(await migrate(db, DEVICE_MIGRATIONS)).toBe(1);
    expect(await migrate(db, DEVICE_MIGRATIONS)).toBe(1);
    await expect(migrate(db, [])).rejects.toThrow('newer than this build');
  });

  it('leaves the database at a whole version when a migration fails', async () => {
    const db = openTestDatabase();
    await expect(
      migrate(db, [
        ['CREATE TABLE a (x INTEGER) STRICT', 'CREATE TABLE a (x INTEGER)'],
      ]),
    ).rejects.toThrow();
    const { rows } = await db.execute('PRAGMA user_version');
    expect(rows[0].user_version).toBe(0);
    const tables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(tables.rows).toEqual([]);
  });
});

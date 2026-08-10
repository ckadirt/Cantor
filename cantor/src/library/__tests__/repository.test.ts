import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SongHeader } from '../../../../protocol/SongHeader';
import {
  applyLibraryChanges,
  clearCachedLibrary,
  commitLibrary,
  loadLibrary,
  mergeSongHeaders,
} from '../repository';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

function song(id: string, revision: number, trashed = false): SongHeader {
  return {
    id,
    revision,
    title: id,
    caption_summary: id,
    created_at: `2026-08-0${id === 'a' ? 8 : 7}T00:00:00Z`,
    duration_ms: 1_000,
    model: 'acestep:test',
    favorite: false,
    tags: [],
    trashed,
    artifacts: [
      {
        kind: 'master',
        profile: 'pcm16-wav-v1',
        media_type: 'audio/wav',
        byte_length: 100,
        sha256: 'a'.repeat(64),
        sample_rate: 48_000,
        channels: 2,
      },
    ],
  };
}

describe('private library cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue();
  });

  afterEach(() => jest.useRealTimers());

  it('keeps the newest song metadata and stable newest-first order', () => {
    expect(
      mergeSongHeaders([song('b', 3)], [song('b', 2), song('a', 1)]),
    ).toEqual([song('a', 1), song('b', 3)]);
  });

  it('applies tombstones only to the matching composite library', () => {
    expect(
      applyLibraryChanges(
        [song('a', 1), song('b', 1)],
        [{ song_id: 'a' }, { song_id: 'b', song: song('b', 2, true) }],
      ),
    ).toEqual([song('b', 2, true)]);
  });

  it('commits a complete node snapshot and never rolls its revision backward', async () => {
    const committed = await commitLibrary('node-a', 4, [song('a', 1)]);
    const first = storage.setItem.mock.calls[0][1];
    storage.getItem.mockResolvedValue(first);
    await expect(commitLibrary('node-a', 2, [])).resolves.toEqual(committed);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    storage.getItem.mockResolvedValue(first);
    await expect(loadLibrary('node-a')).resolves.toMatchObject({
      revision: 4,
      songs: [song('a', 1)],
    });
  });

  it('keeps the key, exact JSON shape, return value, and fresh timestamp stable', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    const first = await commitLibrary('node', 4, [song('b', 1), song('a', 1)]);
    expect(first).toEqual({
      revision: 4,
      songs: [song('a', 1), song('b', 1)],
      lastSyncedAt: '2026-08-09T12:00:00.000Z',
    });
    expect(storage.setItem).toHaveBeenLastCalledWith(
      'cantor.private-library.v1',
      JSON.stringify({ node: first }),
    );

    storage.getItem.mockResolvedValue(storage.setItem.mock.calls[0][1]);
    jest.setSystemTime(new Date('2026-08-09T12:01:00.000Z'));
    await expect(commitLibrary('node', 4, [song('a', 2)])).resolves.toEqual({
      revision: 4,
      songs: [song('a', 2)],
      lastSyncedAt: '2026-08-09T12:01:00.000Z',
    });
  });

  it('serializes concurrent commits without dropping another node', async () => {
    let persisted: string | null = null;
    storage.getItem.mockImplementation(async () => persisted);
    storage.setItem.mockImplementation(async (_key, value) => {
      persisted = value;
    });

    await Promise.all([
      commitLibrary('node-a', 1, [song('a', 1)]),
      commitLibrary('node-b', 2, [song('b', 2)]),
    ]);
    expect(Object.keys(JSON.parse(persisted ?? '{}'))).toEqual([
      'node-a',
      'node-b',
    ]);
  });

  it('continues accepting commits after a storage write fails', async () => {
    storage.setItem
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce();

    await expect(commitLibrary('node', 1, [song('a', 1)])).rejects.toThrow(
      'write failed',
    );
    await expect(
      commitLibrary('node', 2, [song('b', 2)]),
    ).resolves.toMatchObject({
      revision: 2,
      songs: [song('b', 2)],
    });
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('keeps same song ids isolated by node key', async () => {
    await commitLibrary('node-a', 1, [song('a', 1)]);
    const first = storage.setItem.mock.calls[0][1];
    storage.getItem.mockResolvedValue(first);
    await commitLibrary('node-b', 7, [song('a', 7)]);
    const stored = JSON.parse(storage.setItem.mock.calls[1][1]);
    expect(stored['node-a'].songs[0].revision).toBe(1);
    expect(stored['node-b'].songs[0].revision).toBe(7);
  });

  it('drops only an invalid recreatable node cache during an upgrade', async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({
        'node-not-record': null,
        'node-bad-revision': {
          revision: -1,
          lastSyncedAt: '2026-08-08T00:00:00Z',
          songs: [],
        },
        'node-bad-timestamp': {
          revision: 3,
          lastSyncedAt: 7,
          songs: [],
        },
        'node-old': {
          revision: 3,
          lastSyncedAt: '2026-08-08T00:00:00Z',
          songs: [{ id: 'pre-library-schema' }],
        },
        'node-good': {
          revision: 4,
          lastSyncedAt: '2026-08-09T00:00:00Z',
          songs: [song('a', 1)],
        },
      }),
    );

    await expect(loadLibrary('node-old')).resolves.toEqual({
      revision: null,
      songs: [],
      lastSyncedAt: null,
    });
    for (const node of [
      'node-not-record',
      'node-bad-revision',
      'node-bad-timestamp',
    ]) {
      await expect(loadLibrary(node)).resolves.toEqual({
        revision: null,
        songs: [],
        lastSyncedAt: null,
      });
    }
    await expect(loadLibrary('node-good')).resolves.toMatchObject({
      revision: 4,
      songs: [song('a', 1)],
    });
  });

  it('preserves malformed JSON and top-level validation errors', async () => {
    storage.getItem.mockResolvedValueOnce('{broken');
    await expect(loadLibrary('node')).rejects.toBeInstanceOf(SyntaxError);

    storage.getItem.mockResolvedValueOnce('[]');
    await expect(loadLibrary('node')).rejects.toThrow(
      'Saved private libraries are invalid.',
    );
  });

  it('clears only the requested node and persists even when it is absent', async () => {
    const stored = JSON.stringify({
      'node-a': {
        revision: 1,
        songs: [song('a', 1)],
        lastSyncedAt: '2026-08-09T00:00:00Z',
      },
      'node-b': {
        revision: 2,
        songs: [song('b', 2)],
        lastSyncedAt: '2026-08-09T00:00:00Z',
      },
    });
    storage.getItem.mockResolvedValue(stored);

    await expect(clearCachedLibrary('node-a')).resolves.toBeUndefined();
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({
      'node-b': JSON.parse(stored)['node-b'],
    });

    storage.getItem.mockResolvedValue(storage.setItem.mock.calls[0][1]);
    await clearCachedLibrary('missing');
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(storage.setItem.mock.calls[1][1]).toBe(
      storage.setItem.mock.calls[0][1],
    );
  });
});

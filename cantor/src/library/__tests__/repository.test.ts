import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SongHeader } from '../../../../protocol/SongHeader';
import {
  applyLibraryChanges,
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
    await commitLibrary('node-a', 4, [song('a', 1)]);
    const first = storage.setItem.mock.calls[0][1];
    storage.getItem.mockResolvedValue(first);
    await commitLibrary('node-a', 2, []);
    storage.getItem.mockResolvedValue(first);
    await expect(loadLibrary('node-a')).resolves.toMatchObject({
      revision: 4,
      songs: [song('a', 1)],
    });
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
    await expect(loadLibrary('node-good')).resolves.toMatchObject({
      revision: 4,
      songs: [song('a', 1)],
    });
  });
});

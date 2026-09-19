import type { SongHeader } from '../../../protocol/SongHeader';
import { parseSongs } from '../core/protocol';
import { createSerializedJsonStore } from '../core/storage/serializedJsonStore';
import { isRecord } from '../core/validation';

const LIBRARY_KEY = 'cantor.private-library.v1';

export type CachedLibrary = {
  revision: number | null;
  songs: SongHeader[];
  lastSyncedAt: string | null;
};

type StoredLibrary = {
  revision: number;
  songs: SongHeader[];
  lastSyncedAt: string;
};

type StoredLibraries = Record<string, StoredLibrary>;

const libraryStore = createSerializedJsonStore<StoredLibraries>({
  key: LIBRARY_KEY,
  empty: () => ({}),
  decode: decodeStoredLibraries,
  invalidJson: (_raw, error) => {
    throw error;
  },
});

export function mergeSongHeaders(
  current: SongHeader[],
  incoming: SongHeader[],
): SongHeader[] {
  const merged = new Map(current.map(song => [song.id, song]));
  for (const song of incoming) {
    const existing = merged.get(song.id);
    if (existing === undefined || song.revision > existing.revision) {
      merged.set(song.id, song);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) ||
      right.id.localeCompare(left.id),
  );
}

export function applyLibraryChanges(
  current: SongHeader[],
  changes: Array<{ song_id: string; song?: SongHeader }>,
): SongHeader[] {
  const merged = new Map(current.map(song => [song.id, song]));
  for (const change of changes) {
    if (change.song === undefined) {
      merged.delete(change.song_id);
      continue;
    }
    const existing = merged.get(change.song_id);
    if (existing === undefined || change.song.revision >= existing.revision) {
      merged.set(change.song_id, change.song);
    }
  }
  return mergeSongHeaders([], [...merged.values()]);
}

/** Cached metadata also locates downloaded songs from forgotten nodes. */
export async function loadLibraries(): Promise<Record<string, CachedLibrary>> {
  return libraryStore.load();
}

export async function loadLibrary(
  nodePublicKey: string,
): Promise<CachedLibrary> {
  const stored = await libraryStore.load();
  const library = stored[nodePublicKey];
  return library === undefined
    ? { revision: null, songs: [], lastSyncedAt: null }
    : {
        revision: library.revision,
        songs: library.songs,
        lastSyncedAt: library.lastSyncedAt,
      };
}

/** A completed remote sync replaces one node atomically in one native write. */
export async function commitLibrary(
  nodePublicKey: string,
  revision: number,
  songs: SongHeader[],
): Promise<CachedLibrary> {
  return libraryStore.update(stored => {
    const existing = stored[nodePublicKey];
    if (existing !== undefined && existing.revision > revision) {
      return { unchanged: true, result: existing };
    }
    const next: StoredLibrary = {
      revision,
      songs: mergeSongHeaders([], songs),
      lastSyncedAt: new Date().toISOString(),
    };
    stored[nodePublicKey] = next;
    return { value: stored, result: next };
  });
}

export async function clearCachedLibrary(nodePublicKey: string): Promise<void> {
  await libraryStore.update(stored => {
    delete stored[nodePublicKey];
    return { value: stored, result: undefined };
  });
}

function decodeStoredLibraries(value: unknown): StoredLibraries {
  if (!isRecord(value)) throw new Error('Saved private libraries are invalid.');
  const result: StoredLibraries = {};
  for (const [node, candidate] of Object.entries(value)) {
    if (
      !isRecord(candidate) ||
      !Number.isSafeInteger(candidate.revision) ||
      (candidate.revision as number) < 0 ||
      typeof candidate.lastSyncedAt !== 'string'
    ) {
      continue;
    }
    const songs = parseSongs(candidate.songs);
    if (songs === null) continue;
    result[node] = {
      revision: candidate.revision as number,
      songs: mergeSongHeaders([], songs),
      lastSyncedAt: candidate.lastSyncedAt,
    };
  }
  return result;
}

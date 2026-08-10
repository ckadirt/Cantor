import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SongHeader } from '../../../protocol/SongHeader';
import { parseSongs } from '../core/protocol';
import { isRecord } from '../core/validation';

const LIBRARY_KEY = 'cantor.private-library.v1';
let writeQueue = Promise.resolve();

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

export async function loadLibrary(
  nodePublicKey: string,
): Promise<CachedLibrary> {
  const stored = await loadAll();
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
  return withWriteLock(async () => {
    const stored = await loadAll();
    const existing = stored[nodePublicKey];
    if (existing !== undefined && existing.revision > revision) {
      return existing;
    }
    const next: StoredLibrary = {
      revision,
      songs: mergeSongHeaders([], songs),
      lastSyncedAt: new Date().toISOString(),
    };
    stored[nodePublicKey] = next;
    await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(stored));
    return next;
  });
}

export async function clearCachedLibrary(nodePublicKey: string): Promise<void> {
  await withWriteLock(async () => {
    const stored = await loadAll();
    delete stored[nodePublicKey];
    await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(stored));
  });
}

async function loadAll(): Promise<StoredLibraries> {
  const raw = await AsyncStorage.getItem(LIBRARY_KEY);
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
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

function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

import type { LibraryChange } from '../../../../protocol/LibraryChange';
import { isNonNegativeInteger, isRecord } from '../validation';
import { parseSong } from './songs';

export function parseLibraryChanges(value: unknown): LibraryChange[] | null {
  if (!Array.isArray(value)) return null;
  const changes = value.map(candidate => {
    if (
      !isRecord(candidate) ||
      !isNonNegativeInteger(candidate.revision) ||
      typeof candidate.song_id !== 'string' ||
      !['upsert', 'trash', 'restore', 'tombstone'].includes(
        String(candidate.kind),
      ) ||
      typeof candidate.changed_at !== 'string'
    )
      return null;
    const song =
      candidate.song === undefined ? undefined : parseSong(candidate.song);
    if (candidate.song !== undefined && song === null) return null;
    if (
      candidate.kind === 'tombstone' ? song !== undefined : song === undefined
    )
      return null;
    return {
      revision: candidate.revision,
      song_id: candidate.song_id,
      kind: candidate.kind as LibraryChange['kind'],
      changed_at: candidate.changed_at,
      ...(song === undefined ? {} : { song }),
    };
  });
  return changes.some(change => change === null)
    ? null
    : (changes as LibraryChange[]);
}

import type { ArtifactView } from '../../../protocol/ArtifactView';
import {
  parseArtifact,
  parseJob,
  parseJobs,
  parseLibraryChanges,
  parseSong,
  parseSongDetail,
  parseSongs,
  type JobView,
  type LibraryChange,
  type SongDetail,
  type SongHeader,
} from '../core/protocol';
import { isRecord } from '../core/validation';

export type ArtifactInfo = {
  transferId: string;
  songId: string;
  artifact: ArtifactView;
  acceptedOffset: number;
  chunkBytes: number;
  windowChunks: number;
};

export type ArtifactPart =
  | { kind: 'chunk'; transferId: string; offset: number; data: string }
  | {
      kind: 'complete';
      transferId: string;
      byteLength: number;
      sha256: string;
    };

export type LibraryPage = {
  snapshotRevision: number;
  songs: SongHeader[];
  tombstones: string[];
  nextCursor?: string;
};

export type LibraryChangesPage = {
  changes: LibraryChange[];
  throughRevision: number;
  hasMore: boolean;
};

export function decodeJobsPage(message: unknown): JobView[] | null {
  return isRecord(message) ? parseJobs(message.jobs) : null;
}

export function decodeJobResponse(message: unknown): JobView | null {
  return isRecord(message) ? parseJob(message.job) : null;
}

export function decodeSongResponse(message: unknown): SongHeader | null {
  return isRecord(message) ? parseSong(message.song) : null;
}

export function decodeSongDetailResponse(message: unknown): SongDetail | null {
  return isRecord(message) ? parseSongDetail(message.detail) : null;
}

export function decodeArtifactInfo(message: unknown): ArtifactInfo | null {
  if (!isRecord(message)) return null;
  const artifact = parseArtifact(message.artifact);
  if (
    artifact === null ||
    typeof message.transfer_id !== 'string' ||
    typeof message.song_id !== 'string' ||
    !isSafeRevision(message.accepted_offset) ||
    !isPositiveSafeInteger(message.chunk_bytes) ||
    !isPositiveSafeInteger(message.window_chunks) ||
    message.chunk_bytes > 64 * 1024 ||
    message.window_chunks !== 1
  ) {
    return null;
  }
  return {
    transferId: message.transfer_id,
    songId: message.song_id,
    artifact,
    acceptedOffset: message.accepted_offset,
    chunkBytes: message.chunk_bytes,
    windowChunks: message.window_chunks,
  };
}

export function decodeArtifactPart(message: unknown): ArtifactPart | null {
  if (!isRecord(message)) return null;
  if (message.t === 'artifact.chunk') {
    if (
      typeof message.transfer_id !== 'string' ||
      !isSafeRevision(message.offset) ||
      typeof message.data !== 'string' ||
      message.data.length === 0 ||
      message.data.length > 88_000
    ) {
      return null;
    }
    return {
      kind: 'chunk',
      transferId: message.transfer_id,
      offset: message.offset,
      data: message.data,
    };
  }
  if (
    message.t !== 'artifact.complete' ||
    typeof message.transfer_id !== 'string' ||
    !isSafeRevision(message.byte_length) ||
    typeof message.sha256 !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'complete',
    transferId: message.transfer_id,
    byteLength: message.byte_length,
    sha256: message.sha256,
  };
}

export function decodeLibraryPage(message: unknown): LibraryPage | null {
  if (!isRecord(message)) return null;
  const songs = parseSongs(message.songs);
  const snapshotRevision = message.snapshot_revision;
  const tombstones = message.tombstones;
  if (
    songs === null ||
    !isSafeRevision(snapshotRevision) ||
    !Array.isArray(tombstones) ||
    !tombstones.every(songId => typeof songId === 'string') ||
    !(
      message.next_cursor === undefined ||
      typeof message.next_cursor === 'string'
    )
  ) {
    return null;
  }
  return {
    snapshotRevision,
    songs,
    tombstones,
    ...(message.next_cursor === undefined
      ? {}
      : { nextCursor: message.next_cursor }),
  };
}

export function decodeLibraryChanges(
  message: unknown,
): LibraryChangesPage | null {
  if (!isRecord(message)) return null;
  const changes = parseLibraryChanges(message.changes);
  if (
    changes === null ||
    !isSafeRevision(message.through_revision) ||
    typeof message.has_more !== 'boolean'
  ) {
    return null;
  }
  return {
    changes,
    throughRevision: message.through_revision,
    hasMore: message.has_more,
  };
}

export function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeRevision(value) && value > 0;
}

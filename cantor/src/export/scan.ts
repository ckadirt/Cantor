import type { MediaInspection, MediaRow } from '../device/native';
import { readMarker, type ExportMarker } from './marker';
import type { ExportCopy, ExportFormat } from './types';

/**
 * How the device scan treats the copies Cantor saved (D5 in
 * internal/docs/plans/take-it-plan.md). A copy is never a song of the person's
 * own, wherever it was saved, so it never becomes a second mark:
 *
 * 1. A row at a path `export_copy` knows is a copy, and is not even read.
 * 2. A new file whose marker names a song in this library is a copy too; its
 *    row is written back (a reinstall, Cantor Dev's saves seen by Cantor).
 * 3. A marker for a song not here imports like any file: it was shared by
 *    someone, or its song was deleted, and it is the person's own now.
 * 4. No marker: import as ever.
 *
 * Pure; `deviceLibrary.ts` calls it, the export service keeps the table.
 */
export type CopyGate = Readonly<{
  /** Every copy `export_copy` holds. */
  known(): Promise<readonly ExportCopy[]>;
  /** The node key of a marker's song, when that song is in this library. */
  recognise(marker: ExportMarker): string | null;
  /** Write back the rows of copies found by their markers. */
  relink(copies: readonly ExportCopy[]): Promise<void>;
}>;

/** The rows that are not copies Cantor already knows (rule 1). */
export function withoutKnownCopies(
  rows: readonly MediaRow[],
  copies: readonly ExportCopy[],
): MediaRow[] {
  if (copies.length === 0) return [...rows];
  const paths = new Set<string>();
  const ids = new Set<number>();
  for (const copy of copies) {
    if (copy.path !== null) paths.add(copy.path);
    if (copy.mediaId !== null) ids.add(copy.mediaId);
  }
  return rows.filter(row => !paths.has(row.path) && !ids.has(row.mediaId));
}

/** A new file that is a copy of a song in this library (rule 2), or null. */
export function copyFromMarker(
  row: MediaRow,
  inspection: MediaInspection,
  recognise: (marker: ExportMarker) => string | null,
  nowMs: number,
): ExportCopy | null {
  const marker = readMarker(inspection.marker);
  if (marker === null) return null;
  const format = formatOfPath(row.path);
  if (format === null) return null;
  const nodeKey = recognise(marker);
  if (nodeKey === null) return null;
  return {
    nodeKey,
    songId: marker.songId,
    format,
    digest: marker.digest,
    mediaId: row.mediaId,
    path: row.path,
    uri: mediaStoreAudioUri(row.mediaId),
    bytes: inspection.size,
    savedAtMs: nowMs,
  };
}

export function formatOfPath(path: string): ExportFormat | null {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'opus':
    case 'ogg':
      return 'opus';
    case 'mp3':
      return 'mp3';
    case 'wav':
      return 'wav';
    default:
      return null;
  }
}

/** MediaStore's URI for an audio row, by its id. */
export function mediaStoreAudioUri(mediaId: number): string {
  return `content://media/external_primary/audio/media/${mediaId}`;
}

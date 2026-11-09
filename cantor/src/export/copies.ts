import type { SqlExecutor, SqlRow } from '../core/storage/sql';
import {
  EXPORT_FORMATS,
  isExportFormat,
  type ExportCopy,
  type ExportFormat,
} from './types';

/**
 * The public copies Cantor has saved, one row per song and format
 * (`export_copy`, phone database migration 5).
 *
 * Two readers: the song sheet, which says where a song's copies are, and the
 * device scan, which must never import one of them as a song of the person's
 * own. The scan also keeps it honest: a copy whose file is gone loses its row.
 */
export type ExportCopyRepository = Readonly<{
  forSong(nodeKey: string, songId: string): Promise<ExportCopy[]>;
  all(): Promise<ExportCopy[]>;
  /** Insert, or replace the song's copy in that format. */
  put(copy: ExportCopy): Promise<void>;
  remove(nodeKey: string, songId: string, format: ExportFormat): Promise<void>;
  /** Forget every copy of a song (the song was deleted; the files stay). */
  forgetSong(nodeKey: string, songId: string): Promise<void>;
}>;

const COLUMNS =
  'node_key, song_id, format, digest, media_id, path, uri, bytes, saved_at_ms';

export function createExportCopyRepository(
  db: SqlExecutor,
): ExportCopyRepository {
  // A song's copies in the order the formats are offered, whatever order
  // the table keeps them in.
  const read = (rows: readonly SqlRow[]) =>
    rows
      .map(toCopy)
      .filter((copy): copy is ExportCopy => copy !== null)
      .sort(
        (a, b) =>
          a.nodeKey.localeCompare(b.nodeKey) ||
          a.songId.localeCompare(b.songId) ||
          EXPORT_FORMATS.indexOf(a.format) - EXPORT_FORMATS.indexOf(b.format),
      );
  return {
    async forSong(nodeKey, songId) {
      const { rows } = await db.execute(
        `SELECT ${COLUMNS} FROM export_copy WHERE node_key = ? AND song_id = ?`,
        [nodeKey, songId],
      );
      return read(rows);
    },
    async all() {
      const { rows } = await db.execute(`SELECT ${COLUMNS} FROM export_copy`);
      return read(rows);
    },
    async put(copy) {
      await db.execute(
        `INSERT INTO export_copy (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (node_key, song_id, format) DO UPDATE SET
           digest = excluded.digest,
           media_id = excluded.media_id,
           path = excluded.path,
           uri = excluded.uri,
           bytes = excluded.bytes,
           saved_at_ms = excluded.saved_at_ms`,
        [
          copy.nodeKey,
          copy.songId,
          copy.format,
          copy.digest,
          copy.mediaId,
          copy.path,
          copy.uri,
          copy.bytes,
          copy.savedAtMs,
        ],
      );
    },
    async remove(nodeKey, songId, format) {
      await db.execute(
        'DELETE FROM export_copy WHERE node_key = ? AND song_id = ? AND format = ?',
        [nodeKey, songId, format],
      );
    },
    async forgetSong(nodeKey, songId) {
      await db.execute(
        'DELETE FROM export_copy WHERE node_key = ? AND song_id = ?',
        [nodeKey, songId],
      );
    },
  };
}

function toCopy(row: SqlRow): ExportCopy | null {
  const format = row.format;
  if (
    typeof row.node_key !== 'string' ||
    typeof row.song_id !== 'string' ||
    !isExportFormat(format) ||
    typeof row.digest !== 'string' ||
    typeof row.uri !== 'string' ||
    typeof row.bytes !== 'number' ||
    typeof row.saved_at_ms !== 'number'
  ) {
    return null;
  }
  return {
    nodeKey: row.node_key,
    songId: row.song_id,
    format,
    digest: row.digest,
    mediaId: typeof row.media_id === 'number' ? row.media_id : null,
    path: typeof row.path === 'string' ? row.path : null,
    uri: row.uri,
    bytes: row.bytes,
    savedAtMs: row.saved_at_ms,
  };
}

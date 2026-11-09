/**
 * Taking a song out of Cantor as a file (internal/docs/plans/take-it-plan.md).
 *
 * A made song leaves in one of three formats: its delivery Opus as it is, an
 * MP3 made from it on the phone, or the node's own master as WAV. Each one can
 * be shared (handed to Android's share sheet as the file itself) or saved (a
 * public copy in the folder chosen in Settings).
 */

export type ExportFormat = 'opus' | 'mp3' | 'wav';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['opus', 'mp3', 'wav'];

/**
 * Where a saved copy goes. `music` and `download` are a `Cantor` folder under
 * Android's own; `tree` is a folder the person picked, reached through the
 * grant they gave (`uri`), called `name` on screen.
 */
export type ExportDestination =
  | Readonly<{ kind: 'music' }>
  | Readonly<{ kind: 'download' }>
  | Readonly<{ kind: 'tree'; uri: string; name: string }>;

/** One public copy of a made song, as `export_copy` keeps it. */
export type ExportCopy = Readonly<{
  nodeKey: string;
  songId: string;
  format: ExportFormat;
  /** The audio it was made from: the delivery digest, or the master's. */
  digest: string;
  /** MediaStore's id and path, when MediaStore has the file. */
  mediaId: number | null;
  path: string | null;
  /** Where it was written. */
  uri: string;
  bytes: number;
  savedAtMs: number;
}>;

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'opus' || value === 'mp3' || value === 'wav';
}

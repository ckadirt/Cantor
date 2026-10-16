import type { SqlExecutor, SqlRow } from '../core/storage/sql';
import type { Fact, FactKind, FactStatus } from './types';

/**
 * Song facts on the phone database (`device_song_fact`, migration 2). Stores
 * what it is given and checks what it reads back; deciding what a lookup
 * means is the service's job.
 */
export type FactRepository = Readonly<{
  get(subject: string, kind: FactKind): Promise<Fact | null>;
  put(fact: Fact): Promise<void>;
}>;

export function createFactRepository(db: SqlExecutor): FactRepository {
  return {
    async get(subject, kind) {
      const result = await db.execute(
        'SELECT * FROM device_song_fact WHERE subject = ? AND kind = ?',
        [subject, kind],
      );
      const row = result.rows[0];
      return row === undefined ? null : factFromRow(row);
    },
    async put(fact) {
      await db.execute(
        `INSERT INTO device_song_fact
           (subject, kind, status, value, source, reason, checked_at_ms,
            retry_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subject, kind) DO UPDATE SET
           status = excluded.status,
           value = excluded.value,
           source = excluded.source,
           reason = excluded.reason,
           checked_at_ms = excluded.checked_at_ms,
           retry_at_ms = excluded.retry_at_ms`,
        [
          fact.subject,
          fact.kind,
          fact.status,
          fact.value,
          fact.source,
          fact.reason,
          fact.checkedAtMs,
          fact.retryAtMs,
        ],
      );
    },
  };
}

const STATUSES: ReadonlySet<string> = new Set<FactStatus>([
  'found',
  'none',
  'unreachable',
]);

function factFromRow(row: SqlRow): Fact {
  const status = text(row, 'status');
  if (!STATUSES.has(status))
    throw new Error(`fact status ${status} is unknown.`);
  const kind = text(row, 'kind');
  if (kind !== 'lyrics') throw new Error(`fact kind ${kind} is unknown.`);
  return {
    subject: text(row, 'subject'),
    kind,
    status: status as FactStatus,
    value: optionalText(row, 'value'),
    source: optionalText(row, 'source'),
    reason: optionalText(row, 'reason'),
    checkedAtMs: integer(row, 'checked_at_ms'),
    retryAtMs: optionalInteger(row, 'retry_at_ms'),
  };
}

function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`fact ${column} is not text.`);
  return value;
}

function optionalText(row: SqlRow, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function integer(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`fact ${column} is not an integer.`);
  }
  return value;
}

function optionalInteger(row: SqlRow, column: string): number | null {
  return row[column] === null ? null : integer(row, column);
}

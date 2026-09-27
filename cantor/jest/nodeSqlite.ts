import type {
  SqlDatabase,
  SqlExecutor,
  SqlResult,
  SqlRow,
  SqlValue,
} from '../src/core/storage/sql';

/**
 * The `SqlDatabase` port on Node's built-in SQLite, for tests.
 *
 * The phone runs op-sqlite; Jest runs this, against an in-memory database, so
 * the real schema and every real query execute in a test. The few `node:sqlite`
 * shapes used are declared here instead of loading Node's types into the whole
 * program (which would change what `setTimeout` returns everywhere).
 */
type Statement = {
  all(...params: SqlValue[]): Record<string, SqlValue>[];
  run(...params: SqlValue[]): { changes: number | bigint };
};
type NodeDatabase = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
};

const RETURNS_ROWS = /^\s*(select|pragma|with)\b/i;

export function openTestDatabase(): SqlDatabase & { close(): void } {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => NodeDatabase;
  };
  const db = new DatabaseSync(':memory:');
  let inTransaction = false;

  const executor: SqlExecutor = {
    async execute(sql, params = []): Promise<SqlResult> {
      const statement = db.prepare(sql);
      if (RETURNS_ROWS.test(sql)) {
        const rows = statement.all(...params) as SqlRow[];
        return { rows, rowsAffected: 0 };
      }
      const { changes } = statement.run(...params);
      return { rows: [], rowsAffected: Number(changes) };
    },
  };

  return {
    execute: (sql, params) => {
      if (inTransaction) {
        throw new Error(
          'A statement ran on the database inside a transaction.',
        );
      }
      return executor.execute(sql, params);
    },
    async transaction(work) {
      db.exec('BEGIN');
      inTransaction = true;
      try {
        const result = await work(executor);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close: () => db.close(),
  };
}

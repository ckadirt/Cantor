/**
 * The phone's SQL database, as the rest of the app sees it.
 *
 * A port, not a library: `device/database.ts` binds it to op-sqlite on the
 * phone, and the tests bind it to Node's built-in SQLite, so the schema and
 * every query run for real in Jest. Nothing here imports a native module.
 */
export type SqlValue = string | number | null;

export type SqlRow = Readonly<Record<string, SqlValue>>;

export type SqlResult = Readonly<{
  rows: readonly SqlRow[];
  rowsAffected: number;
}>;

export interface SqlExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<SqlResult>;
}

export interface SqlDatabase extends SqlExecutor {
  /**
   * Run `work` in one transaction: committed when it resolves, rolled back
   * when it throws. Statements inside go through `tx`, never the database.
   */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** One schema step: its statements run in order, in one transaction. */
export type Migration = readonly string[];

/**
 * Bring the database up to `migrations.length`.
 *
 * The schema version is SQLite's own `user_version`: migration `i` takes it
 * from `i` to `i + 1`, and the version moves in the same transaction as the
 * statements, so a crash leaves the database at a whole version. Migrations
 * are a compatibility contract: once shipped, one is never edited, only
 * followed by another. A database newer than this build is refused rather than
 * read with the wrong shape.
 */
export async function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[],
): Promise<number> {
  const current = await userVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `The database is at schema ${current}, newer than this build (${migrations.length}).`,
    );
  }
  for (let version = current; version < migrations.length; version += 1) {
    await db.transaction(async tx => {
      for (const statement of migrations[version]) {
        await tx.execute(statement);
      }
      // PRAGMA takes no bound parameters; the version is a small integer.
      await tx.execute(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return migrations.length;
}

async function userVersion(db: SqlExecutor): Promise<number> {
  const { rows } = await db.execute('PRAGMA user_version');
  const value = rows[0]?.user_version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('The database reports no schema version.');
  }
  return value;
}

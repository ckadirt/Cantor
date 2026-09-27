import { open, type DB, type QueryResult } from '@op-engineering/op-sqlite';
import {
  migrate,
  type SqlDatabase,
  type SqlExecutor,
  type SqlResult,
  type SqlRow,
} from '../core/storage/sql';
import { DEVICE_MIGRATIONS } from './schema';

/**
 * The phone database's file, in op-sqlite's default location (the app's
 * `databases/` directory). A compatibility contract: renaming it loses every
 * imported song's tags.
 */
export const PHONE_DATABASE_NAME = 'cantor.sqlite';

/**
 * Open the phone database and bring its schema up to date.
 *
 * The only place op-sqlite is imported; everything else sees the
 * `SqlDatabase` port.
 */
export async function openPhoneDatabase(): Promise<SqlDatabase> {
  const db = bind(open({ name: PHONE_DATABASE_NAME }));
  await migrate(db, DEVICE_MIGRATIONS);
  return db;
}

function bind(db: DB): SqlDatabase {
  return {
    execute: async (sql, params = []) =>
      result(await db.execute(sql, [...params])),
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      // op-sqlite's transaction resolves with nothing; carry the result out.
      let value: T | undefined;
      await db.transaction(async tx => {
        value = await work({
          execute: async (sql, params = []) =>
            result(await tx.execute(sql, [...params])),
        });
      });
      return value as T;
    },
  };
}

function result(raw: QueryResult): SqlResult {
  return { rows: raw.rows as SqlRow[], rowsAffected: raw.rowsAffected };
}

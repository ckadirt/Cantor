import type { SongDetail } from '../../../protocol/SongDetail';
import { parseSongDetail } from '../core/protocol';
import type { SqlExecutor } from '../core/storage/sql';

/**
 * Made songs' recipes, kept on the phone.
 *
 * A song's recipe (`SongDetail`: its caption, its words, the words the model
 * wrote, the engine) lives on the node that made it, and a downloaded song
 * used to bring only its audio: with that node away, the sheet could not say
 * what made it and a version could not sing its words. A made song never
 * changes, so its recipe is stored once (in the phone database, migration 4)
 * and read back whenever its node cannot be asked.
 *
 * Two ways in: every recipe the sheet fetches is kept, and `keep` fetches the
 * recipe of every song whose audio is on the phone (FieldScreen reconciles
 * them), so a download brings its recipe however it finished.
 */
export type RecipeRepository = Readonly<{
  get(nodeKey: string, songId: string): Promise<SongDetail | null>;
  put(
    nodeKey: string,
    songId: string,
    detail: SongDetail,
    savedAtMs: number,
  ): Promise<void>;
}>;

export function createRecipeRepository(db: SqlExecutor): RecipeRepository {
  return {
    async get(nodeKey, songId) {
      const result = await db.execute(
        'SELECT detail_json FROM node_song_recipe WHERE node_key = ? AND song_id = ?',
        [nodeKey, songId],
      );
      const raw = result.rows[0]?.detail_json;
      if (typeof raw !== 'string') return null;
      // Read as a node's answer is read: a stored shape this build cannot
      // parse is no recipe, not a crash.
      try {
        return parseSongDetail(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async put(nodeKey, songId, detail, savedAtMs) {
      await db.execute(
        `INSERT INTO node_song_recipe (node_key, song_id, detail_json, saved_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (node_key, song_id) DO UPDATE SET
           detail_json = excluded.detail_json,
           saved_at_ms = excluded.saved_at_ms`,
        [nodeKey, songId, JSON.stringify(detail), savedAtMs],
      );
    },
  };
}

export type Recipes = Readonly<{
  /**
   * A song's recipe: from its node when the node is here (and kept), else the
   * kept copy. Rejects with the node's own error when neither has it.
   */
  detail(nodeKey: string, songId: string): Promise<SongDetail>;
  /** Make sure a song's recipe is kept: asks its node only if it is not. */
  keep(nodeKey: string, songId: string): Promise<void>;
}>;

export function createRecipes(deps: {
  openRepository: () => Promise<RecipeRepository>;
  /** Ask the song's node; rejects when it is not connected. */
  fetchLive: (nodeKey: string, songId: string) => Promise<SongDetail>;
  now: () => number;
  onError?: (error: unknown) => void;
}): Recipes {
  const report = (error: unknown) => deps.onError?.(error);
  let repository: Promise<RecipeRepository | null> | null = null;
  const stored = () =>
    (repository ??= deps.openRepository().catch(error => {
      report(error);
      return null;
    }));
  const kept = new Set<string>();
  const keeping = new Map<string, Promise<void>>();
  const id = (nodeKey: string, songId: string) => `${nodeKey}:${songId}`;

  const save = async (nodeKey: string, songId: string, detail: SongDetail) => {
    kept.add(id(nodeKey, songId));
    await (await stored())
      ?.put(nodeKey, songId, detail, deps.now())
      .catch(report);
  };

  return {
    async detail(nodeKey, songId) {
      try {
        const detail = await deps.fetchLive(nodeKey, songId);
        await save(nodeKey, songId, detail);
        return detail;
      } catch (error) {
        const copy = await (await stored())
          ?.get(nodeKey, songId)
          .catch(failure => {
            report(failure);
            return null;
          });
        if (copy) return copy;
        throw error;
      }
    },
    keep(nodeKey, songId) {
      const key = id(nodeKey, songId);
      if (kept.has(key)) return Promise.resolve();
      const already = keeping.get(key);
      if (already !== undefined) return already;
      const work = (async () => {
        const copy = await (await stored())
          ?.get(nodeKey, songId)
          .catch(() => null);
        if (copy) {
          kept.add(key);
          return;
        }
        await save(nodeKey, songId, await deps.fetchLive(nodeKey, songId));
      })()
        .catch(report)
        .finally(() => keeping.delete(key));
      keeping.set(key, work);
      return work;
    },
  };
}

import type { FieldEntity } from './types';

/*
 * eslint-disable no-bitwise -- a hash is a bit field by definition; the same
 * exemption `lenses/face.ts` and `motion/geometry.ts` take.
 */
/* eslint-disable no-bitwise */

/**
 * Order is position, not a list setting.
 *
 * `layoutField` seats a member at `cy + (index − (n−1)/2) · gap`, so a song's
 * index *is* where it sits — `BLOOM_GAP_WORLD` in the packing, and the pitch
 * `shelfRowGapWorld` derives from FIT in the column. Re-ordering therefore re-forms the cluster
 * and the existing from/target tween animates every mark to its new seat — at
 * L0 and L1 both, because the bloom is indexed by the same number as the
 * column. Sorting is something you watch rather than a setting you toggle.
 *
 * Ordering lives here rather than inside an arrangement because it is
 * orthogonal to grouping: the same three orders apply to weeks, to playlists
 * and to whatever the semantic axis becomes. It also repairs `byPlaylist`,
 * which sorted its groups by name and left their members in whatever order the
 * tags happened to produce.
 */
export type SongOrderKey = 'date' | 'random' | 'duration';

export type SongOrder = Readonly<{
  key: SongOrderKey;
  label: string;
  /**
   * The value a member sorts by, ascending. A number rather than a comparator
   * so `random` can be a *seeded* key rather than a shuffle with state.
   */
  rank: (entity: FieldEntity, seed: number) => number;
}>;

export const SONG_ORDERS: readonly SongOrder[] = [
  {
    key: 'date',
    label: 'Date',
    rank: entity => entity.createdAtMs,
  },
  {
    // Seeded, and held: an unseeded shuffle would re-form the whole field on
    // every render, which is not an order at all. The same seed and the same
    // song always produce the same seat, so the field is still while you look
    // at it and re-forms only when you ask for the order again.
    key: 'random',
    label: 'Random',
    rank: (entity, seed) => shuffleRank(entity.key, seed),
  },
  {
    key: 'duration',
    label: 'Duration',
    rank: entity => entity.durationMs,
  },
];

export const DEFAULT_ORDER_KEY: SongOrderKey = 'date';

export function orderByKey(key: string): SongOrder {
  return (
    SONG_ORDERS.find(order => order.key === key) ??
    SONG_ORDERS[0]
  );
}

/**
 * One group's members, in the order they should be seated.
 *
 * Ties break on the entity key so the result is total: two songs generated in
 * the same millisecond, or two of exactly the same length, must not swap places
 * between two renders of the same field.
 */
export function orderMembers(
  entityKeys: readonly string[],
  entitiesByKey: ReadonlyMap<string, FieldEntity>,
  order: SongOrder,
  seed: number,
): readonly string[] {
  const ranked = entityKeys.map(key => {
    const entity = entitiesByKey.get(key);
    return {
      key,
      rank: entity === undefined ? 0 : order.rank(entity, seed),
    };
  });
  ranked.sort(
    (left, right) => left.rank - right.rank || left.key.localeCompare(right.key),
  );
  return ranked.map(entry => entry.key);
}

/** A stable number per (song, seed): FNV-1a over the key, mixed with the seed. */
function shuffleRank(entityKey: string, seed: number): number {
  let hash = 0x811c9dc5 ^ (seed >>> 0);
  for (let index = 0; index < entityKey.length; index += 1) {
    hash ^= entityKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 4294967296;
}

/* eslint-enable no-bitwise */

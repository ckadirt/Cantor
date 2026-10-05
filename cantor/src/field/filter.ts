import { fold, plainTagsOf } from '../playlists/playlists';
import type { FieldEntity } from './types';

/**
 * The tag filter: which songs are on the map at all.
 *
 * A filtered song is taken out of the entities before `layoutField`, not
 * dimmed in place, so the map re-packs around what is left. Nothing is
 * deleted; clearing the filter brings every song back where the axis seats it.
 *
 * Only plain tags filter. A playlist (`p/`) is already a grouping, with an
 * axis of its own, and a filter over it would be a second way to say the same
 * thing.
 */
export type TagFilter = Readonly<{
  /** Display spellings; compared case-insensitively, the way tags are. */
  tags: readonly string[];
  /**
   * `any`: a song with one of the tags stays. `all`: it needs every one. The
   * two only differ from the second tag on.
   */
  mode: 'any' | 'all';
}>;

export const EMPTY_FILTER: TagFilter = { tags: [], mode: 'any' };

export function filterIsEmpty(filter: TagFilter): boolean {
  return filter.tags.length === 0;
}

/**
 * The entities a filter leaves on the map.
 *
 * An empty filter returns the same array, not a copy: the layout is memoised
 * on it and the camera's re-cut is decided by comparing layouts, so a copy on
 * every render would be a re-cut on every render.
 */
export function applyTagFilter(
  entities: readonly FieldEntity[],
  filter: TagFilter,
): readonly FieldEntity[] {
  if (filterIsEmpty(filter)) return entities;
  const wanted = [...new Set(filter.tags.map(fold))];
  return entities.filter(entity => {
    const own = new Set(plainTagsOf(entity.tags).map(fold));
    return filter.mode === 'all'
      ? wanted.every(tag => own.has(tag))
      : wanted.some(tag => own.has(tag));
  });
}

export type TagCount = Readonly<{ tag: string; count: number }>;

/**
 * Every plain tag with how many songs carry it, in `allTags` order.
 *
 * Counted over the whole library, never the filtered one: a tag the filter
 * has emptied the map of is still a tag you can choose, and it must not vanish
 * from the list that would bring it back.
 */
export function tagCounts(entities: readonly FieldEntity[]): readonly TagCount[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const entity of entities) {
    if (entity.kind !== 'song') continue;
    const seen = new Set<string>();
    for (const name of plainTagsOf(entity.tags)) {
      const key = fold(name);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      const count = counts.get(key);
      if (count === undefined) counts.set(key, { tag: name.trim(), count: 1 });
      else count.count += 1;
    }
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, count]) => count);
}

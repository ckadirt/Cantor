import type { FieldLayout, Placement } from '../field';

/**
 * Find: type, and get the songs that match laid out the way the field is cut.
 *
 * Find never changes the map. It reads the layout the field already drew —
 * which is the filtered one, so every result is a place you can actually go —
 * and answers in its order: groups as the axis seats them, rows as the shelf's
 * ORDER seats them. A person who knows where a song sits on the map finds it in
 * the same place in the list.
 *
 * The cost is split on purpose. Folding a song's text is the expensive part
 * and happens once per library change (`buildFindIndex`); a keystroke only
 * compares folded words (`findIn`).
 */

/** Each song's folded words, by entity key. Songs absent here never match. */
export type FindIndex = ReadonlyMap<string, readonly string[]>;

/** Where to look: the whole field, or one group's shelf. */
export type FindScope = Readonly<{ groupKey: string }> | null;

export type FindGroup = Readonly<{
  groupKey: string;
  label: string;
  placements: readonly Placement[];
}>;

export type FindResult = Readonly<{
  groups: readonly FindGroup[];
  /** Rows across `groups`. */
  count: number;
  /**
   * Matches the scope left out: what widening it would add. Always zero for
   * the whole field.
   */
  outside: number;
}>;

const NOTHING: FindResult = { groups: [], count: 0, outside: 0 };

const WORD = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}/gu;

/**
 * Lower case without accents, split into words: `Café del Mar` is `cafe`,
 * `del`, `mar`. Typing on a phone keyboard drops accents more often than it
 * adds them, so neither side keeps them.
 */
export function foldWords(text: string): readonly string[] {
  return (
    text.normalize('NFD').replace(MARKS, '').toLocaleLowerCase().match(WORD) ??
    []
  );
}

/** Fold every song's searchable text once; blank parts are skipped. */
export function buildFindIndex(
  songs: Iterable<readonly [string, readonly (string | null | undefined)[]]>,
): FindIndex {
  const index = new Map<string, readonly string[]>();
  for (const [entityKey, texts] of songs) {
    const words = new Set<string>();
    for (const text of texts) {
      if (text === null || text === undefined) continue;
      for (const word of foldWords(text)) words.add(word);
    }
    index.set(entityKey, [...words]);
  }
  return index;
}

/**
 * Every query word begins one of the song's words: `love` finds *Lovely* and
 * not *Glove*. Word starts rather than substrings, because a person types the
 * front of what they remember, and inside-word hits on a short query are
 * nearly every song.
 */
export function wordsMatch(
  words: readonly string[],
  query: readonly string[],
): boolean {
  return query.every(part => words.some(word => word.startsWith(part)));
}

/**
 * The matches for `query`, grouped and ordered the way `layout` is.
 *
 * `layoutField` emits placements group by group, in seat order, so one pass
 * over them is already in the order the list wants. On the playlist axis a
 * song sits in several groups and each copy is kept: each is a different
 * shelf, and so a different place to arrive.
 */
export function findIn(
  layout: FieldLayout,
  index: FindIndex,
  query: string,
  scope: FindScope,
): FindResult {
  const parts = foldWords(query);
  if (parts.length === 0) return NOTHING;
  const labels = new Map(layout.groups.map(group => [group.key, group.label]));
  const matched = new Map<string, boolean>();
  const groups: { groupKey: string; label: string; placements: Placement[] }[] =
    [];
  let count = 0;
  let outside = 0;
  for (const placement of layout.placements) {
    let hit = matched.get(placement.entityKey);
    if (hit === undefined) {
      const words = index.get(placement.entityKey);
      hit = words !== undefined && wordsMatch(words, parts);
      matched.set(placement.entityKey, hit);
    }
    if (!hit) continue;
    if (scope !== null && placement.groupKey !== scope.groupKey) {
      outside += 1;
      continue;
    }
    const last = groups[groups.length - 1];
    if (last !== undefined && last.groupKey === placement.groupKey) {
      last.placements.push(placement);
    } else {
      groups.push({
        groupKey: placement.groupKey,
        label: labels.get(placement.groupKey) ?? placement.groupKey,
        placements: [placement],
      });
    }
    count += 1;
  }
  return { groups, count, outside };
}

/** A stretch of a name to draw in ink: `[start, end)` in UTF-16 units. */
export type MatchRange = Readonly<{ start: number; end: number }>;

const RAW_WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/**
 * Where in `text` the query's words begin a word, for drawing the matched
 * starts in ink and the rest in grey: `love` in *Lovely Rain* is `Love`.
 *
 * Measured on the original text, not the folded one — folding changes
 * lengths (`é` is two units decomposed) — by folding the word one character
 * at a time until the query word is covered.
 */
export function matchRanges(text: string, query: string): readonly MatchRange[] {
  const parts = foldWords(query);
  if (parts.length === 0) return [];
  const ranges: MatchRange[] = [];
  for (const found of text.matchAll(RAW_WORD)) {
    const word = found[0];
    const start = found.index ?? 0;
    const folded = foldWords(word).join('');
    const part = parts
      .filter(each => folded.startsWith(each))
      .reduce((longest, each) => (each.length > longest.length ? each : longest), '');
    if (part.length === 0) continue;
    let covered = 0;
    let end = start;
    for (const character of word) {
      if (covered >= part.length) break;
      covered += foldWords(character).join('').length;
      end += character.length;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

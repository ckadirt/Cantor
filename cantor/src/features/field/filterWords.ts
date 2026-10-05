import type { TagFilter } from '../../field';

/**
 * How the field says its filter: on the count line (`RAINY OR LIVE`), and in
 * the sentence the map shows when the filter leaves nothing.
 */

/** KNOB — the most tags the count line names before it says `N MORE`. */
export const FILTER_WORDS_KNOBS = {
  NAMED_TAGS: 1,
  /** Up to this many the line names them all: `RAINY OR LIVE`. */
  ALL_NAMED_UP_TO: 2,
} as const;

/** One press target inside the phrase, as character offsets into it. */
export type PhraseSegment = Readonly<{
  start: number;
  end: number;
  /** A tag word or `N MORE` opens the tags; the conjunction flips the mode. */
  kind: 'tag' | 'join' | 'more';
}>;

export type FilterPhrase = Readonly<{
  text: string;
  segments: readonly PhraseSegment[];
}>;

const NO_PHRASE: FilterPhrase = { text: '', segments: [] };

function conjunction(filter: TagFilter): string {
  return filter.mode === 'all' ? 'AND' : 'OR';
}

/**
 * `RAINY`, `RAINY OR LIVE`, `RAINY AND 2 MORE`: the filter as the count line
 * says it, and where in that line each press target lies.
 *
 * `fits` is the row's say: when the names do not fit, the line names fewer —
 * `ULTRAFAV OR 1 MORE`, then `ULTR… OR 1 MORE` — rather than running off the
 * screen. The conjunction is never what gives way: it is the only door to the
 * mode. `2 TAGS` is the last resort, for a row with no room for it either.
 */
export function filterPhrase(
  filter: TagFilter,
  fits: (text: string) => boolean = () => true,
): FilterPhrase {
  const tags = filter.tags.map(tag => tag.trim().toLocaleUpperCase());
  if (tags.length === 0) return NO_PHRASE;
  const first = phraseNaming(
    filter,
    tags,
    tags.length <= FILTER_WORDS_KNOBS.ALL_NAMED_UP_TO
      ? tags.length
      : FILTER_WORDS_KNOBS.NAMED_TAGS,
  );
  if (fits(first.text)) return first;
  if (tags.length > 1) {
    const fewer = phraseNaming(filter, tags, 1);
    if (fits(fewer.text)) return fewer;
    const letters = [...tags[0]];
    for (let keep = letters.length - 1; keep > 0; keep -= 1) {
      const cut = `${letters.slice(0, keep).join('').trimEnd()}…`;
      const shorter = phraseNaming(filter, [cut, ...tags.slice(1)], 1);
      if (fits(shorter.text)) return shorter;
    }
  }
  const count = `${tags.length} ${tags.length === 1 ? 'TAG' : 'TAGS'}`;
  return {
    text: count,
    segments: [{ start: 0, end: count.length, kind: 'more' }],
  };
}

function phraseNaming(
  filter: TagFilter,
  tags: readonly string[],
  namedCount: number,
): FilterPhrase {
  const named = tags.slice(0, namedCount);
  const rest = tags.length - named.length;
  const words: { word: string; kind: PhraseSegment['kind'] }[] = [];
  named.forEach((tag, index) => {
    if (index > 0) words.push({ word: conjunction(filter), kind: 'join' });
    words.push({ word: tag, kind: 'tag' });
  });
  if (rest > 0) {
    words.push({ word: conjunction(filter), kind: 'join' });
    words.push({ word: `${rest} MORE`, kind: 'more' });
  }
  const segments: PhraseSegment[] = [];
  let text = '';
  for (const { word, kind } of words) {
    if (text.length > 0) text += ' ';
    segments.push({ start: text.length, end: text.length + word.length, kind });
    text += word;
  }
  return { text, segments };
}

/**
 * The map's sentence when the filter has left it empty: *No songs are rainy
 * and live*. The tags are said as the person chose them, joined the way the
 * filter joins them.
 */
export function emptyFilterSentence(filter: TagFilter): string {
  const tags = filter.tags.map(tag => tag.trim());
  const join = filter.mode === 'all' ? 'and' : 'or';
  if (tags.length === 0) return 'No songs match.';
  if (tags.length === 1) return `No songs are ${tags[0]}.`;
  return `No songs are ${tags.slice(0, -1).join(', ')} ${join} ${
    tags[tags.length - 1]
  }.`;
}

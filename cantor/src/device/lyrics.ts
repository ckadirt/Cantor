import { nativeMedia } from './native';

/**
 * The words of a song on this phone, for a version that keeps them.
 *
 * A version sung against `[Instrumental]` or no words garbles the kept voice;
 * the same render against the song's real words sings them (audio prompting,
 * A0). So: the file's own tags first, which never leave the phone, then
 * LRCLIB, which learns the song's title, artist and length. Asked only when a
 * version of that one song is opened, never for the library.
 *
 * Never throws: a song whose words cannot be found opens as instrumental.
 */
export const LYRICS_KNOBS = {
  LRCLIB_SEARCH: 'https://lrclib.net/api/search',
  /** LRCLIB asks every client to name itself. */
  USER_AGENT: 'Cantor (https://github.com/ckadirt/Cantor)',
  /** A hit this far from the file's length, in seconds, is another cut. */
  DURATION_SLACK_S: 3,
  TIMEOUT_MS: 8000,
} as const;

export type LyricsQuery = Readonly<{
  path: string;
  title: string;
  /** False when `title` is the file's name: nothing to search by. */
  titleFromTag: boolean;
  artist: string | null;
  album: string | null;
  durationMs: number;
}>;

export type LyricsSources = Readonly<{
  tags: (path: string) => Promise<string | null>;
  fetch: typeof fetch;
}>;

const DEFAULT_SOURCES: LyricsSources = {
  tags: path => nativeMedia.lyrics(path),
  fetch: (...args) => fetch(...args),
};

export async function lyricsFor(
  song: LyricsQuery,
  sources: LyricsSources = DEFAULT_SOURCES,
): Promise<string | null> {
  const tagged = await sources.tags(song.path).catch(() => null);
  const fromTags = tagged === null ? null : cleanLyrics(tagged);
  if (fromTags !== null) return fromTags;
  if (!song.titleFromTag || song.artist === null) return null;
  return lookUp(song, sources.fetch).catch(() => null);
}

/**
 * Words as a model reads them: an LRC file's timestamps and header tags
 * gone, lines trimmed, at most one blank line between stanzas. Null when
 * nothing is left, or it only says it is instrumental.
 */
export function cleanLyrics(text: string): string | null {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => !LRC_HEADER.test(line.trim()))
    .map(line =>
      line.replace(LRC_STAMPS, '').replace(LRC_WORD_STAMP, '').trim(),
    );
  const words = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (words.length === 0 || /^\[?instrumental\]?$/i.test(words)) return null;
  return words;
}

const LRC_HEADER = /^\[(ar|ti|al|au|by|offset|length|re|ve|tool|#):[^\]]*\]$/i;
const LRC_STAMPS = /^(\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/;
const LRC_WORD_STAMP = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g;

type LrclibHit = {
  duration?: unknown;
  instrumental?: unknown;
  plainLyrics?: unknown;
  syncedLyrics?: unknown;
};

async function lookUp(
  song: LyricsQuery,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const seconds = song.durationMs / 1000;
  for (const { title, artist } of searchesFor(song)) {
    const hits = await search(fetchFn, title, artist);
    const best = hits
      .filter(hit => typeof hit.duration === 'number')
      .map(hit => ({ hit, off: Math.abs((hit.duration as number) - seconds) }))
      .filter(({ off }) => off <= LYRICS_KNOBS.DURATION_SLACK_S)
      .sort((a, b) => a.off - b.off)
      .map(({ hit }) => hit)
      .find(hit => hit.instrumental !== true && wordsOf(hit) !== null);
    if (best !== undefined) return wordsOf(best);
  }
  return null;
}

function wordsOf(hit: LrclibHit): string | null {
  const text =
    typeof hit.plainLyrics === 'string' && hit.plainLyrics.trim() !== ''
      ? hit.plainLyrics
      : typeof hit.syncedLyrics === 'string'
      ? hit.syncedLyrics
      : '';
  return cleanLyrics(text);
}

/**
 * The tags as written, then with the featured artists and `(feat. …)` gone:
 * `Haven., Kaitlin Aragon` and `It’s Only (feat. Zyra)` are how a library
 * spells what LRCLIB files as one artist and a bare title.
 */
export function searchesFor(
  song: Pick<LyricsQuery, 'title' | 'artist'>,
): { title: string; artist: string }[] {
  const artist = song.artist ?? '';
  const bare = {
    title: song.title
      .replace(/\s*[([](?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]/gi, '')
      .replace(/[‘’]/g, "'")
      .trim(),
    artist: artist.split(/\s*(?:;|,|\/|&|\bfeat\.?\s|\bft\.?\s)\s*/i)[0]!.trim(),
  };
  const asWritten = { title: song.title.trim(), artist: artist.trim() };
  return bare.title === asWritten.title && bare.artist === asWritten.artist
    ? [asWritten]
    : [asWritten, bare];
}

async function search(
  fetchFn: typeof fetch,
  title: string,
  artist: string,
): Promise<LrclibHit[]> {
  const query = `track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LYRICS_KNOBS.TIMEOUT_MS);
  try {
    const response = await fetchFn(`${LYRICS_KNOBS.LRCLIB_SEARCH}?${query}`, {
      headers: { 'User-Agent': LYRICS_KNOBS.USER_AGENT },
      signal: abort.signal,
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    return Array.isArray(body)
      ? body.filter(
          (hit): hit is LrclibHit => typeof hit === 'object' && hit !== null,
        )
      : [];
  } finally {
    clearTimeout(timer);
  }
}

import type { DeviceSubject, Lookup } from '../facts/types';

/**
 * Where an imported song's words can come from: its file's own tags, and
 * LRCLIB. The adapters behind the `file-tags` and `lrclib` fact providers
 * (`src/facts/`), which decide the order and remember the answer.
 *
 * A version sung against `[Instrumental]` or no words garbles the kept voice;
 * the same render against the song's real words sings them (audio prompting,
 * A0). The tags never leave the phone; LRCLIB learns a title, an artist and a
 * length. Both say `none` only when they were asked and had nothing, and
 * LRCLIB says `unreachable` when it could not be asked.
 */
export const LYRICS_KNOBS = {
  LRCLIB_SEARCH: 'https://lrclib.net/api/search',
  /** LRCLIB asks every client to name itself. */
  USER_AGENT: 'Cantor (https://github.com/ckadirt/Cantor)',
  /** A hit this far from the file's length, in seconds, is another cut. */
  DURATION_SLACK_S: 3,
  TIMEOUT_MS: 8000,
} as const;

export type LyricsQuery = Pick<
  DeviceSubject,
  'title' | 'titleFromTag' | 'artist' | 'album' | 'durationMs'
>;

/** The file's embedded words (`EmbeddedLyrics.kt`). A file that cannot be read has none. */
export async function tagLyrics(
  path: string,
  read: (path: string) => Promise<string | null>,
): Promise<Lookup> {
  const tagged = await read(path).catch(() => null);
  const words = tagged === null ? null : cleanLyrics(tagged);
  return words === null ? { status: 'none' } : { status: 'found', value: words };
}

/**
 * LRCLIB's words for the song, matched by length. A song without a title
 * tag or an artist is not searched: a file name finds someone else's song.
 */
export async function lrclibLyrics(
  song: LyricsQuery,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Lookup> {
  if (!song.titleFromTag || song.artist === null) return { status: 'none' };
  const seconds = song.durationMs / 1000;
  let unreachable: Extract<Lookup, { status: 'unreachable' }> | null = null;
  for (const { title, artist } of searchesFor(song)) {
    const answer = await search(fetchFn, title, artist, signal);
    if (answer.status === 'unreachable') {
      unreachable = laterOf(unreachable, answer);
      continue;
    }
    const best = answer.hits
      .filter(hit => typeof hit.duration === 'number')
      .map(hit => ({ hit, off: Math.abs((hit.duration as number) - seconds) }))
      .filter(({ off }) => off <= LYRICS_KNOBS.DURATION_SLACK_S)
      .sort((a, b) => a.off - b.off)
      .map(({ hit }) => hit)
      .find(hit => hit.instrumental !== true && wordsOf(hit) !== null);
    if (best !== undefined) return { status: 'found', value: wordsOf(best)! };
  }
  return unreachable ?? { status: 'none' };
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

type SearchAnswer =
  | Readonly<{ status: 'answered'; hits: LrclibHit[] }>
  | Extract<Lookup, { status: 'unreachable' }>;

/**
 * One search. A 404 or a request LRCLIB refuses is an answer with no hits; a
 * timeout, no network, a 429 or a 5xx is unreachable, with LRCLIB's
 * `Retry-After` when it sends one.
 */
async function search(
  fetchFn: typeof fetch,
  title: string,
  artist: string,
  signal?: AbortSignal,
): Promise<SearchAnswer> {
  const query = `track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LYRICS_KNOBS.TIMEOUT_MS);
  const stop = () => abort.abort();
  signal?.addEventListener('abort', stop);
  try {
    const response = await fetchFn(`${LYRICS_KNOBS.LRCLIB_SEARCH}?${query}`, {
      headers: { 'User-Agent': LYRICS_KNOBS.USER_AGENT },
      signal: abort.signal,
    });
    if (response.status === 429 || response.status >= 500) {
      const retryAfterMs = retryAfter(response.headers?.get('Retry-After'));
      return retryAfterMs === undefined
        ? { status: 'unreachable' }
        : { status: 'unreachable', retryAfterMs };
    }
    if (!response.ok) return { status: 'answered', hits: [] };
    const body: unknown = await response.json();
    return {
      status: 'answered',
      hits: Array.isArray(body)
        ? body.filter(
            (hit): hit is LrclibHit => typeof hit === 'object' && hit !== null,
          )
        : [],
    };
  } catch {
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds from now. */
export function retryAfter(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

function laterOf(
  left: Extract<Lookup, { status: 'unreachable' }> | null,
  right: Extract<Lookup, { status: 'unreachable' }>,
): Extract<Lookup, { status: 'unreachable' }> {
  if (left === null) return right;
  return (right.retryAfterMs ?? 0) > (left.retryAfterMs ?? 0) ? right : left;
}

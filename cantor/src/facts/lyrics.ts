import { lrclibLyrics, tagLyrics } from '../device/lyrics';
import { wordsOf } from './recipeWords';
import type { FactProvider } from './types';

/**
 * Where a song's words come from, in the order they are asked (plan D12c):
 * the song's own recipe, its file's tags, then LRCLIB. Each answers only for
 * the songs it knows: a made song has a recipe and no file, an imported one a
 * file and no recipe. A self-hosted LRCLIB, or transcription on a node, is one
 * more entry here.
 */
export function lyricsProviders(deps: {
  readTags: (path: string) => Promise<string | null>;
  fetch: typeof fetch;
}): readonly FactProvider[] {
  return [
    {
      source: 'recipe',
      lookup: async subject => {
        if (subject.kind !== 'node') return { status: 'none' };
        const detail = await subject.detail().catch(() => null);
        if (detail === null) return { status: 'unreachable' };
        const { words } = wordsOf(detail, subject.instrumentalLyrics);
        return words === null
          ? { status: 'none' }
          : { status: 'found', value: words };
      },
    },
    {
      source: 'file-tags',
      lookup: subject =>
        subject.kind === 'device'
          ? tagLyrics(subject.path, deps.readTags)
          : Promise.resolve({ status: 'none' }),
    },
    {
      source: 'lrclib',
      lookup: (subject, signal) =>
        subject.kind === 'device'
          ? lrclibLyrics(subject, deps.fetch, signal)
          : Promise.resolve({ status: 'none' }),
    },
  ];
}

import type { ModelView } from '../../../../protocol/ModelView';

export type LyricsContract = Readonly<{
  writerLabel: string | null;
  instrumentalLyrics?: string;
}>;

/**
 * Compatibility adapter for the installed engine's existing lyrics input.
 *
 * ACE's request parser accepts [Instrumental]; its PLAN stage fills empty
 * lyrics and preserves supplied lyrics (acestep.cpp request.cpp / pipeline-lm.cpp).
 * No write_lyrics boolean exists in that ABI. The engine identity and declared
 * PLAN stage establish this path, not the model's display name or selector.
 * Keep this translation here until nodes advertise lyric capabilities directly.
 * Unknown engines receive no invented capability or sentinel.
 */
export function lyricsContractFor(
  model: ModelView | undefined,
): LyricsContract {
  if (model?.engine === 'acestep') {
    return {
      writerLabel: model.stages?.includes('plan') ? "ACESTEP'S" : null,
      instrumentalLyrics: '[Instrumental]',
    };
  }
  return { writerLabel: null };
}

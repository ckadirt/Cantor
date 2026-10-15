import type { SongDetail } from '../../../../protocol/SongDetail';

export type SongWords = Readonly<{
  /** The words sung, or null: the model's instrumental marker is not words. */
  words: string | null;
  /**
   * The model wrote them: the recipe asked for no words of its own. A song
   * made before its node kept written words has none to show.
   */
  written: boolean;
}>;

/**
 * What a song sings, from its detail. Given words win; a recipe made from
 * words that sent none asked the model to write them, and the node keeps what
 * it wrote (`written_lyrics`). A version or a hum sends its words or the
 * instrumental marker, so a missing field there is no words, not the model's.
 */
export function wordsOf(
  detail: SongDetail | null | undefined,
  instrumentalLyrics: string | undefined,
): SongWords {
  const given = detail?.generation.lyrics;
  const written =
    detail !== null &&
    detail !== undefined &&
    given === undefined &&
    detail.generation.audio === undefined;
  const lyrics = (written ? detail.written_lyrics : given)?.trim();
  return {
    words:
      lyrics === undefined || lyrics === '' || lyrics === instrumentalLyrics
        ? null
        : lyrics,
    written,
  };
}

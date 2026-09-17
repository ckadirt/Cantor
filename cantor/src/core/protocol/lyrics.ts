import type { LyricsCapabilities } from '../../../../protocol/LyricsCapabilities';
import { isRecord } from '../validation';
import type { ModelView } from '../../../../protocol/ModelView';

export type LyricsContract = Readonly<{
  writerLabel: string | null;
  instrumentalLyrics?: string;
  requiresLyrics?: boolean;
}>;

/** Prefer model capabilities; retain the established ACE fallback for older nodes. */
export function lyricsContractFor(
  model: ModelView | undefined,
): LyricsContract {
  if (model?.lyrics) {
    return {
      writerLabel: model.lyrics.can_generate
        ? model.lyrics.writer_label ?? "MODEL'S"
        : null,
      requiresLyrics: model.lyrics.requires_lyrics,
      instrumentalLyrics: model.lyrics.instrumental_text,
    };
  }
  // Older nodes did not advertise capabilities. Preserve their established
  // ACE behavior; advertised capabilities always take precedence.
  if (model?.engine === 'acestep') {
    return {
      writerLabel: model.stages?.includes('plan') ? "ACESTEP'S" : null,
      instrumentalLyrics: '[Instrumental]',
    };
  }
  return { writerLabel: null };
}

export function parseLyricsCapabilities(
  value: unknown,
): LyricsCapabilities | undefined {
  if (
    !isRecord(value) ||
    typeof value.can_generate !== 'boolean' ||
    typeof value.requires_lyrics !== 'boolean'
  )
    return undefined;
  if (
    value.instrumental_text !== undefined &&
    typeof value.instrumental_text !== 'string'
  )
    return undefined;
  if (
    value.writer_label !== undefined &&
    typeof value.writer_label !== 'string'
  )
    return undefined;
  return {
    can_generate: value.can_generate,
    requires_lyrics: value.requires_lyrics,
    ...(typeof value.instrumental_text === 'string'
      ? { instrumental_text: value.instrumental_text }
      : {}),
    ...(typeof value.writer_label === 'string'
      ? { writer_label: value.writer_label }
      : {}),
  };
}

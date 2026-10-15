import { parseSongDetail } from '../../../core/protocol';
import type { SongDetail } from '../../../../../protocol/SongDetail';
import { wordsOf } from '../songWords';

const detail = (extra: Partial<SongDetail> = {}, lyrics?: string): SongDetail => ({
  song: {
    id: 'song-1',
    title: 'Lanterns',
    caption_summary: 'a slow harbour',
    duration_ms: 60_000,
    model: 'acestep@1.5-turbo',
    seed: 7,
    favorite: false,
    tags: [],
    created_at: '2026-10-14T00:00:00Z',
    revision: 1,
    trashed: false,
    artifacts: [],
  },
  generation: {
    caption: 'a slow harbour',
    ...(lyrics === undefined ? {} : { lyrics }),
  },
  engine: 'acestep',
  component_digests: [],
  attempts: 1,
  ...extra,
});

describe('wordsOf', () => {
  it('reads given words, and never the written ones beside them', () => {
    expect(wordsOf(detail({ written_lyrics: 'other' }, ' mine '), '[Instrumental]')).toEqual({
      words: 'mine',
      written: false,
    });
  });

  it('reads the words the model wrote when the recipe gave none', () => {
    expect(wordsOf(detail({ written_lyrics: '[verse]\nwritten\n' }), '[Instrumental]')).toEqual({
      words: '[verse]\nwritten',
      written: true,
    });
  });

  it('knows a song whose written words were not kept', () => {
    expect(wordsOf(detail(), '[Instrumental]')).toEqual({ words: null, written: true });
  });

  it('reads the instrumental marker as no words, given or written', () => {
    expect(wordsOf(detail({}, '[Instrumental]'), '[Instrumental]')).toEqual({
      words: null,
      written: false,
    });
    expect(
      wordsOf(detail({ written_lyrics: '[Instrumental]' }), '[Instrumental]').words,
    ).toBeNull();
  });

  it('never calls a version without words the model’s', () => {
    const version = detail();
    const withAudio = {
      ...version,
      generation: {
        ...version.generation,
        audio: { source: { kind: 'song', song_id: 's' }, act: 'cover' },
      },
    } as SongDetail;
    expect(wordsOf(withAudio, '[Instrumental]')).toEqual({ words: null, written: false });
  });

  it('is nothing before the detail arrives', () => {
    expect(wordsOf(null, undefined)).toEqual({ words: null, written: false });
  });
});

describe('parseSongDetail written_lyrics', () => {
  const wire = (extra: Record<string, unknown>) => ({
    song: detail().song,
    generation: { caption: 'a slow harbour' },
    engine: 'acestep',
    component_digests: [],
    attempts: 1,
    ...extra,
  });

  it('keeps them when present and is unchanged when absent', () => {
    expect(parseSongDetail(wire({ written_lyrics: 'words' }))?.written_lyrics).toBe('words');
    const old = parseSongDetail(wire({}));
    expect(old).not.toBeNull();
    expect(old).not.toHaveProperty('written_lyrics');
  });

  it('refuses them when they are not text', () => {
    expect(parseSongDetail(wire({ written_lyrics: 3 }))).toBeNull();
  });
});

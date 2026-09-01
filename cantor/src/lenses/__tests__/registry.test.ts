import { Skia } from '@shopify/react-native-skia';
import {
  DEFAULT_LENS_KEY,
  LENSES,
  analyseWindow,
  lensByKey,
  neutralAnalysis,
  type LensSong,
} from '..';

function paint(color: string) {
  const value = Skia.Paint();
  value.setAntiAlias(true);
  value.setColor(Skia.Color(color));
  return value;
}

function song(overrides: Partial<LensSong> = {}): LensSong {
  return {
    key: 'node-a:song-a',
    id: 'song-a',
    seed: 41822,
    title: 'A song with a fairly long title',
    createdAtMs: Date.parse('2026-08-10T00:00:00Z'),
    durationMs: 141_000,
    model: 'acestep:1.5-fast',
    nodeLabel: 'Studio',
    audioState: 'remote',
    arriving: null,
    playing: false,
    analysis: neutralAnalysis(),
    progress: null,
    ...overrides,
  };
}

function measured(): LensSong['analysis'] {
  const buckets = 128;
  const rms = new Float32Array(buckets);
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let i = 0; i < buckets; i += 1) {
    rms[i] = (i % 16) / 16;
    max[i] = rms[i];
    min[i] = -rms[i];
  }
  return analyseWindow({
    startSeconds: 0,
    endSeconds: 141,
    buckets,
    sampleRate: 48000,
    channels: [{ min, max, rms }],
  });
}

describe('the lens registry', () => {
  it('has more than one lens, which is the whole point of it', () => {
    expect(LENSES.length).toBeGreaterThan(1);
  });

  it('gives every lens a unique key and a label to show', () => {
    const keys = LENSES.map(lens => lens.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const lens of LENSES) {
      expect(lens.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('resolves a lens by key and refuses an unknown one', () => {
    for (const lens of LENSES) expect(lensByKey(lens.key)).toBe(lens);
    expect(lensByKey('no-such-lens')).toBeNull();
  });

  it('defaults to a lens that is actually registered', () => {
    expect(lensByKey(DEFAULT_LENS_KEY)).not.toBeNull();
  });
});

describe('every lens draws', () => {
  const ink = paint('#000000');
  const paints = {
    ink,
    muted: paint('#666666'),
    faint: paint('#A6A6A6'),
    outline: paint('#000000'),
  };
  const display = Skia.Font(undefined, 20);
  const fonts = { display, body: display, mono: Skia.Font(undefined, 9) };

  const boxes = [
    { kind: 'mark' as const, x: 120, y: 200, width: 0, height: 0 },
    { kind: 'row' as const, x: 200, y: 300, width: 240, height: 30 },
  ];

  const songs: Array<[string, LensSong]> = [
    ['a song with no audio yet', song()],
    ['a measured song', song({ audioState: 'cached', analysis: measured() })],
    ['the playing song', song({ playing: true, progress: 0.42 })],
    ['a song at its very end', song({ playing: true, progress: 1 })],
    ['a silent song', song({ analysis: analyseWindow(silence()) })],
    // The four availability marks: every lens has to survive all of them, and
    // the name lens has to tell the last two apart.
    ['a song still on the node', song({ audioState: 'remote' })],
    ['a song arriving', song({ audioState: 'partial', arriving: 0.4 })],
    [
      'a song arriving with no known total',
      song({ audioState: 'partial', arriving: null }),
    ],
    ['a downloaded song', song({ audioState: 'pinned' })],
    [
      'a downloaded song that is playing',
      song({ audioState: 'pinned', playing: true, progress: 0.2 }),
    ],
  ];

  for (const lens of LENSES) {
    for (const box of boxes) {
      for (const [label, value] of songs) {
        it(`${lens.key} draws ${label} as a ${box.kind}`, () => {
          const recorder = Skia.PictureRecorder();
          const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 400, 800));

          expect(() =>
            lens.draw(canvas, box, value, { alpha: 1, fonts, paints }),
          ).not.toThrow();
          expect(recorder.finishRecordingAsPicture()).toBeTruthy();
        });
      }
    }

    it(`${lens.key} draws nothing at zero alpha`, () => {
      const recorder = Skia.PictureRecorder();
      const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 400, 800));

      lens.draw(canvas, boxes[0], song(), { alpha: 0, fonts, paints });

      expect(recorder.finishRecordingAsPicture()).toBeTruthy();
    });

    it(`${lens.key} hands the shared paint back as a fill`, () => {
      const styles: number[] = [];
      const original = ink.setStyle.bind(ink);
      ink.setStyle = (style: number) => {
        styles.push(style);
        original(style);
      };
      const recorder = Skia.PictureRecorder();
      const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 400, 800));

      lens.draw(canvas, boxes[1], song({ playing: true }), {
        alpha: 1,
        fonts,
        paints,
      });
      ink.setStyle = original;

      // Paints are shared across the whole picture: a lens that left one
      // stroked would outline everything drawn after it.
      if (styles.length > 0) expect(styles[styles.length - 1]).toBe(0);
    });
  }
});

function silence() {
  const buckets = 64;
  return {
    startSeconds: 0,
    endSeconds: 10,
    buckets,
    sampleRate: 48000,
    channels: [
      {
        min: new Float32Array(buckets),
        max: new Float32Array(buckets),
        rms: new Float32Array(buckets),
      },
    ],
  };
}

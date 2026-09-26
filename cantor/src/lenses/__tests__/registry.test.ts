import { PaintStyle, Skia } from '@shopify/react-native-skia';
import {
  ARRIVING_NONE,
  ARRIVING_UNKNOWN,
  DEFAULT_LENS_KEY,
  LENSES,
  analyseWindow,
  lensByKey,
  type LensSong,
} from '..';

function paint(color: string) {
  const value = Skia.Paint();
  value.setAntiAlias(true);
  value.setColor(Skia.Color(color));
  return value;
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

/**
 * Every lens draws every state a song can be in, through the contract the
 * renderer calls — marks and players, unmeasured, measured and silent, at
 * every ink — and hands the shared paints back as it found them. What each
 * draws is pinned by `features/field/__tests__/lensGoldens.test.ts`.
 */
describe('every lens draws', () => {
  const recipe = {
    seed: 41822,
    id: 'song-a',
    model: 'acestep:1.5-fast',
    durationMs: 141_000,
  };
  const analyses: Array<[string, LensSong['analysis'] | undefined]> = [
    ['unmeasured', undefined],
    ['measured', measured()],
    ['silent', analyseWindow(silence())],
  ];
  const inks: Array<[string, number, number, number]> = [
    ['on the node', 0.38, 0, ARRIVING_NONE],
    ['cached', 0.85, 0, ARRIVING_NONE],
    ['downloaded', 1, 1, ARRIVING_NONE],
    ['filling in', 0.6, 0.5, ARRIVING_NONE],
    ['arriving', 0.38, 0, 0.4],
    ['arriving at an unknown size', 0.38, 0, ARRIVING_UNKNOWN],
  ];

  function paints() {
    const stroke = paint('#000000');
    stroke.setStyle(PaintStyle.Stroke);
    return { fill: paint('#000000'), stroke, paper: paint('#FFFFFF') };
  }

  for (const lens of LENSES) {
    for (const [soundLabel, analysis] of analyses) {
      for (const [inkLabel, weight, fill, arriving] of inks) {
        it(`${lens.key} draws a ${soundLabel} song ${inkLabel}`, () => {
          const shared = paints();
          const restyled = [
            jest.spyOn(shared.fill, 'setStyle'),
            jest.spyOn(shared.stroke, 'setStyle'),
            jest.spyOn(shared.paper, 'setStyle'),
          ];
          const recorder = Skia.PictureRecorder();
          const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 400, 800));
          const identity = lens.identity(recipe);
          const player = lens.player(recipe, analysis);
          expect(() => {
            lens.ui.drawMark(
              canvas,
              identity,
              1.2,
              1,
              weight,
              fill,
              0,
              arriving,
              1,
              shared,
            );
            for (const arrived of [0, 0.5, 1]) {
              lens.ui.drawPlayer(
                canvas,
                player,
                identity,
                12,
                1,
                weight,
                fill,
                arrived,
                arriving,
                1,
                0.4,
                1,
                shared,
              );
            }
          }).not.toThrow();
          expect(recorder.finishRecordingAsPicture()).toBeTruthy();
          // Paints are shared across the whole field: a lens that restyled
          // one would change everything drawn after it.
          for (const spy of restyled) expect(spy).not.toHaveBeenCalled();
        });
      }
    }

    it(`${lens.key} puts down no ink at zero alpha`, () => {
      const surface = Skia.Surface.Make(64, 64)!;
      const canvas = surface.getCanvas();
      canvas.clear(Skia.Color('#FFFFFF'));
      canvas.translate(32, 32);
      lens.ui.drawMark(
        canvas,
        lens.identity(recipe),
        2,
        0,
        1,
        1,
        0,
        ARRIVING_NONE,
        1,
        paints(),
      );
      surface.flush();
      const pixels = surface.makeImageSnapshot().readPixels() as Uint8Array;
      expect(pixels.every(value => value === 255)).toBe(true);
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

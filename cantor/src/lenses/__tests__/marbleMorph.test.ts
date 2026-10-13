import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import type { FaceRecipe } from '../face';
import { drawMarbleMorph, marbleLens } from '../marbleLens';
import { drawMarblePlayer, marbleBakeImage, marbleBakeKey, marblePlayerOf, type MarblePlayer } from '../marblePlayer';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';
import { motionFrameAt } from '../motion/motionFrame';
import { LENS_PAIRS, lensIndex, LENSES } from '../registry';
import { drawSealAsPlayer } from '../sealLens';

declare const require: (name: string) => { writeFileSync: (path: string, data: Uint8Array) => void };
declare const process: { env: Record<string, string | undefined> };

/*
 * Marbling's transitions are ring-by-ring morphs (`marbleMorph.ts`). These pin
 * their ends (each is exactly the drawing it leaves or arrives at), their
 * smoothness (no frame that pops), and write sheets to look at with
 * `MARBLE_SHEET=<dir>`.
 */

const track = trackOf(load('edm-drop'));
const A: FaceRecipe = { seed: 4242, id: 'song-a', model: 'light', durationMs: 262_000 };
const B: FaceRecipe = { seed: 777, id: 'song-b', model: 'light', durationMs: 262_000 };
const a = marblePlayerOf(A, undefined, null, track);
const b = marblePlayerOf(B, undefined, null, track);
const T = 120;
a.baked.value = marbleBakeImage(a, marbleBakeKey(a, T));
b.baked.value = marbleBakeImage(b, marbleBakeKey(b, 30));
const VIEW = 180;
const SIZE = 7.5;
/** Frames per morph in the smoothness checks. */
const STEPS = 16;

function paints() {
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(1);
  const paper = Skia.Paint();
  paper.setColor(Skia.Color('white'));
  return { fill, stroke, paper };
}

const sheets: Record<string, Uint8Array[]> = {};

function raster(draw: (canvas: SkCanvas) => void, sheet?: string): Uint8Array {
  const surface = Skia.Surface.Make(VIEW, VIEW)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  canvas.translate(VIEW / 2, VIEW / 2);
  draw(canvas);
  surface.flush();
  const image = surface.makeImageSnapshot();
  if (sheet !== undefined) (sheets[sheet] ??= []).push(image.encodeToBytes());
  const px = image.readPixels() as Uint8Array;
  image.dispose();
  surface.dispose();
  return px;
}

/**
 * Smooth: no step of the clock changes the frame much more than the steps
 * either side of it. Fine marbled bands moving shift many pixels, so the size
 * of a step says little; a pop is a step that stands alone.
 */
function expectNoPop(steps: number[]): void {
  if (process.env.MARBLE_SHEET) console.log(steps.map(d => d.toFixed(1)).join(' '));
  steps.forEach((d, i) => {
    const around = Math.max(steps[i - 1] ?? 0, steps[i + 1] ?? 0);
    expect(d).toBeLessThanOrEqual(around * 1.6 + 1.5);
  });
}

/** Mean absolute difference per pixel, 0..255. */
function diff(x: Uint8Array, y: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i += 4) sum += Math.abs(x[i] - y[i]);
  return sum / (x.length / 4);
}

const frameA = { ...motionFrameAt(track, T), presence: 1 };
const heardB = 30 / b.duration;

const step = (t: number, sheet?: string) =>
  raster(c => drawMarbleMorph(c, null, a, null, b, t, SIZE, 1, 1, 1, 1, -1, 1, heardB, 1, paints(), frameA), sheet);
const plainA = () => raster(c => drawMarblePlayer(c, a as MarblePlayer, SIZE, 1, 1, 1, 1, 1, T / a.duration, 1, paints(), frameA));
const plainB = () => raster(c => drawMarblePlayer(c, b as MarblePlayer, SIZE, 1, 1, 1, 1, 1, heardB, 1, paints(), null));

describe("marbling's morphs", () => {
  afterAll(() => {
    const dir = process.env.MARBLE_SHEET;
    if (!dir) return;
    for (const [name, list] of Object.entries(sheets)) {
      list.forEach((png, i) => require('fs').writeFileSync(`${dir}/${name}-${i}.png`, png));
    }
  });

  it('steps the queue from exactly the leaving song to exactly the arriving one', () => {
    expect(diff(step(0), plainA())).toBe(0);
    expect(diff(step(1), plainB())).toBeLessThan(0.5);
  });

  it('steps smoothly, with no frame that pops', () => {
    const steps: number[] = [];
    let last = step(0);
    for (let i = 1; i <= STEPS; i++) {
      const next = step(i / STEPS, i % 4 === 0 ? 'step' : undefined);
      steps.push(diff(last, next));
      last = next;
    }
    expectNoPop(steps);
  });

  it('raises the sound as a morph: the identity at 0, the bath at 1', () => {
    const rise = (soundIn: number, sheet?: string) =>
      raster(c => drawMarblePlayer(c, a, SIZE, 1, 1, 1, 1, soundIn, T / a.duration, 1, paints(), frameA), sheet);
    const zero = rise(0);
    const one = rise(1);
    expect(diff(zero, one)).toBeGreaterThan(5);
    const steps: number[] = [];
    let last = zero;
    for (let i = 1; i <= STEPS; i++) {
      const next = rise(i / STEPS, i % 4 === 0 ? 'rise' : undefined);
      steps.push(diff(last, next));
      last = next;
    }
    expect(diff(last, one)).toBe(0);
    // The first step also trades the identity's paths for its baked image:
    // the same drawing, filtered, so no pop.
    expectNoPop(steps);
  });

  it('morphs the seal into marbling, exactly at both ends', () => {
    const seal = lensIndex('seal');
    const marble = lensIndex('marble');
    const pair = LENS_PAIRS.find(p => p.a === seal && p.b === marble)!;
    expect(pair).toBeDefined();
    const sealPlayer = LENSES[seal].player(A, undefined, null, track);
    const sealIdentity = LENSES[seal].identity(A);
    const marbleIdentity = LENSES[marble].identity(A);
    const morph = (t: number, sheet?: string) =>
      raster(
        c =>
          pair.drawPlayer(c, sealIdentity, sealPlayer, marbleIdentity, a, t, SIZE, 1, 1, 1, 1, -1, 1, T / a.duration, 1, paints(), null),
        sheet,
      );
    const sealAlone = raster(c =>
      drawSealAsPlayer(c, sealPlayer, sealIdentity, SIZE, 1, 1, 1, 1, -1, 1, T / a.duration, 1, paints(), null),
    );
    const marbleAlone = raster(c =>
      marbleLens.ui.drawPlayer(c, a, marbleIdentity, SIZE, 1, 1, 1, 1, -1, 1, T / a.duration, 1, paints(), null),
    );
    expect(diff(morph(0), sealAlone)).toBe(0);
    expect(diff(morph(1), marbleAlone)).toBeLessThan(0.5);
    const steps: number[] = [];
    let last = morph(0);
    for (let i = 1; i <= STEPS; i++) {
      const next = morph(i / STEPS, i % 4 === 0 ? 'seal' : undefined);
      steps.push(diff(last, next));
      last = next;
    }
    expectNoPop(steps);
  });

  it('has a morph for every lens marbling meets', () => {
    const marble = lensIndex('marble');
    for (const lens of LENSES) {
      if (lens.key === 'marble') continue;
      const index = lensIndex(lens.key);
      expect(LENS_PAIRS.some(p => p.a === index && p.b === marble)).toBe(true);
    }
    expect(marbleLens.ui.morphPlayer).toBe(drawMarbleMorph);
  });
});

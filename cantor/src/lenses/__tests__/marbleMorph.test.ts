import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import type { FaceRecipe } from '../face';
import { drawMarbleMorph, marbleLens } from '../marbleLens';
import {
  MARBLE_PLAYER_KNOBS,
  drawMarblePlayer,
  marbleBakeImage,
  marbleBakeKey,
  marblePlayerOf,
  type MarblePlayer,
} from '../marblePlayer';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';
import { motionFrameAt } from '../motion/motionFrame';
import { LENS_PAIRS, lensIndex, LENSES } from '../registry';
import { MARBLE_MORPH_KNOBS } from '../marbleMorph';
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

  it('morphs the singing circle into marbling, from the contour it is drawn as', () => {
    const circle = lensIndex('name');
    const marble = lensIndex('marble');
    const pair = LENS_PAIRS.find(p => p.a === circle && p.b === marble)!;
    const circlePlayer = LENSES[circle].player(A, undefined, null, track);
    const circleIdentity = LENSES[circle].identity(A);
    const marbleIdentity = LENSES[marble].identity(A);
    const morph = (t: number) =>
      raster(c =>
        pair.drawPlayer(c, circleIdentity, circlePlayer, marbleIdentity, a, t, SIZE, 1, 1, 1, 1, -1, 1, T / a.duration, 1, paints(), frameA),
      );
    const circleAlone = raster(c =>
      LENSES[circle].ui.drawPlayer(c, circlePlayer, circleIdentity, SIZE, 1, 1, 1, 1, -1, 1, T / a.duration, 1, paints(), frameA),
    );
    expect(diff(morph(0), circleAlone)).toBe(0);
    const steps: number[] = [];
    let last = morph(0);
    for (let i = 1; i <= STEPS; i++) {
      const next = morph(i / STEPS);
      steps.push(diff(last, next));
      last = next;
    }
    expectNoPop(steps);
  });

  it('morphs a seek while playing: held, then the old bath into the new, then the new', () => {
    const clock = jest.spyOn(Date, 'now');
    const player = marblePlayerOf({ ...A, id: 'song-seek' }, undefined, null, track);
    const late = 150;
    const at = (t: number) => ({ ...motionFrameAt(track, t), presence: 1 });
    const draw = (t: number, ms: number) => {
      clock.mockReturnValue(ms);
      return raster(c => drawMarblePlayer(c, player, SIZE, 1, 1, 1, 1, 1, t / player.duration, 1, paints(), at(t)));
    };
    player.baked.value = marbleBakeImage(player, marbleBakeKey(player, late));
    const oldFrame = draw(late, 1000);
    draw(late + 0.016, 1016);
    // The back button: the playhead at 0, its bake not here yet — held.
    const held = draw(0.02, 1032);
    expect(diff(held, oldFrame)).toBeLessThan(2);
    player.baked.value = marbleBakeImage(player, marbleBakeKey(player, 0.05));
    draw(0.05, 1048);
    // Frames every 16 ms, as the motion layer draws them while it plays.
    const until = (ms: number) => {
      let now = 1048;
      while (now + 16 < ms) {
        now += 16;
        clock.mockReturnValue(now);
        drawMarblePlayer(Skia.Surface.Make(8, 8)!.getCanvas(), player, SIZE, 1, 1, 1, 1, 1, 0.05, 1, paints(), at(0.05 + (now - 1048) / 1000));
      }
    };
    until(1048 + MARBLE_PLAYER_KNOBS.SEEK_MORPH_MS / 2);
    const mid = draw(0.3, 1048 + MARBLE_PLAYER_KNOBS.SEEK_MORPH_MS / 2);
    // The new bath as it is drawn with no seek in flight: the seek's own state set aside.
    const g = globalThis as unknown as { __marbleSeek?: Map<number, unknown> };
    const kept = g.__marbleSeek;
    g.__marbleSeek = new Map();
    const plainNew = raster(c =>
      drawMarblePlayer(c, player, SIZE, 1, 1, 1, 1, 1, 0.6 / player.duration, 1, paints(), at(0.6)),
    );
    g.__marbleSeek = kept;
    expect(diff(mid, oldFrame)).toBeGreaterThan(3);
    expect(diff(mid, plainNew)).toBeGreaterThan(3);
    until(1048 + MARBLE_PLAYER_KNOBS.SEEK_MORPH_MS + 20);
    const after = draw(0.6, 1048 + MARBLE_PLAYER_KNOBS.SEEK_MORPH_MS + 20);
    expect(diff(after, plainNew)).toBe(0);
    clock.mockRestore();
  });

  it("morphs the cover's strokes into marbling's ink", () => {
    const cover = lensIndex('cover');
    const marble = lensIndex('marble');
    const pair = LENS_PAIRS.find(p => p.a === cover && p.b === marble)!;
    const coverIdentity = LENSES[cover].identity(A);
    const marbleIdentity = LENSES[marble].identity(A);
    const morph = (t: number) =>
      raster(c =>
        pair.drawPlayer(c, coverIdentity, null, marbleIdentity, a, t, SIZE, 1, 1, 1, 1, -1, 1, T / a.duration, 1, paints(), null),
      );
    const alone = raster(c =>
      LENSES[cover].ui.drawPlayer(c, null, coverIdentity, SIZE, 1, 1, 1, 1, -1, 1, T / a.duration, 1, paints(), null),
    );
    expect(diff(morph(0), alone)).toBe(0);
    const steps: number[] = [];
    let last = morph(0);
    for (let i = 1; i <= STEPS; i++) {
      const next = morph(i / STEPS);
      steps.push(diff(last, next));
      last = next;
    }
    expectNoPop(steps);
  });

  it('has its morphs built with its bakes, off the drawing threads', async () => {
    // Until the bake asked for lands (warming slices may be queued before it).
    const landed = async (player: MarblePlayer, key: number) => {
      for (let i = 0; i < 200 && player.baked.value?.key !== key; i++) {
        await new Promise<void>(resolve => setTimeout(() => resolve(), 10));
      }
      expect(player.baked.value?.key).toBe(key);
    };
    const x = marblePlayerOf({ ...A, id: 'built-x' }, undefined, null, track);
    const y = marblePlayerOf({ ...B, id: 'built-y' }, undefined, null, track);
    marbleLens.bake!(x, 40);
    await landed(x, 40);
    const first = x.baked.value!;
    expect(first.key).toBe(40);
    // A first bake carries only the rise, to come back soonest.
    expect(first.morphs!.rise).not.toBeNull();
    expect(Object.keys(first.morphs!.pairs)).toEqual([]);
    // The next bake along is not a seek, and carries the other lenses' morphs; a jump back is.
    marbleLens.bake!(x, 44);
    await landed(x, 44);
    expect(x.baked.value!.morphs!.seek).toBeNull();
    expect(Object.keys(x.baked.value!.morphs!.pairs).sort()).toEqual(['circle', 'cover', 'seal']);
    marbleLens.bake!(x, 0);
    await landed(x, 0);
    expect(x.baked.value!.morphs!.seek?.fromKey).toBe(44);
    // Built in the bath's unit, not px: its rings get their share of points,
    // not each the least (they were 8-point shards on the phone).
    const seek = x.baked.value!.morphs!.seek!.morph;
    const rings = seek.starts.length - 1;
    expect(seek.from.length / 2 / rings).toBeGreaterThan(MARBLE_MORPH_KNOBS.MIN_POINTS * 2);
    // The next song's first bake carries the step from this one.
    marbleLens.bake!(x, 8);
    await landed(x, 8);
    marbleLens.bake!(y, 12);
    await landed(y, 12);
    expect(y.baked.value!.morphs!.step?.fromId).toBe(x.id);
    expect(y.baked.value!.morphs!.step?.fromKey).toBe(8);
    marbleLens.bake!(y, 16);
    await landed(y, 16);
    expect(y.baked.value!.morphs!.pairs.seal).toBeDefined();

    // And the seal pair drawn from the built morph keeps its exact ends.
    const seal = lensIndex('seal');
    const marble = lensIndex('marble');
    const pair = LENS_PAIRS.find(p => p.a === seal && p.b === marble)!;
    const sealPlayer = LENSES[seal].player(B, undefined, null, track);
    const sealIdentity = LENSES[seal].identity(B);
    const marbleIdentity = LENSES[marble].identity(B);
    const heardY = 36 / y.duration;
    const morph = (t: number) =>
      raster(c => pair.drawPlayer(c, sealIdentity, sealPlayer, marbleIdentity, y, t, SIZE, 1, 1, 1, 1, -1, 1, heardY, 1, paints(), null));
    const sealAlone = raster(c => drawSealAsPlayer(c, sealPlayer, sealIdentity, SIZE, 1, 1, 1, 1, -1, 1, heardY, 1, paints(), null));
    const marbleAlone = raster(c => marbleLens.ui.drawPlayer(c, y, marbleIdentity, SIZE, 1, 1, 1, 1, -1, 1, heardY, 1, paints(), null));
    expect(diff(morph(0), sealAlone)).toBe(0);
    expect(diff(morph(1), marbleAlone)).toBeLessThan(0.5);
    const steps: number[] = [];
    let last = morph(0);
    for (let i = 1; i <= STEPS; i++) {
      const next = morph(i / STEPS);
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

import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import type { FaceRecipe } from '../face';
import { applyMarbleOp, applyMarbleOpRefined, copySurface, inkAt, surfacePoints } from '../marble';
import { marbleLens } from '../marbleLens';
import { MARBLE_BATH_KNOBS } from '../marbleBath';
import { MARBLE_MARK_REACH_PX } from '../marbleMark';
import {
  MARBLE_PLAYER_KNOBS,
  drawMarblePlayer,
  marbleBakeImage,
  marbleBakeKey,
  marbleBathAt,
  marblePlayerOf,
} from '../marblePlayer';
import { marbleExtAt, marbleLanded, marbleSettledAt } from '../marbleTimeline';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';
import { motionFrameAt } from '../motion/motionFrame';

declare const require: (name: string) => { writeFileSync: (path: string, data: Uint8Array) => void };
declare const process: { env: Record<string, string | undefined> };

const RECIPE: FaceRecipe = { seed: 4242, id: 'song-a', model: 'light', durationMs: 262_000 };
const track = trackOf(load('edm-drop'));
const player = marblePlayerOf(RECIPE, undefined, null, track);
const sound = player.sound!;

/** Size the bath so its clip is ~140 px: a player, at 1×. */
const SIZE = 140 / (MARBLE_MARK_REACH_PX * MARBLE_PLAYER_KNOBS.GROW * MARBLE_PLAYER_KNOBS.CLIP_RATIO);
const VIEW = 320;

function paints() {
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  fill.setColor(Skia.Color('black'));
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(1);
  const paper = Skia.Paint();
  paper.setColor(Skia.Color('white'));
  return { fill, stroke, paper };
}

const pngs: Record<string, Uint8Array> = {};

/** The player at `t`, its pixels. */
function render(t: number, bakeAt: number, name?: string, soundIn = 1): Uint8Array {
  player.baked.value = marbleBakeImage(player, bakeAt);
  const surface = Skia.Surface.Make(VIEW, VIEW)!;
  const canvas: SkCanvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  canvas.translate(VIEW / 2, VIEW / 2);
  const frame = { ...motionFrameAt(track, t), presence: 1 };
  drawMarblePlayer(canvas, player, SIZE, 1, 1, 1, 1, soundIn, t / player.duration, 1, paints(), frame);
  surface.flush();
  const image = surface.makeImageSnapshot();
  if (name !== undefined) pngs[name] = image.encodeToBytes();
  const px = image.readPixels() as Uint8Array;
  image.dispose();
  surface.dispose();
  return px;
}

/**
 * Where the CPU says ink is at `t`, sampled at pixel centres, against the
 * shader's frame: the share of pixels that agree, away from edges (where
 * anti-aliasing and the outlines are) and the nib.
 */
function agreement(t: number, bakeAt: number, name?: string): number {
  const px = render(t, bakeAt, name);
  const settled = marbleSettledAt(sound, t);
  const truth = copySurface(marbleBathAt(player, bakeAt));
  for (let i = bakeAt; i < sound.ops.length && sound.ops[i].t <= t; i++) {
    applyMarbleOp(truth, sound.ops[i].op, marbleLanded(sound.ops[i], t));
  }
  const ext = marbleExtAt(sound, t, bakeAt <= settled ? bakeAt : settled);
  const k = SIZE * MARBLE_PLAYER_KNOBS.GROW;
  const s = player.markScale * k * (sound.ext0 / ext);
  const clipR = player.markScale * k * sound.ext0 * MARBLE_PLAYER_KNOBS.CLIP_RATIO;
  let agree = 0;
  let total = 0;
  for (let y = 2; y < VIEW - 2; y += 3) {
    for (let x = 2; x < VIEW - 2; x += 3) {
      const dx = x + 0.5 - VIEW / 2;
      const dy = y + 0.5 - VIEW / 2;
      if (Math.hypot(dx, dy) > clipR - 3) continue;
      const v = px[(y * VIEW + x) * 4];
      if (v > 40 && v < 215) continue; // an edge or a line
      // and not beside one: all four neighbours as decided
      const n = [-2, 2].flatMap(o => [px[((y + o) * VIEW + x) * 4], px[(y * VIEW + x + o) * 4]]);
      if (n.some(w => (w < 128) !== (v < 128))) continue;
      total += 1;
      if ((v < 128) === inkAt(truth, dx / s, dy / s)) agree += 1;
    }
  }
  expect(total).toBeGreaterThan(1500);
  return agree / total;
}

describe('marbling as the player', () => {
  afterAll(() => {
    const dir = process.env.MARBLE_SHEET;
    if (dir) for (const [name, png] of Object.entries(pngs)) require('fs').writeFileSync(`${dir}/${name}.png`, png);
  });

  it('builds once per recipe and track, and keys its bake by settled ops', () => {
    expect(marblePlayerOf(RECIPE, undefined, null, track)).toBe(player);
    // The queue's step asks for the leaving song's model again, with whatever
    // analysis and cover it has: the same model, its bath still baked.
    const measured = { rms: new Float32Array(4), peak: new Float32Array(4), measured: true, slices: { loudness: new Float32Array(9), punch: new Float32Array(9), width: new Float32Array(9) } };
    expect(marblePlayerOf(RECIPE, measured as never, null, track)).toBe(player);
    expect(marblePlayerOf(RECIPE, undefined, null, null).sound).toBeNull();
    expect(marbleBakeKey(player, 0)).toBe(0);
    const end = sound.ops.length;
    expect(marbleBakeKey(player, track.duration + 1)).toBe(end - (end % MARBLE_PLAYER_KNOBS.BAKE_EVERY));
    // Every key leaves at most BAKE_EVERY − 1 settled ops for the shader.
    for (let t = 0; t < track.duration; t += 1.3) {
      const lag = marbleSettledAt(sound, t) - marbleBakeKey(player, t);
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(MARBLE_PLAYER_KNOBS.BAKE_EVERY);
    }
    expect(marbleBakeKey(marblePlayerOf(RECIPE, undefined, null, null), 50)).toBe(-1);
    expect(marbleLens.player(RECIPE, undefined, null, track)).toBe(player);
  });

  it('reaches the same bath from a keyframe as from the start', () => {
    const k = Math.min(sound.ops.length, 53);
    const viaKeys = copySurface(marbleBathAt(player, k));
    marbleBathAt(player, 3); // move the cursor back
    const fresh = copySurface(marbleBathAt(player, 0));
    for (let i = 0; i < k; i++) applyMarbleOpRefined(fresh, sound.ops[i].op, MARBLE_BATH_KNOBS.SEG_MAX * sound.ops[i].ext, MARBLE_BATH_KNOBS.BAKE_REACH * sound.ops[i].ext);
    expect(viaKeys.rings).toHaveLength(fresh.rings.length);
    viaKeys.rings.forEach((ring, i) => {
      for (let j = 0; j < ring.pts.length; j++) expect(ring.pts[j]).toBeCloseTo(fresh.rings[i].pts[j], 9);
    });
  });

  it('draws the settled bath as the CPU does', () => {
    // Baked a few ops behind, as it is on the phone: the shader lands the rest.
    let t = 100;
    while (marbleSettledAt(sound, t) % MARBLE_PLAYER_KNOBS.BAKE_EVERY === 0) t += 0.5;
    const k = marbleBakeKey(player, t);
    expect(marbleSettledAt(sound, t)).toBeGreaterThan(k);
    expect(agreement(t, k, 'settled')).toBeGreaterThan(0.985);
  });

  it('lands a comb and a drop on the GPU exactly as the CPU does', () => {
    // A section start: its comb is landing over its first bar, with bars' drops inside it.
    const section = track.sections[3];
    const t = section.t0 + 0.6 * (240 / track.bpm);
    const k = marbleBakeKey(player, t);
    const live = sound.ops.slice(k).filter(o => o.t <= t);
    expect(live.some(o => o.op.kind === 'tine')).toBe(true);
    expect(agreement(t, k, 'comb')).toBeGreaterThan(0.985);
  });

  it('lands a bullseye as the CPU does', () => {
    const drop = track.drops[1];
    const t = drop.t + 0.2;
    const k = marbleBakeKey(player, t);
    expect(agreement(t, k, 'bullseye')).toBeGreaterThan(0.985);
  });

  it('is its identity before the sound rises', () => {
    const still = render(60, marbleSettledAt(sound, 60), 'identity', 0);
    const risen = render(60, marbleSettledAt(sound, 60), undefined, 1);
    let differ = 0;
    for (let i = 0; i < still.length; i += 4) if (Math.abs(still[i] - risen[i]) > 60) differ += 1;
    expect(differ).toBeGreaterThan(500);
    // and half risen is an iris, not a crossfade: no pixel is half of both.
    render(60, marbleSettledAt(sound, 60), 'iris', 0.5);
  });

  it('keeps the bath to a bounded number of points', () => {
    const end = marbleBathAt(player, sound.ops.length);
    if (process.env.MARBLE_SHEET) console.log('points at the end', surfacePoints(end), 'rings', end.rings.length);
    expect(surfacePoints(end)).toBeLessThan(40_000);
  });

  it('bakes the latest key asked for, coalescing the ones between', async () => {
    const other = marblePlayerOf({ ...RECIPE, id: 'song-b', seed: 99 }, undefined, null, track);
    expect(other.baked.value).toBeNull();
    for (const key of [3, 7, 12]) marbleLens.bake!(other, key);
    for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(other.baked.value?.key).toBe(12);
  });

  it('bakes within its budget', () => {
    const start = Date.now();
    marbleBakeImage(player, sound.ops.length);
    const ms = Date.now() - start;
    // Jest's CanvasKit, not the phone: a loose guard; the phone's number is M7's.
    expect(ms).toBeLessThan(1500);
  });
});

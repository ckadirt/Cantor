import { Skia, type SkCanvas, type SkPath } from '@shopify/react-native-skia';
import {
  circleMotionPath,
  circlePlayerOf,
  circlePose,
  ringMotionLevel,
  wrapAngle,
} from '../circleMotion';
import type { FaceRecipe } from '../face';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';
import { motionFrameAt, type MotionFrame } from '../motion/motionFrame';
import { NAME_LENS_KNOBS, nameLens, nameLensFacePath } from '../nameLens';

const RECIPE: FaceRecipe = { seed: 4242, id: 'song-a', model: 'light', durationMs: 262_000 };
const IMPORTED: FaceRecipe = { ...RECIPE, imported: true };
const R = NAME_LENS_KNOBS.MARK_RADIUS_PX;
const track = trackOf(load('edm-drop'));
const drop = track.drops[1];

function frameAt(t: number): MotionFrame {
  return motionFrameAt(track, t);
}

function paints() {
  const fill = Skia.Paint();
  const stroke = Skia.Paint();
  stroke.setStyle(1);
  stroke.setAntiAlias(true);
  const paper = Skia.Paint();
  paper.setColor(Skia.Color('white'));
  return { fill, stroke, paper };
}

/** The drawing as a hash of its pixels and how much ink it holds. */
function raster(draw: (canvas: SkCanvas) => void): string {
  const surface = Skia.Surface.Make(240, 240)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  canvas.translate(120, 120);
  draw(canvas);
  surface.flush();
  const image = surface.makeImageSnapshot();
  const pixels = image.readPixels() as Uint8Array;
  let ink = 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i += 4) {
    ink += 255 - pixels[i];
    h = Math.imul(h ^ pixels[i], 0x01000193) >>> 0;
  }
  image.dispose();
  surface.dispose();
  return `${ink} ${h.toString(16)}`;
}

function width(path: SkPath): number {
  return path.computeTightBounds().width;
}

describe('the singing circle', () => {
  it('is the mark, point for point, with no motion', () => {
    for (const recipe of [RECIPE, IMPORTED]) {
      const player = circlePlayerOf(recipe, NAME_LENS_KNOBS.SPINDLE_RATIO);
      const still = nameLensFacePath(recipe, R).toSVGString();
      for (const t of [drop.t - 1, drop.t + 0.2, track.sections[3].t0 + 20]) {
        expect(circleMotionPath(player, frameAt(t), 0, R).toSVGString()).toBe(still);
      }
    }
  });

  it('hands over to the mark: at the row it draws exactly what the row draws', () => {
    const player = nameLens.player(RECIPE, undefined, null);
    const identity = nameLens.identity(RECIPE);
    const frame = frameAt(drop.t + 0.2);
    const draw = (arrived: number, motion: MotionFrame | null) =>
      raster(canvas =>
        nameLens.ui.drawPlayer(canvas, player, identity, 1.6, 1, 0.9, 0, arrived, -1, 1, -1, 1, paints(), motion),
      );
    expect(draw(0, frame)).toBe(draw(0, null));
    expect(draw(1, frame)).not.toBe(draw(1, null));
  });

  it('unwinds the short way: a long section’s turns never spin it back', () => {
    const section = track.sections.reduce((a, b) => (b.z - b.a > a.z - a.a ? b : a));
    const late = frameAt(track.beats[Math.min(section.z, track.beats.length) - 2]);
    const lobes = circlePlayerOf(RECIPE, 0).lobes;
    const raw = circlePose(late, lobes);
    expect(Math.abs(wrapAngle(raw))).toBeLessThanOrEqual(Math.PI);
    for (const a of [-7, -3.2, 0, 3.15, 9.9, 100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
  });

  it('tightens into a drop and blooms on it', () => {
    const player = circlePlayerOf(RECIPE, 0);
    const before = frameAt(drop.t - 0.05);
    const after = frameAt(drop.t + 0.3);
    expect(before.tension).toBeGreaterThan(0.1);
    expect(after.release).toBeGreaterThan(0.1);
    const still = width(nameLensFacePath(RECIPE, R));
    // The tension's own path against the same frame with the drop taken out.
    const tense = width(circleMotionPath(player, before, 1, R));
    const loose = width(circleMotionPath(player, { ...before, tension: 0, release: 0, lift: 0, lifted: 0 }, 1, R));
    expect(tense).toBeLessThan(loose);
    const bloom = width(circleMotionPath(player, after, 1, R));
    const plain = width(circleMotionPath(player, { ...after, tension: 0, release: 0, lift: 0, lifted: 0 }, 1, R));
    expect(bloom).toBeGreaterThan(plain);
    expect(still).toBeGreaterThan(0);
  });

  it('lifts the ring of ticks with the hit, and lets it go between', () => {
    const quiet = ringMotionLevel({ ...frameAt(10), low: 0, beat: 0, loud: 0 });
    expect(quiet).toBe(0);
    const hit = ringMotionLevel({ ...frameAt(10), low: 1, beat: 1, loud: 1 });
    expect(hit).toBeCloseTo(0.45, 9);
  });

  // Frames at named moments of a named fixture: deterministic, because the
  // frame is a pure function of the track and the playhead.
  it.each([
    ['a verse, between hits', track.sections[1].t0 + 3.13],
    ['on a downbeat', track.beats[track.downs.indexOf(1, 120)] + 0.012],
    ['the build into the second drop', drop.t - 0.5],
    ['the bloom', drop.t + 0.25],
    ['a returning section, a bar in', track.sections[8].t0 + 2],
  ])('draws %s', (_name, t) => {
    const player = nameLens.player(RECIPE, undefined, null);
    const identity = nameLens.identity(RECIPE);
    expect(
      raster(canvas =>
        nameLens.ui.drawPlayer(canvas, player, identity, 1.6, 1, 0.9, 0, 1, -1, 1, -1, 1, paints(), frameAt(t)),
      ),
    ).toMatchSnapshot();
  });
});

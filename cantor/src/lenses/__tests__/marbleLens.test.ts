import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import { ARRIVING_NONE, arrivingHeld, type MarkPaints } from '../contract';
import type { FaceRecipe } from '../face';
import { marbleIdentity } from '../marble';
import { MARBLE_MARK_REACH_PX, marbleLens, marbleMarkOf } from '../marbleLens';
import { LENSES, lensOffered } from '../registry';

const RECIPE: FaceRecipe = { seed: 4242, id: 'song-a', model: 'light', durationMs: 214_000 };
const mark = marbleMarkOf(RECIPE);

function paints(): MarkPaints {
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(1);
  return { fill, stroke };
}

/** The mark at 4×, as ink and a hash of its pixels. */
function raster(draw: (canvas: SkCanvas) => void): { ink: number; hash: string } {
  const surface = Skia.Surface.Make(96, 96)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  canvas.translate(48, 48);
  canvas.scale(4, 4);
  draw(canvas);
  surface.flush();
  const image = surface.makeImageSnapshot();
  const px = image.readPixels() as Uint8Array;
  let ink = 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i += 4) {
    ink += 255 - px[i];
    // eslint-disable-next-line no-bitwise
    h = Math.imul(h ^ px[i], 0x01000193) >>> 0;
  }
  image.dispose();
  surface.dispose();
  return { ink, hash: h.toString(16) };
}

const markAt = (weight: number, fill: number, arriving = ARRIVING_NONE) =>
  raster(canvas =>
    marbleLens.ui.drawMark(canvas, mark, 1, 1, weight, fill, 0, arriving, 1, paints()),
  );

describe('marbling as a mark', () => {
  it('fits its furthest ink to the mark reach', () => {
    const bounds = mark.outline.computeTightBounds();
    const far = Math.max(
      -bounds.x,
      -bounds.y,
      bounds.x + bounds.width,
      bounds.y + bounds.height,
    );
    expect(far).toBeLessThanOrEqual(MARBLE_MARK_REACH_PX + 1e-6);
    expect(far).toBeGreaterThan(MARBLE_MARK_REACH_PX * 0.8);
  });

  it('draws grey, then black, then filled, each with more ink', () => {
    const remote = markAt(0.38, 0);
    const cached = markAt(0.85, 0);
    const pinned = markAt(1, 1);
    expect(cached.ink).toBeGreaterThan(remote.ink * 1.5);
    expect(pinned.ink).toBeGreaterThan(cached.ink * 1.3);
    expect([remote.hash, cached.hash, pinned.hash]).toMatchSnapshot();
  });

  it('lands its recipe drop by drop while it downloads', () => {
    const none = markAt(0.38, 0);
    const start = markAt(0.38, 0, 0);
    const half = markAt(0.38, 0, 0.5);
    const done = markAt(0.38, 0, 1);
    expect(start.hash).toBe(none.hash);
    expect(half.ink).toBeGreaterThan(start.ink);
    expect(done.ink).toBeGreaterThan(half.ink);
    // A stopped download keeps what landed, faint.
    const held = markAt(0.38, 0, arrivingHeld(0.5));
    expect(held.ink).toBeLessThan(half.ink);
    expect(held.ink).toBeGreaterThan(start.ink);
    expect([half.hash, done.hash]).toMatchSnapshot();
  });

  it('stamps each look as drawMark draws it', () => {
    const sprites = marbleLens.ui.sprites!;
    const out = [0, 0];
    expect(sprites.alphas(1, 0.38, 0, ARRIVING_NONE, out)).toBe(true);
    expect(out).toEqual([0.38, 0]);
    expect(sprites.alphas(1, 1, 1, ARRIVING_NONE, out)).toBe(true);
    expect(out).toEqual([0, 1]);
    expect(sprites.alphas(1, 1, 0.5, ARRIVING_NONE, out)).toBe(false);
    expect(sprites.alphas(1, 1, 1, 0.5, out)).toBe(false);
    const stamp = (layer: number) =>
      raster(canvas => sprites.drawLayer(canvas, mark, layer, 1, 1, paints()));
    expect(stamp(0).hash).toBe(markAt(1, 0).hash);
    expect(stamp(1).hash).toBe(markAt(1, 1).hash);
  });

  it('seeks by angle anywhere on the disc, never at its dead centre', () => {
    const radius = 150;
    expect(marbleLens.touch.landAt(RECIPE, 0, -60, radius)).toEqual({ kind: 'seek', fraction: 0 });
    const right = marbleLens.touch.landAt(RECIPE, 100, 0, radius);
    expect(right?.kind).toBe('seek');
    expect(right?.fraction).toBeCloseTo(0.25, 9);
    expect(marbleLens.touch.landAt(RECIPE, 2, 2, radius)).toBeNull();
    expect(marbleLens.touch.seekAt(0, 120, radius)).toBeCloseTo(0.5, 9);
  });

  it('is registered, but not offered while it is a preview', () => {
    expect(LENSES).toContain(marbleLens);
    expect(lensOffered(marbleLens)).toBe(false);
    expect(LENSES.filter(lens => lens !== marbleLens).every(lensOffered)).toBe(true);
  });

  it('builds a song in well under a millisecond or two', () => {
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      marbleMarkOf({ seed: 9000 + i, id: `x${i}`, model: 'light', durationMs: 100_000 });
    }
    const each = (Date.now() - start) / 200;
    expect(each).toBeLessThan(5);
    expect(marbleIdentity(RECIPE).ops.length).toBeGreaterThanOrEqual(5);
  });
});

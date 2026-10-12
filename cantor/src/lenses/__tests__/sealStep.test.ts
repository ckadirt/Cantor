import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import type { SongAnalysis } from '../analysis';
import type { FaceRecipe } from '../face';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';
import { motionFrameAt, type MotionFrame } from '../motion/motionFrame';
import { drawSealMorph, sealLens } from '../sealLens';

const RECIPE: FaceRecipe = { seed: 4242, id: 'song-a', model: 'light', durationMs: 262_000 };
const NEXT: FaceRecipe = { seed: 977, id: 'song-b', model: 'light', durationMs: 131_000 };
const track = trackOf(load('edm-drop'));
const drop = track.drops[1];

function analysis(phase: number, punchy = true): SongAnalysis {
  const n = 729;
  const loudness = new Float32Array(n);
  const punch = new Float32Array(n);
  const width = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    loudness[i] = 0.05 + 0.08 * (0.5 + 0.5 * Math.sin(i / 23 + phase));
    punch[i] = punchy ? 0.3 + 0.3 * Math.sin(i / 7 + phase) : 0;
    width[i] = (i + phase) % 11 === 0 ? 0.3 : 0;
  }
  return { rms: new Float32Array(32), peak: new Float32Array(32), measured: true, slices: { loudness, punch, width } };
}

const identityA = sealLens.identity(RECIPE);
const identityB = sealLens.identity(NEXT);
const playerA = sealLens.player(RECIPE, analysis(0), null);
const playerB = sealLens.player(NEXT, analysis(3), null);

function paints() {
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const stroke = Skia.Paint();
  stroke.setStyle(1);
  stroke.setAntiAlias(true);
  const paper = Skia.Paint();
  paper.setColor(Skia.Color('white'));
  return { fill, stroke, paper };
}

/** A drawing's pixels as how much ink it holds and a hash. */
function raster(draw: (canvas: SkCanvas) => void): { ink: number; hash: string } {
  const surface = Skia.Surface.Make(320, 320)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  canvas.translate(160, 160);
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
  return { ink, hash: h.toString(16) };
}

const morph = (t: number, motion: MotionFrame | null, fromHeard: number) =>
  raster(canvas =>
    drawSealMorph(canvas, identityA, playerA, identityB, playerB, t, 7, 1, 0.9, 0, 1, -1, 1, 0.1, 1, paints(), motion, fromHeard),
  );

describe("the seal's step", () => {
  it('is registered as the seal player morph', () => {
    expect(sealLens.ui.morphPlayer).toBe(drawSealMorph);
  });

  it('starts on the leaving seal singing as it was held, pixel for pixel', () => {
    const frame = motionFrameAt(track, drop.t - 0.3);
    const own = raster(canvas =>
      sealLens.ui.drawPlayer(canvas, playerA, identityA, 7, 1, 0.9, 0, 1, -1, 1, frame.head, 1, paints(), frame),
    );
    expect(morph(0, frame, 0.5)).toEqual(own);
  });

  it('starts on the leaving seal still, at its own playhead', () => {
    const own = raster(canvas =>
      sealLens.ui.drawPlayer(canvas, playerA, identityA, 7, 1, 0.9, 0, 1, -1, 1, 0.6, 1, paints(), null),
    );
    expect(morph(0, null, 0.6)).toEqual(own);
  });

  it('lands on the arriving seal, and is neither halfway', () => {
    const own = (player: typeof playerA, identity: typeof identityA, heard: number) =>
      raster(canvas =>
        sealLens.ui.drawPlayer(canvas, player, identity, 7, 1, 0.9, 0, 1, -1, 1, heard, 1, paints(), null),
      );
    const arriving = own(playerB, identityB, 0.1);
    expect(morph(1, null, 0.6)).toEqual(arriving);
    // The morph's last frame — smootherstep is flat there, so a frame short of
    // the clock's end is a hair short of 1 — is the arriving seal, to the
    // edge's anti-aliasing.
    // Without punch: Jest's web Skia drops `addCircle`'s winding, so the
    // still seal's hollow dots are solid here, and on the phone they are not.
    const flat = sealLens.player(NEXT, analysis(3, false), null);
    const flatOwn = raster(canvas =>
      sealLens.ui.drawPlayer(canvas, flat, identityB, 7, 1, 0.9, 0, 1, -1, 1, 0.1, 1, paints(), null),
    );
    const near = raster(canvas =>
      drawSealMorph(canvas, identityA, playerA, identityB, flat, 1 - 1e-5, 7, 1, 0.9, 0, 1, -1, 1, 0.1, 1, paints(), null, 0.6),
    );
    expect(Math.abs(near.ink - flatOwn.ink) / flatOwn.ink).toBeLessThan(0.005);
    const half = morph(0.5, null, 0.6);
    expect(half.hash).not.toBe(arriving.hash);
    expect(half.hash).not.toBe(own(playerA, identityA, 0.6).hash);
  });
});

import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import type { SongAnalysis } from '../analysis';
import type { FaceRecipe } from '../face';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';
import { motionFrameAt, type MotionFrame } from '../motion/motionFrame';
import { sealLens } from '../sealLens';
import { sealMotionOf, SEAL_MOTION_KNOBS } from '../sealMotion';
import type { SealPlayer } from '../sealPlayer';

// Node's, for looking at the frames: `SEAL_SHEET=/tmp/dir` writes each one out.
declare const require: (name: string) => { writeFileSync: (path: string, data: Uint8Array) => void };
declare const process: { env: Record<string, string | undefined> };

const RECIPE: FaceRecipe = { seed: 4242, id: 'song-a', model: 'light', durationMs: 262_000 };
const track = trackOf(load('edm-drop'));
const drop = track.drops[1];

/** A measured song: loudness that swells and falls, some punch, a little width. */
function analysis(): SongAnalysis {
  const n = 729;
  const loudness = new Float32Array(n);
  const punch = new Float32Array(n);
  const width = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    loudness[i] = 0.05 + 0.08 * (0.5 + 0.5 * Math.sin(i / 23));
    punch[i] = 0.3 + 0.3 * Math.sin(i / 7);
    width[i] = i % 11 === 0 ? 0.3 : 0;
  }
  return { rms: new Float32Array(32), peak: new Float32Array(32), measured: true, slices: { loudness, punch, width } };
}

const player = sealLens.player(RECIPE, analysis(), null) as SealPlayer;
const identity = sealLens.identity(RECIPE);

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

const pngs: Record<string, Uint8Array> = {};

/** The player at `t` (or still), as a hash of its pixels and how much ink it holds. */
function raster(motion: MotionFrame | null, arrived = 1, name?: string, at = 0.4): string {
  // `SEAL_SHEET` draws bigger, to be looked at; the pinned hashes are at 1×.
  const zoom = process.env.SEAL_SHEET ? 3 : 1;
  const surface = Skia.Surface.Make(320 * zoom, 320 * zoom)!;
  const canvas: SkCanvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  canvas.translate(160 * zoom, 160 * zoom);
  canvas.scale(zoom, zoom);
  const heard = motion === null ? at : motion.head;
  sealLens.ui.drawPlayer(canvas, player, identity, 7, 1, 0.9, 0, arrived, -1, 1, heard, 1, paints(), motion);
  surface.flush();
  const image = surface.makeImageSnapshot();
  if (name !== undefined) pngs[name] = image.encodeToBytes();
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

describe('the seal in time with its song', () => {
  afterAll(() => {
    // `SEAL_SHEET=/tmp/dir` writes each named frame out to look at.
    const dir = process.env.SEAL_SHEET;
    if (dir) for (const [name, png] of Object.entries(pngs)) require('fs').writeFileSync(`${dir}/${name}.png`, png);
  });

  it('is the still player with no motion, and hands over to the mark', () => {
    const frame = motionFrameAt(track, drop.t + 0.2);
    const still = raster(null, 1, undefined, frame.head);
    expect(raster({ ...frame, presence: 0 })).toBe(still);
    expect(raster(frame, 0)).toBe(raster(null, 0, undefined, frame.head));
    expect(raster(frame)).not.toBe(still);
  });

  it('sounds the meter on the seal’s own levels', () => {
    const count = player.order.length;
    const head = 100.5;
    const quiet = { ...motionFrameAt(track, 30), down: 0, beat: 0, low: 0, mid: 0, hats: [], echoes: [], tension: 0, release: 0, lift: 0, lifted: 0 };
    const still = sealMotionOf(quiet, 1, player.cluster, player.ninth, head);
    expect(still.mul.every(v => v === 1)).toBe(true);
    // The bar: every dot.
    const bar = sealMotionOf({ ...quiet, down: 1 }, 1, player.cluster, player.ninth, head);
    expect(bar.mul.every(v => v === 1 + quiet.g * SEAL_MOTION_KNOBS.DOWN)).toBe(true);
    // The kick: the bead's cluster, and no other dot.
    const kick = sealMotionOf({ ...quiet, low: 1 }, 1, player.cluster, player.ninth, head);
    const here = player.cluster[100];
    for (let k = 0; k < count; k++) expect(kick.mul[k] > 1).toBe(player.cluster[k] === here);
    // The beat: the bead's ninth, which holds its cluster and more.
    const beat = sealMotionOf({ ...quiet, beat: 1 }, 1, player.cluster, player.ninth, head);
    const lifted = beat.mul.filter(v => v > 1).length;
    expect(lifted).toBeGreaterThan(kick.mul.filter(v => v > 1).length);
    expect(lifted).toBeLessThan(count);
  });

  it('sounds an echo where its section first played, under a ghost bead', () => {
    const repeat = track.sections.findIndex((s, i) => track.sections.slice(0, i).some(o => o.label === s.label));
    const frame = motionFrameAt(track, track.sections[repeat].t0 + 1);
    expect(frame.echoes.length).toBeGreaterThan(0);
    const moved = sealMotionOf(frame, 1, player.cluster, player.ninth, frame.head * player.order.length);
    expect(moved.ghosts).toHaveLength(frame.echoes.length);
    expect(moved.ghosts[0]).toBeCloseTo((frame.echoes[0] / track.duration) * player.order.length, 9);
  });

  it('gathers into a drop and lets go on it', () => {
    const build = motionFrameAt(track, drop.t - 0.3);
    const on = motionFrameAt(track, drop.t + 0.3);
    const count = player.order.length;
    expect(sealMotionOf(build, 1, player.cluster, player.ninth, 0).pull).toBeGreaterThan(0.1);
    expect(sealMotionOf(on, 1, player.cluster, player.ninth, 0).pull).toBe(0);
    expect(sealMotionOf({ ...build, tension: 1, g: 10 }, 1, player.cluster, player.ninth, 0).pull).toBe(
      SEAL_MOTION_KNOBS.GATHER_CAP,
    );
    expect(count).toBeGreaterThan(0);
  });

  // Frames at named moments: deterministic, because the frame is a pure function.
  it.each([
    ['verse', track.sections[1].t0 + 3.13],
    ['downbeat', track.beats[track.downs.indexOf(1, 120)] + 0.012],
    ['build', drop.t - 0.5],
    ['drop', drop.t + 0.25],
    ['section-written-on', track.sections[8].t0 + 0.9],
    ['returning-section', track.sections[8].t0 + 6],
  ])('draws the %s', (name, t) => {
    expect(raster(motionFrameAt(track, t), 1, name)).toMatchSnapshot();
  });
});

/**
 * Golden pixels for everything a lens draws — the guard for R6.
 *
 * R6 moves the circle and the seal behind one lens contract without changing
 * a pixel of what either draws (see `docs/refactor/field-rewrite-log.md`,
 * "R6 plan"). The other tests here read the draw *calls*; a port reorganises
 * the calls, so those tests would move with it and prove nothing. This one
 * rasterises the frames with real CanvasKit and pins a hash of the pixels, so
 * a port either draws the same image or fails.
 *
 * The grid is the space a lens lives in: camera distance (mark, row, the
 * descent, the player) × lens progress × ink (remote, cached, pinned, a fill
 * arriving) × sound (unmeasured, measured, heard). A golden that changes on
 * purpose — a step that is *meant* to look different — is regenerated with
 * `npx jest lensGoldens -u` and the reason written in the log.
 */
import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import {
  GRAIN_KNOBS,
  LEVEL_SCALE_RATIOS,
  byDate,
  layoutField,
  planPlacementFlights,
  type Camera,
  type FieldEntity,
} from '../../../field';
import {
  ARRIVING_UNKNOWN,
  analyseWindow,
  lensIndex,
  type SongAnalysis,
} from '../../../lenses';
import {
  drawFieldFaces,
  drawSongDetail,
  faceFlightsOf,
  type FaceFlight,
  type GrainBars,
  type SongDetailModel,
} from '../FieldCanvas';
import type { FieldPresentation } from '../useFieldController';

const viewport = { width: 380, height: 800 };
const CIRCLE = lensIndex('name');
const SEAL = lensIndex('seal');

/** Three songs, one per way a song can be held: elsewhere, cached, pinned. */
const STATES = ['remote', 'cached', 'pinned'] as const;

const entities: FieldEntity[] = STATES.map((_, index) => ({
  key: `node-a:song-${index}`,
  nodePublicKey: 'node-a',
  entityId: `song-${index}`,
  kind: 'song' as const,
  createdAtMs: Date.UTC(2026, 7, 8 - index),
  durationMs: 0,
  tags: [],
}));

const presentations: ReadonlyMap<string, FieldPresentation> = new Map(
  entities.map((entity, index) => [
    entity.key,
    {
      entity,
      song: {
        id: entity.entityId,
        revision: 1,
        title: `Song ${index}`,
        caption_summary: '',
        created_at: new Date(entity.createdAtMs).toISOString(),
        duration_ms: 60_000 + index * 17_000,
        model: 'light',
        // Two with a seed and one without, which takes the id path.
        seed: index === 1 ? undefined : 1_000 + index,
        favorite: false,
        tags: [],
        trashed: false,
        artifacts: [],
      },
      backend: {
        nodePubkey: 'node-a',
        relayUrl: 'wss://relay.example',
        petname: 'Studio',
        lastNodeInfo: null,
      },
      ready: true,
      nodeLabels: ['Studio'],
      delivery: undefined,
      localAudio: { state: STATES[index], bytes: 0 },
    } as FieldPresentation,
  ]),
);

const layout = layoutField({
  entities,
  arrangement: byDate('year'),
  viewport,
});
const fit = layout.fitScale;
const recut = {
  fromCamera: { x: layout.fieldCenter.x, y: layout.fieldCenter.y, scale: fit },
  toCamera: { x: layout.fieldCenter.x, y: layout.fieldCenter.y, scale: fit },
  fromFitScale: fit,
  toFitScale: fit,
};

/** A measured song with some shape to it: loudness, punch and width vary. */
function measured(): SongAnalysis {
  const buckets = 729;
  const rms = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const min = new Float32Array(buckets);
  const side = new Float32Array(buckets);
  for (let index = 0; index < buckets; index++) {
    rms[index] = 0.15 + 0.12 * Math.sin(index / 23);
    max[index] = rms[index] * (1.3 + 0.8 * Math.abs(Math.sin(index / 7)));
    min[index] = -max[index];
    side[index] = 0.1 * Math.abs(Math.cos(index / 31));
  }
  return analyseWindow({
    startSeconds: 0,
    endSeconds: 60,
    buckets,
    sampleRate: 48000,
    channels: [
      { min, max, rms },
      { min: min.map((v, i) => v + side[i]), max, rms },
    ],
  });
}

function facesFor(
  focusKey: string | null,
  playingKey: string | null = null,
  analyses?: ReadonlyMap<string, SongAnalysis>,
): readonly FaceFlight[] {
  return faceFlightsOf(
    planPlacementFlights([], layout.placements, 1),
    presentations,
    focusKey,
    playingKey,
    analyses,
  );
}

function paints() {
  const make = (colour: string) => {
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(colour));
    paint.setAntiAlias(true);
    return paint;
  };
  const stroke = make('black');
  stroke.setStyle(1);
  const ring = make('black');
  ring.setStyle(1);
  ring.setStrokeWidth(1.5);
  return { fill: make('black'), stroke, ring, paper: make('white') };
}

/**
 * FNV-1a over the pixels, a 32-bit word at a time, twice with different
 * offsets: 64 bits of hash with no Node types in a React Native project. Words
 * through a view of the same buffer, not bytes one by one — a byte loop over
 * CanvasKit's array took most of a second per frame.
 */
/* eslint-disable no-bitwise -- a hash is inherently bitwise */
function pixelHash(pixels: Uint8Array): string {
  const words = new Uint32Array(
    pixels.buffer,
    pixels.byteOffset,
    pixels.byteLength >> 2,
  );
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    a = Math.imul(a ^ word, 0x01000193) >>> 0;
    b = Math.imul(b ^ word ^ index, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
/* eslint-enable no-bitwise */

/** The frame, as a short hash and how much ink it holds (for a readable diff). */
function raster(draw: (canvas: SkCanvas) => void): string {
  const surface = Skia.Surface.Make(viewport.width, viewport.height)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  draw(canvas);
  surface.flush();
  const image = surface.makeImageSnapshot();
  const pixels = image.readPixels() as Uint8Array;
  let ink = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    ink += 255 - Number(pixels[index]);
  }
  const hash = pixelHash(pixels);
  image.dispose();
  surface.dispose();
  return `${ink} ${hash}`;
}

type FaceFrame = Readonly<{
  faces: readonly FaceFlight[];
  camera: Camera;
  lens?: number;
  reverse?: boolean;
  reducedMotion?: boolean;
  soundProgress?: number;
  heard?: number;
  arrival?: number;
}>;

function faces(frame: FaceFrame): string {
  return raster(canvas =>
    drawFieldFaces(
      canvas,
      frame.faces,
      paints(),
      1,
      recut,
      { value: frame.camera } as never,
      { value: fit } as never,
      viewport,
      // `lens` is how far the change from the circle to the seal has got;
      // `reverse` plays the same frame as the change back, which must draw
      // the same pixels.
      frame.reverse ? SEAL : CIRCLE,
      frame.reverse ? CIRCLE : SEAL,
      frame.reverse ? 1 - (frame.lens ?? 0) : frame.lens ?? 0,
      frame.reducedMotion ?? false,
      frame.soundProgress ?? 1,
      frame.heard ?? -1,
      frame.arrival ?? 1,
    ),
  );
}

const LENS_STEPS = [0, 0.25, 0.5, 0.75, 1];
const atField: Camera = { ...recut.toCamera };
// The pinned song: filled, so the fill paths run through the player too.
const held = layout.placements.find(
  placement => placement.entityKey === entities[2].key,
)!;
const heldSeat = (ratio: number): Camera => ({
  x: held.x,
  y: held.y,
  scale: fit * ratio,
});

describe('golden pixels: faces', () => {
  it('L0, every lens step, and reduced motion', () => {
    const plain = facesFor(null);
    const frames: Record<string, string> = {};
    for (const lens of LENS_STEPS) {
      frames[`lens ${lens}`] = faces({ faces: plain, camera: atField, lens });
    }
    frames['reduced lens 0.5'] = faces({
      faces: plain,
      camera: atField,
      lens: 0.5,
      reducedMotion: true,
    });
    const playing = facesFor(null, held.entityKey);
    frames['playing lens 0'] = faces({ faces: playing, camera: atField });
    frames['playing lens 1'] = faces({
      faces: playing,
      camera: atField,
      lens: 1,
    });
    // A fill arriving under the remote song, half landed.
    const arriving = plain.map((face, index) =>
      index === 0
        ? { ...face, fill: 1, weight: 1, fromFill: 0, fromWeight: face.weight }
        : face,
    );
    for (const lens of [0, 1]) {
      frames[`arriving lens ${lens}`] = faces({
        faces: arriving,
        camera: atField,
        lens,
        arrival: 0.5,
      });
    }
    expect(frames).toMatchSnapshot();
  });

  it('L1, the row faces, every lens step', () => {
    const plain = facesFor(null);
    const frames: Record<string, string> = {};
    for (const lens of LENS_STEPS) {
      frames[`lens ${lens}`] = faces({
        faces: plain,
        camera: heldSeat(LEVEL_SCALE_RATIOS.shelf),
        lens,
      });
    }
    expect(frames).toMatchSnapshot();
  });

  it('the descent and the player, unmeasured', () => {
    const focused = facesFor(held.key);
    const frames: Record<string, string> = {};
    for (const ratio of [12.5, 18, LEVEL_SCALE_RATIOS.song]) {
      for (const lens of [0, 0.3, 0.7, 1]) {
        frames[`ratio ${ratio} lens ${lens}`] = faces({
          faces: focused,
          camera: heldSeat(ratio),
          lens,
        });
      }
    }
    frames['reduced lens 0.5'] = faces({
      faces: focused,
      camera: heldSeat(LEVEL_SCALE_RATIOS.song),
      lens: 0.5,
      reducedMotion: true,
    });
    expect(frames).toMatchSnapshot();
  });

  it('the player, measured, rising and heard', () => {
    const focused = facesFor(
      held.key,
      held.entityKey,
      new Map([[held.entityKey, measured()]]),
    );
    const frames: Record<string, string> = {};
    for (const lens of [0, 0.3, 0.7, 1]) {
      for (const [soundProgress, heard] of [
        [0.5, -1],
        [1, -1],
        [1, 0.4],
      ]) {
        frames[`lens ${lens} sound ${soundProgress} heard ${heard}`] = faces({
          faces: focused,
          camera: heldSeat(LEVEL_SCALE_RATIOS.song),
          lens,
          soundProgress,
          heard,
        });
      }
    }
    frames['descending lens 1 heard 0.4'] = faces({
      faces: focused,
      camera: heldSeat(18),
      lens: 1,
      heard: 0.4,
    });
    expect(frames).toMatchSnapshot();
  });
});

/**
 * Downloads landing (R7): every lens shows one in its own form — the circle an
 * arc round the face, the seal its dust filling in along its thread — at the
 * mark, the row, and through the descent into the player, where the seal's
 * opening has to start exactly as its mark stands.
 */
describe('golden pixels: downloads landing', () => {
  const landing = (flights: readonly FaceFlight[]) =>
    flights.map((face, index) => ({
      ...face,
      arriving: index === 0 ? 0.4 : index === 1 ? ARRIVING_UNKNOWN : 0.85,
      weight: 0.38,
      fill: 0,
      fromWeight: 0.38,
      fromFill: 0,
    }));

  it('marks and rows, circle and seal', () => {
    const frames: Record<string, string> = {};
    for (const lens of [0, 1]) {
      frames[`L0 lens ${lens}`] = faces({
        faces: landing(facesFor(null)),
        camera: atField,
        lens,
      });
      frames[`L1 lens ${lens}`] = faces({
        faces: landing(facesFor(null)),
        camera: heldSeat(LEVEL_SCALE_RATIOS.shelf),
        lens,
      });
    }
    expect(frames).toMatchSnapshot();
  });

  it('the descent into a song still landing', () => {
    const frames: Record<string, string> = {};
    for (const ratio of [LEVEL_SCALE_RATIOS.shelf, 12.5, 18, 30]) {
      for (const lens of [0, 1]) {
        frames[`ratio ${ratio} lens ${lens}`] = faces({
          faces: landing(facesFor(held.key)),
          camera: heldSeat(ratio),
          lens,
        });
      }
    }
    expect(frames).toMatchSnapshot();
  });
});

/**
 * The lens clock reverses by swapping `from` and `to` and taking `1 − t`
 * (`retargetLens`). That is only free of a jump if the reversed clock draws
 * the frame the forward one did — every mark's beats, the reduced-motion
 * crossfade, and the player's morph, measured or not.
 */
describe('a reversed lens clock draws the same frame', () => {
  const measuredFaces = facesFor(
    held.key,
    held.entityKey,
    new Map([[held.entityKey, measured()]]),
  );
  const cases: Array<[string, FaceFrame]> = [];
  for (const lens of [0.2, 0.5, 0.8]) {
    cases.push([
      `L0 ${lens}`,
      { faces: facesFor(null), camera: atField, lens },
    ]);
    cases.push([
      `L0 reduced ${lens}`,
      { faces: facesFor(null), camera: atField, lens, reducedMotion: true },
    ]);
    cases.push([
      `L1 ${lens}`,
      {
        faces: facesFor(null),
        camera: heldSeat(LEVEL_SCALE_RATIOS.shelf),
        lens,
      },
    ]);
    cases.push([
      `player ${lens}`,
      {
        faces: measuredFaces,
        camera: heldSeat(LEVEL_SCALE_RATIOS.song),
        lens,
        heard: 0.4,
      },
    ]);
  }
  it.each(cases)('%s', (_, frame) => {
    expect(faces({ ...frame, reverse: true })).toBe(faces(frame));
  });
});

describe('golden pixels: the measurement', () => {
  const model: SongDetailModel = {
    fromX: 0,
    fromY: 0,
    targetX: 0,
    targetY: 0,
    fromBloomX: 0,
    fromBloomY: 0,
    targetBloomX: 0,
    targetBloomY: 0,
    levels: Array.from({ length: 64 }, (_, i) => 0.3 + 0.2 * Math.sin(i)),
    durationSeconds: 120,
  };
  const still = {
    fromCamera: { x: 0, y: 0, scale: fit },
    toCamera: { x: 0, y: 0, scale: fit },
    fromFitScale: fit,
    toFitScale: fit,
  };
  const bars: GrainBars = {
    min: Array.from(
      { length: 32 },
      (_, i) => -0.2 - 0.2 * Math.abs(Math.sin(i)),
    ),
    max: Array.from(
      { length: 32 },
      (_, i) => 0.2 + 0.2 * Math.abs(Math.cos(i)),
    ),
    startSeconds: 60 - GRAIN_KNOBS.ENTRY_SECONDS / 2,
    endSeconds: 60 + GRAIN_KNOBS.ENTRY_SECONDS / 2,
    label: '12.00s VISIBLE',
  };
  function detail(
    ratio: number,
    lens: number,
    drawn = 1,
    grain: GrainBars | null = null,
    resolved = 0,
  ): string {
    return raster(canvas =>
      drawSongDetail(
        canvas,
        model,
        paints(),
        1,
        still,
        { value: { x: 0, y: 0, scale: fit * ratio } } as never,
        { value: fit } as never,
        { value: 60 } as never,
        grain,
        resolved,
        drawn,
        viewport,
        lens,
      ),
    );
  }

  it('the ring at every lens step, sweeping, and unrolling', () => {
    const frames: Record<string, string> = {};
    for (const lens of LENS_STEPS) {
      frames[`ring lens ${lens}`] = detail(LEVEL_SCALE_RATIOS.song, lens);
    }
    frames['ring half drawn'] = detail(LEVEL_SCALE_RATIOS.song, 0, 0.5);
    const between = Math.sqrt(
      LEVEL_SCALE_RATIOS.song * GRAIN_KNOBS.ENTRY_RATIO,
    );
    for (const lens of [0, 1]) {
      frames[`unrolling lens ${lens}`] = detail(between, lens, 1, bars, 1);
      frames[`grain lens ${lens}`] = detail(
        GRAIN_KNOBS.ENTRY_RATIO,
        lens,
        1,
        bars,
        1,
      );
    }
    expect(frames).toMatchSnapshot();
  });
});

/**
 * The faces as stamps draw what the faces as paths draw.
 *
 * The field stamps plain marks from an image drawn once (`faceAtlas.ts`)
 * rather than drawing their paths every frame. Each lens's looks must stamp
 * the same pixels its `drawMark` paints, up to the resampling a stamp placed
 * between pixels has.
 */
import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import {
  byDate,
  layoutField,
  planPlacementFlights,
  type FieldEntity,
} from '../../../field';
import {
  ARRIVING_NONE,
  LENS_UI,
  lensIndex,
  type LensIdentity,
} from '../../../lenses';
import { drawFieldFaces, faceFlightsOf, type FaceFlight } from '../FieldCanvas';
import {
  faceAtlasFor,
  pumpFaceAtlas,
  stampFor,
  type FaceAtlas,
  type FaceStamping,
  type StampPool,
} from '../faceAtlas';
import {
  nodePresentation,
  type FieldPresentation,
} from '../useFieldController';

const viewport = { width: 380, height: 800 };
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
    nodePresentation({
      entity,
      song: {
        id: entity.entityId,
        revision: 1,
        title: `Song ${index}`,
        caption_summary: '',
        created_at: new Date(entity.createdAtMs).toISOString(),
        duration_ms: 60_000,
        model: 'light',
        seed: 1_000 + index,
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
    }),
  ]),
);

const layout = layoutField({ entities, arrangement: byDate('year'), viewport });
const fit = layout.fitScale;
const camera = { x: layout.fieldCenter.x, y: layout.fieldCenter.y, scale: fit };
const recut = {
  fromCamera: camera,
  toCamera: camera,
  fromFitScale: fit,
  toFitScale: fit,
};

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
  return {
    fill: make('black'),
    stroke,
    ring,
    paper: make('white'),
    stamp: Skia.Paint(),
  };
}

function pixels(draw: (canvas: SkCanvas) => void): Uint8Array {
  const surface = Skia.Surface.Make(viewport.width, viewport.height)!;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('white'));
  draw(canvas);
  surface.flush();
  const image = surface.makeImageSnapshot();
  const out = image.readPixels() as Uint8Array;
  image.dispose();
  surface.dispose();
  return out;
}

function frame(faces: readonly FaceFlight[], lens: number, stamping: FaceStamping | null) {
  return pixels(canvas =>
    drawFieldFaces(
      canvas,
      faces,
      paints(),
      1,
      recut,
      { value: camera } as never,
      { value: fit } as never,
      viewport,
      lens,
      lens,
      1,
      false,
      1,
      -1,
      1,
      Infinity,
      null,
      null,
      0,
      stamping,
    ),
  );
}

function stampingFor(faces: readonly FaceFlight[]): FaceStamping {
  const songs: Record<string, { identities: readonly LensIdentity[] }> = {};
  for (const face of faces) songs[face.entityKey] = { identities: face.identities };
  return {
    atlas: { value: null } as { value: FaceAtlas | null } as never,
    pool: { value: { xforms: [], colors: [] } } as { value: StampPool } as never,
    songs,
    pixelRatio: 1,
    hairlinePx: 1,
  };
}

/** Ink (darkness) in each, and the mean difference per pixel. */
function compare(a: Uint8Array, b: Uint8Array) {
  let inkA = 0;
  let inkB = 0;
  let diff = 0;
  for (let index = 0; index < a.length; index += 4) {
    inkA += 255 - a[index];
    inkB += 255 - b[index];
    diff += Math.abs(a[index] - b[index]);
  }
  return { inkA, inkB, meanDiff: diff / (a.length / 4) };
}

describe('faces as stamps', () => {
  // The stamps are the UI thread's alone (`faceAtlasFor`); Jest runs as the
  // JS thread.
  const runtime = globalThis as { __RUNTIME_KIND?: number };
  const jsKind = runtime.__RUNTIME_KIND;
  beforeEach(() => {
    runtime.__RUNTIME_KIND = 2;
  });
  afterEach(() => {
    runtime.__RUNTIME_KIND = jsKind;
  });

  it('keeps no stamps, and no worker, on the JS thread', () => {
    runtime.__RUNTIME_KIND = 1;
    const stamping = stampingFor(pinned);
    const lens = lensIndex('name');
    expect(faceAtlasFor(stamping, [lens], 1, paints())).toBeNull();
    expect(stamping.atlas.value).toBeNull();
  });

  const faces = faceFlightsOf(
    planPlacementFlights([], layout.placements, 1),
    presentations,
    null,
    null,
  );
  // The song on the phone for good: full ink, which the web Skia these tests
  // run on can draw both ways. It ignores `drawAtlas`'s colours, so the
  // fainter states are checked through their alphas below; the device draws
  // them (seen on the A52s: find's ghost map at 13 %).
  const pinned = faces.filter(face => face.fill >= 1 && face.weight >= 1);

  it.each([
    ['circle', lensIndex('name')],
    ['seal', lensIndex('seal')],
  ])('the %s stamps what its paths draw', (_, lens) => {
    expect(pinned.length).toBeGreaterThan(0);
    const stamping = stampingFor(pinned);
    const paths = frame(pinned, lens, null);
    // The first frame has no stamps yet: it draws paths and asks for them.
    const asking = frame(pinned, lens, stamping);
    expect(stamping.pool.value.xforms.length).toBe(0);
    expect(compare(paths, asking).meanDiff).toBe(0);
    // The worker draws what was asked for, and the next frame stamps it.
    pumpFaceAtlas(stamping.atlas, Infinity);
    const stamped = frame(pinned, lens, stamping);
    // The stamps were drawn and used.
    expect(stamping.atlas.value).not.toBeNull();
    expect(stamping.pool.value.xforms.length).toBe(pinned.length);
    const { inkA, inkB, meanDiff } = compare(paths, stamped);
    expect(inkA).toBeGreaterThan(0);
    // The same ink, to within what resampling a stamp between pixels moves.
    expect(Math.abs(inkB - inkA) / inkA).toBeLessThan(0.03);
    expect(meanDiff).toBeLessThan(1);
  });

  it('keeps the stamps of a size while the field visits another', () => {
    const lens = lensIndex('name');
    const stamping = stampingFor(pinned);
    const marks = paints();
    const face = pinned[0];
    const ask = (size: number) => {
      // The size held still for two frames, as it is once a zoom has landed.
      faceAtlasFor(stamping, [lens], size, marks);
      const atlas = faceAtlasFor(stamping, [lens], size, marks)!;
      return stampFor(atlas, lens, face.entityKey, face.identities[lens], size);
    };
    expect(ask(1)).toBeNull();
    pumpFaceAtlas(stamping.atlas, Infinity);
    const small = ask(1);
    expect(small).not.toBeNull();
    // Twice the size: the small stamps would blur, so it is drawn as paths
    // until stamps are drawn for it.
    expect(ask(2)).toBeNull();
    pumpFaceAtlas(stamping.atlas, Infinity);
    expect(ask(2)?.size).toBe(2);
    // Back at the first size, its stamps are still there: nothing to draw.
    expect(ask(1)).toBe(small);
    // Mid-zoom, a size between the two is served by the bigger stamps.
    const moving = faceAtlasFor(stamping, [lens], 1.5, marks)!;
    expect(
      stampFor(moving, lens, face.entityKey, face.identities[lens], 1.5)?.size,
    ).toBe(2);
  });

  it('gives each look the alpha its paths are drawn at', () => {
    const out = [0, 0];
    const circle = LENS_UI[lensIndex('name')].sprites!;
    // An outline: drawn at alpha × weight.
    expect(circle.alphas(0.5, 0.38, 0, ARRIVING_NONE, out)).toBe(true);
    expect(out).toEqual([0, 0.19]);
    // Filled: fill and outline at alpha × weight, as one look.
    expect(circle.alphas(0.5, 1, 1, ARRIVING_NONE, out)).toBe(true);
    expect(out).toEqual([0.5, 0]);
    // Between the two, or downloading: drawn as paths.
    expect(circle.alphas(1, 1, 0.5, ARRIVING_NONE, out)).toBe(false);
    expect(circle.alphas(1, 1, 1, 0.4, out)).toBe(false);

    const seal = LENS_UI[lensIndex('seal')].sprites!;
    expect(seal.alphas(0.5, 0.38, 0, ARRIVING_NONE, out)).toBe(true);
    expect(out).toEqual([0.19, 0]);
    expect(seal.alphas(0.5, 1, 1, ARRIVING_NONE, out)).toBe(true);
    expect(out).toEqual([0, 0.5]);
    // Filled with a fainter spindle is not one look.
    expect(seal.alphas(1, 0.85, 1, ARRIVING_NONE, out)).toBe(false);
  });
});

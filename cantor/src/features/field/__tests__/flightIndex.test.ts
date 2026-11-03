/**
 * The position index answers a superset of what is on the screen.
 *
 * `flightIndex.ts` files every flight by the box it can stand in, so a frame
 * walks only those under its view. Whatever it skips must be something the
 * exact cull would have skipped too: a field drawn through the index is the
 * field drawn without it, pixel for pixel.
 */
import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import {
  byDate,
  layoutField,
  planPlacementFlights,
  type FieldEntity,
} from '../../../field';
import { lensIndex } from '../../../lenses';
import { drawFieldFaces, faceFlightsOf, type FaceFlight } from '../FieldCanvas';
import {
  buildFlightIndex,
  queryFlightIndex,
  viewRect,
  type FlightSeat,
} from '../flightIndex';
import {
  nodePresentation,
  type FieldPresentation,
} from '../useFieldController';

const viewport = { width: 380, height: 800 };

const entities: FieldEntity[] = Array.from({ length: 160 }, (_, index) => ({
  key: `node-a:song-${index}`,
  nodePublicKey: 'node-a',
  entityId: `song-${index}`,
  kind: 'song' as const,
  // A song every two to five days: weeks of one, of none, and of several.
  createdAtMs: Date.UTC(2026, 7, 8) - index * ((index % 4) + 2) * 86_400_000,
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
      localAudio: { state: 'pinned', bytes: 0 },
    }),
  ]),
);

const weeks = layoutField({ entities, arrangement: byDate('week'), viewport });
const years = layoutField({ entities, arrangement: byDate('year'), viewport });

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
  return { fill: make('black'), stroke, ring, paper: make('white') };
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

type Camera = { x: number; y: number; scale: number };

function frame(
  faces: readonly FaceFlight[],
  from: Camera,
  to: Camera,
  fit: number,
  progress: number,
  indexed: boolean,
) {
  const lens = lensIndex('name');
  const index = indexed
    ? buildFlightIndex(
        faces,
        face => face,
        face => (face.timing === null ? 0 : face.timing.bowPx),
        face => face.isPlayer,
      )
    : null;
  return pixels(canvas =>
    drawFieldFaces(
      canvas,
      faces,
      paints(),
      progress,
      { fromCamera: from, toCamera: to, fromFitScale: fit, toFitScale: fit },
      { value: to } as never,
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
      null,
      null,
      false,
      null,
      1,
      null,
      false,
      index,
    ),
  );
}

function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function ink(image: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < image.length; index += 4) total += 255 - image[index];
  return total;
}

describe('the position index', () => {
  const fit = weeks.fitScale;
  const settled = faceFlightsOf(
    planPlacementFlights([], weeks.placements, 1),
    presentations,
    null,
    null,
  );
  const center = weeks.fieldCenter;
  const someone = weeks.placements[37];
  const cameras: [string, Camera][] = [
    ['the map', { x: center.x, y: center.y, scale: fit }],
    ['part way down the map', { x: center.x, y: center.y + 900 / fit, scale: fit }],
    ['a shelf', { x: someone.x, y: someone.y, scale: fit * 3 }],
    ['inside a song', { x: someone.x, y: someone.y, scale: fit * 12 }],
  ];

  it.each(cameras)('draws %s as the full walk does', (_, camera) => {
    const plain = frame(settled, camera, camera, fit, 1, false);
    const indexed = frame(settled, camera, camera, fit, 1, true);
    expect(ink(plain)).toBeGreaterThan(0);
    expect(samePixels(indexed, plain)).toBe(true);
  });

  it('walks a small part of the field standing inside a song', () => {
    const [, camera] = cameras[3];
    const index = buildFlightIndex(settled, face => face, () => 0, () => false);
    const rect = viewRect(camera.x, camera.y, camera.scale, viewport.width, viewport.height, 400);
    const walked = queryFlightIndex(index, rect.minX, rect.minY, rect.maxX, rect.maxY);
    expect(walked.length).toBeGreaterThan(0);
    expect(walked.length).toBeLessThan(settled.length / 2);
  });

  it('draws a re-cut in flight as the full walk does', () => {
    const moving = faceFlightsOf(
      planPlacementFlights(weeks.placements, years.placements, 2),
      presentations,
      null,
      null,
    );
    const from = { x: center.x, y: center.y + 400 / fit, scale: fit };
    const to = { x: years.fieldCenter.x, y: years.fieldCenter.y, scale: years.fitScale };
    for (const progress of [0, 0.3, 0.6, 1]) {
      const plain = frame(moving, from, to, fit, progress, false);
      const indexed = frame(moving, from, to, fit, progress, true);
      expect(samePixels(indexed, plain)).toBe(true);
    }
  });

  it('answers every box under the view, in order, and the ones it must always', () => {
    let state = 7;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const seats: FlightSeat[] = Array.from({ length: 500 }, () => {
      const x = random() * 1000;
      const y = random() * 4000;
      const far = random() < 0.05;
      return {
        fromX: x,
        fromY: y,
        targetX: far ? random() * 1000 : x + random() * 20,
        targetY: far ? random() * 4000 : y + random() * 20,
        fromBloomX: random() * 10 - 5,
        fromBloomY: random() * 10 - 5,
        targetBloomX: random() * 10 - 5,
        targetBloomY: random() * 10 - 5,
      };
    });
    const index = buildFlightIndex(
      seats,
      seat => seat,
      () => 0,
      seat => seat === seats[3],
    );
    for (let trial = 0; trial < 200; trial++) {
      const minX = random() * 1100 - 50;
      const minY = random() * 4100 - 50;
      const maxX = minX + random() * 300;
      const maxY = minY + random() * 600;
      const answer = [...queryFlightIndex(index, minX, minY, maxX, maxY)];
      expect(answer).toEqual([...answer].sort((a, b) => a - b));
      expect(new Set(answer).size).toBe(answer.length);
      expect(answer).toContain(3);
      seats.forEach((seat, at) => {
        const xs = [seat.fromX, seat.fromX + seat.fromBloomX, seat.targetX, seat.targetX + seat.targetBloomX];
        const ys = [seat.fromY, seat.fromY + seat.fromBloomY, seat.targetY, seat.targetY + seat.targetBloomY];
        const meets =
          Math.min(...xs) <= maxX &&
          Math.max(...xs) >= minX &&
          Math.min(...ys) <= maxY &&
          Math.max(...ys) >= minY;
        if (meets) expect(answer).toContain(at);
      });
    }
  });
});

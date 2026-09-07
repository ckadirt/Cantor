/**
 * The field's faces, read straight out of the loop that draws them.
 *
 * `drawFieldFaces` replaced one component per placement with one pass over an
 * array, so the thing worth pinning moved too: there are no nodes left to walk
 * for a transform. A recording canvas is the honest reading — it is the same
 * sequence of calls Skia will receive, in the same order.
 */
import { Skia, type SkCanvas } from '@shopify/react-native-skia';
import {
  byDate,
  layoutField,
  planPlacementFlights,
  type Camera,
  type FieldEntity,
} from '../../../field';
import { drawFieldFaces, faceFlightsOf, type FaceFlight } from '../FieldCanvas';
import { playerFaceScale } from '../songPose';
import type { FieldPresentation } from '../useFieldController';

const viewport = { width: 380, height: 800 };

const entities: FieldEntity[] = ['song-a', 'song-b', 'song-c'].map(
  (entityId, index) => ({
    key: `node-a:${entityId}`,
    nodePublicKey: 'node-a',
    entityId,
    kind: 'song' as const,
    createdAtMs: Date.UTC(2026, 7, 8 - index),
    durationMs: 0,
    tags: [],
  }),
);

const presentations: ReadonlyMap<string, FieldPresentation> = new Map(
  entities.map(entity => [
    entity.key,
    {
      entity,
      song: {
        id: entity.entityId,
        revision: 1,
        title: `Song ${entity.entityId}`,
        caption_summary: '',
        created_at: new Date(entity.createdAtMs).toISOString(),
        duration_ms: 11_000,
        model: 'light',
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
      localAudio: { state: 'remote', bytes: 0 },
    } as FieldPresentation,
  ]),
);

/** A canvas that answers every call by writing it down. */
function recordingCanvas() {
  const scales: number[] = [];
  const circles: Array<{ x: number; r: number }> = [];
  let paths = 0;
  const canvas = {
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: (sx: number) => scales.push(sx),
    drawPath: () => {
      paths += 1;
    },
    drawCircle: (x: number, _y: number, r: number) => circles.push({ x, r }),
  };
  return {
    canvas: canvas as unknown as SkCanvas,
    scales,
    circles,
    paths: () => paths,
  };
}

function facePaints() {
  const make = () => Skia.Paint();
  return { fill: make(), stroke: make(), ring: make() };
}

const layout = layoutField({
  entities,
  arrangement: byDate('year'),
  viewport,
});

const settled: Camera = {
  x: layout.fieldCenter.x,
  y: layout.fieldCenter.y,
  scale: layout.fitScale,
};

/** The re-cut this field has already finished; the clock below stands at 1. */
const recut = {
  fromCamera: settled,
  toCamera: settled,
  fromFitScale: layout.fitScale,
  toFitScale: layout.fitScale,
};

function facesAt(focusKey: string | null, playingKey: string | null) {
  return faceFlightsOf(
    planPlacementFlights([], layout.placements, 1),
    presentations,
    focusKey,
    playingKey,
  );
}

function drawAt(
  faces: readonly FaceFlight[],
  camera: Camera,
): ReturnType<typeof recordingCanvas> {
  const target = recordingCanvas();
  drawFieldFaces(
    target.canvas,
    faces,
    facePaints(),
    1,
    recut,
    { value: camera } as never,
    { value: layout.fitScale } as never,
    viewport,
  );
  return target;
}

/** The whole field in frame, which is what L0 means. */
const atField: Camera = settled;

describe('the field drawn as one pass', () => {
  it('draws every placement at L0', () => {
    const faces = facesAt(null, null);
    expect(faces.length).toBe(layout.placements.length);
    expect(faces.length).toBeGreaterThan(1);
    expect(drawAt(faces, atField).paths()).toBe(faces.length);
  });

  /**
   * One face grows into the player; every other stays at its row seat.
   *
   * The gate this pins has been lost twice — once when the player was first
   * drawn here, once when the pose was hoisted to be shared for its setup
   * cost. Both times the words stayed correct and the drawing did not, because
   * the pose is a function of the camera and the camera cannot tell one song
   * from another. Here `isPlayer` is a field on the row rather than a choice
   * made beside it, so there is nothing left to hoist it out of.
   */
  it('grows one face into the player and leaves every other at its row seat', () => {
    const held = layout.placements[0];
    const faces = facesAt(held.key, null);
    const player = faces.filter(face => face.isPlayer);
    expect(player).toHaveLength(1);
    expect(faces.length).toBeGreaterThan(1);

    /*
     * Where the shape has grown and the row has not yet gone.
     *
     * `SHAPE_GROW` runs to 13 and the row band does not close until 29, so
     * this is the one stretch where a player face and an ordinary face are
     * both on the canvas — which is what makes the difference between them
     * readable. Further in, an ordinary mark is not drawn at all, and the
     * comparison would be against nothing.
     *
     * Centred on the placement, because at this distance its neighbours are
     * off screen and the loop rightly drops them.
     */
    const atSong: Camera = {
      x: held.x,
      y: held.y,
      scale: layout.fitScale * 12.5,
    };
    const asMark = [{ ...player[0], isPlayer: false }];
    const grownScales = drawAt(player, atSong).scales;
    const markScales = drawAt(asMark, atSong).scales;

    // The same seat, the same camera, the same frame — one gate between them.
    expect(grownScales).toHaveLength(1);
    expect(markScales).toHaveLength(1);
    expect(grownScales[0]).toBeGreaterThan(markScales[0]);
    /*
     * And the ordinary one is the same size here as it was a whole band out.
     *
     * This is the gate itself, stated as an equality: `shapeArrived` is very
     * different at 6× and at 12.5×, and an ordinary mark may not notice. When
     * the pose was shared across the field these two numbers came apart, and
     * every mark on screen was part-way to the player's size.
     */
    const walkedOnly: Camera = { ...atSong, scale: layout.fitScale * 6 };
    expect(drawAt(asMark, walkedOnly).scales).toEqual(markScales);
    expect(markScales[0]).toBeLessThan(playerFaceScale(viewport.width));
  });

  /** The ring belongs to the song making sound, and to no other. */
  it('rings only the playing song', () => {
    const playing = layout.placements[0];
    const faces = facesAt(null, playing.entityKey);
    expect(drawAt(faces, atField).circles).toHaveLength(1);
    expect(drawAt(facesAt(null, null), atField).circles).toHaveLength(0);
  });

  /**
   * A mark off screen is not drawn, which is the thing the node renderer could
   * not do: its answer would have had to come back through React to unmount
   * anything, and by then the camera has moved.
   */
  it('draws nothing for a camera the field has left behind', () => {
    const faces = facesAt(null, null);
    const elsewhere: Camera = { ...settled, x: settled.x + 1e6 };
    expect(drawAt(faces, elsewhere).paths()).toBe(0);
  });
});

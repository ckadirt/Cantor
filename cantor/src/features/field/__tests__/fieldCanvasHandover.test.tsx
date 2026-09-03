/**
 * The L0 → L1 handover: the picture appears where the camera already is.
 *
 * Skia's reanimated container plays the first frame of a redraw straight from
 * the values the JS thread holds, and only then starts the mapper that keeps
 * them live. So the frame that introduces the picture is painted at whatever
 * `pictureCamera` last said. While the native path owns the canvas there is no
 * picture to correct — which is exactly why the record camera has to keep
 * being written anyway: an L0 pan that never touched it would leave it at the
 * camera of the last picture recorded, one shelf ago, and the crossing would
 * paint one frame there before snapping back.
 */
import React from 'react';
import { Picture, Skia, Text } from '@shopify/react-native-skia';
import ReactTestRenderer from 'react-test-renderer';
import {
  REPRESENTATION_WINDOWS,
  byDate,
  isNativeDrawnDistance,
  layoutField,
  planPlacementFlights,
  representationAlphas,
  type Camera,
  type FieldEntity,
  type FieldLayout,
} from '../../../field';
import { FieldCanvas, pictureTransformFor } from '../FieldCanvas';
import type { FieldPresentation } from '../useFieldController';
import type { FieldRecutModel } from '../useFieldCamera';

/** Every shared value the canvas built, in creation order. */
const sharedValues: Array<{ value: unknown }> = [];

jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  const react = require('react');
  return {
    ...actual,
    /**
     * Ref-backed, because the library's mock is not.
     *
     * `react-native-reanimated/mock` builds a fresh `{ value }` on every
     * render, so a value written in one render is gone by the next — and
     * whether a written value survives to the next render is the whole of what
     * this file tests. The real hook keeps one object for the component's life,
     * which is what this does.
     */
    useSharedValue: (initial: unknown) => {
      const held: { current: { value: unknown } | null } =
        react.useRef(null);
      if (held.current === null) {
        held.current = { value: initial };
        sharedValues.push(held.current);
      }
      return held.current;
    },
  };
});

let mockFont: ReturnType<typeof Skia.Font> | null = null;

// CanvasKit's system font manager is empty under Jest, so hand the canvas a
// face built the way the other canvas tests build one.
jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => mockFont,
}));

const viewport = { width: 380, height: 800 };

const entities: FieldEntity[] = [
  {
    key: 'node-a:song-a',
    nodePublicKey: 'node-a',
    entityId: 'song-a',
    kind: 'song',
    createdAtMs: Date.UTC(2026, 7, 8),
    durationMs: 0,
    tags: [],
  },
  {
    key: 'node-a:song-b',
    nodePublicKey: 'node-a',
    entityId: 'song-b',
    kind: 'song',
    createdAtMs: Date.UTC(2026, 6, 8),
    durationMs: 0,
    tags: [],
  },
];

const palette = {
  bg: '#FFFFFF',
  ink: '#000000',
  muted: '#666666',
  faint: '#A6A6A6',
  line: '#E6E6E6',
};

const backend = {
  nodePubkey: 'node-a',
  relayUrl: 'wss://relay.example',
  petname: 'Studio',
  lastNodeInfo: null,
};

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
      backend,
      ready: true,
      nodeLabels: ['Studio'],
      delivery: undefined,
      localAudio: { state: 'remote', bytes: 0 },
    } as FieldPresentation,
  ]),
);

function cameraFor(layout: FieldLayout): Camera {
  return {
    x: layout.fieldCenter.x,
    y: layout.fieldCenter.y,
    scale: layout.fitScale,
  };
}

describe('field canvas L0 to L1 handover', () => {
  const month = layoutField({
    entities,
    arrangement: byDate('month'),
    viewport,
  });
  const year = layoutField({ entities, arrangement: byDate('year'), viewport });

  beforeAll(() => {
    mockFont = Skia.Font(undefined, 9);
  });

  beforeEach(() => {
    sharedValues.length = 0;
  });

  /**
   * The reason the native renderer had to learn the row.
   *
   * A recorded picture moves by being scaled, and a row is measured in screen
   * pixels from end to end. So the picture may only take over once there is
   * nothing left on screen whose size the scale would falsify — which is where
   * the player opens, not where the row band does.
   */
  it('keeps the picture out of the whole span where rows are drawn', () => {
    const fit = month.fitScale;
    for (const ratio of [1.2, 2, 3.6, 11.9]) {
      const alphas = representationAlphas(fit * ratio, fit);
      expect(alphas.row + alphas.dot).toBeGreaterThan(0);
      expect(isNativeDrawnDistance(fit * ratio, fit)).toBe(true);
    }
    // And it does take over for the player, which the native path does not
    // know how to draw.
    expect(
      isNativeDrawnDistance(fit * REPRESENTATION_WINDOWS.song[0], fit),
    ).toBe(false);
  });

  it('draws a row on the native path rather than handing over to the picture', async () => {
    const recut: FieldRecutModel = {
      generation: 1,
      layout: year,
      flights: planPlacementFlights(month.placements, year.placements, 1),
      fromFitScale: month.fitScale,
      toFitScale: year.fitScale,
      fromCamera: cameraFor(month),
      toCamera: cameraFor(year),
      fromGroups: month.groups,
      animate: true,
      nativeDriven: true,
    };
    // Deep inside the row band, where the picture used to own the field and
    // where a zoom inflated every title it had baked.
    const inRowBand = {
      ...cameraFor(year),
      scale: year.fitScale * 3,
    };
    const cameraShared = { value: inRowBand };
    const fitScaleShared = { value: year.fitScale };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <FieldCanvas
          camera={inRowBand}
          cameraShared={cameraShared as never}
          fitScaleShared={fitScaleShared as never}
          layout={year}
          labelFromGroups={recut.fromGroups}
          palette={palette}
          placements={year.placements}
          nowMs={Date.UTC(2026, 7, 30)}
          recut={recut}
          renderFitScale={year.fitScale}
          transitionGeneration={recut.generation}
          presentations={presentations}
          viewport={viewport}
        />,
      );
    });
    expect(renderer.root.findAllByType(Picture)).toHaveLength(0);
    // The row's own text, as Skia nodes the UI thread can move and fade —
    // never baked into a recording that a scale would stretch.
    const drawn = renderer.root
      .findAllByType(Text)
      .map(node => node.props.text as string);
    // The title, the availability line and the action word: the three strings
    // `nameLens` draws for a row, from the same two functions it calls.
    expect(drawn).toContain('Song song-a');
    expect(drawn).toContain('ON STUDIO');
    expect(drawn).toContain('GET');
  });

  it('holds the record camera level with the live one while L0 owns the canvas', async () => {
    // A cut whose clusters are renamed, because the native path is only taken
    // while there are label flights to carry: month into year is the L0 move
    // the arrangement dial makes.
    const recut: FieldRecutModel = {
      generation: 1,
      layout: year,
      flights: planPlacementFlights(month.placements, year.placements, 1),
      fromFitScale: month.fitScale,
      toFitScale: year.fitScale,
      fromCamera: cameraFor(month),
      toCamera: cameraFor(year),
      fromGroups: month.groups,
      animate: true,
      nativeDriven: true,
    };
    const cameraShared = { value: cameraFor(year) };
    const fitScaleShared = { value: year.fitScale };
    const canvas = (camera: Camera) => (
      <FieldCanvas
        camera={camera}
        cameraShared={cameraShared as never}
        fitScaleShared={fitScaleShared as never}
        layout={year}
        labelFromGroups={recut.fromGroups}
        palette={palette}
        placements={year.placements}
        nowMs={Date.UTC(2026, 7, 30)}
        recut={recut}
        renderFitScale={year.fitScale}
        transitionGeneration={recut.generation}
        presentations={presentations}
        viewport={viewport}
      />
    );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(canvas(cameraFor(year)));
    });
    // The native path is the premise: at FIT there is no picture at all, which
    // is what leaves its camera free to go stale.
    expect(renderer.root.findAllByType(Picture)).toHaveLength(0);
    expect(sharedValues).toHaveLength(1);
    const pictureCamera = sharedValues[0];

    // A pan well past the re-record threshold, mirrored into React the way the
    // camera hook mirrors one.
    const panned = {
      ...cameraFor(year),
      x: cameraFor(year).x + 2000 / year.fitScale,
    };
    cameraShared.value = panned;
    await ReactTestRenderer.act(async () => {
      renderer.update(canvas(panned));
    });
    expect(renderer.root.findAllByType(Picture)).toHaveLength(0);

    // Whatever the crossing paints its first frame with is this transform, and
    // at the moment the picture appears it has to be identity.
    expect(
      pictureTransformFor(pictureCamera.value as Camera, panned, viewport),
    ).toEqual([
      { translateX: viewport.width / 2 },
      { translateY: viewport.height / 2 },
      { scale: 1 },
      { translateX: -viewport.width / 2 },
      { translateY: -viewport.height / 2 },
    ]);
  });
});

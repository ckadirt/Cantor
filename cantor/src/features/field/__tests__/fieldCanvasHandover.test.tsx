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
import { Path, Picture, Skia, Text } from '@shopify/react-native-skia';
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

/** Every string the canvas drew, for a camera and a focused placement. */
async function drawnTextAt(
  recut: FieldRecutModel,
  camera: Camera,
  focusKey: string,
): Promise<string[]> {
  const cameraShared = { value: camera };
  const fitScaleShared = { value: recut.toFitScale };
  const positionSeconds = { value: 0 };
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <FieldCanvas
        camera={camera}
        cameraShared={cameraShared as never}
        fitScaleShared={fitScaleShared as never}
        focusKey={focusKey}
        layout={recut.layout}
        labelFromGroups={recut.fromGroups}
        nowMs={Date.UTC(2026, 7, 30)}
        palette={palette}
        placements={recut.layout.placements}
        positionSeconds={positionSeconds as never}
        presentations={presentations}
        recut={recut}
        renderFitScale={recut.toFitScale}
        transitionGeneration={recut.generation}
        viewport={viewport}
      />,
    );
  });
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.text as string);
}

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
   * The reason the native renderer had to learn the row, and then the player.
   *
   * A recorded picture moves by being scaled, and a row is measured in screen
   * pixels from end to end — as is every part of the player. So the picture may
   * only take over once there is nothing left on screen whose size the scale
   * would falsify, which is where the grain opens: the waveform is drawn from
   * the viewport rather than from the camera, so it is the one representation a
   * recording cannot lie about.
   */
  it('keeps the picture out of the whole span where rows and the player are drawn', () => {
    const fit = month.fitScale;
    for (const ratio of [1.2, 2, 3.6, 11.9]) {
      const alphas = representationAlphas(fit * ratio, fit);
      expect(alphas.row + alphas.dot).toBeGreaterThan(0);
      expect(isNativeDrawnDistance(fit * ratio, fit)).toBe(true);
    }
    for (const ratio of [REPRESENTATION_WINDOWS.song[0], 27, 90, 177]) {
      expect(isNativeDrawnDistance(fit * ratio, fit)).toBe(true);
    }
    // And it does take over for the grain, which the native path does not know
    // how to draw.
    expect(
      isNativeDrawnDistance(fit * REPRESENTATION_WINDOWS.grain[0], fit),
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

  /**
   * The third pose, on the native path: the player is drawn, not laid out.
   *
   * At L2 the picture is still out of the canvas — the ceiling now reaches the
   * grain — and the song's name, its recipe and its transport are Skia nodes
   * hanging off the same mark the row hung off. Nothing here is React chrome
   * over a canvas any more, which is what made the two disagree.
   */
  it('draws the player on the native path at the song band', async () => {
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
    const held = year.placements[0];
    const atSong = { ...cameraFor(year), scale: year.fitScale * 30 };
    expect(isNativeDrawnDistance(atSong.scale, year.fitScale)).toBe(true);
    const drawn = await drawnTextAt(recut, atSong, held.key);
    // The player's own words, which no row has.
    expect(drawn).toContain('PLAY');
    expect(drawn).toContain('ON NODE');
    /*
     * And exactly one player, with two songs in the field.
     *
     * The song band is a function of the camera alone, so anything written
     * against it without asking *which* song this is applies to every mark at
     * once. The words were gated on the model from the start; the face was not,
     * and on the device every song in the field grew to full size at L2 and
     * stacked up. One `DETAIL` is the cheapest way to keep asking.
     */
    expect(drawn.filter(text => text === 'DETAIL')).toHaveLength(1);
    // And the recipe the availability line becomes.
    expect(drawn.some(text => text.startsWith('LIGHT · '))).toBe(true);
  });

  /**
   * The player answers to a *placement*, not to a song.
   *
   * One song can sit in several groups at once — a date mark and a playlist
   * membership are two placements of one entity — and only the one the camera
   * arrived at is the player. Matching on the entity instead drew the player
   * for none of them, because a placement key and an entity key are never the
   * same string.
   */
  it('draws no player for a key that names the entity rather than the seat', async () => {
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
    const held = year.placements[0];
    expect(held.entityKey).not.toBe(held.key);
    const atSong = { ...cameraFor(year), scale: year.fitScale * 30 };
    const drawn = await drawnTextAt(recut, atSong, held.entityKey);
    expect(drawn).not.toContain('DETAIL');
  });

  /**
   * Where the pen cannot be had, the name still arrives.
   *
   * `Skia.Path.MakeFromText` is native-only, and CanvasKit — which is what runs
   * here — answers with a stub rather than refusing. A stub handed to a `Path`
   * node is a blank title, silently, so this pins the fallback: no traced
   * outline, and the glyphs still drawn.
   */
  it('falls back to plain glyphs where no outline can be had', async () => {
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
    const inRowBand = { ...cameraFor(year), scale: year.fitScale * 3 };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <FieldCanvas
          camera={inRowBand}
          cameraShared={{ value: inRowBand } as never}
          fitScaleShared={{ value: year.fitScale } as never}
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
    // The pen's own signature: a round-capped stroke, trimmed rather than
    // faded. Nothing else on this canvas is drawn that way.
    expect(
      renderer.root
        .findAllByType(Path)
        .filter(node => node.props.strokeCap === 'round'),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByType(Text).map(node => node.props.text as string),
    ).toContain('Song song-a');
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

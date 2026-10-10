/**
 * House rule 5, on the field canvas, as the living scene keeps it.
 *
 * A clock shared across cuts must never be read by one cut's drawing while it
 * belongs to another's: that is how the destination once flashed for a frame
 * after a back-and-forth on the arrangement dial. The canvas used to keep the
 * rule by building a scene per cut, each with a born clock. Now it has one
 * scene and one clock, and keeps it by installing a cut and restarting the
 * clock in the same UI-thread task (`livingScene.ts`).
 */
import React from 'react';
import { Canvas, Skia } from '@shopify/react-native-skia';
import ReactTestRenderer from 'react-test-renderer';
import {
  byDate,
  layoutField,
  planPlacementFlights,
  type Camera,
  type FieldEntity,
  type FieldLayout,
} from '../../../field';
import { FieldCanvas } from '../FieldCanvas';
import {
  nodePresentation,
  type FieldPresentation,
  type JobPresentation,
  type NodePresentation,
} from '../useFieldController';
import type { FieldRecutModel } from '../useFieldCamera';

const mockBornClocks: Array<{ born: number; clock: { value: number } }> = [];

// CanvasKit's system font manager is empty under Jest, so hand the canvas a
// face built the way the other canvas tests build one.
let mockFont: ReturnType<typeof Skia.Font> | null = null;

jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => mockFont,
  useFontScaledStyle: (style: unknown) => style,
}));

jest.mock('../../../motion/clock', () => ({
  __esModule: true,
  bornClock: (start: number) => {
    const clock = { value: start };
    mockBornClocks.push({ born: start, clock });
    return clock;
  },
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
  spine: '#D4D4D4',
};

function cameraFor(layout: FieldLayout): Camera {
  return {
    x: layout.fieldCenter.x,
    y: layout.fieldCenter.y,
    scale: layout.fitScale,
  };
}

function recutBetween(
  generation: number,
  from: FieldLayout,
  to: FieldLayout,
  animate: boolean,
): FieldRecutModel {
  return {
    generation,
    layout: to,
    flights: planPlacementFlights(from.placements, to.placements, generation),
    fromFitScale: from.fitScale,
    toFitScale: to.fitScale,
    fromCamera: cameraFor(from),
    toCamera: cameraFor(to),
    fromGroups: from.groups,
    animate,
  };
}

const backend = {
  nodePubkey: 'node-a',
  relayUrl: 'wss://relay.example',
  petname: 'Studio',
  lastNodeInfo: null,
};

const presentations: ReadonlyMap<string, FieldPresentation> = new Map(
  entities.map(entity => [
    entity.key,
    nodePresentation({
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
    }),
  ]),
);

describe('field canvas re-cut clock', () => {
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
    mockBornClocks.length = 0;
  });

  /** The living scene's shared values, as the canvas hands them to it. */
  const sceneOf = (renderer: ReactTestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByType(Canvas)[0].props.children.props.children[0].props
      .scene as {
      cut: { value: { generation: number; labels: readonly unknown[] } | null };
      clock: { value: number };
    };

  it('installs each cut with its clock at the start, on the scene it already has', async () => {
    // A clock that does not run: what the first frame after an install reads.
    const reanimated = require('react-native-reanimated');
    const timing = jest
      .spyOn(reanimated, 'withTiming')
      .mockImplementation(() => 0 as never);
    const cameraShared = { value: cameraFor(month) };
    const fitScaleShared = { value: month.fitScale };
    const canvas = (recut: FieldRecutModel, layout: FieldLayout, nowMs = 0) => (
      <FieldCanvas
        cameraShared={cameraShared as never}
        fitScaleShared={fitScaleShared as never}
        layout={layout}
        labelFromGroups={recut.fromGroups}
        palette={palette}
        nowMs={nowMs}
        recut={recut}
        transitionGeneration={recut.generation}
        presentations={presentations}
        viewport={viewport}
      />
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        canvas(recutBetween(1, month, month, false), month),
      );
    });
    const element = renderer.root.findAllByType(Canvas)[0].props.children;
    const scene = sceneOf(renderer);
    // A cut that does not animate lands at once, so reduced motion shows the
    // new arrangement rather than one stale frame of the old one.
    expect(scene.cut.value?.generation).toBe(1);
    expect(scene.clock.value).toBe(1);

    await ReactTestRenderer.act(async () => {
      renderer.update(canvas(recutBetween(2, month, year, true), year));
    });
    // The new cut and its clock's start arrive together.
    expect(scene.cut.value?.generation).toBe(2);
    expect(scene.clock.value).toBe(0);
    // On the scene the canvas already had: a re-cut builds nothing.
    expect(renderer.root.findAllByType(Canvas)[0].props.children).toBe(element);
    expect(sceneOf(renderer)).toBe(scene);

    // A render that is not a new cut leaves the clock where it is.
    scene.clock.value = 0.5;
    await ReactTestRenderer.act(async () => {
      renderer.update(canvas(recutBetween(2, month, year, true), year, 1));
    });
    expect(scene.clock.value).toBe(0.5);
    timing.mockRestore();
    await ReactTestRenderer.act(async () => renderer.unmount());
  });

  it('starts an interrupting re-cut from where the names were drawn', async () => {
    // The names' outlines are native-only (CanvasKit's are stubs), so their
    // capture answers as it does without them; where they are is the question.
    const labelMorph = require('../labelMorph');
    jest.spyOn(labelMorph, 'captureLabelText').mockReturnValue(null);
    jest.spyOn(labelMorph, 'captureLabelMorph').mockReturnValue(null);
    const nativeLabels = require('../nativeLabels');
    const prepared = jest.spyOn(nativeLabels, 'prepareNativeLabels');
    const cameraShared = { value: cameraFor(year) };
    const fitScaleShared = { value: year.fitScale };
    const canvas = (recut: FieldRecutModel, from: FieldLayout) => (
      <FieldCanvas
        cameraShared={cameraShared as never}
        fitScaleShared={fitScaleShared as never}
        layout={recut.layout}
        labelFromGroups={from.groups}
        palette={palette}
        nowMs={Date.UTC(2026, 7, 30)}
        recut={recut}
        transitionGeneration={recut.generation}
        presentations={presentations}
        viewport={viewport}
      />
    );
    type Flight = {
      fromGroupKey: string | null;
      toGroupKey: string | null;
      from: { x: number; y: number };
      to: { x: number; y: number };
    };
    const lastLabels = () =>
      prepared.mock.calls.slice(-1)[0][0] as readonly Flight[];

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        canvas(recutBetween(1, month, year, true), month),
      );
    });
    const first = lastLabels();
    // Halfway through, as the UI thread would have it when the dial is
    // tapped again. The clock is already eased: this is where the canvas drew.
    sceneOf(renderer).clock.value = 0.5;
    await ReactTestRenderer.act(async () => {
      renderer.update(canvas(recutBetween(2, year, month, true), year));
    });
    const second = lastLabels();

    const moved = first.filter(
      flight =>
        flight.toGroupKey !== null &&
        (flight.from.x !== flight.to.x || flight.from.y !== flight.to.y),
    );
    expect(moved.length).toBeGreaterThan(0);
    // Each group keeps one capture — several months can fly into one year —
    // so a resumed name starts where one of the names flying into its group
    // was drawn: halfway, not at either end of the flight it interrupted.
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    for (const group of new Set(moved.map(flight => flight.toGroupKey))) {
      const resumed = second.find(next => next.fromGroupKey === group);
      expect(resumed).toBeDefined();
      const drawnAt = first
        .filter(flight => flight.toGroupKey === group)
        .map(flight => ({
          x: flight.from.x + (flight.to.x - flight.from.x) * 0.5,
          y: flight.from.y + (flight.to.y - flight.from.y) * 0.5,
        }));
      expect(
        drawnAt.some(
          point =>
            near(point.x, resumed!.from.x) && near(point.y, resumed!.from.y),
        ),
      ).toBe(true);
    }
    await ReactTestRenderer.act(async () => renderer.unmount());
    jest.restoreAllMocks();
  });

  /**
   * Skia re-renders the canvas from a layout effect keyed on the children
   * *element*, and its reanimated container's redraw stops the animation
   * mapper, re-records the tree from whatever the JS thread holds, paints that
   * frame, and only then restarts the mapper. A fresh element on every camera
   * render therefore paints a stale frame of the whole scene between two live
   * ones — which is what a pan looked like.
   */
  it.each(['name', 'seal'])(
    'keeps the %s scene while the camera moves or the lens changes',
    async lens => {
      const recut = recutBetween(1, month, year, true);
      const cameraShared = { value: cameraFor(month) };
      const fitScaleShared = { value: month.fitScale };
      const canvas = (camera: Camera, activeLensKey = lens) => (
        <FieldCanvas
          activeLensKey={activeLensKey}
          cameraShared={cameraShared as never}
          fitScaleShared={fitScaleShared as never}
          layout={year}
          labelFromGroups={recut.fromGroups}
          palette={palette}
          nowMs={Date.UTC(2026, 7, 30)}
          recut={recut}
          transitionGeneration={recut.generation}
          presentations={presentations}
          viewport={viewport}
        />
      );

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(canvas(cameraFor(year)));
      });
      const scene = renderer.root.findAllByType(Canvas)[0].props.children;
      // The native path is what this is about; a picture would legitimately be
      // rebuilt on every camera frame.
      expect(scene).not.toBeNull();

      const panned = { ...cameraFor(year), x: cameraFor(year).x + 240 };
      await ReactTestRenderer.act(async () => {
        renderer.update(canvas(panned));
      });
      expect(renderer.root.findAllByType(Canvas)[0].props.children).toBe(scene);
      await ReactTestRenderer.act(async () => {
        renderer.update(canvas(panned, lens === 'name' ? 'seal' : 'name'));
      });
      expect(renderer.root.findAllByType(Canvas)[0].props.children).toBe(scene);
    },
  );
  it('keeps songs on the same native scene across live job progress updates', async () => {
    const recut = recutBetween(1, year, year, false);
    const cameraShared = { value: cameraFor(year) };
    const fitScaleShared = { value: year.fitScale };
    const entity = entities[1];
    const songs = new Map([
      [entities[0].key, presentations.get(entities[0].key)!],
    ]);
    const pending: JobPresentation = {
      entity: { ...entity, kind: 'job' },
      backend,
      nodeLabels: ['Studio'],
      caption: 'working',
      request: null,
      declaredStages: [],
      job: {
        id: entity.entityId,
        revision: 1,
        state: 'running',
        model: 'light',
        created_at: '2026-08-08T00:00:00Z',
        updated_at: '2026-08-08T00:00:00Z',
      },
    };
    // One object per revision, as the controller hands back an unchanged job.
    const revisions = new Map<number, JobPresentation>();
    const jobAt = (revision: number) => {
      const kept = revisions.get(revision);
      if (kept !== undefined) return kept;
      const next = {
        ...pending,
        job: {
          ...pending.job,
          revision,
          progress: { completed: revision, total: 8, unit: 'steps' },
        },
      } as JobPresentation;
      revisions.set(revision, next);
      return next;
    };
    const render = (revision: number) => (
      <FieldCanvas
        cameraShared={cameraShared as never}
        fitScaleShared={fitScaleShared as never}
        layout={year}
        palette={palette}
        viewport={viewport}
        recut={recut}
        transitionGeneration={1}
        nowMs={0}
        presentations={
          new Map(
            [...songs].map(([key, value]) => [
              key,
              {
                ...(value as NodePresentation),
                nodeLabels: [...(value as NodePresentation).nodeLabels],
              },
            ]),
          )
        }
        jobs={new Map([[entity.key, jobAt(revision)]])}
      />
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(render(1));
    });
    // Jobs are a layer of the song scene, not a surface over it: the only
    // other canvas is the moving player's (`PlayerMotionLayer`).
    const canvases = renderer.root.findAllByType(Canvas);
    expect(canvases).toHaveLength(2);
    const scene = canvases[0].props.children;
    const jobMarks = scene.props.children[0].props.jobMarks;
    const first = jobMarks.value[entity.key];
    expect(first).toBeDefined();
    await ReactTestRenderer.act(async () => {
      renderer.update(render(2));
    });
    // Progress reaches the drawing through the shared value, and the canvas is
    // handed the element it already had — nothing repaints from React.
    expect(renderer.root.findAllByType(Canvas)[0].props.children).toBe(scene);
    expect(jobMarks.value[entity.key]).toBeDefined();
    expect(jobMarks.value[entity.key] === first).toBe(false);
    // A render with nothing new records nothing new.
    const second = jobMarks.value;
    await ReactTestRenderer.act(async () => {
      renderer.update(render(2));
    });
    expect(jobMarks.value === second).toBe(true);
    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });
});

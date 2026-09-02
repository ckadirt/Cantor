import React from 'react';
import { Skia } from '@shopify/react-native-skia';
import ReactTestRenderer from 'react-test-renderer';
import type { ArtifactView } from '../../../../../protocol/ArtifactView';
import type { SongHeader } from '../../../../../protocol/SongHeader';
import { byTime, layoutField, worldToScreen } from '../../../field';
import { FieldA11yList } from '../FieldA11yList';
import { pictureTransformFor, recordFieldPicture } from '../FieldCanvas';
import type { FieldPresentation } from '../useFieldController';

const viewport = { width: 380, height: 800 };
const artifact: ArtifactView = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg; codecs=opus',
  byte_length: 900,
  sha256: 'a'.repeat(64),
  sample_rate: 48_000,
  channels: 2,
};
const song: SongHeader = {
  id: 'song-a',
  revision: 1,
  title: 'A field song',
  caption_summary: 'A test song',
  created_at: '2026-08-08T00:00:00Z',
  duration_ms: 11_000,
  model: 'light',
  favorite: false,
  tags: [],
  trashed: false,
  artifacts: [artifact],
};
const entity = {
  key: 'node-a:song-a',
  nodePublicKey: 'node-a',
  entityId: 'song-a',
  kind: 'song' as const,
  createdAtMs: Date.parse(song.created_at),
  durationMs: 0,
  tags: [],
};
const presentation: FieldPresentation = {
  entity,
  song,
  backend: {
    nodePubkey: 'node-a',
    relayUrl: 'wss://relay.example',
    petname: 'Studio',
    lastNodeInfo: null,
  },
  ready: true,
  nodeLabels: ['Studio'],
  delivery: artifact,
  localAudio: { state: 'cached', bytes: artifact.byte_length },
};

function paint(color: string) {
  const result = Skia.Paint();
  result.setColor(Skia.Color(color));
  return result;
}

describe('field canvas and accessibility mirror', () => {
  const layout = layoutField({
    entities: [entity],
    arrangement: byTime,
    viewport,
  });
  const camera = {
    x: layout.fieldCenter.x,
    y: layout.fieldCenter.y,
    scale: layout.fitScale,
  };

  it('records one drawable picture from prepared data', () => {
    const display = Skia.Font(undefined, 20);
    const mono = Skia.Font(undefined, 9);
    const picture = recordFieldPicture({
      layout,
      placements: layout.placements,
      camera,
      viewport,
      presentations: new Map([[entity.key, presentation]]),
      palette: {
        bg: '#FFFFFF',
        ink: '#000000',
        muted: '#666666',
        faint: '#A6A6A6',
        line: '#E6E6E6',
      },
      lensKey: 'name',
      nowMs: Date.UTC(2026, 7, 30),
      fonts: { display, body: display, mono },
      paints: {
        ink: paint('#000000'),
        muted: paint('#666666'),
        faint: paint('#A6A6A6'),
      outline: paint('#A6A6A6'),
      },
    });
    expect(picture).not.toBeNull();
    // The native SkPicture interface intentionally exposes no bounds getter.
    // Recording successfully is the contract we need here.
    expect(picture).toBeTruthy();
  });

  it('records the playing mark without leaving a stroked paint behind', () => {
    const display = Skia.Font(undefined, 20);
    const mono = Skia.Font(undefined, 9);
    const ink = paint('#000000');
    // CanvasKit's Paint exposes no style getter, so watch the writes instead.
    const styles: number[] = [];
    const setStyle = ink.setStyle.bind(ink);
    ink.setStyle = (style: number) => {
      styles.push(style);
      setStyle(style);
    };
    const record = (playingKey: string | null) =>
      recordFieldPicture({
        layout,
        placements: layout.placements,
        camera,
        viewport,
        presentations: new Map([[entity.key, presentation]]),
        palette: {
          bg: '#FFFFFF',
          ink: '#000000',
          muted: '#666666',
          faint: '#A6A6A6',
          line: '#E6E6E6',
        },
        playingKey,
        lensKey: 'name',
        nowMs: Date.UTC(2026, 7, 30),
        fonts: { display, body: display, mono },
        paints: {
          ink,
          muted: paint('#666666'),
          faint: paint('#A6A6A6'),
          outline: paint('#000000'),
        },
      });

    expect(record(entity.key)).toBeTruthy();
    // Paints are shared across the whole picture: a ring that forgot to restore
    // the fill style would silently outline everything drawn afterwards.
    expect(styles).toContain(1);
    expect(styles[styles.length - 1]).toBe(0);

    styles.length = 0;
    expect(record(null)).toBeTruthy();
    // Nothing is playing, so the ring never runs and the style is never touched.
    expect(styles).toEqual([]);
  });

  it('draws a job mark without claiming progress the node never counted', () => {
    const display = Skia.Font(undefined, 20);
    const mono = Skia.Font(undefined, 9);
    const ink = paint('#000000');
    const styles: number[] = [];
    const setStyle = ink.setStyle.bind(ink);
    ink.setStyle = (style: number) => {
      styles.push(style);
      setStyle(style);
    };
    const jobEntity = { ...entity, key: 'node-a:job-1', kind: 'job' as const };
    const jobLayout = layoutField({
      entities: [jobEntity],
      arrangement: byTime,
      viewport,
    });

    const picture = recordFieldPicture({
      layout: jobLayout,
      placements: jobLayout.placements,
      camera: {
        x: jobLayout.fieldCenter.x,
        y: jobLayout.fieldCenter.y,
        scale: jobLayout.fitScale,
      },
      viewport,
      presentations: new Map(),
      jobs: new Map([
        [
          jobEntity.key,
          {
            entity: jobEntity,
            job: {
              id: 'job-1',
              revision: 1,
              state: 'running' as const,
              stage: 'diffuse' as const,
              model: 'light',
              created_at: '2026-08-10T00:00:00Z',
              updated_at: '2026-08-10T00:00:00Z',
            },
            backend: presentation.backend,
            nodeLabels: ['Studio'],
            caption: 'a slow piano piece',
            declaredStages: ['plan', 'codes', 'diffuse', 'decode'] as const,
          },
        ],
      ]),
      palette: {
        bg: '#FFFFFF',
        ink: '#000000',
        muted: '#666666',
        faint: '#A6A6A6',
        line: '#E6E6E6',
      },
      lensKey: 'name',
      nowMs: Date.UTC(2026, 7, 30),
      fonts: { display, body: display, mono },
      paints: {
          ink,
          muted: paint('#666666'),
          faint: paint('#A6A6A6'),
          outline: paint('#000000'),
        },
    });

    expect(picture).toBeTruthy();
    // The ring is stroked, and the shared paint is handed back as a fill.
    expect(styles).toContain(1);
    expect(styles[styles.length - 1]).toBe(0);
  });

  it('exposes labelled semantic actions instead of canvas nodes', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(FieldA11yList, {
          focus: null,
          layout,
          level: 'field',
          onSelect: jest.fn(),
          placements: layout.placements,
          presentations: new Map([[entity.key, presentation]]),
        }),
      );
    });
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'A field song, 2026-W32, 11 seconds',
      }),
    ).toBeTruthy();
  });
});

/**
 * The one piece of maths the whole field's smoothness rests on: between two
 * recordings, every mark's position is this transform and nothing else. A sign
 * error here does not fail anything, it just draws the field in the wrong
 * place, so it is checked against the function it has to agree with.
 */
describe('the picture transform', () => {
  /** Apply the transform the way Skia does: canvas operations, in order. */
  function apply(
    transform: readonly Record<string, number>[],
    point: { x: number; y: number },
  ): { x: number; y: number } {
    // Walk backwards: each op maps the *local* point outward to the parent.
    let { x, y } = point;
    for (let index = transform.length - 1; index >= 0; index -= 1) {
      const op = transform[index];
      if (op.scale !== undefined) {
        x *= op.scale;
        y *= op.scale;
      }
      if (op.translateX !== undefined) x += op.translateX;
      if (op.translateY !== undefined) y += op.translateY;
    }
    return { x, y };
  }

  const recorded = { x: 120, y: -40, scale: 1.4 };
  const world = [
    { x: 0, y: 0 },
    { x: 300, y: 220 },
    { x: -180, y: 95 },
  ];

  it('puts a recorded mark exactly where the live camera would draw it', () => {
    for (const live of [
      // A pan: the same scale, which is the case that must be exact.
      { x: 260, y: 30, scale: 1.4 },
      // A pinch, in both directions.
      { x: 120, y: -40, scale: 2.1 },
      { x: 55, y: 400, scale: 0.6 },
    ]) {
      const transform = pictureTransformFor(recorded, live, viewport);
      for (const point of world) {
        const asRecorded = worldToScreen(point, recorded, viewport);
        const shown = apply(
          transform as unknown as Record<string, number>[],
          asRecorded,
        );
        const truth = worldToScreen(point, live, viewport);
        expect(shown.x).toBeCloseTo(truth.x, 6);
        expect(shown.y).toBeCloseTo(truth.y, 6);
      }
    }
  });

  it('is the identity when nothing has moved', () => {
    const transform = pictureTransformFor(recorded, recorded, viewport);
    for (const point of world) {
      const asRecorded = worldToScreen(point, recorded, viewport);
      const shown = apply(
        transform as unknown as Record<string, number>[],
        asRecorded,
      );
      expect(shown.x).toBeCloseTo(asRecorded.x, 6);
      expect(shown.y).toBeCloseTo(asRecorded.y, 6);
    }
  });

  it('answers with a harmless transform before a scale exists', () => {
    const zero = { x: 0, y: 0, scale: 0 };
    expect(pictureTransformFor(zero, recorded, viewport)).toEqual([
      { translateX: 0 },
      { translateY: 0 },
    ]);
    expect(pictureTransformFor(recorded, zero, viewport)).toEqual([
      { translateX: 0 },
      { translateY: 0 },
    ]);
  });
});

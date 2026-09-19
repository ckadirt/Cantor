import { Skia } from '@shopify/react-native-skia';
import { ARRANGEMENTS } from '../../field/arrangements';
import {
  LEVEL_SCALE_RATIOS,
  layoutField,
  representationAlphas,
  worldToScreen,
  type FieldEntity,
} from '../../field';
import { LENSES, neutralAnalysis, type LensSong } from '..';

const viewport = { width: 380, height: 800 };

function entities(count: number): FieldEntity[] {
  const day = 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, index) => ({
    key: `node-a:song-${index}`,
    nodePublicKey: 'node-a',
    entityId: `song-${index}`,
    kind: 'song' as const,
    // Spread across weeks so time bucketing actually produces several groups.
    createdAtMs: Date.parse('2026-01-01T00:00:00Z') + index * day * 3,
    durationMs: 0,
    tags: index % 3 === 0 ? ['p/Focus'] : ['ambient'],
  }));
}

function song(key: string): LensSong {
  return {
    key,
    id: key,
    seed: 41822,
    title: `Song ${key}`,
    createdAtMs: 0,
    durationMs: 120_000,
    model: 'acestep:1.5-fast',
    nodeLabel: 'Studio',
    audioState: 'remote',
    arriving: null,
    byteLength: 3_400_000,
    playing: false,
    analysis: neutralAnalysis(),
    progress: null,
  };
}

/**
 * Every lens, at every canonical distance, under every arrangement.
 *
 * This is the combination sweep the milestone asks for: it does not assert what
 * anything looks like, it asserts that no combination throws and that no
 * placement is lost. A lens added later is swept automatically because the
 * registry is the only list.
 */
describe('lens harness', () => {
  const paints = {
    ink: paint('#000000'),
    muted: paint('#666666'),
    faint: paint('#A6A6A6'),
    outline: paint('#000000'),
  };
  const display = Skia.Font(undefined, 20);
  const fonts = { display, body: display, mono: Skia.Font(undefined, 9) };
  const model = entities(34);

  for (const arrangement of ARRANGEMENTS) {
    const layout = layoutField({ entities: model, arrangement, viewport });

    it(`${arrangement.key} keeps every entity reachable`, () => {
      const placed = new Set(layout.placements.map(p => p.entityKey));
      for (const entity of model) expect(placed.has(entity.key)).toBe(true);
    });

    for (const lens of LENSES) {
      for (const [level, ratio] of [
        ['field', 1],
        ['shelf', LEVEL_SCALE_RATIOS.shelf],
        ['song', LEVEL_SCALE_RATIOS.song],
        ['grain', LEVEL_SCALE_RATIOS.grain],
      ] as const) {
        it(`${lens.key} draws ${arrangement.key} at ${level}`, () => {
          const scale = layout.fitScale * ratio;
          const camera = {
            x: layout.fieldCenter.x,
            y: layout.fieldCenter.y,
            scale,
          };
          const alpha = representationAlphas(scale, layout.fitScale);
          const recorder = Skia.PictureRecorder();
          const canvas = recorder.beginRecording(
            Skia.XYWHRect(0, 0, viewport.width, viewport.height),
          );

          expect(() => {
            for (const placement of layout.placements) {
              const point = worldToScreen(
                { x: placement.x, y: placement.y },
                camera,
                viewport,
              );
              if (alpha.dot > 0) {
                lens.draw(
                  canvas,
                  { kind: 'mark', x: point.x, y: point.y, width: 0, height: 0 },
                  song(placement.entityKey),
                  { alpha: alpha.dot, fonts, paints },
                );
              }
              if (alpha.row > 0) {
                lens.draw(
                  canvas,
                  { kind: 'row', x: point.x, y: point.y, width: 240, height: 30 },
                  song(placement.entityKey),
                  { alpha: alpha.row, fonts, paints },
                );
              }
            }
          }).not.toThrow();
          expect(recorder.finishRecordingAsPicture()).toBeTruthy();
        });
      }
    }
  }

  it('draws a five-hundred-placement field without throwing', () => {
    const large = entities(500);
    const layout = layoutField({
      entities: large,
      arrangement: ARRANGEMENTS[0],
      viewport,
    });
    expect(layout.placements).toHaveLength(500);

    const camera = {
      x: layout.fieldCenter.x,
      y: layout.fieldCenter.y,
      scale: layout.fitScale,
    };
    const alpha = representationAlphas(layout.fitScale, layout.fitScale);
    for (const lens of LENSES) {
      const recorder = Skia.PictureRecorder();
      const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, 380, 800));
      expect(() => {
        for (const placement of layout.placements) {
          const point = worldToScreen(
            { x: placement.x, y: placement.y },
            camera,
            viewport,
          );
          lens.draw(
            canvas,
            { kind: 'mark', x: point.x, y: point.y, width: 0, height: 0 },
            song(placement.entityKey),
            { alpha: Math.max(alpha.dot, 0.01), fonts, paints },
          );
        }
      }).not.toThrow();
      expect(recorder.finishRecordingAsPicture()).toBeTruthy();
    }
  });
});

function paint(color: string) {
  const value = Skia.Paint();
  value.setAntiAlias(true);
  value.setColor(Skia.Color(color));
  return value;
}

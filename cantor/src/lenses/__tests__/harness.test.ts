import { Skia } from '@shopify/react-native-skia';
import { ARRANGEMENTS } from '../../field/arrangements';
import {
  LEVEL_SCALE_RATIOS,
  layoutField,
  representationAlphas,
  worldToScreen,
  type FieldEntity,
} from '../../field';
import { ARRIVING_NONE, LENSES } from '..';

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

/** A song's recipe: all a lens's identity is drawn from. */
function recipe(key: string) {
  return { seed: 41822, id: key, model: 'acestep:1.5-fast', durationMs: 120_000 };
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
    fill: paint('#000000'),
    stroke: paint('#000000'),
    paper: paint('#FFFFFF'),
  };
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
              const identity = lens.identity(recipe(placement.entityKey));
              canvas.save();
              canvas.translate(point.x, point.y);
              if (alpha.dot > 0) {
                lens.ui.drawMark(canvas, identity, 1, alpha.dot, 0.38, 0, 0, ARRIVING_NONE, 1, paints);
              }
              if (alpha.row > 0) {
                lens.ui.drawMark(canvas, identity, 1.2, alpha.row, 0.85, 0, 0, 0.4, 1, paints);
              }
              if (alpha.song > 0) {
                lens.ui.drawPlayer(
                  canvas,
                  lens.player(recipe(placement.entityKey), undefined, null),
                  identity,
                  12,
                  alpha.song,
                  1,
                  1,
                  1,
                  ARRIVING_NONE,
                  0,
                  -1,
                  1,
                  paints,
                  null,
                );
              }
              canvas.restore();
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
          canvas.save();
          canvas.translate(point.x, point.y);
          lens.ui.drawMark(
            canvas,
            lens.identity(recipe(placement.entityKey)),
            1,
            Math.max(alpha.dot, 0.01),
            0.85,
            0,
            0,
            ARRIVING_NONE,
            1,
            paints,
          );
          canvas.restore();
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

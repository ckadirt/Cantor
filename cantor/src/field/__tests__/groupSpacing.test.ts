import {
  byTime,
  byPlaylist,
  bloomedTargetPoint,
  layoutField,
  gridColumnCount,
  LAYOUT_KNOBS,
} from '..';
import { GROUP_SCENARIOS, groupScenario } from '../fixtures/groupScenarios';

// Regression: checking each group's internal spacing alone missed busy weeks
// reaching into a different group. Compare complete adjacent row envelopes.
describe.each(Object.entries(GROUP_SCENARIOS))(
  '%s group spacing',
  (_name, counts) => {
    it.each([byTime, byPlaylist])(
      'reserves actual bloom heights on $key',
      arrangement => {
        const entities = groupScenario(counts);
        const layout = layoutField({
          entities,
          arrangement,
          viewport: { width: 393, height: 780 },
        });
        const columns = gridColumnCount(layout.groups.length);
        const rows: { top: number; bottom: number }[] = [];
        for (let start = 0; start < layout.groups.length; start += columns) {
          const keys = new Set(
            layout.groups.slice(start, start + columns).map(group => group.key),
          );
          const ys = layout.placements
            .filter(p => keys.has(p.groupKey))
            .map(p => bloomedTargetPoint(p).y);
          rows.push({ top: Math.min(...ys), bottom: Math.max(...ys) });
        }
        for (let row = 1; row < rows.length; row++) {
          expect(rows[row].top - rows[row - 1].bottom).toBeGreaterThanOrEqual(
            LAYOUT_KNOBS.CLUSTER_CONTENT_GAP_WORLD - 1e-8,
          );
        }
        for (let row = 1; row < rows.length; row++) {
          expect(
            (rows[row].top - rows[row - 1].bottom) * layout.fitScale,
          ).toBeGreaterThanOrEqual(LAYOUT_KNOBS.CLUSTER_CONTENT_GAP_PX - 0.01);
        }
        for (let index = 1; index < columns; index++) {
          expect(
            (layout.groups[index].cx - layout.groups[index - 1].cx) *
              layout.fitScale,
          ).toBeGreaterThanOrEqual(LAYOUT_KNOBS.CLUSTER_COLUMN_PITCH_PX - 0.01);
        }
        // Gathered columns must also be disjoint across groups, not merely
        // have correct spacing within each individual group.
        for (const left of layout.groups) {
          for (const right of layout.groups) {
            if (left.cx !== right.cx || left.cy >= right.cy) continue;
            const bottom = Math.max(
              ...layout.placements
                .filter(p => p.groupKey === left.key)
                .map(p => p.targetY),
            );
            const top = Math.min(
              ...layout.placements
                .filter(p => p.groupKey === right.key)
                .map(p => p.targetY),
            );
            expect((top - bottom) * layout.fitScale * 5).toBeGreaterThanOrEqual(
              92 - 0.01,
            );
          }
        }
        expect(layout.placements).toHaveLength(entities.length);
        expect(
          layoutField({
            entities: [...entities].reverse(),
            arrangement,
            viewport: { width: 393, height: 780 },
          }),
        ).toEqual(layout);
      },
    );
  },
);

import type { FieldEntity } from '../types';

/** Uneven membership, including a crowded final row and a short final row. */
export const GROUP_SCENARIOS = {
  sparse: [1, 2, 1, 3],
  crowdedWeek: [5, 3, 2, 19],
  alternating: [1, 24, 2, 18, 3, 12, 1],
  dense: [40, 1, 3, 60, 2, 12, 4, 32, 1],
} as const;

export function groupScenario(counts: readonly number[]): FieldEntity[] {
  return counts.flatMap((count, group) =>
    Array.from({ length: count }, (_, member) => ({
      key: `layout-fixture:${group}-${member}`,
      nodePublicKey: 'layout-fixture',
      entityId: `${group}-${member}`,
      kind: 'song' as const,
      createdAtMs: new Date(2026, 7, 24 + group * 7, 12, member).getTime(),
      durationMs: (30 + member * 17) * 1000,
      tags: [`p/Group ${group + 1}`],
    })),
  );
}

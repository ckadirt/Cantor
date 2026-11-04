import type { FaceRecipe } from '../face';
import { marbleBakeImage, marbleBakeKey, marblePlayerOf } from '../marblePlayer';
import { circleRing, ringDepths } from '../marbleMorph';
import { load, trackOf } from '../motion/__fixtures__/referenceTrack';

/** The nesting walked the long way: every ring's first point against every other ring. */
function everyRing(rings: readonly (readonly number[])[]): number[] {
  return rings.map((ring, i) => {
    const px = ring[0];
    const py = ring[1];
    let depth = 0;
    rings.forEach((r, j) => {
      if (j === i) return;
      const n = Math.floor(r.length / 2);
      let inside = false;
      for (let p = 0, q = n - 1; p < n; q = p++) {
        const xi = r[2 * p];
        const yi = r[2 * p + 1];
        const xj = r[2 * q];
        const yj = r[2 * q + 1];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) depth += 1;
    });
    return depth;
  });
}

describe('ringDepths', () => {
  it('nests rings as walking every ring does: side by side, inside, and touching boxes', () => {
    const rings = [
      circleRing(0, 0, 10, 48),
      circleRing(0, 0, 6, 32),
      circleRing(1, 0, 2, 16),
      circleRing(25, 0, 10, 48),
      circleRing(25, 0, 4, 16),
      // Inside the first ring's box but outside the ring itself: a corner.
      circleRing(9, 9, 0.5, 8),
      circleRing(-40, -40, 3, 12),
    ];
    expect(ringDepths(rings)).toEqual(everyRing(rings));
    expect(ringDepths(rings)).toEqual([0, 1, 2, 0, 1, 0, 0]);
  });

  it('nests a real bath late in a song as walking every ring does', () => {
    const recipe: FaceRecipe = { seed: 4242, id: 'depths', model: 'light', durationMs: 262_000 };
    const player = marblePlayerOf(recipe, undefined, null, trackOf(load('edm-drop')));
    const bake = marbleBakeImage(player, marbleBakeKey(player, 200));
    expect(bake.rings.length).toBeGreaterThan(10);
    expect(ringDepths(bake.rings)).toEqual(everyRing(bake.rings));
  });
});

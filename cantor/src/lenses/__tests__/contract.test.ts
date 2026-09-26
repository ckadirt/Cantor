/**
 * The lens registry keeps its two halves in step.
 *
 * The renderer captures `LENS_UI` and indexes a face's `identities` by the
 * same position, so a lens whose UI half stood anywhere but beside its own
 * identity would draw another lens's paths. What each lens *draws* is pinned
 * by `features/field/__tests__/lensGoldens.test.ts`.
 */
import { LENSES, LENS_UI, lensIndex } from '../registry';

const recipe = { seed: 7, id: 'song-a', model: 'light', durationMs: 60_000 };

describe('the lens contract', () => {
  it("keeps every UI half at its lens's own position", () => {
    expect(LENS_UI).toHaveLength(LENSES.length);
    LENSES.forEach((lens, index) => {
      expect(LENS_UI[index]).toBe(lens.ui);
      expect(lensIndex(lens.key)).toBe(index);
    });
    expect(lensIndex('no-such-lens')).toBe(-1);
  });

  it('gives every lens an identity from the recipe alone, and a mark', () => {
    for (const lens of LENSES) {
      expect(lens.identity(recipe)).toBeDefined();
      // Cached: the same recipe is the same object, so a re-cut that rebuilds
      // the faces hands the canvas nothing new for an unchanged song.
      expect(lens.identity({ ...recipe })).toBe(lens.identity(recipe));
      expect(typeof lens.ui.drawMark).toBe('function');
    }
  });
});

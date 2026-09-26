/**
 * The lens registry keeps its two halves in step.
 *
 * The renderer captures `LENS_UI` and indexes a face's `identities` by the
 * same position, so a lens whose UI half stood anywhere but beside its own
 * identity would draw another lens's paths. What each lens *draws* is pinned
 * by `features/field/__tests__/lensGoldens.test.ts`.
 */
import { analyseWindow } from '../analysis';
import { LENSES, LENS_PAIRS, LENS_UI, lensIndex } from '../registry';

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

  it('gives every lens a player and says what its player reads', () => {
    for (const lens of LENSES) {
      expect(typeof lens.ui.drawPlayer).toBe('function');
      expect([0, 1]).toContain(lens.ui.ringTicks);
      expect([0, 1]).toContain(lens.ui.hearsPlayhead);
    }
  });

  /**
   * The two-layer rule, at the player: without a measurement a lens's player
   * is its identity alone, and the sound arrives with the analysis.
   */
  it('builds a player without sound until the song is measured', () => {
    const buckets = 729;
    const measured = analyseWindow({
      startSeconds: 0,
      endSeconds: 60,
      buckets,
      sampleRate: 48000,
      channels: [
        {
          min: new Float32Array(buckets).fill(-0.4),
          max: new Float32Array(buckets).fill(0.4),
          rms: new Float32Array(buckets).fill(0.2),
        },
      ],
    });
    for (const lens of LENSES) {
      const quiet = lens.player(recipe, undefined);
      if (quiet === null) continue; // its player is its mark, grown
      expect(quiet.sound).toBeNull();
      expect(lens.player(recipe, measured)?.sound).not.toBeNull();
    }
    expect(LENSES[lensIndex('seal')].player(recipe, undefined)).not.toBeNull();
    expect(LENSES[lensIndex('name')].player(recipe, undefined)).toBeNull();
  });

  it('gives every lens a clock the player can draw', () => {
    for (const lens of LENSES) {
      const clock = lens.ui.clock;
      expect(clock.ratio).toBeGreaterThan(0);
      expect(clock.handInnerRatio).toBeLessThanOrEqual(clock.handOuterRatio);
      for (const alpha of [clock.rimAlpha, clock.tickAlpha]) {
        expect(alpha).toBeGreaterThanOrEqual(0);
        expect(alpha).toBeLessThanOrEqual(1);
      }
      for (const size of [
        clock.heardWidthPx,
        clock.handWidthPx,
        clock.rimWidthPx,
        clock.tickPx,
        clock.knobRadiusPx,
      ]) {
        expect(size).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('resolves every pair morph to two registered lenses', () => {
    expect(LENS_PAIRS.length).toBeGreaterThan(0);
    for (const pair of LENS_PAIRS) {
      expect(LENSES[pair.a]).toBeDefined();
      expect(LENSES[pair.b]).toBeDefined();
      expect(pair.a).not.toBe(pair.b);
    }
  });
});

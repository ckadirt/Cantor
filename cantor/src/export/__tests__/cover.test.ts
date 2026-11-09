import { LENSES } from '../../lenses/registry';
import { COVER_KNOBS, renderCover } from '../cover';

const recipe = {
  seed: 4_812_337,
  id: '0b6f9c1e-6a3d-4c55-9a3e-2f4b8d7c1a90',
  model: 'acestep@1.5-turbo',
  durationMs: 192_000,
};

describe('covers', () => {
  it.each(LENSES.map(lens => [lens.key, lens] as const))(
    'draws the %s face as a PNG',
    (_key, lens) => {
      const cover = renderCover(lens, recipe);
      expect(cover).not.toBeNull();
      expect(cover!.width).toBe(COVER_KNOBS.SIDE_PX);
      // The PNG signature, as base64.
      expect(cover!.png.startsWith('iVBORw0KGgo')).toBe(true);
    },
  );

  it('draws different songs differently', () => {
    const seal = LENSES.find(lens => lens.key === 'seal')!;
    const a = renderCover(seal, recipe)!.png;
    const b = renderCover(seal, { ...recipe, seed: 99 })!.png;
    expect(a).not.toBe(b);
  });
});

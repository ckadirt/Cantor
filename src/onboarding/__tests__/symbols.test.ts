import { Skia } from '@shopify/react-native-skia';
import { SIGILS } from '../sigils';
import {
  CONSTELLATION_SYMBOL_NAMES,
  CONSTELLATION_SYMBOLS,
  INTRO_CONTOUR_COUNT,
} from '../symbols';
import { SYMBOL_LIBRARY } from '../../motion';

describe('onboarding symbol selection', () => {
  it('keeps the intro constellation frozen at its original ten symbols', () => {
    expect(CONSTELLATION_SYMBOL_NAMES).toHaveLength(10);
    expect(
      CONSTELLATION_SYMBOLS.reduce(
        (sum, item) => sum + item.symbol.contours.length,
        0,
      ),
    ).toBe(INTRO_CONTOUR_COUNT);
  });

  it('uses new SVG symbols for content steps and deliberately reuses infinity', () => {
    const constellation = new Set(
      CONSTELLATION_SYMBOLS.map(item => item.symbol),
    );

    for (const sigil of [
      SIGILS.what,
      SIGILS.backends,
      SIGILS.identity,
      SIGILS.backup,
    ]) {
      expect(constellation.has(sigil)).toBe(false);
      expect(Skia.Path.MakeFromSVGString(sigil.artwork.d)).not.toBeNull();
    }
    expect(SIGILS.threshold).toBe(SYMBOL_LIBRARY.infinity);
  });
});

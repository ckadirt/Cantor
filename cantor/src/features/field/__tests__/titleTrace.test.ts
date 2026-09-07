import { Skia } from '@shopify/react-native-skia';
import { traceTitlePath } from '../titleTrace';
import { writePhase, writeSubAlpha } from '../../../motion/text';

describe('batched title strokes', () => {
  const glyphs = [0, 20, 40].map(x =>
    Skia.Path.Make().moveTo(x, 0).lineTo(x + 10, 0),
  );

  it('preserves each glyph’s lag and leaves source outlines intact in both directions', () => {
    const sources = glyphs.map(path => path.toSVGString());
    for (const progress of [0, 0.2, 0.4, 0.6, 1, 0.6, 0.2, 0]) {
      const expected = Skia.Path.Make();
      glyphs.forEach((_, index) => {
        const end = writePhase(writeSubAlpha(progress, index, glyphs.length)).borderEnd;
        if (end > 0) {
          expected.moveTo(index * 20, 0).lineTo(index * 20 + 10 * end, 0);
        }
      });
      const actual = traceTitlePath(glyphs, progress);
      expect(actual.toCmds()).toEqual(expected.toCmds());
      expect(glyphs.map(path => path.toSVGString())).toEqual(sources);
      actual.dispose();
      expected.dispose();
    }
  });
});

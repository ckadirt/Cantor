import { Skia } from '@shopify/react-native-skia';
import { titleTracePaths, traceTitlePath } from '../titleTrace';
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

describe('title outline cache', () => {
  const font = Skia.Font(undefined, 20);

  /*
   * `MakeFromText` is native-only — CanvasKit answers with a stub that is not a
   * path — so the outlines are stood in for by real empty paths. What is under
   * test is how often the builder is asked, not what it returns.
   */
  function countingBuilder() {
    return jest
      .spyOn(Skia.Path, 'MakeFromText')
      .mockImplementation(() => Skia.Path.Make());
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds one title once and hands the same outlines back', () => {
    const build = countingBuilder();
    const first = titleTracePaths('Ashes', font, -110, 4);
    const afterFirst = build.mock.calls.length;
    const second = titleTracePaths('Ashes', font, -110, 4);

    expect(afterFirst).toBe(5);
    // Identity, not equality: a re-cut remounts `TracedTitle`, and the mapper
    // it installs closes over this array. Rebuilding it would be the cost the
    // cache exists to remove.
    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(afterFirst);
  });

  it('keeps titles drawn at another size or baseline apart', () => {
    countingBuilder();
    const row = titleTracePaths('Ashes', font, -110, 4);
    const lower = titleTracePaths('Ashes', font, -110, 40);
    const bigger = titleTracePaths('Ashes', Skia.Font(undefined, 26), -110, 4);

    expect(lower).not.toBe(row);
    expect(bigger).not.toBe(row);
  });
});

/** Text planners and Manim timing laws. CanvasKit remains the real test env. */
import { Skia } from '@shopify/react-native-skia';

// Jest runs on Node, but the RN tsconfig ships no Node types — type the two
// pieces this file needs locally instead of widening the app's globals.
declare const __dirname: string;
declare function require(id: string): unknown;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string) => Uint8Array;
};
const { join } = require('path') as {
  join: (...parts: string[]) => string;
};
import {
  buildFlights,
  buildTransformFlights,
  graphemes,
  layoutText,
  chooseTextKind,
  textVariantChanged,
  writeDurationMs,
  writeLagRatio,
  writePhase,
  writeSubAlpha,
  type CharBox,
} from '../index';

function box(ch: string, x: number, word = 0): CharBox {
  return { ch, ids: [ch.charCodeAt(0)], xo: [0], w: 10, x, y: 20, word };
}

describe('plain text Transform', () => {
  it('aligns glyph families by reading order on one shared window', () => {
    const tr = buildTransformFlights(
      [box('A', 0), box('B', 10), box('C', 20)],
      [box('C', 0), box('B', 10), box('A', 20)],
    );
    expect(tr.morphs.map(m => `${m.from.ch}->${m.to.ch}`)).toEqual([
      'A->C',
      'B->B',
      'C->A',
    ]);
    for (const m of tr.morphs) {
      expect([m.a, m.b, m.px, m.py]).toEqual([0, 1, 0, 0]);
    }
  });

  it('uses evenly distributed invisible copies on the shorter side', () => {
    const grow = buildTransformFlights(
      [box('A', 0), box('B', 10)],
      [box('W', 0), box('X', 10), box('Y', 20), box('Z', 30)],
    );
    expect(grow.morphs.map(m => m.from.ch)).toEqual(['A', 'A', 'B', 'B']);
    expect(grow.morphs.map(m => m.fromAlpha)).toEqual([1, 0, 1, 0]);
    expect(grow.morphs.map(m => m.toAlpha)).toEqual([1, 1, 1, 1]);

    const shrink = buildTransformFlights(
      [box('W', 0), box('X', 10), box('Y', 20), box('Z', 30)],
      [box('A', 0), box('B', 10)],
    );
    expect(shrink.morphs.map(m => m.to.ch)).toEqual(['A', 'A', 'B', 'B']);
    expect(shrink.morphs.map(m => m.toAlpha)).toEqual([1, 0, 1, 0]);
  });

  it('keeps matching as a distinct identity-based variant', () => {
    const matching = buildFlights(
      [box('A', 0), box('B', 10), box('C', 20)],
      [box('C', 0), box('B', 10), box('A', 20)],
      100,
    );
    expect(matching.movers.map(m => m.ids[0])).toEqual([
      'C'.charCodeAt(0),
      'B'.charCodeAt(0),
      'A'.charCodeAt(0),
    ]);
  });
});

describe('layoutText alignment', () => {
  it('centers a line by shifting every box uniformly inside maxWidth', () => {
    const font = Skia.Font(undefined, 14);
    const left = layoutText('to the centre', font, 0, 300, 20, 'left');
    const centered = layoutText('to the centre', font, 0, 300, 20, 'center');
    const last = left[left.length - 1];
    const dx = (300 - (last.x + last.w)) / 2;
    for (let i = 0; i < left.length; i++) {
      expect(centered[i].x - left[i].x).toBeCloseTo(dx, 5);
      expect(centered[i].y).toBe(left[i].y);
    }
  });

  /**
   * Chrome pinned to an edge needs this: a slot sized to its longest possible
   * string keeps a stable width, and a stable width is what lets a line erase
   * itself. A slot measured to the text collapses to zero when the text goes
   * away, and a zero-width slot builds no model at all.
   */
  it('pins a line flush right inside maxWidth', () => {
    // The jest default font has no typeface, so a right shift measured against
    // it would be the whole container. Use the real bundled face.
    const bytes = readFileSync(
      join(__dirname, '../../../assets/fonts/cmu-serif.ttf'),
    );
    const typeface = Skia.Typeface.MakeFreeTypeFaceFromData(
      Skia.Data.fromBytes(new Uint8Array(bytes)),
    );
    const font = Skia.Font(typeface ?? undefined, 14);
    const left = layoutText('REMOVE ALL', font, 0, 400, 20, 'left');
    const right = layoutText('REMOVE ALL', font, 0, 400, 20, 'right');
    const last = left[left.length - 1];
    const inkWidth = last.x + last.w;
    expect(inkWidth).toBeGreaterThan(0);
    // Every box moves by the same free space, so the row keeps its shape and
    // its last glyph lands on the container's right edge.
    const shift = 400 - inkWidth;
    for (let i = 0; i < left.length; i += 1) {
      expect(right[i].x - left[i].x).toBeCloseTo(shift, 4);
      expect(right[i].y).toBe(left[i].y);
    }
    // A line that already fills its container is not pulled off the left edge.
    const tight = layoutText('REMOVE ALL', font, 0, inkWidth, 20, 'right');
    expect(tight[0].x).toBeCloseTo(left[0].x, 4);
  });
});

describe('layoutText robustness', () => {
  // The jest default font has no typeface (all widths 0), which would make
  // wrapping untestable — use the real bundled face the app lays out with.
  const bytes = readFileSync(
    join(__dirname, '../../../assets/fonts/cmu-serif.ttf'),
  );
  const typeface = Skia.Typeface.MakeFreeTypeFaceFromData(
    Skia.Data.fromBytes(new Uint8Array(bytes)),
  );
  const font = Skia.Font(typeface ?? undefined, 14);

  it('keeps combining marks attached to their base character', () => {
    // decomposed e + U+0301 must stay one CharBox, not shatter into marks
    const accented = 'e\u0301';
    expect(graphemes(`caf${accented}`)).toEqual(['c', 'a', 'f', accented]);
    const boxes = layoutText(`caf${accented}`, font, 0, 300, 20);
    expect(boxes.map(b => b.ch)).toEqual(['c', 'a', 'f', accented]);
  });

  it('keeps emoji ZWJ sequences whole', () => {
    const family = '👨‍👩‍👧';
    expect(graphemes(`a ${family}`)).toEqual(['a', ' ', family]);
    const boxes = layoutText(`a ${family}`, font, 0, 300, 20);
    expect(boxes.map(b => b.ch)).toEqual(['a', family]);
  });

  it('treats \\n as a forced line break in a distinct word', () => {
    const boxes = layoutText('one\ntwo', font, 0, 300, 20);
    const rows = [...new Set(boxes.map(b => b.y))];
    expect(rows).toHaveLength(2);
    const byRow = (y: number) =>
      boxes.filter(b => b.y === y).map(b => b.ch).join('');
    expect(byRow(rows[0])).toBe('one');
    expect(byRow(rows[1])).toBe('two');
    // the two words must not merge into one gliding unit
    expect(new Set(boxes.map(b => b.word)).size).toBe(2);
  });

  it('never wraps a word that exactly fits its measured width', () => {
    // the IdentityPanel bug: an 11-bit group sized from real metrics must
    // lay out on one line, not drop its last digit onto a second one
    const bits = '10110100101';
    const width = [...bits]
      .map(ch => font.getGlyphWidths(font.getGlyphIDs(ch))[0])
      .reduce((s, w) => s + w, 0);
    const boxes = layoutText(bits, font, 0, width + 1e-6, 20);
    expect(boxes).toHaveLength(bits.length);
    expect(new Set(boxes.map(b => b.y)).size).toBe(1);
  });

  it('breaks an over-wide word mid-word instead of overflowing', () => {
    const maxWidth = 40;
    const boxes = layoutText('incomprehensibilities', font, 0, maxWidth, 20);
    for (const b of boxes) {
      expect(b.x + b.w).toBeLessThanOrEqual(maxWidth + 1e-6);
    }
    expect(new Set(boxes.map(b => b.y)).size).toBeGreaterThan(1);
  });
});

describe('Manim Write timing', () => {
  it('uses ManimGL lag and duration defaults', () => {
    expect(writeLagRatio(5)).toBe(0.2);
    expect(writeLagRatio(20)).toBeCloseTo(4 / 21);
    expect(writeDurationMs(14)).toBe(1000);
    expect(writeDurationMs(15)).toBe(2000);
  });

  it('draws the border first and fills during the second half', () => {
    expect(writePhase(0)).toEqual({
      borderEnd: 0,
      borderAlpha: 1,
      fillAlpha: 0,
      settled: false,
    });
    expect(writePhase(0.25).borderEnd).toBe(0.5);
    expect(writePhase(0.75)).toEqual({
      borderEnd: 1,
      borderAlpha: 0.5,
      fillAlpha: 0.5,
      settled: false,
    });
    expect(writePhase(1).settled).toBe(true);
  });

  it('stays on one shared clock while staggering glyph sub-alphas', () => {
    expect(writeSubAlpha(0.5, 0, 5)).toBeCloseTo(0.9);
    expect(writeSubAlpha(0.5, 1, 5)).toBeCloseTo(0.7);
    expect(writeSubAlpha(0.5, 4, 5)).toBeCloseTo(0.1);
    expect(writeSubAlpha(1, 4, 5)).toBe(1);
  });
});

describe('choosing a text gesture', () => {
  const plan = (over: Partial<Parameters<typeof chooseTextKind>[0]> = {}) =>
    chooseTextKind({
      appearance: 'write',
      variant: 'matching',
      reduced: false,
      retarget: true,
      fromCount: 5,
      toCount: 5,
      ...over,
    });

  it('writes ink on and takes the same ink back off', () => {
    // Nothing drawn yet and something to draw: trace it on.
    expect(plan({ retarget: false, fromCount: 0 })).toBe('write');
    expect(plan({ fromCount: 0 })).toBe('write');
    // Something drawn and nothing left to draw: unwrite it. This is the half
    // that used to fade, which made a line arrive by drawing and leave by
    // dissolving — two gestures for one object.
    expect(plan({ toCount: 0 })).toBe('erase');
  });

  it('never erases what was never written', () => {
    // A first mount that starts empty has no ink on screen to take back. What
    // it settles on does not matter — with nothing at either end there is
    // nothing to draw — but it must not be an erase, which would build write
    // models out of an empty capture.
    expect(plan({ retarget: false, toCount: 0, fromCount: 0 })).not.toBe(
      'erase',
    );
    expect(plan({ toCount: 0, fromCount: 0 })).not.toBe('erase');
    // And a caller that asked to fade still fades in both directions.
    expect(plan({ appearance: 'fade', toCount: 0 })).toBe('matching');
    expect(plan({ appearance: 'fade', retarget: false, fromCount: 0 })).toBe(
      'crossfade',
    );
    expect(plan({ appearance: 'none', retarget: false, fromCount: 0 })).toBe(
      'settled',
    );
  });

  it('keeps a text change between two lines on its chosen variant', () => {
    expect(plan()).toBe('matching');
    expect(plan({ variant: 'transform' })).toBe('transform');
    expect(plan({ variant: 'crossfade' })).toBe('crossfade');
    // Reduced motion overrides every appearance and every variant.
    expect(plan({ reduced: true, fromCount: 0 })).toBe('crossfade');
    expect(plan({ reduced: true, toCount: 0 })).toBe('crossfade');
  });
});

describe('when a committed text model is stale', () => {
  /**
   * The loop this exists to stop: `erase` is not a variant, so a model holding
   * it can never equal the caller's `variant`. Read as "anything that is not
   * write or settled must be a variant", every render decided the model was
   * stale, rebuilt it, and re-rendered — React's re-render limit, on the first
   * line of chrome that tried to unwrite itself.
   */
  it('leaves a finished appearance alone', () => {
    for (const kind of ['settled', 'write', 'erase'] as const) {
      expect(textVariantChanged(kind, 'matching', false)).toBe(false);
      expect(textVariantChanged(kind, 'transform', false)).toBe(false);
      expect(textVariantChanged(kind, 'crossfade', false)).toBe(false);
    }
  });

  it('rebuilds a morph whose variant changed under it', () => {
    expect(textVariantChanged('matching', 'transform', false)).toBe(true);
    expect(textVariantChanged('transform', 'matching', false)).toBe(true);
    expect(textVariantChanged('matching', 'matching', false)).toBe(false);
    // Reduced motion pins everything to crossfade, so nothing is ever stale
    // for having the wrong variant.
    expect(textVariantChanged('matching', 'transform', true)).toBe(false);
  });
});

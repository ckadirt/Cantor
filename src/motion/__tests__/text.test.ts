/** Text planners and Manim timing laws. CanvasKit remains the real test env. */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Skia } from '@shopify/react-native-skia';
import {
  buildFlights,
  buildTransformFlights,
  graphemes,
  layoutText,
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

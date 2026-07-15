/** Text planners and Manim timing laws. CanvasKit remains the real test env. */
import { Skia } from '@shopify/react-native-skia';
import {
  buildFlights,
  buildTransformFlights,
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

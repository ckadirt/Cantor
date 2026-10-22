/**
 * The identity reveal's geometry, built once at build time: each word of a
 * phrase as the 11 bits it encodes (its index in the BIP39 list, as the app's
 * `wordBits` reads it), then as the word, both as glyph outlines in the site's
 * display face, with every bit contour paired to a word contour so the
 * browser only has to lerp. The pairing follows the app's motion engine
 * (`cantor/src/motion`): outlines resampled to the same count by arc length,
 * matched in reading order, counters to counters, each rotated to the start
 * that travels least; a contour with no partner grows from, or shrinks into,
 * its own centre.
 */
import { readFileSync } from 'node:fs';
import { create, type Font, type PathCommand } from 'fontkitten';

/** Points per contour: enough for a serif's curves at display sizes. */
const N = 56;
/** Steps a curve is cut into before resampling. */
const CURVE_STEPS = 10;

type Pt = { x: number; y: number };
type Contour = { pts: Pt[]; area: number; cx: number };

export type PhraseSlot = {
  word: string;
  bits: string;
  /** Every contour as `x0 y0 x1 y1 …` in ems, y down, origin at the baseline's start. */
  from: number[][];
  to: number[][];
  /**
   * One entry per moving contour: `[from, to, near]`. A pair morphs from one
   * into the other; with `to` at -1 the contour shrinks into the centre of
   * `to[near]`, with `from` at -1 it grows out of the centre of `from[near]`.
   * Pairs are one to one, so no outline is ever stacked on another: stacked
   * windings would fill a letter's counters.
   */
  pairs: [number, number, number][];
  /** Which glyph each `from` contour belongs to, for the write's per-glyph lag. */
  fromGlyph: number[];
  glyphs: number;
  /** Advance widths, in ems. */
  bitsWidth: number;
  wordWidth: number;
};

function flatten(commands: PathCommand[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let at: Pt = { x: 0, y: 0 };
  const close = () => {
    if (cur.length > 2) out.push(cur);
    cur = [];
  };
  for (const { command, args } of commands) {
    if (command === 'moveTo') {
      close();
      at = { x: args[0], y: args[1] };
      cur.push(at);
    } else if (command === 'lineTo') {
      at = { x: args[0], y: args[1] };
      cur.push(at);
    } else if (command === 'quadraticCurveTo') {
      const [cx, cy, x, y] = args;
      for (let i = 1; i <= CURVE_STEPS; i += 1) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        cur.push({ x: u * u * at.x + 2 * u * t * cx + t * t * x, y: u * u * at.y + 2 * u * t * cy + t * t * y });
      }
      at = { x, y };
    } else if (command === 'bezierCurveTo') {
      const [c1x, c1y, c2x, c2y, x, y] = args;
      for (let i = 1; i <= CURVE_STEPS; i += 1) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        cur.push({
          x: u * u * u * at.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
          y: u * u * u * at.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
        });
      }
      at = { x, y };
    } else if (command === 'closePath') {
      close();
    }
  }
  close();
  return out;
}

/** The closed contour resampled to `n` points evenly along its length. */
function resample(pts: Pt[], n = N): Pt[] {
  const ring = [...pts, pts[0]];
  const lengths = [0];
  for (let i = 1; i < ring.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y));
  const total = lengths[lengths.length - 1];
  const out: Pt[] = [];
  let j = 1;
  for (let k = 0; k < n; k += 1) {
    const d = (k / n) * total;
    while (j < lengths.length - 1 && lengths[j] < d) j += 1;
    const span = lengths[j] - lengths[j - 1] || 1;
    const t = (d - lengths[j - 1]) / span;
    out.push({ x: ring[j - 1].x + (ring[j].x - ring[j - 1].x) * t, y: ring[j - 1].y + (ring[j].y - ring[j - 1].y) * t });
  }
  return out;
}

const areaOf = (pts: Pt[]) => pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p.x * q.y - q.x * p.y; }, 0) / 2;
const centre = (pts: Pt[]) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });

/** A line of text as contours, in ems with y down, and which glyph each came from. */
function outline(font: Font, text: string) {
  const scale = 1 / font.unitsPerEm;
  const contours: (Contour & { glyph: number })[] = [];
  let x = 0;
  [...text].forEach((ch, glyph) => {
    const g = font.glyphForCodePoint(ch.codePointAt(0)!);
    for (const raw of flatten(g.path.commands)) {
      const pts = resample(raw.map((p) => ({ x: x + p.x * scale, y: -p.y * scale })));
      contours.push({ pts, area: areaOf(pts), cx: centre(pts).x, glyph });
    }
    x += g.advanceWidth * scale;
  });
  return { contours, width: x };
}

/** `b` rotated to start where it best follows `a`, measured about their own centres. */
function align(a: Pt[], b: Pt[]): Pt[] {
  const ca = centre(a);
  const cb = centre(b);
  let best = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < b.length; shift += 1) {
    let cost = 0;
    for (let i = 0; i < a.length; i += 1) {
      const p = a[i];
      const q = b[(i + shift) % b.length];
      cost += (p.x - ca.x - (q.x - cb.x)) ** 2 + (p.y - ca.y - (q.y - cb.y)) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = shift;
    }
  }
  return b.map((_, i) => b[(i + best) % b.length]);
}

/**
 * Pair two lists, each in reading order, one to one: the shorter list's
 * contours take partners spread evenly through the longer; every contour left
 * over joins the nearest contour that has one.
 */
function match(from: number[], to: number[], fromX: number[], toX: number[]): [number, number, number][] {
  const swap = from.length > to.length;
  const few = swap ? to : from;
  const many = swap ? from : to;
  const fewX = swap ? toX : fromX;
  const manyX = swap ? fromX : toX;
  const chosen = new Map<number, number>();
  few.forEach((f, k) => chosen.set(many[Math.floor(((k + 0.5) * many.length) / few.length)], f));
  return many.map((m) => {
    const partner = chosen.get(m);
    if (partner !== undefined) return swap ? [m, partner, -1] : [partner, m, -1];
    // Nothing of its own: it leaves into, or comes out of, the nearest glyph across.
    const near = few.length === 0
      ? -1
      : few.reduce((best, f) => (Math.abs(fewX[f] - manyX[m]) < Math.abs(fewX[best] - manyX[m]) ? f : best), few[0]);
    return swap ? [m, -1, near] : [-1, m, near];
  });
}

const flat = (pts: Pt[]) => pts.flatMap((p) => [+p.x.toFixed(4), +p.y.toFixed(4)]);

export function phraseGeometry(fontFile: string, words: { word: string; bits: string }[]): PhraseSlot[] {
  const font = create(readFileSync(fontFile)) as Font;
  return words.map(({ word, bits }) => {
    const a = outline(font, bits);
    const b = outline(font, word);
    // An outline winds one way and a counter the other: the largest contour says which is which.
    const all = [...a.contours, ...b.contours];
    const outer = Math.sign(all.reduce((m, c) => (Math.abs(c.area) > Math.abs(m.area) ? c : m)).area);
    const byX = (list: Contour[], keep: (c: Contour) => boolean) =>
      list.map((c, i) => ({ c, i })).filter(({ c }) => keep(c)).sort((p, q) => p.c.cx - q.c.cx).map(({ i }) => i);
    const isOuter = (c: Contour) => Math.sign(c.area) === outer;
    const ax = a.contours.map((c) => c.cx);
    const bx = b.contours.map((c) => c.cx);
    const pairs = [
      ...match(byX(a.contours, isOuter), byX(b.contours, isOuter), ax, bx),
      ...match(byX(a.contours, (c) => !isOuter(c)), byX(b.contours, (c) => !isOuter(c)), ax, bx),
    ];
    // Each destination starts where its source travels least to it.
    const to = b.contours.map((c) => c.pts);
    const aligned = new Map<number, Pt[]>();
    for (const [i, j] of pairs) {
      if (i >= 0 && j >= 0 && !aligned.has(j)) aligned.set(j, align(a.contours[i].pts, to[j]));
    }
    return {
      word,
      bits,
      from: a.contours.map((c) => flat(c.pts)),
      to: to.map((pts, j) => flat(aligned.get(j) ?? pts)),
      pairs,
      fromGlyph: a.contours.map((c) => c.glyph),
      glyphs: bits.length,
      bitsWidth: +a.width.toFixed(4),
      wordWidth: +b.width.toFixed(4),
    };
  });
}

/**
 * The engine's contract, executed against real CanvasKit (see jest.config.js):
 * every library shape parses, validates, and resolves to interpolable
 * geometry; transitions stay verb-identical end to end; capture reproduces
 * the endpoints it should.
 */
import { Skia } from '@shopify/react-native-skia';
import {
  alignSampled,
  assertInterpolatable,
  buildTransition,
  buildSilhouetteTransition,
  captureTransition,
  LIBRARY,
  mulberry32,
  N,
  polygonPath,
  polylinePath,
  resolveShape,
  resolveSilhouette,
  SYMBOL_LIBRARY,
  validateShape,
  type ContourGeom,
  type Pt,
} from '../index';

const SHAPES = Object.values(LIBRARY);

describe('shape library', () => {
  it.each(SHAPES.map(s => [s.name, s] as const))('%s validates', (_, shape) => {
    expect(() => validateShape(shape)).not.toThrow();
  });

  it.each(SHAPES.map(s => [s.name, s] as const))(
    '%s resolves to N-point contours',
    (_, shape) => {
      const geoms = resolveShape(shape, 300, 200, 0.8);
      expect(geoms).toHaveLength(shape.contours.length);
      for (const g of geoms) {
        expect(g.pts).toHaveLength(N);
        if (g.closed) {
          expect(g.pts[0]).toEqual(g.pts[N - 1]);
        }
        if (g.mode === 'fill') {
          expect(g.closed).toBe(true);
        }
      }
    },
  );

  it('corner-preserving sampling keeps polyline vertices', () => {
    const geoms = resolveShape(LIBRARY.square, 200, 200, 1);
    // all four corners of the placed square must be actual sample points
    const corners = [
      { x: 52, y: 52 },
      { x: 148, y: 52 },
      { x: 148, y: 148 },
      { x: 52, y: 148 },
    ];
    for (const c of corners) {
      expect(
        geoms[0].pts.some(
          p => Math.abs(p.x - c.x) < 1e-6 && Math.abs(p.y - c.y) < 1e-6,
        ),
      ).toBe(true);
    }
  });
});

describe('canonical symbol primitives', () => {
  const names = [
    'alephNull',
    'infinity',
    'cantorSet',
    'contourIntegral',
    'trebleClef',
    'segno',
    'fermata',
    'partial',
    'nabla',
    'continuum',
    'eighthNote',
    'interchange',
    'identityMark',
    'restore',
  ];

  it('contains the selected SVG-backed semantic set', () => {
    expect(Object.keys(SYMBOL_LIBRARY)).toEqual(names);
    for (const shape of Object.values(SYMBOL_LIBRARY)) {
      expect(shape.glyph.length).toBeGreaterThan(0);
      expect(shape.label.length).toBeGreaterThan(0);
      expect(shape.meaning.length).toBeGreaterThan(0);
      expect(shape.aspectRatio).toBeGreaterThan(0);
      expect(shape.strokeWidth).toBeGreaterThan(0);
      expect(['STIX Math', 'Noto Music']).toContain(shape.artwork.source);
      const artwork = Skia.Path.MakeFromSVGString(shape.artwork.d);
      expect(artwork).not.toBeNull();
      const contours = Skia.ContourMeasureIter(artwork!, false, 1);
      expect(contours.next()).not.toBeNull();
    }
  });

  it('preserves exact artwork aspect ratios by default', () => {
    for (const shape of Object.values(SYMBOL_LIBRARY)) {
      const source = Skia.Path.MakeFromSVGString(shape.artwork.d)!;
      const sourceBounds = source.computeTightBounds();
      const resolved = resolveSilhouette(shape, 300, 300, 1);
      const points = resolved.contours.flat();
      const xs = points.map(point => point.x);
      const ys = points.map(point => point.y);
      const resolvedRatio =
        (Math.max(...xs) - Math.min(...xs)) /
        (Math.max(...ys) - Math.min(...ys));

      expect(resolvedRatio).toBeCloseTo(
        sourceBounds.width / sourceBounds.height,
        1,
      );
    }
  });

  it('supports per-instance aspect, stroke, and centre overrides', () => {
    const narrow = resolveShape(SYMBOL_LIBRARY.nabla, 300, 200, 0.8, N, {
      aspectRatio: 0.5,
      strokeWidth: 1,
      centerX: 80,
      centerY: 60,
    });
    const wide = resolveShape(SYMBOL_LIBRARY.nabla, 300, 200, 0.8, N, {
      aspectRatio: 1.5,
      strokeWidth: 1,
      centerX: 80,
      centerY: 60,
    });
    const bounds = (geoms: typeof narrow) => {
      const pts = geoms.flatMap(g => g.pts);
      const xs = pts.map(p => p.x);
      const ys = pts.map(p => p.y);
      return {
        width: Math.max(...xs) - Math.min(...xs),
        centerX: (Math.max(...xs) + Math.min(...xs)) / 2,
        centerY: (Math.max(...ys) + Math.min(...ys)) / 2,
      };
    };
    expect(bounds(wide).width).toBeGreaterThan(bounds(narrow).width * 2);
    expect(bounds(narrow).centerX).toBeCloseTo(80, 5);
    expect(bounds(narrow).centerY).toBeCloseTo(64, 0); // optical triangle centre
    expect(narrow.every(g => g.width === 1.6)).toBe(true);
  });

  it('morphs the canonical compound outlines directly', () => {
    const from = resolveSilhouette(SYMBOL_LIBRARY.infinity, 320, 220, 0.8);
    const to = resolveSilhouette(SYMBOL_LIBRARY.trebleClef, 320, 220, 0.8);
    const transition = buildSilhouetteTransition(from, to);

    expect(transition.from.isInterpolatable(transition.to)).toBe(true);
    expect(transition.toContours).toHaveLength(
      Math.max(from.contours.length, to.contours.length),
    );
    expect(transition.to.toCmds()).toHaveLength(
      transition.from.toCmds().length,
    );
  });

  it('uses strokeWidth to make canonical artwork lighter or heavier', () => {
    const shape = SYMBOL_LIBRARY.infinity;
    const base = shape.strokeWidth;
    const bounds = (strokeWidth: number) => {
      const points = resolveSilhouette(shape, 320, 220, 0.8, {
        strokeWidth,
      }).contours.flat();
      const xs = points.map(point => point.x);
      return Math.max(...xs) - Math.min(...xs);
    };

    expect(bounds(base + 0.8)).toBeGreaterThan(bounds(base));
    expect(bounds(Math.max(0.25, base - 0.5))).toBeLessThan(bounds(base));
  });

  it('morphs through the complete symbol set with compatible slots', () => {
    const symbols = Object.values(SYMBOL_LIBRARY);
    symbols.forEach((shape, index) => {
      const next = symbols[(index + 1) % symbols.length];
      const transition = buildTransition(
        resolveShape(shape, 240, 180, 0.8),
        resolveShape(next, 240, 180, 0.8),
      );
      expect(transition.slots.length).toBeGreaterThan(0);
      transition.slots.forEach(slot => {
        expect(slot.fromPts).toHaveLength(N);
        expect(slot.toPts).toHaveLength(N);
      });
    });
  });
});

describe('transitions', () => {
  const from = resolveShape(LIBRARY.note, 300, 200, 0.8); // 2 fills? 1 fill + 2 strokes
  const to = resolveShape(LIBRARY.spiral, 300, 200, 0.8); // 1 stroke

  it('pairs by mode and stays verb-identical', () => {
    const tr = buildTransition(from, to);
    // 1 fill slot (head shrinks away) + 2 stroke slots (stem+flag → spiral)
    expect(tr.slots).toHaveLength(3);
    for (const s of tr.slots) {
      expect(s.fromPts).toHaveLength(s.toPts.length);
    }
    const fill = tr.slots.find(s => s.mode === 'fill')!;
    expect(fill.toA).toBe(0); // nothing filled arrives — the head fades out
  });

  it('capture reproduces the endpoints', () => {
    const tr = buildTransition(from, to);
    const at0 = captureTransition(tr, 0);
    expect(at0[0].pts).toEqual(tr.slots[0].fromPts);
    const at1 = captureTransition(tr, 1);
    // faded ghosts are dropped; survivors sit exactly on their targets
    expect(at1.length).toBeLessThan(tr.slots.length);
    for (const g of at1) {
      expect(g.alpha).toBe(1);
    }
    const strokes = tr.slots.filter(s => s.mode === 'stroke');
    at1.forEach((g, i) => {
      g.pts.forEach((p, j) => {
        expect(Math.abs(p.x - strokes[i].toPts[j].x)).toBeLessThan(1e-6);
        expect(Math.abs(p.y - strokes[i].toPts[j].y)).toBeLessThan(1e-6);
      });
    });
  });

  it('retarget mid-flight starts from interpolated geometry', () => {
    const tr = buildTransition(from, to);
    const mid = captureTransition(tr, 0.5);
    const back = buildTransition(mid, from);
    expect(back.slots.length).toBeGreaterThan(0);
    for (const s of back.slots) {
      expect(s.fromPts).toHaveLength(s.toPts.length);
    }
  });
});

describe('robustness invariants', () => {
  const strokeGeom = (offset: number): ContourGeom => ({
    pts: Array.from({ length: N }, (_, i) => ({
      x: i * 2 + offset,
      y: 40 + offset,
    })),
    closed: false,
    mode: 'stroke',
    width: 2,
    alpha: 1,
  });

  it('staggered windows never invert, however many slots', () => {
    const many = Array.from({ length: 20 }, (_, i) => strokeGeom(i * 5));
    const tr = buildTransition(many, many);
    expect(tr.slots).toHaveLength(20);
    for (const s of tr.slots) {
      expect(s.winB).toBeGreaterThan(s.winA);
      // every slot keeps a real share of the clock to move in
      expect(s.winB - s.winA).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(s.winA).toBeGreaterThanOrEqual(0);
      expect(s.winB).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('few slots keep the full authored stagger', () => {
    const three = Array.from({ length: 3 }, (_, i) => strokeGeom(i * 5));
    const tr = buildTransition(three, three);
    expect(tr.slots[1].winA - tr.slots[0].winA).toBeCloseTo(0.08, 9);
  });

  it('alignment never increases total travel over the naive pairing', () => {
    const rand = mulberry32(7);
    const ringOf = (n: number): Pt[] => {
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const r = 40 + rand() * 25;
        pts.push({ x: 100 + Math.cos(a) * r, y: 100 + Math.sin(a) * r });
      }
      pts.push({ ...pts[0] });
      return pts;
    };
    const travel = (a: Pt[], b: Pt[]) =>
      a.reduce(
        (s, p, i) => s + (p.x - b[i].x) ** 2 + (p.y - b[i].y) ** 2,
        0,
      );
    for (let trial = 0; trial < 8; trial++) {
      const a = { pts: ringOf(N), closed: true };
      const b = { pts: [...ringOf(N)].reverse(), closed: true };
      const aligned = alignSampled(a, b);
      expect(aligned).toHaveLength(b.pts.length);
      expect(aligned[0]).toEqual(aligned[aligned.length - 1]);
      expect(travel(a.pts, aligned)).toBeLessThanOrEqual(
        travel(a.pts, b.pts) + 1e-9,
      );
    }
  });

  it('assertInterpolatable rejects verb drift in dev', () => {
    const open = polylinePath([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    const closed = polygonPath([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(() => assertInterpolatable(open, closed, 'test')).toThrow(
      /non-interpolatable/,
    );
    expect(() => assertInterpolatable(open, open, 'test')).not.toThrow();
  });
});

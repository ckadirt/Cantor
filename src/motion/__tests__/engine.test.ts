/**
 * The engine's contract, executed against real CanvasKit (see jest.config.js):
 * every library shape parses, validates, and resolves to interpolable
 * geometry; transitions stay verb-identical end to end; capture reproduces
 * the endpoints it should.
 */
import {
  buildTransition,
  captureTransition,
  LIBRARY,
  N,
  resolveShape,
  validateShape,
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
        geoms[0].pts.some(p => Math.abs(p.x - c.x) < 1e-6 && Math.abs(p.y - c.y) < 1e-6),
      ).toBe(true);
    }
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

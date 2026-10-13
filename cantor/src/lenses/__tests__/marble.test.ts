import { faceSeed, hash, mulberry32, type FaceRecipe } from '../face';
import {
  MARBLE_KNOBS,
  applyMarbleOp,
  copySurface,
  dropForward,
  dropInverse,
  inkAt,
  insideRing,
  marbleIdentity,
  marbleIdentityOpsFrom,
  ringArea,
  tineForward,
  tineInverse,
  type MarbleSurface,
  type MarbleTine,
} from '../marble';

const recipe: FaceRecipe = {
  seed: 20261011,
  id: 'cantor',
  model: 'ace-step',
  durationMs: 214000,
};

describe('the equations', () => {
  const out: [number, number] = [0, 0];
  const back: [number, number] = [0, 0];
  const random = mulberry32(5);

  it('undoes a drop exactly, and owns the points inside it', () => {
    for (let n = 0; n < 500; n++) {
      const cx = random() - 0.5;
      const cy = random() - 0.5;
      const r = 0.05 + random() * 0.4;
      const px = (random() - 0.5) * 4;
      const py = (random() - 0.5) * 4;
      dropForward(px, py, cx, cy, r, out);
      // Pushed out of the drop, and back to where it was.
      expect(Math.hypot(out[0] - cx, out[1] - cy)).toBeGreaterThan(r);
      expect(dropInverse(out[0], out[1], cx, cy, r, back)).toBe(true);
      expect(back[0]).toBeCloseTo(px, 9);
      expect(back[1]).toBeCloseTo(py, 9);
    }
    expect(dropInverse(0.1, 0, 0, 0, 0.2, back)).toBe(false);
  });

  it('undoes a tine exactly, whatever its strength', () => {
    for (let n = 0; n < 500; n++) {
      const dir = random() * Math.PI * 2;
      const tine: MarbleTine = {
        kind: 'tine',
        mx: Math.cos(dir),
        my: Math.sin(dir),
        off: random() - 0.5,
        z: random(),
        lambda: 0.05 + random() * 0.3,
      };
      const px = (random() - 0.5) * 3;
      const py = (random() - 0.5) * 3;
      const fraction = random();
      tineForward(px, py, tine, fraction, out);
      tineInverse(out[0], out[1], tine, fraction, back);
      expect(back[0]).toBeCloseTo(px, 9);
      expect(back[1]).toBeCloseTo(py, 9);
    }
  });

  it('preserves area: a drop moves rings, it never shrinks or grows them', () => {
    const ring = (x: number, y: number, r: number, n = 2000) => {
      const pts = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        pts[2 * i] = x + Math.cos((i / n) * Math.PI * 2) * r;
        pts[2 * i + 1] = y + Math.sin((i / n) * Math.PI * 2) * r;
      }
      return pts;
    };
    const surface: MarbleSurface = {
      rings: [
        { pts: ring(0, 0, 0.6), ink: true, toggle: true },
        { pts: ring(0.4, 0.1, 0.15), ink: false, toggle: true },
      ],
    };
    const before = surface.rings.map(r => ringArea(r.pts));
    applyMarbleOp(surface, { kind: 'drop', x: 0.1, y: -0.05, r: 0.3, ink: true, points: 64 }, 1);
    applyMarbleOp(
      surface,
      { kind: 'tine', mx: 0.6, my: 0.8, off: 0.1, z: 0.4, lambda: 0.15 },
      1,
    );
    // The first ring is round the drop, so it gains the drop's own area; what
    // lies between them keeps its own. The second is clear of it.
    expect(
      (ringArea(surface.rings[0].pts) - Math.PI * 0.3 * 0.3) / before[0],
    ).toBeCloseTo(1, 3);
    expect(ringArea(surface.rings[1].pts) / before[1]).toBeCloseTo(1, 3);
  });
});

/*
 * The page's own identity, copied verbatim from lenses-four.html (`MARBLE`):
 * the ops it draws from a stream, and `apply` on Float32 rings. The app's
 * stream salts in the duration (`marbleRandom`), so the two are compared on
 * one stream: the page's `rngOf(recipe, 'marble')`.
 */
const TAU = Math.PI * 2;
const pageLerp = (a: number, b: number, s: number) => a + (b - a) * s;
function pageIdentityOps(q: () => number) {
  const ops: any[] = [];
  const nd = 4 + Math.floor(q() * 4);
  for (let i = 0; i < nd; i++) ops.push({ drop: true, x: (q() - 0.5) * 0.3, y: (q() - 0.5) * 0.3, r: pageLerp(0.25, 0.45, q()), ink: i % 2 === 0 });
  const nt = q() < 0.45 ? 2 : 1;
  for (let i = 0; i < nt; i++) ops.push({ tine: true, dir: q() * TAU, off: (q() - 0.5) * 0.6, z: pageLerp(0.25, 0.6, q()), lam: pageLerp(0.1, 0.25, q()) });
  if (q() < 0.5) { const a = q() * TAU; ops.push({ drop: true, x: Math.cos(a) * 0.45, y: Math.sin(a) * 0.45, r: pageLerp(0.15, 0.25, q()), ink: nd % 2 === 0 }); }
  return ops;
}
function pageApply(rings: { pts: Float32Array; ink: boolean }[], op: any, fr: number, pts: number) {
  if (op.drop) {
    const r = op.r * Math.sqrt(fr), r2 = r * r; if (r2 <= 0) return;
    for (const ring of rings) { const P = ring.pts; for (let i = 0; i < P.length; i += 2) { const dx = P[i] - op.x, dy = P[i + 1] - op.y, k = Math.sqrt(1 + r2 / (dx * dx + dy * dy || 1e-9)); P[i] = op.x + dx * k; P[i + 1] = op.y + dy * k; } }
    const n = op.pts || pts, P = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { const a = i / n * TAU; P[i * 2] = op.x + Math.cos(a) * r; P[i * 2 + 1] = op.y + Math.sin(a) * r; }
    rings.push({ pts: P, ink: op.ink });
  } else {
    const mx = Math.cos(op.dir), my = Math.sin(op.dir), z = op.z * fr;
    for (const ring of rings) { const P = ring.pts; for (let i = 0; i < P.length; i += 2) { const d = Math.abs(-P[i] * my + P[i + 1] * mx - op.off), k = z * Math.exp(-d / op.lam); P[i] += mx * k; P[i + 1] += my * k; } }
  }
}
const pageRandom = (rec: FaceRecipe) =>
  // eslint-disable-next-line no-bitwise
  mulberry32((faceSeed(rec) ^ hash('marble')) >>> 0);

describe('the identity', () => {
  const recipes: FaceRecipe[] = Array.from({ length: 40 }, (_, i) => ({
    seed: i % 5 === 0 ? undefined : 1000 + i * 7919,
    id: `song-${i}`,
    model: ['ace-step', 'yue', 'diffrhythm'][i % 3],
    durationMs: 90000 + i * 3000,
  }));

  it("draws the page's ops from the page's stream", () => {
    for (const rec of recipes) {
      const page = pageIdentityOps(pageRandom(rec));
      const ours = marbleIdentityOpsFrom(pageRandom(rec));
      expect(ours).toHaveLength(page.length);
      page.forEach((op, index) => {
        const mine = ours[index];
        if (op.drop) {
          expect(mine.kind).toBe('drop');
          if (mine.kind !== 'drop') return;
          expect(mine.x).toBeCloseTo(op.x, 12);
          expect(mine.y).toBeCloseTo(op.y, 12);
          expect(mine.r).toBeCloseTo(op.r, 12);
          expect(mine.ink).toBe(op.ink);
        } else {
          expect(mine.kind).toBe('tine');
          if (mine.kind !== 'tine') return;
          expect(mine.mx).toBeCloseTo(Math.cos(op.dir), 12);
          expect(mine.my).toBeCloseTo(Math.sin(op.dir), 12);
          expect(mine.off).toBeCloseTo(op.off, 12);
          expect(mine.z).toBeCloseTo(op.z, 12);
          expect(mine.lambda).toBeCloseTo(op.lam, 12);
        }
      });
    }
  });

  it("leaves the page's rings", () => {
    for (const rec of recipes.slice(0, 12)) {
      const page: { pts: Float32Array; ink: boolean }[] = [];
      for (const op of pageIdentityOps(pageRandom(rec))) pageApply(page, op, 1, MARBLE_KNOBS.MARK_POINTS);
      const ours: MarbleSurface = { rings: [] };
      for (const op of marbleIdentityOpsFrom(pageRandom(rec))) applyMarbleOp(ours, op, 1);
      expect(ours.rings).toHaveLength(page.length);
      ours.rings.forEach((ring, index) => {
        expect(ring.ink).toBe(page[index].ink);
        for (let i = 0; i < ring.pts.length; i++) {
          // The page's rings are Float32.
          expect(Math.abs(ring.pts[i] - page[index].pts[i])).toBeLessThan(1e-5);
        }
      });
    }
  });

  it('is the same marbling for the same recipe, and another for another take', () => {
    expect(marbleIdentity(recipe)).toBe(marbleIdentity({ ...recipe }));
    const other = marbleIdentity({ ...recipe, durationMs: 215000 });
    expect(other.ops).not.toEqual(marbleIdentity(recipe).ops);
  });

  it('fills even-odd as it paints: the newest ring round a point', () => {
    // Up to the polygons' own error: a stretched ring's chords can cut a
    // hair across its neighbour, which painting in order shows as well.
    let wrong = 0;
    let total = 0;
    for (const rec of recipes.slice(0, 20)) {
      const surface = marbleIdentity(rec, MARBLE_KNOBS.PLAYER_POINTS).surface;
      const random = mulberry32(faceSeed(rec));
      for (let n = 0; n < 300; n++) {
        const x = (random() - 0.5) * 2.4;
        const y = (random() - 0.5) * 2.4;
        let odd = false;
        for (const ring of surface.rings) {
          if (ring.toggle && insideRing(ring.pts, x, y)) odd = !odd;
        }
        total += 1;
        if (odd !== inkAt(surface, x, y)) wrong += 1;
      }
    }
    expect(wrong / total).toBeLessThan(0.003);
  });

  it('measures its extent by area: √Σr² of its drops', () => {
    const identity = marbleIdentity(recipe);
    const area = identity.surface.rings.reduce(
      (sum, ring) => sum + ringArea(ring.pts),
      0,
    );
    // Rings nest, so their areas overlap; the bath's own area is the drops'.
    let drops = 0;
    for (const op of identity.ops) if (op.kind === 'drop') drops += Math.PI * op.r * op.r;
    expect(area).toBeGreaterThan(drops * 0.99);
    expect(identity.ext).toBeCloseTo(Math.sqrt(drops / Math.PI), 9);
    expect(identity.reach).toBeGreaterThan(identity.ext * 0.9);
  });

  it('gives an imported song a clear drop at its centre, outlined', () => {
    const imported = marbleIdentity({ ...recipe, imported: true });
    const plain = marbleIdentity(recipe);
    expect(imported.surface.rings).toHaveLength(plain.surface.rings.length + 1);
    const spindle = imported.surface.rings[imported.surface.rings.length - 1];
    expect(spindle.ink).toBe(false);
    expect(inkAt(imported.surface, 0, 0)).toBe(false);
  });

  it('copies deeply', () => {
    const identity = marbleIdentity(recipe);
    const copy = copySurface(identity.surface);
    applyMarbleOp(copy, { kind: 'drop', x: 0, y: 0, r: 0.3, ink: true, points: 40 }, 1);
    expect(copy.rings).toHaveLength(identity.surface.rings.length + 1);
    expect(copy.rings[0].pts[0]).not.toBe(identity.surface.rings[0].pts[0]);
  });
});

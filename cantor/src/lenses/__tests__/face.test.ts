import {
  FACE_KNOBS,
  FACE_MAX_EXTENT,
  faceParams,
  facePoints,
  faceSeed,
  type FaceRecipe,
} from '../face';
import { NAME_LENS_KNOBS, nameLensFacePath } from '../nameLens';

const recipe = (over: Partial<FaceRecipe> = {}): FaceRecipe => ({
  seed: 41822,
  id: 'song-a',
  model: 'acestep:1.5-fast',
  durationMs: 192_000,
  ...over,
});

const maxRadius = (points: readonly { x: number; y: number }[]): number =>
  Math.max(...points.map(point => Math.hypot(point.x, point.y)));

describe('the face', () => {
  /**
   * What the L0 → L1 transition rests on.
   *
   * The field draws one face across both levels and *scales* it from the mark's
   * radius to the row's, rather than crossfading two drawings of the same
   * silhouette. That is only the same shape if the path is linear in its
   * radius — no constant inset, no radius-dependent detail. If this ever stops
   * being true the face will visibly deform on the way into a row, and it will
   * deform silently, so it is asserted here rather than discovered there.
   */
  it('is the same silhouette at any radius, scaled', () => {
    const mark = nameLensFacePath(recipe(), NAME_LENS_KNOBS.MARK_RADIUS_PX);
    const row = nameLensFacePath(recipe(), NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX);
    const growth =
      NAME_LENS_KNOBS.ROW_FACE_RADIUS_PX / NAME_LENS_KNOBS.MARK_RADIUS_PX;
    expect(row.countPoints()).toBe(mark.countPoints());
    for (let index = 0; index < mark.countPoints(); index += 1) {
      const from = mark.getPoint(index);
      const to = row.getPoint(index);
      expect(to.x).toBeCloseTo(from.x * growth, 5);
      expect(to.y).toBeCloseTo(from.y * growth, 5);
    }
  });

  it('draws the same shape for the same recipe, every time', () => {
    expect(facePoints(recipe())).toEqual(facePoints(recipe()));
  });

  it('gives different seeds different shapes', () => {
    const left = facePoints(recipe({ seed: 1 }));
    const right = facePoints(recipe({ seed: 2 }));
    expect(left).not.toEqual(right);
  });

  it('separates two seeds that collide across models', () => {
    const ace = faceSeed(recipe({ model: 'acestep:1.5-fast' }));
    const levo = faceSeed(recipe({ model: 'levo2:1.0' }));
    expect(ace).not.toEqual(levo);
  });

  it('still has a face when the node sent no seed', () => {
    const first = facePoints(recipe({ seed: undefined }));
    const second = facePoints(recipe({ seed: undefined }));
    expect(first).toEqual(second);
    expect(first).not.toEqual(facePoints(recipe({ seed: undefined, id: 'song-b' })));
  });

  it('closes: the last point returns to the neighbourhood of the first', () => {
    const points = facePoints(recipe());
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const step = (2 * Math.PI) / points.length;
    // One sample apart on a curve of radius ~1, so the gap is bounded by the arc.
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeLessThan(step * 2);
  });

  it('stays near the unit circle, so callers can scale by radius alone', () => {
    const points = facePoints(recipe());
    const bound =
      (1 + FACE_KNOBS.PRIMARY_MIN + FACE_KNOBS.PRIMARY_SPAN +
        FACE_KNOBS.SECONDARY_MIN + FACE_KNOBS.SECONDARY_SPAN) *
      (1 + FACE_KNOBS.ECCENTRICITY / 2);
    expect(maxRadius(points)).toBeLessThanOrEqual(bound);
    expect(maxRadius(points)).toBeGreaterThan(0.5);
  });

  it('never reaches past FACE_MAX_EXTENT, which is where the rings sit', () => {
    // A ring drawn inside this radius cuts through a lobe, so the bound has to
    // hold for every recipe rather than for the one this file usually draws.
    for (let index = 0; index < 500; index += 1) {
      const points = facePoints(
        recipe({
          seed: index * 7919,
          id: `song-${index}`,
          durationMs: index * 1_337,
        }),
      );
      expect(maxRadius(points)).toBeLessThanOrEqual(FACE_MAX_EXTENT);
    }
  });

  it('survives a zero, absurd or negative duration', () => {
    for (const durationMs of [0, -1, 5_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const points = facePoints(recipe({ durationMs }));
      expect(points).toHaveLength(FACE_KNOBS.SAMPLES);
      for (const point of points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
    }
  });

  it('lets duration widen or narrow the form without changing its character', () => {
    const short = faceParams(recipe({ durationMs: 30_000 }));
    const long = faceParams(recipe({ durationMs: 300_000 }));
    expect(short.lobes).toEqual(long.lobes);
    expect(short.detail).toEqual(long.detail);
    expect(short.eccentricity).not.toEqual(long.eccentricity);
  });

  it('never returns fewer than three points, whatever it is asked for', () => {
    expect(facePoints(recipe(), 0)).toHaveLength(3);
    expect(facePoints(recipe(), 1)).toHaveLength(3);
    expect(facePoints(recipe(), 12)).toHaveLength(12);
  });
});

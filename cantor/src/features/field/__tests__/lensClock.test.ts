/**
 * The lens clock's rules: any lens to any other, interrupted from what is
 * drawn. Three lenses are named here though two exist, because the third-lens
 * rule is the one the tree will need and it has to hold before it arrives.
 */
import { lensWeight, retargetLens, type LensClockState } from '../lensClock';

const CIRCLE = 0;
const SEAL = 1;
const TREE = 2;

const rest = (lens: number): LensClockState => ({
  from: lens,
  to: lens,
  t: 1,
  next: -1,
});

describe('retargeting the lens clock', () => {
  it('starts a change from where it rests', () => {
    expect(retargetLens(rest(CIRCLE), SEAL)).toEqual({
      from: CIRCLE,
      to: SEAL,
      t: 0,
      next: -1,
      run: true,
    });
  });

  it('does nothing for the lens it already shows', () => {
    expect(retargetLens(rest(SEAL), SEAL).run).toBe(false);
    // A change that has landed counts as resting on its destination.
    const landed = { from: CIRCLE, to: SEAL, t: 1, next: -1 };
    expect(retargetLens(landed, SEAL)).toEqual({ ...rest(SEAL), run: false });
    expect(retargetLens(landed, CIRCLE)).toEqual({
      from: SEAL,
      to: CIRCLE,
      t: 0,
      next: -1,
      run: true,
    });
  });

  it('reverses from where it stands when sent back', () => {
    const mid = { from: CIRCLE, to: SEAL, t: 0.3, next: -1 };
    const back = retargetLens(mid, CIRCLE);
    expect(back).toEqual({
      from: SEAL,
      to: CIRCLE,
      t: 0.7,
      next: -1,
      run: true,
    });
    // The same amount of each lens is showing, on the frame it turns round.
    for (const lens of [CIRCLE, SEAL]) {
      expect(lensWeight(lens, back.from, back.to, back.t)).toBeCloseTo(
        lensWeight(lens, mid.from, mid.to, mid.t),
        12,
      );
    }
  });

  it('keeps going, and forgets a queued lens, when asked for its destination', () => {
    const queued = { from: CIRCLE, to: SEAL, t: 0.4, next: TREE };
    expect(retargetLens(queued, SEAL)).toEqual({
      ...queued,
      next: -1,
      run: false,
    });
  });

  it('queues a third lens rather than jumping to it mid-change', () => {
    const mid = { from: CIRCLE, to: SEAL, t: 0.4, next: -1 };
    expect(retargetLens(mid, TREE)).toEqual({ ...mid, next: TREE, run: false });
  });
});

describe('how much of a lens is showing', () => {
  it('is all of a resting lens and none of the others', () => {
    expect(lensWeight(SEAL, SEAL, SEAL, 1)).toBe(1);
    expect(lensWeight(CIRCLE, SEAL, SEAL, 1)).toBe(0);
  });

  it('runs from the lens being left to the one arriving', () => {
    expect(lensWeight(CIRCLE, CIRCLE, SEAL, 0.25)).toBe(0.75);
    expect(lensWeight(SEAL, CIRCLE, SEAL, 0.25)).toBe(0.25);
    expect(lensWeight(TREE, CIRCLE, SEAL, 0.25)).toBe(0);
  });
});

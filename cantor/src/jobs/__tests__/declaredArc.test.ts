import { declaredArc, jobMarkModel } from '../marks';
import type { JobView } from '../../core/protocol';

const MASK = ['plan', 'codes', 'diffuse', 'decode'] as const;

const job = (over: Partial<JobView> = {}): JobView =>
  ({
    id: 'job-1',
    revision: 1,
    state: 'running',
    stage: 'diffuse',
    model: 'acestep:1.5-fast',
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    ...over,
  }) as JobView;

describe('the arc a job will trace', () => {
  it('gives every declared stage an equal share of the ring', () => {
    const indeterminate = { kind: 'indeterminate' } as const;
    expect(declaredArc(MASK, 'plan', indeterminate)).toBeCloseTo(0);
    expect(declaredArc(MASK, 'codes', indeterminate)).toBeCloseTo(0.25);
    expect(declaredArc(MASK, 'diffuse', indeterminate)).toBeCloseTo(0.5);
    expect(declaredArc(MASK, 'decode', indeterminate)).toBeCloseTo(0.75);
  });

  it('spends a counted stage across its own share, never past it', () => {
    const half = { kind: 'determinate', fraction: 0.5, completed: 16, total: 32 } as const;
    // Half way through the third of four stages: half of the third quarter.
    expect(declaredArc(MASK, 'diffuse', half)).toBeCloseTo(0.625);
    const done = { kind: 'determinate', fraction: 1, completed: 32, total: 32 } as const;
    expect(declaredArc(MASK, 'diffuse', done)).toBeCloseTo(0.75);
    expect(declaredArc(MASK, 'decode', done)).toBeCloseTo(1);
  });

  it('has no arc at all when the model declared nothing', () => {
    // Not zero: an undeclared pipeline has made no claim about its shape, and
    // the mark falls back to the sweep rather than drawing an empty ring.
    expect(declaredArc([], 'diffuse', { kind: 'indeterminate' })).toBeNull();
  });

  it('starts the ring for a stage the mask never mentioned', () => {
    expect(
      declaredArc(MASK, 'polish' as never, { kind: 'indeterminate' }),
    ).toBe(0);
  });

  it('carries the mask, the stage index and the arc onto the mark', () => {
    const model = jobMarkModel(job(), [], MASK);

    expect(model.declaredStages).toEqual(MASK);
    expect(model.stageIndex).toBe(2);
    expect(model.arc).toBeCloseTo(0.5);
    expect(model.symbol).toBe('contourIntegral');
  });

  it('leaves a job with no mask exactly as it was before M8', () => {
    const model = jobMarkModel(job(), []);

    expect(model.declaredStages).toEqual([]);
    expect(model.stageIndex).toBe(-1);
    expect(model.arc).toBeNull();
  });
});

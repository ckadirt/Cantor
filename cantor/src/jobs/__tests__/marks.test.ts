import type { JobView } from '../../core/protocol';
import { STAGE_SYMBOLS, jobMarkModel, observeStage } from '../marks';

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    revision: 1,
    state: 'running',
    model: 'light',
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

describe('stage symbols', () => {
  it('maps every generation stage to a canonical symbol', () => {
    expect(Object.keys(STAGE_SYMBOLS)).toEqual([
      'plan',
      'codes',
      'diffuse',
      'decode',
    ]);
  });

  it('has no symbol at all until the node reports a stage', () => {
    expect(jobMarkModel(job({ stage: undefined }), []).symbol).toBeNull();
  });

  it.each(['plan', 'codes', 'diffuse', 'decode'] as const)(
    'draws the %s stage with its own symbol',
    stage => {
      expect(jobMarkModel(job({ stage }), []).symbol).toBe(STAGE_SYMBOLS[stage]);
    },
  );
});

describe('progress', () => {
  it('is determinate only when the node supplied a total', () => {
    const model = jobMarkModel(
      job({ progress: { completed: 3, total: 12, unit: 'steps' } }),
      [],
    );

    expect(model.progress).toEqual({
      kind: 'determinate',
      fraction: 0.25,
      completed: 3,
      total: 12,
    });
  });

  it('refuses to fabricate a percentage without a total', () => {
    const model = jobMarkModel(
      job({ progress: { completed: 7, unit: 'steps' } }),
      [],
    );

    expect(model.progress).toEqual({ kind: 'indeterminate' });
  });

  it('is indeterminate when there is no progress at all', () => {
    expect(jobMarkModel(job(), []).progress).toEqual({ kind: 'indeterminate' });
  });

  it('treats a zero total as unknowable rather than dividing by it', () => {
    const model = jobMarkModel(
      job({ progress: { completed: 0, total: 0, unit: 'steps' } }),
      [],
    );

    expect(model.progress).toEqual({ kind: 'indeterminate' });
  });

  it('clamps a node that overshoots its own total', () => {
    const model = jobMarkModel(
      job({ progress: { completed: 20, total: 12, unit: 'steps' } }),
      [],
    );

    expect(model.progress).toMatchObject({ fraction: 1 });
  });
});

describe('observed stages', () => {
  it('remembers only stages that were actually seen', () => {
    expect(jobMarkModel(job({ stage: 'codes' }), ['plan']).observedStages).toEqual(
      ['plan', 'codes'],
    );
  });

  it('does not predict an arc the node never advertised', () => {
    // Before M8 there is no stage mask, so a job seen once knows one stage.
    expect(jobMarkModel(job({ stage: 'plan' }), []).observedStages).toEqual([
      'plan',
    ]);
  });

  it('does not duplicate a stage revisited after recovering', () => {
    expect(observeStage(['plan', 'codes'], 'plan')).toEqual(['plan', 'codes']);
  });

  it('ignores an absent stage', () => {
    expect(observeStage(['plan'], undefined)).toEqual(['plan']);
  });
});

describe('liveness and failure', () => {
  it.each(['queued', 'preparing', 'running', 'recovering', 'finalizing'] as const)(
    'treats %s as live work',
    state => {
      expect(jobMarkModel(job({ state }), []).live).toBe(true);
    },
  );

  it.each(['paused', 'pause_requested', 'failed', 'completed'] as const)(
    'does not treat %s as live work',
    state => {
      expect(jobMarkModel(job({ state }), []).live).toBe(false);
    },
  );

  it('offers a retry only when the node said the failure is retryable', () => {
    const retryable = jobMarkModel(
      job({
        state: 'failed',
        error: { code: 'internal', message: 'boom', retryable: true },
      }),
      [],
    );
    const permanent = jobMarkModel(
      job({
        state: 'failed',
        error: { code: 'invalid_request', message: 'no', retryable: false },
      }),
      [],
    );

    expect(retryable).toMatchObject({ failed: true, retryable: true });
    expect(permanent).toMatchObject({ failed: true, retryable: false });
  });
});

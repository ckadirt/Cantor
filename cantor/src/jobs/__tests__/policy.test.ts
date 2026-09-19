import type { JobView } from '../../core/protocol';
import { canForgetJob, jobControls } from '../policy';

function job(state: JobView['state'], retryable?: boolean): JobView {
  return {
    id: 'job-1',
    revision: 1,
    state,
    model: 'acestep:1.5-fast',
    created_at: '2026-09-18T10:00:00Z',
    updated_at: '2026-09-18T10:01:00Z',
    ...(retryable === undefined
      ? {}
      : { error: { code: 'internal', message: 'stopped', retryable } }),
  };
}

describe('what a job lets you do', () => {
  it('offers deletion exactly where the node allows it', () => {
    expect(canForgetJob(job('failed', false))).toBe(true);
    expect(canForgetJob(job('cancelled'))).toBe(true);
    for (const state of [
      'queued',
      'preparing',
      'running',
      'pause_requested',
      'paused',
      'cancel_requested',
      'finalizing',
      'recovering',
      // A completed job owns a song's audio under the same directory.
      'completed',
    ] as const) {
      expect(canForgetJob(job(state))).toBe(false);
    }
  });

  it('leaves a failure that will not be retried with deletion as its only act', () => {
    expect(jobControls(job('failed', false))).toEqual([]);
    expect(canForgetJob(job('failed', false))).toBe(true);
    expect(jobControls(job('failed', true))).toEqual(['retry']);
  });
});

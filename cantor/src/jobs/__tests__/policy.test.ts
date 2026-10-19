import type { JobView } from '../../core/protocol';
import {
  canForgetJob,
  jobControls,
  jobProgressLabel,
  jobStateLabel,
} from '../policy';

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

describe('what a running job is called', () => {
  const running = (stage?: string): JobView => ({
    ...job('running'),
    ...(stage === undefined ? {} : { stage }),
  });

  it('names the stages it knows', () => {
    expect(jobStateLabel(running('encode'))).toBe('Reading the source');
    expect(jobStateLabel(running('listen'))).toBe('Listening to the source');
    expect(jobStateLabel(running('diffuse'))).toBe('Shaping audio');
  });

  it('calls any other stage, or none yet, working', () => {
    expect(jobStateLabel(running('mixdown'))).toBe('Working');
    expect(jobStateLabel(running())).toBe('Working');
  });
});

it('names each local phase and offers no controls before a node job exists', () => {
  expect(jobStateLabel(null, { kind: 'waiting' }, 'Studio')).toBe(
    'Waiting for Studio',
  );
  expect(
    jobStateLabel(null, { kind: 'sending', sent: 1, total: 10 }, 'Studio'),
  ).toBe('Sending the source');
  expect(jobStateLabel(null, { kind: 'submitted' }, 'Studio')).toBe(
    'Handing it to Studio',
  );
  expect(jobControls(null)).toEqual([]);
  expect(canForgetJob(null)).toBe(false);
});

it.each(['encode', 'diffuse', 'decode', 'mixdown'])(
  'resumes at the same label as the running %s stage',
  stage => {
    const running = { ...job('running'), stage };
    const label = jobStateLabel(running);
    expect(jobStateLabel({ ...running, state: 'preparing' })).toBe(
      `Resuming: ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
    );
  },
);

it('writes sending bytes in MB while tile and step counts keep their units', () => {
  const progress = {
    kind: 'determinate',
    completed: 7225344,
    total: 25149263,
    fraction: 0.28,
  } as const;
  const phase = {
    kind: 'sending',
    sent: progress.completed,
    total: progress.total,
  } as const;
  expect(
    `${jobStateLabel(null, phase)}${jobProgressLabel(progress, phase)}`,
  ).toBe('Sending the source · 7.2 of 25 MB');
  expect(
    jobProgressLabel({ ...progress, completed: 3, total: 12 }, { kind: 'job' }),
  ).toBe(' 3/12');
  expect(jobProgressLabel({ kind: 'indeterminate' }, phase)).toBe('');
});

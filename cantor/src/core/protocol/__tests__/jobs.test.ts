import { parseJob } from '../jobs';

const wire = (extra: Record<string, unknown> = {}) => ({
  id: 'job-1',
  revision: 2,
  state: 'running',
  model: 'acestep:1.5-fast',
  created_at: '2026-10-15T12:00:00Z',
  updated_at: '2026-10-15T12:01:00Z',
  ...extra,
});

describe('parseJob reads a newer node forward', () => {
  it('keeps a stage it has no symbol for, by name', () => {
    expect(parseJob(wire({ stage: 'encode' }))?.stage).toBe('encode');
  });

  it('keeps counts in a unit it does not know', () => {
    expect(
      parseJob(
        wire({
          stage: 'encode',
          progress: { completed: 2, total: 6, unit: 'chunks' },
        }),
      )?.progress,
    ).toEqual({ completed: 2, total: 6, unit: 'chunks' });
  });

  it('reads a state it does not know as live work', () => {
    expect(parseJob(wire({ state: 'listening' }))?.state).toBe('running');
  });

  it('reads a state it does not know, carrying an error, as a failure', () => {
    expect(
      parseJob(
        wire({
          state: 'abandoned',
          error: {
            code: 'source_gone',
            message: 'The source was removed.',
            retryable: false,
          },
        }),
      ),
    ).toMatchObject({
      state: 'failed',
      error: { code: 'source_gone', message: 'The source was removed.' },
    });
  });

  it('still refuses what is malformed rather than merely new', () => {
    expect(parseJob(wire({ stage: 4 }))).toBeNull();
    expect(parseJob(wire({ stage: 'Encode Audio' }))).toBeNull();
    expect(parseJob(wire({ state: '' }))).toBeNull();
    expect(
      parseJob(wire({ progress: { completed: 1, total: 6, unit: 9 } })),
    ).toBeNull();
    // A known failure still needs its error, and only a failure may carry one.
    expect(parseJob(wire({ state: 'failed' }))).toBeNull();
    expect(
      parseJob(
        wire({ error: { code: 'internal', message: 'x', retryable: true } }),
      ),
    ).toBeNull();
  });
});

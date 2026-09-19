import AsyncStorage from '@react-native-async-storage/async-storage';
import type { JobView } from '../../../../protocol/JobView';
import {
  forgetJobs,
  loadJobs,
  mergeJobs,
  mergeJobViews,
} from '../repository';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const storage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

function job(id: string, revision: number, state: JobView['state']): JobView {
  return {
    id,
    revision,
    state,
    model: 'acestep:test',
    created_at: '2026-08-07T00:00:00Z',
    updated_at: `2026-08-07T00:00:0${revision}Z`,
    ...(state === 'failed'
      ? {
          error: {
            code: 'internal',
            message: 'Generation failed.',
            retryable: true,
          },
        }
      : {}),
  };
}

describe('job snapshot repository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue();
  });

  it('never rolls a job backward during list and push races', () => {
    expect(
      mergeJobViews([job('same', 4, 'running')], [job('same', 2, 'queued')]),
    ).toEqual([job('same', 4, 'running')]);
  });

  it('sorts newest first and uses descending ids as the stable tie-breaker', () => {
    const older = {
      ...job('z', 1, 'queued'),
      created_at: '2026-08-06T00:00:00Z',
    };
    expect(
      mergeJobViews([], [job('a', 1, 'queued'), older, job('b', 1, 'queued')]),
    ).toEqual([job('b', 1, 'queued'), job('a', 1, 'queued'), older]);
  });

  it('isolates the same job id on two nodes', async () => {
    await mergeJobs('node-a', [job('same', 2, 'running')]);
    const firstWrite = storage.setItem.mock.calls[0][1];
    storage.getItem.mockResolvedValue(firstWrite);
    await mergeJobs('node-b', [job('same', 5, 'completed')]);
    const stored = JSON.parse(storage.setItem.mock.calls[1][1]);
    expect(stored['node-a'].same.revision).toBe(2);
    expect(stored['node-b'].same.revision).toBe(5);
  });

  it('keeps the storage key, JSON shape, and merged return value stable', async () => {
    const merged = await mergeJobs('node', [job('two', 2, 'running')]);
    expect(merged).toEqual([job('two', 2, 'running')]);
    expect(storage.setItem).toHaveBeenCalledWith(
      'cantor.job-snapshots.v1',
      JSON.stringify({ node: { two: job('two', 2, 'running') } }),
    );
  });

  it('serializes concurrent merges without dropping either snapshot', async () => {
    let persisted: string | null = null;
    storage.getItem.mockImplementation(async () => persisted);
    storage.setItem.mockImplementation(async (_key, value) => {
      persisted = value;
    });

    await Promise.all([
      mergeJobs('node', [job('first', 1, 'queued')]),
      mergeJobs('node', [job('second', 2, 'running')]),
    ]);
    expect(JSON.parse(persisted ?? '{}').node).toEqual({
      first: job('first', 1, 'queued'),
      second: job('second', 2, 'running'),
    });
  });

  it('continues accepting merges after a storage write fails', async () => {
    storage.setItem
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce();

    await expect(mergeJobs('node', [job('lost', 1, 'queued')])).rejects.toThrow(
      'write failed',
    );
    await expect(
      mergeJobs('node', [job('kept', 2, 'running')]),
    ).resolves.toEqual([job('kept', 2, 'running')]);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('restores a terminal snapshot after process restart', async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({ node: { done: job('done', 7, 'completed') } }),
    );
    await expect(loadJobs('node')).resolves.toEqual([
      job('done', 7, 'completed'),
    ]);
  });

  it('forgets only the named job, and only on its own node', async () => {
    const values = new Map<string, string>();
    storage.getItem.mockImplementation(async key => values.get(key) ?? null);
    storage.setItem.mockImplementation(async (key, value) => {
      values.set(key, value);
    });
    await mergeJobs('node-a', [job('gone', 3, 'failed'), job('kept', 1, 'running')]);
    await mergeJobs('node-b', [job('gone', 2, 'failed')]);

    await forgetJobs('node-a', ['gone']);

    await expect(loadJobs('node-a')).resolves.toEqual([job('kept', 1, 'running')]);
    await expect(loadJobs('node-b')).resolves.toEqual([job('gone', 2, 'failed')]);
  });

  it('does not resurrect a forgotten job when the node lists again', async () => {
    const values = new Map<string, string>();
    storage.getItem.mockImplementation(async key => values.get(key) ?? null);
    storage.setItem.mockImplementation(async (key, value) => {
      values.set(key, value);
    });
    await mergeJobs('node', [job('gone', 3, 'failed')]);
    await forgetJobs('node', ['gone']);
    // The node no longer sends it, so a later page simply never mentions it.
    await expect(mergeJobs('node', [job('other', 1, 'queued')])).resolves.toEqual([
      job('other', 1, 'queued'),
    ]);
    await expect(loadJobs('node')).resolves.toEqual([job('other', 1, 'queued')]);
  });

  it('preserves the invalid JSON and snapshot validation errors', async () => {
    storage.getItem.mockResolvedValueOnce('{broken');
    await expect(loadJobs('node')).rejects.toBeInstanceOf(SyntaxError);

    storage.getItem.mockResolvedValueOnce('[]');
    await expect(loadJobs('node')).rejects.toThrow(
      'Saved job snapshots are invalid.',
    );

    storage.getItem.mockResolvedValueOnce(
      JSON.stringify({ node: { expected: job('different', 1, 'queued') } }),
    );
    await expect(loadJobs('node')).rejects.toThrow(
      'Saved job snapshots contain an invalid job.',
    );
  });
});

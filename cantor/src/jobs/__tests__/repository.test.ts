import AsyncStorage from '@react-native-async-storage/async-storage';
import type { JobView } from '../../../../protocol/JobView';
import { loadJobs, mergeJobs, mergeJobViews } from '../repository';

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

  it('isolates the same job id on two nodes', async () => {
    await mergeJobs('node-a', [job('same', 2, 'running')]);
    const firstWrite = storage.setItem.mock.calls[0][1];
    storage.getItem.mockResolvedValue(firstWrite);
    await mergeJobs('node-b', [job('same', 5, 'completed')]);
    const stored = JSON.parse(storage.setItem.mock.calls[1][1]);
    expect(stored['node-a'].same.revision).toBe(2);
    expect(stored['node-b'].same.revision).toBe(5);
  });

  it('restores a terminal snapshot after process restart', async () => {
    storage.getItem.mockResolvedValue(
      JSON.stringify({ node: { done: job('done', 7, 'completed') } }),
    );
    await expect(loadJobs('node')).resolves.toEqual([
      job('done', 7, 'completed'),
    ]);
  });
});

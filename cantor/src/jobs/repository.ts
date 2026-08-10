import type { JobView } from '../../../protocol/JobView';
import { parseJob } from '../core/protocol';
import { createSerializedJsonStore } from '../core/storage/serializedJsonStore';
import { isRecord } from '../core/validation';

const JOBS_KEY = 'cantor.job-snapshots.v1';

type StoredJobs = Record<string, Record<string, JobView>>;

const jobStore = createSerializedJsonStore<StoredJobs>({
  key: JOBS_KEY,
  empty: () => ({}),
  decode: decodeStoredJobs,
  invalidJson: (_raw, error) => {
    throw error;
  },
});

export function mergeJobViews(
  current: JobView[],
  incoming: JobView[],
): JobView[] {
  const merged = new Map(current.map(job => [job.id, job]));
  for (const job of incoming) {
    const existing = merged.get(job.id);
    if (existing === undefined || job.revision > existing.revision) {
      merged.set(job.id, job);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) ||
      right.id.localeCompare(left.id),
  );
}

export async function loadJobs(nodePublicKey: string): Promise<JobView[]> {
  const stored = await jobStore.load();
  return mergeJobViews([], Object.values(stored[nodePublicKey] ?? {}));
}

export async function mergeJobs(
  nodePublicKey: string,
  incoming: JobView[],
): Promise<JobView[]> {
  return jobStore.update(stored => {
    const current = Object.values(stored[nodePublicKey] ?? {});
    const merged = mergeJobViews(current, incoming);
    stored[nodePublicKey] = Object.fromEntries(
      merged.map(job => [job.id, job]),
    );
    return { value: stored, result: merged };
  });
}

function decodeStoredJobs(value: unknown): StoredJobs {
  if (!isRecord(value)) throw new Error('Saved job snapshots are invalid.');
  const result: StoredJobs = {};
  for (const [node, jobs] of Object.entries(value)) {
    if (!isRecord(jobs)) throw new Error('Saved job snapshots are invalid.');
    result[node] = {};
    for (const [id, candidate] of Object.entries(jobs)) {
      const job = parseJob(candidate);
      if (job === null || job.id !== id) {
        throw new Error('Saved job snapshots contain an invalid job.');
      }
      result[node][id] = job;
    }
  }
  return result;
}

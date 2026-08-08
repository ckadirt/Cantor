import AsyncStorage from '@react-native-async-storage/async-storage';
import type { JobView } from '../../../protocol/JobView';
import { parseJob } from '../backends/types';

const JOBS_KEY = 'cantor.job-snapshots.v1';
let writeQueue = Promise.resolve();

type StoredJobs = Record<string, Record<string, JobView>>;

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
  const stored = await loadAll();
  return mergeJobViews([], Object.values(stored[nodePublicKey] ?? {}));
}

export async function mergeJobs(
  nodePublicKey: string,
  incoming: JobView[],
): Promise<JobView[]> {
  return withWriteLock(async () => {
    const stored = await loadAll();
    const current = Object.values(stored[nodePublicKey] ?? {});
    const merged = mergeJobViews(current, incoming);
    stored[nodePublicKey] = Object.fromEntries(
      merged.map(job => [job.id, job]),
    );
    await AsyncStorage.setItem(JOBS_KEY, JSON.stringify(stored));
    return merged;
  });
}

async function loadAll(): Promise<StoredJobs> {
  const raw = await AsyncStorage.getItem(JOBS_KEY);
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

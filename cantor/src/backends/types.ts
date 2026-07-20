import type { JobView } from '../../../protocol/JobView';
import type { NodeInfo } from '../../../protocol/NodeInfo';

export type { JobView, NodeInfo };

export type BackendRecord = {
  nodePubkey: string;
  relayUrl: string;
  petname: string;
  lastNodeInfo: NodeInfo | null;
};

export type ConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'attached'
  | 'handshaking'
  | 'ready';

export type ConnectionSnapshot = {
  phase: ConnectionPhase;
  error: string | null;
  jobs: JobView[];
};

export type PairingRequest = {
  backend: BackendRecord;
  pairToken: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseNodeInfo(value: unknown): NodeInfo | null {
  if (!isRecord(value) || !isRecord(value.limits) || !isRecord(value.load)) {
    return null;
  }
  if (
    typeof value.name !== 'string' ||
    typeof value.device_type !== 'string' ||
    typeof value.engine_version !== 'string' ||
    !Array.isArray(value.models) ||
    !value.models.every(model => typeof model === 'string') ||
    typeof value.limits.max_concurrent_jobs !== 'number' ||
    typeof value.limits.max_song_seconds !== 'number' ||
    typeof value.load.active_jobs !== 'number' ||
    typeof value.load.queued_jobs !== 'number'
  ) {
    return null;
  }
  return value as NodeInfo;
}

export function parseJobs(value: unknown): JobView[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const jobs: JobView[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.state !== 'string' ||
      typeof item.stage !== 'string' ||
      !(item.step === null || typeof item.step === 'number') ||
      !(item.steps_total === null || typeof item.steps_total === 'number')
    ) {
      return null;
    }
    jobs.push(item as JobView);
  }
  return jobs;
}

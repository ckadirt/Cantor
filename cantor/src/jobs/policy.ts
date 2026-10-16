import type { WorkPhase } from '../work';
import type { JobView } from '../core/protocol';

/** What a caller may ask the node to do to a job. */
export type JobControl = 'pause' | 'resume' | 'cancel' | 'retry';

/**
 * What a job lets you do, and what it is currently doing.
 *
 * Pure policy, deliberately outside any component: the console renders it as a
 * queue row and the field renders it as a mark, and both have to agree about
 * which controls a job in a given state actually offers. Terminal states offer
 * nothing, and a failure only offers a retry when the node said it is
 * retryable.
 */
export function jobControls(job: JobView | null): JobControl[] {
  if (job === null) return [];
  switch (job.state) {
    case 'queued':
    case 'preparing':
    case 'running':
      return ['pause', 'cancel'];
    case 'pause_requested':
      return ['cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'failed':
      return job.error?.retryable ? ['retry'] : [];
    default:
      return [];
  }
}

/**
 * Whether a job can be deleted outright.
 *
 * Deletion is not a control: it ends the record rather than the work, so it is
 * offered only where there is no work left to end and nothing was published.
 * The node enforces the same two states; this is the app agreeing with it in
 * advance rather than offering an act that would be refused.
 */
export function canForgetJob(job: JobView | null): boolean {
  if (job === null) return false;
  return job.state === 'failed' || job.state === 'cancelled';
}

export function jobStateLabel(
  job: JobView | null,
  phase: WorkPhase = { kind: 'job' },
  node = 'node',
): string {
  if (job === null) {
    switch (phase.kind) {
      case 'waiting':
        return `Waiting for ${node}`;
      case 'sending':
        return 'Sending the source';
      default:
        return `Handing it to ${node}`;
    }
  }
  if (job.state === 'preparing' && job.stage !== undefined) {
    const label = jobStateLabel({ ...job, state: 'running' });
    return `Resuming: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  }
  if (job.state === 'running') {
    switch (job.stage) {
      case 'plan':
        return 'Writing plan';
      case 'codes':
        return 'Generating codes';
      case 'encode':
        return 'Reading the source';
      case 'diffuse':
        return 'Shaping audio';
      case 'decode':
        return 'Decoding';
      default:
        // A stage a newer node runs, or none reported yet: work all the same.
        return 'Working';
    }
  }
  switch (job.state) {
    case 'queued':
      return 'Waiting on node';
    case 'preparing':
      return 'Preparing model';
    case 'finalizing':
      return 'Saving song';
    case 'pause_requested':
      return 'Pausing at a safe point';
    case 'paused':
      return `Paused${job.stage ? ` during ${job.stage}` : ''}`;
    case 'cancel_requested':
      return 'Cancelling at a safe point';
    case 'cancelled':
      return 'Generation cancelled';
    case 'completed':
      return 'Generation complete';
    case 'failed':
      return 'Generation failed';
    case 'recovering':
      return 'Restarting from request';
  }
}

export function shortKey(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

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
export function jobControls(job: JobView): JobControl[] {
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

export function jobStateLabel(job: JobView): string {
  if (job.state === 'running') {
    switch (job.stage) {
      case 'plan':
        return 'Writing plan';
      case 'codes':
        return 'Generating codes';
      case 'diffuse':
        return 'Shaping audio';
      case 'decode':
        return 'Decoding';
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
    default:
      return job.state.replaceAll('_', ' ');
  }
}

export function shortKey(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

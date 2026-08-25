import type { GenerationStage } from '../../../protocol/GenerationStage';
import type { JobView } from '../core/protocol';

/**
 * The canonical symbol for each generation stage.
 *
 * These are keys into `src/motion/symbolLibrary.ts`, not glyphs: the field draws
 * real outlines, and a stage that arrives without a symbol must not silently
 * become a letter.
 */
export const STAGE_SYMBOLS = {
  plan: 'nabla', // ∇  — the gradient the plan descends
  codes: 'alephNull', // ℵ₀ — the count of things being enumerated
  diffuse: 'contourIntegral', // ∮  — accumulation around a closed curve
  decode: 'trebleClef', // 𝄞  — it becomes music here
} as const satisfies Record<GenerationStage, string>;

export type StageSymbol = (typeof STAGE_SYMBOLS)[GenerationStage];

/**
 * How far along a job is, when that can be said honestly.
 *
 * `determinate` only exists when the node supplied a total. Everything else is
 * `indeterminate`: the mark shows that work is happening without claiming to
 * know how much is left. Before M8 the node does not advertise a stage mask, so
 * there is no way to compute a percentage across stages, and inventing one
 * would be a number that looks like knowledge.
 */
export type JobProgressModel =
  | { kind: 'determinate'; fraction: number; completed: number; total: number }
  | { kind: 'indeterminate' };

export type JobMarkModel = Readonly<{
  /** Symbol for the current stage, or null when no stage has been reported. */
  symbol: StageSymbol | null;
  progress: JobProgressModel;
  /**
   * Stages actually observed for this job, in the order they were seen.
   *
   * Not a predicted arc. Until the node advertises its stage mask (M8) the app
   * cannot know how many stages a model has, so the mark draws the history it
   * has watched rather than a future it guessed.
   */
  observedStages: readonly GenerationStage[];
  /** True while the node is doing work rather than waiting or stopped. */
  live: boolean;
  failed: boolean;
  retryable: boolean;
}>;

const LIVE_STATES: ReadonlySet<JobView['state']> = new Set([
  'queued',
  'preparing',
  'running',
  'recovering',
  'finalizing',
]);

/**
 * Fold a newly seen stage into the stages already observed for a job.
 *
 * Order is first-seen order and repeats are ignored, so a job that returns to a
 * stage after `recovering` does not grow a duplicate.
 */
export function observeStage(
  observed: readonly GenerationStage[],
  stage: GenerationStage | undefined,
): readonly GenerationStage[] {
  if (stage === undefined || observed.includes(stage)) return observed;
  return [...observed, stage];
}

export function jobMarkModel(
  job: JobView,
  observedStages: readonly GenerationStage[],
): JobMarkModel {
  const total = job.progress?.total;
  const completed = job.progress?.completed ?? 0;
  const progress: JobProgressModel =
    total !== undefined && total > 0
      ? {
          kind: 'determinate',
          fraction: Math.min(Math.max(completed / total, 0), 1),
          completed,
          total,
        }
      : { kind: 'indeterminate' };

  return {
    symbol: job.stage === undefined ? null : STAGE_SYMBOLS[job.stage],
    progress,
    observedStages: observeStage(observedStages, job.stage),
    live: LIVE_STATES.has(job.state),
    failed: job.state === 'failed',
    retryable: job.state === 'failed' && (job.error?.retryable ?? false),
  };
}

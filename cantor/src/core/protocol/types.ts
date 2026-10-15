import type { ErrorCode } from '../../../../protocol/ErrorCode';
import type { GenerationStage } from '../../../../protocol/GenerationStage';
import type { JobError } from '../../../../protocol/JobError';
import type { JobProgress } from '../../../../protocol/JobProgress';
import type { ProgressUnit } from '../../../../protocol/ProgressUnit';
import type { JobView as WireJobView } from '../../../../protocol/JobView';
import type { LibraryChange } from '../../../../protocol/LibraryChange';
import type { ModelCapability as WireModelCapability } from '../../../../protocol/ModelCapability';
import type { ModelView as WireModelView } from '../../../../protocol/ModelView';
import type { NodeInfo as WireNodeInfo } from '../../../../protocol/NodeInfo';
import type { SongDetail } from '../../../../protocol/SongDetail';
import type { SongHeader } from '../../../../protocol/SongHeader';

/**
 * A generation stage by the name the node gave it.
 *
 * The four this app can draw are `GenerationStage`. Any other is a stage a
 * newer node runs: it is kept by name, so a model's arc and a job's history
 * still place it, and drawn as the generic working stage (`jobs/stages.ts`).
 * A stage is never a reason to drop a job or a model.
 */
export type StageName = GenerationStage | (string & {});

/** The wire's capability, with stages open (see `StageName`). */
export type ModelCapability = Omit<WireModelCapability, 'stages'> & {
  stages?: StageName[];
};

/** The wire's model, with stages open (see `StageName`). */
export type ModelView = Omit<WireModelView, 'stages' | 'capabilities'> & {
  stages?: StageName[];
  capabilities?: ModelCapability[];
};

/** The wire's node info, with its models' stages open. */
export type NodeInfo = Omit<WireNodeInfo, 'models'> & { models: ModelView[] };

/** The wire's job, with its stage, progress unit and error code open. */
export type JobView = Omit<WireJobView, 'stage' | 'progress' | 'error'> & {
  stage?: StageName;
  /** Counts are drawn; the unit is kept by name and never drawn. */
  progress?: Omit<JobProgress, 'unit'> & { unit: ProgressUnit | (string & {}) };
  /** An unknown code reads as `internal` (`describeError`), never as no error. */
  error?: Omit<JobError, 'code'> & { code: ErrorCode | (string & {}) };
};

export type {
  ErrorCode,
  GenerationStage,
  LibraryChange,
  SongDetail,
  SongHeader,
};

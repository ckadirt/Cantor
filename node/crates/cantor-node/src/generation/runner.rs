//! Native generation runner and its thread-affine session cache.
//!
//! The stage walk is driven by what the loaded engine advertises, not by a
//! fixed pipeline: a family that begins at `codes` runs here unchanged.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU8;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cantor_proto::{ErrorCode, GenerationStage, JobView, ProgressUnit};
use tokio::sync::mpsc;

use super::WorkerFailure;
use super::plan::GenerationPlan;
use super::worker::{GenerationCommand, GenerationDriver};
use crate::checkpoints::{self, CheckpointOutcome, CheckpointReference, EngineProvenance};
use crate::engine::{self, LoadOptions, Stage};
use crate::generate::{Generation, Progress, Request, StageExecution};
use crate::jobs::StopReason;
use crate::library::WorkItem;
use crate::principal::PrincipalId;
use crate::runtime::{NodeEvent, SharedState};

const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);

#[derive(PartialEq, Eq)]
struct GenerationKey {
    engine_directory: PathBuf,
    backend: String,
    components: Vec<(String, PathBuf)>,
    options: LoadOptions,
}

struct CachedGeneration {
    key: GenerationKey,
    generation: Generation,
}

#[derive(Default)]
pub(super) struct NativeGenerationDriver {
    cached: Option<CachedGeneration>,
}

impl GenerationDriver for NativeGenerationDriver {
    fn run(&mut self, command: GenerationCommand) -> std::result::Result<(), WorkerFailure> {
        let GenerationCommand {
            state,
            events,
            work,
            signal,
            plan,
        } = command;
        let GenerationPlan {
            attempts,
            components,
            options,
            request,
        } = plan;
        let result = run_generation(
            &state,
            &events,
            &work,
            &signal,
            &attempts,
            &components,
            options,
            &request,
            &mut self.cached,
        );
        // Native engines may retain budgeted stage caches even with this flag
        // off. End the session on every outcome so no weights survive a job.
        if options.keep_loaded == 0 {
            self.cached = None;
        }
        result
    }
}

#[allow(clippy::too_many_arguments)]
fn run_generation(
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    work: &WorkItem,
    signal: &AtomicU8,
    attempts: &[(String, PathBuf)],
    components: &[(String, PathBuf)],
    options: LoadOptions,
    request: &Request,
    cached: &mut Option<CachedGeneration>,
) -> std::result::Result<(), WorkerFailure> {
    let selection = engine::select(attempts).map_err(|error| {
        WorkerFailure::with_source(
            ErrorCode::ModelUnavailable,
            false,
            "No installed engine backend could load this model.",
            error,
        )
    })?;
    for (backend, reason) in &selection.rejected {
        eprintln!("engine.rejected backend={backend} reason={reason}");
    }
    let engine = selection.engine;
    if engine.model != work.engine {
        return Err(WorkerFailure::permanent(
            ErrorCode::ModelUnavailable,
            "The selected engine family does not match this job.",
        ));
    }
    let provenance = EngineProvenance {
        family: engine.model.clone(),
        abi: engine.abi,
        build: engine.version.clone(),
        backend: engine.backend.clone(),
    };
    let selected = checkpoints::select(
        work.job_directory(),
        &work.checkpoint_expectation(),
        Some(&provenance),
    )
    .map_err(WorkerFailure::from_internal)?;
    for rejected in &selected.rejected {
        eprintln!("checkpoint.rejected job={} reason={rejected}", work.id);
    }
    // A fresh job enters at whatever stage this engine actually begins with —
    // `plan` for ACE-Step, `codes` for a family that has no separate planning
    // pass — and the request JSON is what that first stage consumes either way.
    let (mut stage, mut input) = match selected.source {
        Some(source) => (source.stage, source.input),
        None => (
            engine.first_stage(),
            Generation::initial_state(request).map_err(WorkerFailure::from_internal)?,
        ),
    };
    let key = GenerationKey {
        engine_directory: engine.directory.clone(),
        backend: engine.backend.clone(),
        components: components.to_vec(),
        options,
    };
    if cached.as_ref().map(|entry| &entry.key) != Some(&key) {
        // Free the previous device working set before allocating its replacement.
        *cached = None;
        let generation =
            Generation::start(Arc::clone(&engine), components, options).map_err(|error| {
                WorkerFailure::with_source(
                    ErrorCode::Internal,
                    true,
                    "The engine could not load this generation.",
                    error,
                )
            })?;
        *cached = Some(CachedGeneration { key, generation });
    }
    let generation = &mut cached
        .as_mut()
        .context("the generation session cache was not initialized")
        .map_err(WorkerFailure::from_internal)?
        .generation;
    eprintln!(
        "engine.loaded stage={} backend={} resident_bytes={}",
        stage.as_str(),
        provenance.backend,
        generation.resident_bytes()
    );

    loop {
        if settle_standing_stop(state, events, work, signal, None, stage)? {
            return Ok(());
        }
        let mut last_stage = stage;
        let mut last_persisted = Instant::now();
        let should_stop = || StopReason::load(signal) != StopReason::None;
        let execution =
            match generation.run_stage(stage, &input, request, &should_stop, |progress| {
                let stage_changed = progress.stage != last_stage;
                let is_last = progress.total > 0 && progress.done >= progress.total;
                if stage_changed || is_last || last_persisted.elapsed() >= PROGRESS_INTERVAL {
                    if let Err(error) = persist_progress(state, events, work, progress.clone()) {
                        eprintln!("progress.persist_failed job={} cause={error:#}", work.id);
                    }
                    last_stage = progress.stage;
                    last_persisted = Instant::now();
                }
            }) {
                Ok(execution) => execution,
                Err(error) => {
                    if settle_standing_stop(state, events, work, signal, None, stage)? {
                        return Ok(());
                    }
                    return Err(WorkerFailure::with_source(
                        ErrorCode::Internal,
                        true,
                        "The engine could not complete this generation.",
                        error,
                    ));
                }
            };

        match execution {
            StageExecution::Done { .. } if stage == Stage::Decode => {
                if StopReason::load(signal) == StopReason::Cancel {
                    settle_standing_stop(state, events, work, signal, None, Stage::Decode)?;
                    return Ok(());
                }
                let audio = generation.audio().map_err(WorkerFailure::from_internal)?;
                let finalizing = state
                    .lock()
                    .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?
                    .library
                    .begin_finalizing(work)
                    .map_err(WorkerFailure::from_internal)?
                    .context("the worker claim was superseded before finalization")
                    .map_err(WorkerFailure::from_internal)?;
                emit(events, work.principal_id, finalizing);
                let completed = state
                    .lock()
                    .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?
                    .library
                    .complete(work, &audio)
                    .map_err(|error| {
                        WorkerFailure::with_source(
                            ErrorCode::InsufficientDisk,
                            true,
                            "The node could not durably finalize the generated audio.",
                            error,
                        )
                    })?
                    .context("the worker claim was superseded during finalization")
                    .map_err(WorkerFailure::from_internal)?;
                eprintln!(
                    "artifact.finalized job={} bytes={} sha256={}",
                    work.id,
                    completed.1.byte_length,
                    &completed.1.sha256[..12]
                );
                emit(events, work.principal_id, completed.0);
                let _ = events.try_send(NodeEvent::LibraryChanged {
                    principal_id: work.principal_id,
                    revision: completed.3,
                });
                if let Ok(locked) = state.lock() {
                    locked.delivery_notify.notify_one();
                }
                return Ok(());
            }
            StageExecution::Done { output } => {
                let reference = persist_checkpoint(
                    state,
                    events,
                    work,
                    stage,
                    CheckpointOutcome::Done,
                    provenance.clone(),
                    &output,
                )?;
                let next = next_engine_stage(stage)
                    .context("decode handled above")
                    .map_err(WorkerFailure::from_internal)?;
                if settle_standing_stop(state, events, work, signal, Some(&reference), next)? {
                    return Ok(());
                }
                stage = next;
                input = output;
            }
            StageExecution::Paused { resume } => {
                if StopReason::load(signal) == StopReason::Cancel {
                    settle_standing_stop(state, events, work, signal, None, stage)?;
                    return Ok(());
                }
                let reference = match persist_checkpoint(
                    state,
                    events,
                    work,
                    stage,
                    CheckpointOutcome::Paused,
                    provenance.clone(),
                    &resume,
                ) {
                    Ok(reference) => Some(reference),
                    Err(error)
                        if matches!(
                            StopReason::load(signal),
                            StopReason::Pause | StopReason::Revoked | StopReason::Shutdown
                        ) =>
                    {
                        eprintln!(
                            "checkpoint.write_failed job={} stage={} cause={:#}; using prior boundary",
                            work.id,
                            stage.as_str(),
                            error.source
                        );
                        None
                    }
                    Err(error) => return Err(error),
                };
                if settle_standing_stop(state, events, work, signal, reference.as_ref(), stage)? {
                    return Ok(());
                }
                input = resume;
            }
        }
    }
}

fn persist_checkpoint(
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    work: &WorkItem,
    stage: Stage,
    outcome: CheckpointOutcome,
    engine: EngineProvenance,
    bytes: &[u8],
) -> std::result::Result<CheckpointReference, WorkerFailure> {
    let reference = checkpoints::write(
        &work.job_directory().join("checkpoints"),
        &work.checkpoint_expectation(),
        work.attempt,
        stage,
        outcome,
        engine,
        bytes,
    )
    .map_err(|error| {
        WorkerFailure::with_source(
            ErrorCode::CheckpointUnavailable,
            true,
            "The node could not durably save generation progress.",
            error,
        )
    })?;
    let resume_stage = match outcome {
        CheckpointOutcome::Paused => checkpoints::protocol_stage(stage),
        CheckpointOutcome::Done => checkpoints::next_stage(checkpoints::protocol_stage(stage))
            .context("decode output is not a resumable checkpoint")
            .map_err(WorkerFailure::from_internal)?,
    };
    let job = state
        .lock()
        .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?
        .library
        .record_checkpoint(work, &reference, resume_stage)
        .map_err(WorkerFailure::from_internal)?
        .context("the worker claim was superseded while saving a checkpoint")
        .map_err(WorkerFailure::from_internal)?;
    emit(events, work.principal_id, job);
    if let Err(error) = checkpoints::prune_rolling(
        &work.job_directory().join("checkpoints"),
        &reference.metadata_path,
    ) {
        eprintln!("checkpoint.prune_failed job={} cause={error:#}", work.id);
    }
    eprintln!(
        "checkpoint.committed job={} stage={} outcome={outcome:?} bytes={}",
        work.id,
        stage.as_str(),
        bytes.len()
    );
    Ok(reference)
}

pub(crate) fn settle_standing_stop(
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    work: &WorkItem,
    signal: &AtomicU8,
    reference: Option<&CheckpointReference>,
    stage: Stage,
) -> std::result::Result<bool, WorkerFailure> {
    let reason = StopReason::load(signal);
    if reason == StopReason::None {
        return Ok(false);
    }
    let mut locked = state
        .lock()
        .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?;
    let job = match reason {
        StopReason::None => None,
        StopReason::Cancel => locked
            .library
            .finish_cancelled(work)
            .map_err(WorkerFailure::from_internal)?,
        StopReason::Pause | StopReason::Revoked => locked
            .library
            .finish_paused(
                work,
                reference,
                checkpoints::protocol_stage(stage),
                if reason == StopReason::Revoked {
                    "revoked"
                } else {
                    "pause"
                },
            )
            .map_err(WorkerFailure::from_internal)?,
        StopReason::Shutdown => locked
            .library
            .finish_shutdown(work, reference, checkpoints::protocol_stage(stage))
            .map_err(WorkerFailure::from_internal)?,
    };
    if let Some(job) = job {
        emit(events, work.principal_id, job);
    }
    Ok(true)
}

pub(crate) fn current_stage(
    state: &SharedState,
    work: &WorkItem,
) -> std::result::Result<Stage, WorkerFailure> {
    let stage = state
        .lock()
        .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?
        .library
        .get(work.principal_id, &work.id)
        .map_err(WorkerFailure::from_internal)?
        .and_then(|job| job.stage)
        .unwrap_or(GenerationStage::Plan);
    Ok(checkpoints::engine_stage(stage))
}

fn next_engine_stage(stage: Stage) -> Option<Stage> {
    checkpoints::next_stage(checkpoints::protocol_stage(stage)).map(checkpoints::engine_stage)
}

fn persist_progress(
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    work: &WorkItem,
    progress: Progress,
) -> Result<()> {
    let completed = progress.done.max(0) as u32;
    let total = (progress.total > 0).then_some(progress.total as u32);
    let completed = total.map_or(completed, |total| completed.min(total));
    let (stage, unit) = match progress.stage {
        Stage::Plan => (GenerationStage::Plan, ProgressUnit::Tokens),
        Stage::Codes => (GenerationStage::Codes, ProgressUnit::Tokens),
        Stage::Diffuse => (GenerationStage::Diffuse, ProgressUnit::Steps),
        Stage::Decode => (GenerationStage::Decode, ProgressUnit::Tiles),
    };
    let updated = state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is poisoned"))?
        .library
        .record_progress(work, stage, completed, total, unit)?;
    if let Some(job) = updated {
        emit(events, work.principal_id, job);
    }
    Ok(())
}

fn emit(events: &mpsc::Sender<NodeEvent>, principal_id: PrincipalId, job: JobView) {
    let _ = events.try_send(NodeEvent::JobUpdated { principal_id, job });
}

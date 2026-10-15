//! Native generation runner and its thread-affine session cache.
//!
//! The stage walk is driven by what the loaded engine advertises, not by a
//! fixed pipeline: a family that begins at `codes` runs here unchanged.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU8;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cantor_proto::{ErrorCode, GenerationStage, JobView, MAX_LYRICS_BYTES, PlanStage};
use tokio::sync::mpsc;

use super::WorkerFailure;
use super::plan::{GenerationPlan, SourceRestore};
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
            entry,
            restore,
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
            Entry { entry, restore },
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

/// Where an audio act enters, and what it puts back after decoding.
struct Entry {
    entry: Option<Stage>,
    restore: Option<SourceRestore>,
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
    entry: Entry,
    cached: &mut Option<CachedGeneration>,
) -> std::result::Result<(), WorkerFailure> {
    let family_was_known = engine::loaded_capabilities(&work.engine).is_some();
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
    if !family_was_known {
        // The first build of this family this process has loaded: what the
        // node can advertise about it may have just changed.
        let _ = events.try_send(NodeEvent::NodeInfoChanged);
    }
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
    let first = match entry.entry {
        Some(stage) if engine.supports(stage) => stage,
        // An engine that predates ENCODE encodes inside DIFFUSE.
        Some(Stage::Encode) if engine.supports(Stage::Diffuse) => Stage::Diffuse,
        Some(stage) => {
            return Err(WorkerFailure::with_source(
                ErrorCode::ModelUnavailable,
                false,
                "This engine cannot start where an audio act starts.",
                anyhow::anyhow!("the engine does not run the {} stage", stage.as_str()),
            ));
        }
        None => engine.first_stage(),
    };
    // A job's plan is fixed by the run that starts it. A resume keeps the plan
    // that run recorded, even on an engine that would now start elsewhere (an
    // upgrade that added ENCODE must not add a stage this job never ran).
    if selected.source.is_none() {
        let plan = actual_plan(first, |stage| engine.supports(stage));
        let updated = state
            .lock()
            .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?
            .library
            .record_plan(work, &plan)
            .map_err(WorkerFailure::from_internal)?;
        if let Some(job) = updated {
            emit(events, work.principal_id, job);
        }
    }
    let (mut stage, mut input) = match selected.source {
        Some(source) => (source.stage, source.input),
        None => (
            first,
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
        if stage == Stage::Diffuse && request.lyrics.is_none() {
            record_written_lyrics(state, work, &input);
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
                let mut audio = generation.audio().map_err(WorkerFailure::from_internal)?;
                if let Some(restore) = &entry.restore {
                    restore_source(&mut audio, restore);
                }
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

/// Put an extension's source back over its part of the result. A failure here
/// costs only exactness: the engine already kept the source's latents, so the
/// audio is a close copy either way.
/// Diffusion's input is the request as planned: when the model was asked to
/// write the words, they are in it. Fresh or resumed, every job that diffuses
/// passes here with that JSON (a paused diffusion's resume blob is not JSON,
/// and its words were kept when it first began). Never fails the job: a song
/// without its written words is still the song.
fn record_written_lyrics(state: &SharedState, work: &WorkItem, input: &[u8]) {
    let Some(lyrics) = planned_lyrics(input) else {
        return;
    };
    let recorded = state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is unavailable"))
        .and_then(|mut locked| locked.library.record_written_lyrics(work, &lyrics));
    if let Err(error) = recorded {
        eprintln!("lyrics.record_failed job={} cause={error:#}", work.id);
    }
}

/// The words in a planned request: trimmed, not empty, within the wire's bound.
fn planned_lyrics(input: &[u8]) -> Option<String> {
    let planned = serde_json::from_slice::<serde_json::Value>(input).ok()?;
    planned
        .get("lyrics")?
        .as_str()
        .map(str::trim)
        .filter(|lyrics| !lyrics.is_empty() && lyrics.len() <= MAX_LYRICS_BYTES as usize)
        .map(str::to_owned)
}

fn restore_source(audio: &mut crate::generate::Audio, restore: &SourceRestore) {
    match crate::audio::pcm::read_wav16(&restore.source) {
        Ok(source) => {
            let offset = (restore.offset_seconds * f64::from(audio.sample_rate)).round() as usize;
            if !crate::audio::prepare::restore_source(
                &mut audio.planar,
                audio.sample_rate,
                &source,
                offset,
            ) {
                eprintln!(
                    "audio.restore_skipped rate={} source_rate={}",
                    audio.sample_rate, source.rate
                );
            }
        }
        Err(error) => eprintln!("audio.restore_failed cause={error:#}"),
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

fn actual_plan(first: Stage, supports: impl Fn(Stage) -> bool) -> Vec<PlanStage> {
    let stages = if first == Stage::Encode {
        vec![Stage::Encode, Stage::Diffuse, Stage::Decode]
    } else {
        Stage::ALL
            .into_iter()
            .skip_while(|stage| *stage != first)
            .filter(|stage| supports(*stage))
            .collect()
    };
    checkpoints::plan_stages(stages.into_iter().map(checkpoints::protocol_stage))
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
    let stage = checkpoints::protocol_stage(progress.stage);
    let unit = checkpoints::stage_unit(stage);
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

#[cfg(test)]
mod tests {
    use super::{actual_plan, planned_lyrics};
    use crate::checkpoints::plan_stages;
    use crate::engine::Stage;
    use cantor_proto::GenerationStage::{Codes, Decode, Diffuse, Encode, Plan};

    #[test]
    fn actual_arc_follows_the_entry_and_supported_engine_stages() {
        assert_eq!(
            actual_plan(Stage::Plan, |_| true),
            plan_stages([Plan, Codes, Diffuse, Decode])
        );
        assert_eq!(
            actual_plan(Stage::Codes, |stage| stage != Stage::Plan),
            plan_stages([Codes, Diffuse, Decode])
        );
        assert_eq!(
            actual_plan(Stage::Encode, |_| true),
            plan_stages([Encode, Diffuse, Decode])
        );
        assert_eq!(
            actual_plan(Stage::Diffuse, |_| true),
            plan_stages([Diffuse, Decode])
        );
    }

    #[test]
    fn planned_lyrics_reads_the_words_a_plan_wrote() {
        let planned = br#"{"caption":"x","lyrics":"  [verse]\nwritten  ","bpm":96}"#;
        assert_eq!(planned_lyrics(planned).as_deref(), Some("[verse]\nwritten"));
        assert_eq!(planned_lyrics(br#"{"caption":"x","lyrics":"   "}"#), None);
        assert_eq!(planned_lyrics(br#"{"caption":"x"}"#), None);
        assert_eq!(planned_lyrics(b"\x00resume blob"), None);
        let long = format!(
            r#"{{"lyrics":"{}"}}"#,
            "a".repeat(cantor_proto::MAX_LYRICS_BYTES as usize + 1)
        );
        assert_eq!(planned_lyrics(long.as_bytes()), None);
    }
}

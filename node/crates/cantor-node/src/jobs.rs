//! One durable scheduler and one dedicated inference thread.
//!
//! SQLite state decisions remain under `NodeState`; owned inference inputs
//! cross the thread boundary. The native thread keeps a session alive across
//! uninterrupted stage boundaries while the manager durably commits each blob.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc as blocking_mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cantor_proto::{ErrorCode, GenerationStage, JobView, ProgressUnit};
use tokio::sync::{mpsc, oneshot};

use crate::accel;
use crate::backends::{BackendManifest, EngineStore, machine_arch};
use crate::checkpoints::{self, CheckpointOutcome, CheckpointReference, EngineProvenance};
use crate::engine::{self, LoadOptions, Stage};
use crate::generate::{Generation, Progress, Request, StageExecution, components_for};
use crate::library::{FinishResult, WorkItem};
use crate::principal::PrincipalId;
use crate::runtime::{NodeEvent, SharedState};
use crate::store::Store;

const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
const RETRY_DELAY: Duration = Duration::from_secs(2);
const SHUTDOWN_CHECKPOINT_WAIT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum StopReason {
    None = 0,
    Shutdown = 1,
    Pause = 2,
    Revoked = 3,
    Cancel = 4,
}

impl StopReason {
    fn load(signal: &AtomicU8) -> Self {
        match signal.load(Ordering::Acquire) {
            1 => Self::Shutdown,
            2 => Self::Pause,
            3 => Self::Revoked,
            4 => Self::Cancel,
            _ => Self::None,
        }
    }
}

#[derive(Clone)]
pub struct ActiveJobControl {
    pub job_id: String,
    pub principal_id: PrincipalId,
    pub signal: Arc<AtomicU8>,
}

struct InferenceCommand {
    state: SharedState,
    events: mpsc::Sender<NodeEvent>,
    work: WorkItem,
    signal: Arc<AtomicU8>,
    attempts: Vec<(String, PathBuf)>,
    components: Vec<(String, PathBuf)>,
    options: LoadOptions,
    request: Request,
    done: oneshot::Sender<std::result::Result<(), WorkerFailure>>,
}

#[derive(Clone)]
struct InferenceWorker {
    commands: blocking_mpsc::Sender<InferenceCommand>,
}

impl InferenceWorker {
    fn start() -> Result<Self> {
        let (commands, receiver) = blocking_mpsc::channel::<InferenceCommand>();
        std::thread::Builder::new()
            .name("cantor-inference".to_owned())
            .spawn(move || {
                // ABI-1 ACE-Step sessions carry thread-local and process-global
                // native state. Keeping this cache on one dedicated thread is
                // what makes sequential jobs safe as well as merely serialized.
                let mut cached = None;
                while let Ok(command) = receiver.recv() {
                    let result = run_generation(
                        &command.state,
                        &command.events,
                        &command.work,
                        &command.signal,
                        &command.attempts,
                        &command.components,
                        command.options,
                        &command.request,
                        &mut cached,
                    );
                    let _ = command.done.send(result);
                }
            })
            .context("failed to start the inference worker thread")?;
        Ok(Self { commands })
    }
}

pub fn request_stop(signal: &AtomicU8, reason: StopReason) {
    let wanted = reason as u8;
    let mut current = signal.load(Ordering::Acquire);
    while current < wanted {
        match signal.compare_exchange_weak(current, wanted, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return,
            Err(observed) => current = observed,
        }
    }
}

pub async fn graceful_shutdown(state: &SharedState) {
    let notify = {
        let Ok(mut locked) = state.lock() else {
            return;
        };
        locked.shutting_down = true;
        if let Some(active) = &locked.active_job {
            request_stop(&active.signal, StopReason::Shutdown);
        }
        Arc::clone(&locked.job_notify)
    };
    notify.notify_waiters();
    let deadline = tokio::time::Instant::now() + SHUTDOWN_CHECKPOINT_WAIT;
    loop {
        let finished = state
            .lock()
            .map(|locked| locked.active_job.is_none())
            .unwrap_or(true);
        if finished || tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn run(state: SharedState, events: mpsc::Sender<NodeEvent>) {
    let notify = match state.lock() {
        Ok(locked) => Arc::clone(&locked.job_notify),
        Err(_) => return,
    };
    let worker = match InferenceWorker::start() {
        Ok(worker) => worker,
        Err(error) => {
            eprintln!("inference worker failed to start: {error:#}");
            return;
        }
    };

    loop {
        // Register before checking SQLite so an acceptance cannot land in the
        // gap between an empty scan and sleeping.
        let notified = notify.notified();
        tokio::pin!(notified);
        let claim = match state.lock() {
            Ok(locked) if locked.shutting_down => return,
            Ok(mut locked) => locked.library.claim_next(),
            Err(_) => return,
        };
        let claim = match claim {
            Ok(claim) => claim,
            Err(error) => {
                eprintln!("scheduler claim failed: {error:#}");
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
        };
        let Some((work, preparing)) = claim else {
            notified.await;
            continue;
        };
        eprintln!(
            "scheduler.claimed job={} attempt={} model={}",
            work.id, work.attempt, work.model
        );
        emit(&events, work.principal_id, preparing);

        match execute(&state, &events, &worker, &work).await {
            Ok(()) => {}
            Err(failure) => {
                eprintln!(
                    "job.failed job={} attempt={} cause={:#}",
                    work.id, work.attempt, failure.source
                );
                let result = match state.lock() {
                    Ok(mut locked) => locked.library.finish_failure(
                        &work,
                        failure.code,
                        failure.public_message,
                        failure.retryable,
                    ),
                    Err(_) => return,
                };
                match result {
                    Ok(Some(FinishResult::Requeued(job))) => {
                        emit(&events, work.principal_id, job);
                        tokio::time::sleep(RETRY_DELAY).await;
                        notify.notify_one();
                    }
                    Ok(Some(FinishResult::Failed(job))) => emit(&events, work.principal_id, job),
                    Ok(None) => eprintln!("ignored stale failure for job {}", work.id),
                    Err(error) => eprintln!("failed to persist job failure: {error:#}"),
                }
            }
        }
    }
}

async fn execute(
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    worker: &InferenceWorker,
    work: &WorkItem,
) -> std::result::Result<(), WorkerFailure> {
    let signal = Arc::new(AtomicU8::new(StopReason::None as u8));
    {
        let mut locked = state
            .lock()
            .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?;
        if let Some(job) = locked
            .library
            .get(work.principal_id, &work.id)
            .map_err(WorkerFailure::from_internal)?
        {
            match job.state {
                cantor_proto::JobState::PauseRequested => request_stop(&signal, StopReason::Pause),
                cantor_proto::JobState::CancelRequested => {
                    request_stop(&signal, StopReason::Cancel)
                }
                _ => {}
            }
        }
        locked.active_job = Some(ActiveJobControl {
            job_id: work.id.clone(),
            principal_id: work.principal_id,
            signal: Arc::clone(&signal),
        });
    }
    let result = execute_controlled(state, events, worker, work, &signal).await;
    if let Ok(mut locked) = state.lock()
        && locked
            .active_job
            .as_ref()
            .is_some_and(|active| active.job_id == work.id)
    {
        locked.active_job = None;
    }
    result
}

async fn execute_controlled(
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    worker: &InferenceWorker,
    work: &WorkItem,
    signal: &Arc<AtomicU8>,
) -> std::result::Result<(), WorkerFailure> {
    if settle_standing_stop(
        state,
        events,
        work,
        signal,
        None,
        current_stage(state, work)?,
    )? {
        return Ok(());
    }
    let (model_root, backends_url, pinned, tuning) = state
        .lock()
        .map(|locked| {
            (
                locked.config.model_root(),
                locked.config.backends_url(),
                locked.config.backend.clone(),
                locked.config.engine.clone(),
            )
        })
        .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?;

    let store = Store::new(&model_root);
    let variant = store
        .installed()
        .into_iter()
        .find(|variant| variant.selector() == work.model)
        .ok_or_else(|| {
            WorkerFailure::permanent(
                ErrorCode::ModelUnavailable,
                "The exact accepted model is no longer installed.",
            )
        })?;
    if variant.engine() != work.engine {
        return Err(WorkerFailure::permanent(
            ErrorCode::ModelUnavailable,
            "The installed model provenance no longer matches this job.",
        ));
    }
    let installed_digests = variant
        .components
        .iter()
        .map(|component| component.digest().map(str::to_owned))
        .collect::<Result<Vec<_>>>()
        .map_err(WorkerFailure::from_internal)?;
    if installed_digests != work.component_digests {
        return Err(WorkerFailure::permanent(
            ErrorCode::ModelUnavailable,
            "The exact accepted model components are no longer installed.",
        ));
    }
    let components = components_for(&variant, &store.blob_dir()).map_err(|error| {
        WorkerFailure::with_source(
            ErrorCode::ModelUnavailable,
            false,
            "An accepted model component is unavailable.",
            error,
        )
    })?;

    let manifest = BackendManifest::fetch(&backends_url)
        .await
        .map_err(|error| {
            WorkerFailure::with_source(
                ErrorCode::TemporarilyUnavailable,
                true,
                "The node could not verify its installed engine backend.",
                error,
            )
        })?;
    let engine_store = EngineStore::new(&model_root);
    let wanted: Vec<String> = match pinned {
        Some(backend) => vec![backend],
        None => accel::candidates()
            .into_iter()
            .map(|candidate| candidate.backend)
            .collect(),
    };
    let mut attempts = Vec::<(String, PathBuf)>::new();
    for backend in wanted {
        if let Some(artifact) = manifest.find(variant.engine(), &backend, machine_arch())
            && engine_store
                .is_installed(artifact)
                .map_err(WorkerFailure::from_internal)?
        {
            attempts.push((
                backend,
                engine_store
                    .directory_for(artifact)
                    .map_err(WorkerFailure::from_internal)?,
            ));
        }
    }
    if attempts.is_empty() {
        return Err(WorkerFailure::permanent(
            ErrorCode::ModelUnavailable,
            "No installed engine backend can run this model.",
        ));
    }

    let options = LoadOptions {
        vram_budget_bytes: variant.vram_bytes,
        keep_loaded: i32::from(tuning.keep_loaded),
        vae_chunk: tuning.vae_chunk,
        vae_overlap: tuning.vae_overlap,
        n_threads: tuning.n_threads,
        disable_flash_attn: i32::from(tuning.disable_flash_attn),
        disable_batch_cfg: i32::from(tuning.disable_batch_cfg),
    };
    let request = Request {
        caption: work.generation.caption.clone(),
        lyrics: work.generation.lyrics.clone(),
        duration: work.generation.duration.map(|value| value as f32),
        steps: work.generation.steps,
        cfg: work.generation.cfg,
        seed: work.generation.seed,
    };

    let (done, finished) = oneshot::channel();
    worker
        .commands
        .send(InferenceCommand {
            state: Arc::clone(state),
            events: events.clone(),
            work: work.clone(),
            signal: Arc::clone(signal),
            attempts,
            components,
            options,
            request,
            done,
        })
        .map_err(|_| WorkerFailure::internal("The generation worker is unavailable."))?;
    finished.await.map_err(|error| {
        WorkerFailure::with_source(
            ErrorCode::Internal,
            true,
            "The generation worker stopped unexpectedly.",
            error.into(),
        )
    })?
}

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
    let (mut stage, mut input) = match selected.source {
        Some(source) => (source.stage, source.input),
        None => (
            Stage::Plan,
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

fn settle_standing_stop(
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

fn current_stage(
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

struct WorkerFailure {
    code: ErrorCode,
    retryable: bool,
    public_message: &'static str,
    source: anyhow::Error,
}

impl WorkerFailure {
    fn permanent(code: ErrorCode, public_message: &'static str) -> Self {
        Self::with_source(code, false, public_message, anyhow::anyhow!(public_message))
    }

    fn internal(public_message: &'static str) -> Self {
        Self::with_source(
            ErrorCode::Internal,
            true,
            public_message,
            anyhow::anyhow!(public_message),
        )
    }

    fn from_internal(source: anyhow::Error) -> Self {
        Self::with_source(
            ErrorCode::Internal,
            true,
            "The node could not safely execute this generation.",
            source,
        )
    }

    fn with_source(
        code: ErrorCode,
        retryable: bool,
        public_message: &'static str,
        source: anyhow::Error,
    ) -> Self {
        Self {
            code,
            retryable,
            public_message,
            source,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU8;

    use super::{StopReason, request_stop};

    #[test]
    fn stop_requests_escalate_but_never_downgrade() {
        let signal = AtomicU8::new(StopReason::None as u8);

        request_stop(&signal, StopReason::Pause);
        assert_eq!(StopReason::load(&signal), StopReason::Pause);

        request_stop(&signal, StopReason::Shutdown);
        assert_eq!(StopReason::load(&signal), StopReason::Pause);

        request_stop(&signal, StopReason::Revoked);
        assert_eq!(StopReason::load(&signal), StopReason::Revoked);

        request_stop(&signal, StopReason::Pause);
        assert_eq!(StopReason::load(&signal), StopReason::Revoked);

        request_stop(&signal, StopReason::Cancel);
        assert_eq!(StopReason::load(&signal), StopReason::Cancel);

        request_stop(&signal, StopReason::Revoked);
        assert_eq!(StopReason::load(&signal), StopReason::Cancel);
    }
}

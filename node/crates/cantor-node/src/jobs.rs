//! One durable scheduler and one blocking inference worker.
//!
//! SQLite state decisions remain under `NodeState`; owned inference inputs
//! cross the thread boundary. The engine callback only tries a bounded channel.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cantor_proto::{ErrorCode, GenerationStage, JobView, ProgressUnit};
use tokio::sync::mpsc;

use crate::accel;
use crate::backends::{BackendManifest, EngineStore, machine_arch};
use crate::control::{ControlEvent, SharedState};
use crate::engine::{self, LoadOptions, Stage};
use crate::generate::{Generation, Progress, Request, components_for};
use crate::library::{FinishResult, WorkItem};
use crate::store::Store;

const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
const RETRY_DELAY: Duration = Duration::from_secs(2);
const PROGRESS_QUEUE_DEPTH: usize = 32;

pub async fn run(state: SharedState, events: mpsc::Sender<ControlEvent>) {
    let notify = match state.lock() {
        Ok(locked) => Arc::clone(&locked.job_notify),
        Err(_) => return,
    };

    loop {
        // Register before checking SQLite so an acceptance cannot land in the
        // gap between an empty scan and sleeping.
        let notified = notify.notified();
        tokio::pin!(notified);
        let claim = match state.lock() {
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

        match execute(&state, &events, &work).await {
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
    events: &mpsc::Sender<ControlEvent>,
    work: &WorkItem,
) -> std::result::Result<(), WorkerFailure> {
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

    persist_progress(
        state,
        events,
        work,
        Progress {
            stage: Stage::Plan,
            done: 0,
            total: 0,
        },
    )
    .map_err(WorkerFailure::from_internal)?;

    let (progress_tx, mut progress_rx) = mpsc::channel(PROGRESS_QUEUE_DEPTH);
    let generation = tokio::task::spawn_blocking(move || -> Result<crate::generate::Audio> {
        let selection = engine::select(&attempts)?;
        let engine = selection.engine;
        let mut generation = Generation::start(&engine, &components, options)?;
        eprintln!(
            "engine.loaded resident_bytes={}",
            generation.resident_bytes()
        );
        let stop = Arc::new(AtomicBool::new(false));
        generation.run(&request, stop, |progress| {
            let _ = progress_tx.try_send(progress);
        })
    });
    tokio::pin!(generation);

    let mut last_stage = Stage::Plan;
    let mut last_persisted = Instant::now();
    let audio = loop {
        tokio::select! {
            progress = progress_rx.recv() => {
                let Some(progress) = progress else { continue };
                let stage_changed = progress.stage != last_stage;
                let is_last = progress.total > 0 && progress.done >= progress.total;
                if stage_changed || is_last || last_persisted.elapsed() >= PROGRESS_INTERVAL {
                    persist_progress(state, events, work, progress.clone())
                        .map_err(WorkerFailure::from_internal)?;
                    last_stage = progress.stage;
                    last_persisted = Instant::now();
                }
            }
            joined = &mut generation => {
                break joined
                    .map_err(|error| WorkerFailure::with_source(
                        ErrorCode::Internal, true, "The generation worker stopped unexpectedly.", error.into()))?
                    .map_err(|error| WorkerFailure::with_source(
                        ErrorCode::Internal, true, "The engine could not complete this generation.", error))?;
            }
        }
    };
    // The join and final callback can become ready in the same scheduler tick.
    // Drain to the newest callback so decode's terminal progress is durable
    // before the state moves to finalizing.
    let mut final_progress = None;
    while let Ok(progress) = progress_rx.try_recv() {
        final_progress = Some(progress);
    }
    if let Some(progress) = final_progress {
        persist_progress(state, events, work, progress).map_err(WorkerFailure::from_internal)?;
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
    let _ = events.try_send(ControlEvent::LibraryChanged {
        principal_id: work.principal_id,
        revision: completed.3,
    });
    Ok(())
}

fn persist_progress(
    state: &SharedState,
    events: &mpsc::Sender<ControlEvent>,
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

fn emit(events: &mpsc::Sender<ControlEvent>, principal_id: [u8; 32], job: JobView) {
    let _ = events.try_send(ControlEvent::JobUpdated { principal_id, job });
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

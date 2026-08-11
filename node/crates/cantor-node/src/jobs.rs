//! One durable scheduler and one dedicated inference thread.
//!
//! SQLite state decisions remain under `NodeState`; owned inference inputs
//! cross the thread boundary. The native thread keeps a session alive across
//! uninterrupted stage boundaries while the manager durably commits each blob.

use std::sync::Arc;
use std::sync::atomic::AtomicU8;
use std::time::Duration;

use cantor_proto::JobView;
use tokio::sync::mpsc;

use crate::generation::{
    GenerationCommand, InferenceWorker, WorkerFailure, current_stage, plan, settle_standing_stop,
    start_worker,
};
use crate::library::{FinishResult, WorkItem};
use crate::principal::PrincipalId;
use crate::runtime::{ActiveJobControl, NodeEvent, SharedState};

mod stop;

pub use stop::{StopReason, graceful_shutdown, request_stop};

const RETRY_DELAY: Duration = Duration::from_secs(2);

pub async fn run(state: SharedState, events: mpsc::Sender<NodeEvent>) {
    let notify = match state.lock() {
        Ok(locked) => Arc::clone(&locked.job_notify),
        Err(_) => return,
    };
    let worker = match start_worker() {
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
    let plan = plan::resolve(state, work).await?;

    worker
        .execute(GenerationCommand::new(
            Arc::clone(state),
            events.clone(),
            work.clone(),
            Arc::clone(signal),
            plan,
        ))
        .await
}

fn emit(events: &mpsc::Sender<NodeEvent>, principal_id: PrincipalId, job: JobView) {
    let _ = events.try_send(NodeEvent::JobUpdated { principal_id, job });
}

//! Job admission, owner-scoped queries, controls, and worker lifecycle transitions.

use std::ffi::CString;
use std::fs::File;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use cantor_proto::{
    ErrorCode, GenerationRequest, GenerationStage, JobState, JobView, ProgressUnit,
};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::principal::PrincipalId;
use crate::store::InstalledVariant;

use super::artifacts::hex;
use super::rows::{JOB_VIEW_COLUMNS, enum_text, job_from_row};
use super::{
    AcceptedModel, AcceptedRequestSidecar, Library, RequestSidecar, accepted_sidecar_for,
    prepare_real_directory, write_json_atomic, write_status,
};

pub(super) const MAX_ATTEMPTS: u32 = 3;

#[derive(Clone, Debug)]
pub struct Submission {
    pub client_request_id: String,
    pub model: String,
    pub generation: GenerationRequest,
}

/// Immutable work copied out before inference. `attempt` is also the worker
/// token, preventing a late callback from mutating a newer claim.
#[derive(Clone, Debug)]
pub struct WorkItem {
    pub id: String,
    pub principal_id: PrincipalId,
    pub model: String,
    pub generation: GenerationRequest,
    pub engine: String,
    pub component_digests: Vec<String>,
    pub request_hash: String,
    pub attempt: u32,
    pub artifact_directory: PathBuf,
}

impl WorkItem {
    pub fn job_directory(&self) -> &Path {
        self.artifact_directory
            .parent()
            .expect("a work item artifact directory always has its job parent")
    }

    pub fn checkpoint_expectation(&self) -> crate::checkpoints::CheckpointExpectation<'_> {
        crate::checkpoints::CheckpointExpectation {
            job_id: &self.id,
            request_hash: &self.request_hash,
            model_selector: &self.model,
            component_digests: &self.component_digests,
        }
    }
}

#[derive(Debug)]
pub enum FinishResult {
    Requeued(JobView),
    Failed(JobView),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobControl {
    Pause,
    Resume,
    Cancel,
    Retry,
}

#[derive(Debug)]
pub enum ControlResult {
    Updated(JobView),
    Conflict(JobView),
    NotFound,
    InvalidTransition(JobView),
}

#[derive(Debug, PartialEq)]
pub enum SubmitResult {
    Accepted(JobView),
    Conflict,
    QueueFull,
    InsufficientDisk,
}

impl Library {
    pub fn submit(
        &mut self,
        principal: PrincipalId,
        public_key: &[u8; 32],
        submission: &Submission,
        variant: &InstalledVariant,
        max_queued_per_principal: u32,
        minimum_free_bytes: u64,
    ) -> Result<SubmitResult> {
        let principal = principal.to_string();
        let public_key = bs58::encode(public_key).into_string();
        let normalized = serde_json::to_string(&submission.generation)?;
        let request_hash =
            hex(&Sha256::digest(format!("{}\0{}", submission.model, normalized)).into());
        if let Some((existing_hash, job)) = self
            .connection
            .query_row(
                &format!(
                    "SELECT request_hash,{JOB_VIEW_COLUMNS}
                     FROM jobs WHERE principal_id=?1 AND client_request_id=?2"
                ),
                params![principal, submission.client_request_id],
                |row| Ok((row.get::<_, String>(0)?, job_from_row(row, 1)?)),
            )
            .optional()?
        {
            return Ok(if existing_hash == request_hash {
                SubmitResult::Accepted(job)
            } else {
                SubmitResult::Conflict
            });
        }
        if self.queued_count_for_bytes(&principal)? >= max_queued_per_principal {
            return Ok(SubmitResult::QueueFull);
        }
        if self.available_bytes()? < minimum_free_bytes {
            return Ok(SubmitResult::InsufficientDisk);
        }

        let id = Uuid::now_v7().to_string();
        let now = now_rfc3339();
        let principal_directory = self.root.join("jobs").join(&principal);
        prepare_real_directory(&principal_directory)?;
        let directory = principal_directory.join(&id);
        prepare_real_directory(&directory)?;
        prepare_real_directory(&directory.join("checkpoints"))?;
        prepare_real_directory(&directory.join("artifacts"))?;
        let digests = variant
            .components
            .iter()
            .map(|component| component.digest())
            .collect::<Result<Vec<_>>>()?;
        let sidecar = RequestSidecar {
            schema: 1,
            job_id: &id,
            principal_id: &principal,
            client_request_id: &submission.client_request_id,
            accepted_at: &now,
            model: AcceptedModel {
                selector: variant.selector(),
                engine: variant.engine(),
                component_digests: digests,
            },
            generation: &submission.generation,
        };
        write_json_atomic(&directory.join("request.json"), &sidecar)?;
        write_json_atomic(
            &directory.join("status.json"),
            &serde_json::json!({"schema":1,"state":"queued","revision":1,"updated_at":now}),
        )?;
        write_json_atomic(
            &directory.join("manifest.json"),
            &serde_json::json!({"schema":1,"job_id":id,"artifacts":[]}),
        )?;

        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT OR IGNORE INTO principals(id,kind,public_key,created_at) VALUES(?1,'app_key',?2,?3)",
            params![principal, public_key, now],
        )?;
        transaction.execute(
            "INSERT INTO jobs(id,principal_id,client_request_id,request_hash,model_selector,request_json,state,revision,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,'queued',1,?7,?7)",
            params![id, principal, submission.client_request_id, request_hash, submission.model, normalized, now],
        )?;
        transaction.commit()?;
        File::open(&directory)?.sync_all()?;
        Ok(SubmitResult::Accepted(JobView {
            id,
            revision: 1,
            state: JobState::Queued,
            stage: None,
            progress: None,
            model: submission.model.clone(),
            created_at: now.clone(),
            updated_at: now,
            error: None,
        }))
    }

    pub fn list(&self, principal: PrincipalId, limit: u32) -> Result<Vec<JobView>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {JOB_VIEW_COLUMNS} FROM jobs
             WHERE principal_id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2"
        ))?;
        statement
            .query_map(params![principal.to_string(), limit], |row| {
                job_from_row(row, 0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get(&self, principal: PrincipalId, id: &str) -> Result<Option<JobView>> {
        self.connection
            .query_row(
                &format!("SELECT {JOB_VIEW_COLUMNS} FROM jobs WHERE principal_id=?1 AND id=?2"),
                params![principal.to_string(), id],
                |row| job_from_row(row, 0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn control_job(
        &mut self,
        principal: PrincipalId,
        id: &str,
        expected_revision: Option<u32>,
        control: JobControl,
    ) -> Result<ControlResult> {
        let principal_hex = principal.to_string();
        let Some(current) = self.get(principal, id)? else {
            return Ok(ControlResult::NotFound);
        };
        if expected_revision.is_some_and(|expected| expected != current.revision) {
            return Ok(ControlResult::Conflict(current));
        }
        let stop_reason: Option<String> = self.connection.query_row(
            "SELECT stop_reason FROM jobs WHERE principal_id=?1 AND id=?2",
            params![principal_hex, id],
            |row| row.get(0),
        )?;

        let now = now_rfc3339();
        let changed = match control {
            JobControl::Pause => match current.state {
                JobState::Paused | JobState::PauseRequested => {
                    return Ok(ControlResult::Updated(current));
                }
                JobState::Queued => self.connection.execute(
                    "UPDATE jobs SET state='paused',stage='plan',stop_reason='pause',
                     control_requested_at=?3,revision=revision+1,updated_at=?3
                     WHERE principal_id=?1 AND id=?2 AND state='queued'",
                    params![principal_hex, id, now],
                )?,
                JobState::Preparing | JobState::Running => self.connection.execute(
                    "UPDATE jobs SET state='pause_requested',stop_reason='pause',
                     control_requested_at=?3,revision=revision+1,updated_at=?3
                     WHERE principal_id=?1 AND id=?2 AND state IN ('preparing','running')",
                    params![principal_hex, id, now],
                )?,
                _ => return Ok(ControlResult::InvalidTransition(current)),
            },
            JobControl::Cancel => match current.state {
                JobState::Cancelled => return Ok(ControlResult::Updated(current)),
                JobState::Queued | JobState::Paused => self.connection.execute(
                    "UPDATE jobs SET state='cancelled',stage=NULL,stop_reason='cancel',
                     control_requested_at=?3,error_code=NULL,error_message=NULL,
                     error_retryable=0,revision=revision+1,updated_at=?3
                     WHERE principal_id=?1 AND id=?2 AND state IN ('queued','paused')",
                    params![principal_hex, id, now],
                )?,
                JobState::Preparing
                | JobState::Running
                | JobState::PauseRequested
                | JobState::CancelRequested => {
                    if current.state == JobState::CancelRequested {
                        return Ok(ControlResult::Updated(current));
                    }
                    self.connection.execute(
                        "UPDATE jobs SET state='cancel_requested',stop_reason='cancel',
                         control_requested_at=?3,revision=revision+1,updated_at=?3
                         WHERE principal_id=?1 AND id=?2 AND state IN
                           ('preparing','running','pause_requested')",
                        params![principal_hex, id, now],
                    )?
                }
                _ => return Ok(ControlResult::InvalidTransition(current)),
            },
            JobControl::Resume => match current.state {
                JobState::Paused => {
                    let sidecar = accepted_sidecar_for(&self.root, &principal_hex, id)?;
                    let request_hash: String = self.connection.query_row(
                        "SELECT request_hash FROM jobs WHERE principal_id=?1 AND id=?2",
                        params![principal_hex, id],
                        |row| row.get(0),
                    )?;
                    let expectation = crate::checkpoints::CheckpointExpectation {
                        job_id: id,
                        request_hash: &request_hash,
                        model_selector: &sidecar.model.selector,
                        component_digests: &sidecar.model.component_digests,
                    };
                    let job_directory = self.root.join("jobs").join(&principal_hex).join(id);
                    let selection = crate::checkpoints::select(&job_directory, &expectation, None)?;
                    for rejected in selection.rejected {
                        eprintln!("checkpoint.rejected job={id} reason={rejected}");
                    }
                    let selected = selection
                        .source
                        .map(|source| {
                            Ok::<_, anyhow::Error>((
                                source.reference.metadata_path,
                                enum_text(source.reference.outcome)?,
                            ))
                        })
                        .transpose()?;
                    let (checkpoint, outcome) = selected
                        .map(|(checkpoint, outcome)| (Some(checkpoint), Some(outcome)))
                        .unwrap_or((None, None));
                    self.connection.execute(
                        "UPDATE jobs SET state='queued',stage=NULL,active_checkpoint=?4,
                         checkpoint_outcome=?5,stop_reason='resume',control_requested_at=?3,
                         revision=revision+1,updated_at=?3
                         WHERE principal_id=?1 AND id=?2 AND state='paused'",
                        params![principal_hex, id, now, checkpoint, outcome],
                    )?
                }
                JobState::Queued | JobState::Preparing | JobState::Running
                    if matches!(stop_reason.as_deref(), Some("resume")) =>
                {
                    return Ok(ControlResult::Updated(current));
                }
                _ => return Ok(ControlResult::InvalidTransition(current)),
            },
            JobControl::Retry => match current.state {
                JobState::Failed if current.error.as_ref().is_some_and(|error| error.retryable) => {
                    self.connection.execute(
                        "UPDATE jobs SET state='queued',stage=NULL,error_code=NULL,
                         error_message=NULL,error_retryable=0,consecutive_failures=0,
                         stop_reason='retry',control_requested_at=?3,
                         revision=revision+1,updated_at=?3
                         WHERE principal_id=?1 AND id=?2 AND state='failed' AND error_retryable=1",
                        params![principal_hex, id, now],
                    )?
                }
                JobState::Queued | JobState::Preparing | JobState::Running
                    if matches!(stop_reason.as_deref(), Some("retry")) =>
                {
                    return Ok(ControlResult::Updated(current));
                }
                _ => return Ok(ControlResult::InvalidTransition(current)),
            },
        };
        if changed != 1 {
            let current = self
                .get(principal, id)?
                .context("controlled job disappeared")?;
            return Ok(ControlResult::Conflict(current));
        }
        let updated = self
            .get(principal, id)?
            .context("controlled job disappeared")?;
        let artifact_directory = self
            .root
            .join("jobs")
            .join(&principal_hex)
            .join(id)
            .join("artifacts");
        let attempt: u32 = self.connection.query_row(
            "SELECT attempt FROM jobs WHERE id=?1",
            params![id],
            |row| row.get(0),
        )?;
        write_status(&artifact_directory, &updated, attempt)?;
        Ok(ControlResult::Updated(updated))
    }

    pub fn hold_principal_jobs(&mut self, principal: PrincipalId) -> Result<Vec<JobView>> {
        let principal_hex = principal.to_string();
        let now = now_rfc3339();
        self.connection.execute(
            "UPDATE jobs SET state='paused',stage=COALESCE(stage,'plan'),
             stop_reason='revoked',control_requested_at=?2,
             revision=revision+1,updated_at=?2
             WHERE principal_id=?1 AND state='queued'",
            params![principal_hex, now],
        )?;
        self.connection.execute(
            "UPDATE jobs SET state='pause_requested',stop_reason='revoked',
             control_requested_at=?2,revision=revision+1,updated_at=?2
             WHERE principal_id=?1 AND state IN ('preparing','running')",
            params![principal_hex, now],
        )?;
        self.list(principal, cantor_proto::MAX_PAGE_LIMIT)
    }

    pub fn queued_count(&self) -> Result<u32> {
        self.connection
            .query_row(
                "SELECT count(*) FROM jobs WHERE state='queued'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn active_count(&self) -> Result<u32> {
        self.connection
            .query_row(
                "SELECT count(*) FROM jobs WHERE state IN
                 ('preparing','running','pause_requested','cancel_requested','finalizing')",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    /// Atomically claims the oldest eligible job. With one manager this also
    /// documents the global single-worker invariant in the database boundary.
    pub fn claim_next(&mut self) -> Result<Option<(WorkItem, JobView)>> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let candidate = transaction
            .query_row(
                "SELECT id,principal_id,model_selector,request_json,request_hash,attempt
                 FROM jobs WHERE state='queued'
                   AND NOT EXISTS (
                     SELECT 1 FROM jobs active
                     WHERE active.state IN
                       ('preparing','running','pause_requested','cancel_requested','finalizing')
                   )
                 ORDER BY priority DESC,created_at ASC,id ASC LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, u32>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, principal_hex, model, request_json, request_hash, previous_attempt)) =
            candidate
        else {
            transaction.commit()?;
            return Ok(None);
        };
        let attempt = previous_attempt + 1;
        let now = now_rfc3339();
        let changed = transaction.execute(
            "UPDATE jobs SET state='preparing',stage=NULL,progress_completed=NULL,
             progress_total=NULL,progress_unit=NULL,error_code=NULL,error_message=NULL,
             attempt=?2,revision=revision+1,updated_at=?3
             WHERE id=?1 AND state='queued' AND attempt=?4",
            params![id, attempt, now, previous_attempt],
        )?;
        if changed != 1 {
            transaction.rollback()?;
            return Ok(None);
        }
        let job = transaction.query_row(
            &format!("SELECT {JOB_VIEW_COLUMNS} FROM jobs WHERE id=?1"),
            params![id],
            |row| job_from_row(row, 0),
        )?;
        let principal_id = principal_hex.parse::<PrincipalId>()?;
        let generation = serde_json::from_str(&request_json)
            .context("accepted generation request is not valid JSON")?;
        let artifact_directory = self
            .root
            .join("jobs")
            .join(&principal_hex)
            .join(&id)
            .join("artifacts");
        let sidecar_path = artifact_directory
            .parent()
            .context("artifact directory has no job parent")?
            .join("request.json");
        let sidecar: AcceptedRequestSidecar =
            serde_json::from_reader(File::open(&sidecar_path)?)
                .with_context(|| format!("failed to read {}", sidecar_path.display()))?;
        if sidecar.schema != 1
            || sidecar.job_id != id
            || sidecar.principal_id != principal_hex
            || sidecar.model.selector != model
            || sidecar.generation != generation
        {
            bail!("accepted request sidecar does not match its database row");
        }
        write_status(&artifact_directory, &job, attempt)?;
        transaction.commit()?;
        Ok(Some((
            WorkItem {
                id,
                principal_id,
                model,
                generation,
                engine: sidecar.model.engine,
                component_digests: sidecar.model.component_digests,
                request_hash,
                attempt,
                artifact_directory,
            },
            job,
        )))
    }

    /// Persists one already-throttled engine callback. The expected attempt
    /// check rejects stale callbacks after recovery or retry.
    pub fn record_progress(
        &mut self,
        work: &WorkItem,
        stage: GenerationStage,
        completed: u32,
        total: Option<u32>,
        unit: ProgressUnit,
    ) -> Result<Option<JobView>> {
        let now = now_rfc3339();
        let stage = enum_text(stage)?;
        let unit = enum_text(unit)?;
        let changed = self.connection.execute(
            "UPDATE jobs SET state='running',stage=?3,progress_completed=?4,
             progress_total=?5,progress_unit=?6,revision=revision+1,updated_at=?7
             WHERE id=?1 AND attempt=?2 AND state IN ('preparing','running')",
            params![work.id, work.attempt, stage, completed, total, unit, now],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let job = self
            .job_by_id(&work.id)?
            .context("updated job disappeared")?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some(job))
    }

    pub fn begin_finalizing(&mut self, work: &WorkItem) -> Result<Option<JobView>> {
        let now = now_rfc3339();
        let changed = self.connection.execute(
            "UPDATE jobs SET state='finalizing',stage=NULL,progress_completed=NULL,
             progress_total=NULL,progress_unit=NULL,revision=revision+1,updated_at=?3
             WHERE id=?1 AND attempt=?2 AND state IN ('running','pause_requested')",
            params![work.id, work.attempt, now],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let job = self
            .job_by_id(&work.id)?
            .context("finalizing job disappeared")?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some(job))
    }

    pub fn record_checkpoint(
        &mut self,
        work: &WorkItem,
        reference: &crate::checkpoints::CheckpointReference,
        resume_stage: GenerationStage,
    ) -> Result<Option<JobView>> {
        let now = now_rfc3339();
        let stage = enum_text(resume_stage)?;
        let outcome = enum_text(reference.outcome)?;
        let changed = self.connection.execute(
            "UPDATE jobs SET active_checkpoint=?3,checkpoint_outcome=?4,stage=?5,
             progress_completed=NULL,progress_total=NULL,progress_unit=NULL,
             revision=revision+1,updated_at=?6
             WHERE id=?1 AND attempt=?2 AND state IN
               ('preparing','running','pause_requested','cancel_requested')",
            params![
                work.id,
                work.attempt,
                reference.metadata_path,
                outcome,
                stage,
                now
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let job = self
            .job_by_id(&work.id)?
            .context("checkpointed job disappeared")?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some(job))
    }

    pub fn finish_paused(
        &mut self,
        work: &WorkItem,
        reference: Option<&crate::checkpoints::CheckpointReference>,
        stage: GenerationStage,
        reason: &str,
    ) -> Result<Option<JobView>> {
        let now = now_rfc3339();
        let stage = enum_text(stage)?;
        let checkpoint = reference.map(|value| value.metadata_path.as_str());
        let outcome = reference
            .map(|value| enum_text(value.outcome))
            .transpose()?;
        let changed = self.connection.execute(
            "UPDATE jobs SET state='paused',stage=?3,active_checkpoint=COALESCE(?4,active_checkpoint),
             checkpoint_outcome=COALESCE(?5,checkpoint_outcome),stop_reason=?6,
             progress_completed=NULL,progress_total=NULL,progress_unit=NULL,
             revision=revision+1,updated_at=?7
             WHERE id=?1 AND attempt=?2 AND state IN
               ('preparing','running','pause_requested')",
            params![work.id, work.attempt, stage, checkpoint, outcome, reason, now],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let job = self
            .job_by_id(&work.id)?
            .context("paused job disappeared")?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some(job))
    }

    pub fn finish_cancelled(&mut self, work: &WorkItem) -> Result<Option<JobView>> {
        let now = now_rfc3339();
        let changed = self.connection.execute(
            "UPDATE jobs SET state='cancelled',stage=NULL,progress_completed=NULL,
             progress_total=NULL,progress_unit=NULL,error_code=NULL,error_message=NULL,
             error_retryable=0,stop_reason='cancel',revision=revision+1,updated_at=?3
             WHERE id=?1 AND attempt=?2 AND state IN
               ('preparing','running','pause_requested','cancel_requested')",
            params![work.id, work.attempt, now],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let job = self
            .job_by_id(&work.id)?
            .context("cancelled job disappeared")?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some(job))
    }

    pub fn finish_shutdown(
        &mut self,
        work: &WorkItem,
        reference: Option<&crate::checkpoints::CheckpointReference>,
        stage: GenerationStage,
    ) -> Result<Option<JobView>> {
        let now = now_rfc3339();
        let stage = enum_text(stage)?;
        let checkpoint = reference.map(|value| value.metadata_path.as_str());
        let outcome = reference
            .map(|value| enum_text(value.outcome))
            .transpose()?;
        let changed = self.connection.execute(
            "UPDATE jobs SET state='queued',stage=?3,active_checkpoint=COALESCE(?4,active_checkpoint),
             checkpoint_outcome=COALESCE(?5,checkpoint_outcome),stop_reason='shutdown',
             progress_completed=NULL,progress_total=NULL,progress_unit=NULL,
             revision=revision+1,updated_at=?6
             WHERE id=?1 AND attempt=?2 AND state IN ('preparing','running')",
            params![work.id, work.attempt, stage, checkpoint, outcome, now],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let job = self
            .job_by_id(&work.id)?
            .context("shutdown job disappeared")?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some(job))
    }

    pub fn finish_failure(
        &mut self,
        work: &WorkItem,
        code: ErrorCode,
        message: &str,
        retryable: bool,
    ) -> Result<Option<FinishResult>> {
        let previous_failures: u32 = self.connection.query_row(
            "SELECT consecutive_failures FROM jobs WHERE id=?1 AND attempt=?2",
            params![work.id, work.attempt],
            |row| row.get(0),
        )?;
        let failures = previous_failures.saturating_add(1);
        let requeue = retryable && failures < MAX_ATTEMPTS;
        let state = if requeue { "queued" } else { "failed" };
        let (code, message) = if requeue {
            (None, None)
        } else {
            (Some(enum_text(code)?), Some(message))
        };
        let now = now_rfc3339();
        let changed = self.connection.execute(
            "UPDATE jobs SET state=?3,stage=NULL,progress_completed=NULL,
             progress_total=NULL,progress_unit=NULL,error_code=?4,error_message=?5,
             error_retryable=?6,consecutive_failures=?7,
             revision=revision+1,updated_at=?8
             WHERE id=?1 AND attempt=?2 AND state IN ('preparing','running','finalizing')",
            params![
                work.id,
                work.attempt,
                state,
                code,
                message,
                !requeue && retryable,
                failures,
                now
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        let job = self
            .job_by_id(&work.id)?
            .context("failed job disappeared")?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some(if requeue {
            FinishResult::Requeued(job)
        } else {
            FinishResult::Failed(job)
        }))
    }

    pub(super) fn job_by_id(&self, id: &str) -> Result<Option<JobView>> {
        self.connection
            .query_row(
                &format!("SELECT {JOB_VIEW_COLUMNS} FROM jobs WHERE id=?1"),
                params![id],
                |row| job_from_row(row, 0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn queued_count_for_bytes(&self, principal: &str) -> Result<u32> {
        self.connection
            .query_row(
                "SELECT count(*) FROM jobs WHERE principal_id=?1 AND state='queued'",
                params![principal],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn available_bytes(&self) -> Result<u64> {
        let path = CString::new(self.root.as_os_str().as_bytes())
            .context("library path contains a NUL byte")?;
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: `path` is NUL-terminated and `stats` is read only after a
        // successful call initialized it.
        let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
        if result != 0 {
            return Err(std::io::Error::last_os_error()).context("failed to inspect library disk");
        }
        // SAFETY: the successful `statvfs` call initialized every field.
        let stats = unsafe { stats.assume_init() };
        Ok(stats.f_bavail.saturating_mul(stats.f_frsize))
    }
}

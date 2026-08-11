//! Startup filesystem reconciliation and interrupted-job recovery.

use std::fs;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use cantor_proto::GenerationStage;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::principal::PrincipalId;

use super::artifacts::{ArtifactRecord, insert_artifact, inspect_wav, write_artifact_manifest};
use super::jobs::MAX_ATTEMPTS;
use super::rows::{JOB_VIEW_COLUMNS, enum_text, job_from_row};
use super::songs;
use super::{
    Library, accepted_sidecar_for, clear_ephemeral_directory, is_known_incomplete_job, write_status,
};

impl Library {
    pub(super) fn reconcile_startup(&self) -> Result<()> {
        clear_ephemeral_directory(&self.root.join("tmp"))?;
        for principal_entry in fs::read_dir(self.root.join("jobs"))? {
            let principal_entry = principal_entry?;
            let principal_path = principal_entry.path();
            let principal = principal_entry.file_name().to_string_lossy().into_owned();
            let metadata = fs::symlink_metadata(&principal_path)?;
            if !metadata.is_dir() || principal.parse::<PrincipalId>().is_err() {
                self.quarantine(&principal_path)?;
                continue;
            }
            for job_entry in fs::read_dir(&principal_path)? {
                let job_entry = job_entry?;
                let job_path = job_entry.path();
                let id = job_entry.file_name().to_string_lossy().into_owned();
                let metadata = fs::symlink_metadata(&job_path)?;
                if !metadata.is_dir() || Uuid::parse_str(&id).is_err() {
                    self.quarantine(&job_path)?;
                    continue;
                }
                let committed: Option<String> = self
                    .connection
                    .query_row(
                        "SELECT state FROM jobs WHERE principal_id=?1 AND id=?2",
                        params![principal, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if committed.is_none() {
                    if is_known_incomplete_job(&job_path)? {
                        fs::remove_dir_all(&job_path)?;
                    } else {
                        self.quarantine(&job_path)?;
                    }
                } else {
                    let checkpoints = job_path.join("checkpoints");
                    crate::checkpoints::clear_temps(&checkpoints)?;
                    if matches!(
                        committed.as_deref(),
                        Some("completed" | "cancelled" | "failed")
                    ) && crate::checkpoints::prune_terminal(
                        &checkpoints,
                        Duration::from_secs(24 * 60 * 60),
                    )? {
                        eprintln!("checkpoint.gc job={id} reason=terminal-grace-expired");
                    }
                }
            }
        }
        Ok(())
    }

    /// Interrupted work keeps user intent and the newest structurally valid
    /// checkpoint. Exact engine/backend compatibility is checked immediately
    /// before FFI; a durable final WAV is still adopted transactionally.
    pub(super) fn recover_interrupted_jobs(&mut self) -> Result<()> {
        let mut statement = self.connection.prepare(
            "SELECT id,principal_id,state,attempt,consecutive_failures FROM jobs
             WHERE state IN
               ('preparing','running','pause_requested','cancel_requested','finalizing')",
        )?;
        let interrupted = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, u32>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);

        for (id, principal, state, attempt, failures) in interrupted {
            let recovery = select_recovery_source(&self.root, &self.connection, &principal, &id)?;
            let artifacts = self
                .root
                .join("jobs")
                .join(&principal)
                .join(&id)
                .join("artifacts");
            let master = artifacts.join("master.wav");
            if state == "finalizing" && master.is_file() {
                let inspected = match inspect_wav(&master) {
                    Ok(inspected) => inspected,
                    Err(error) => {
                        eprintln!("quarantining interrupted invalid master for {id}: {error:#}");
                        self.quarantine(&master)?;
                        // With no valid canonical artifact, recovery below
                        // restarts from the immutable request.
                        continue_recovery(
                            &self.connection,
                            &id,
                            attempt,
                            failures,
                            &artifacts,
                            &recovery,
                        )?;
                        continue;
                    }
                };
                let record = ArtifactRecord {
                    kind: "master".into(),
                    profile: "pcm16-wav-v1".into(),
                    relative_path: "artifacts/master.wav".into(),
                    media_type: "audio/wav".into(),
                    byte_length: inspected.byte_length,
                    sha256: inspected.sha256,
                    sample_rate: inspected.sample_rate,
                    channels: inspected.channels,
                    duration_ms: inspected.duration_ms,
                    created_at: now_rfc3339(),
                };
                write_artifact_manifest(&artifacts, &id, &record)?;
                let transaction = self.connection.transaction()?;
                insert_artifact(&transaction, &id, &record)?;
                transaction.execute(
                    "UPDATE jobs SET state='completed',stage=NULL,
                     progress_completed=NULL,progress_total=NULL,progress_unit=NULL,
                     revision=revision+1,updated_at=?2
                     WHERE id=?1 AND state='finalizing'",
                    params![id, now_rfc3339()],
                )?;
                songs::publish_song(&transaction, &id)?;
                transaction.commit()?;
                continue;
            }
            if artifacts.is_dir() {
                for entry in fs::read_dir(&artifacts)? {
                    let entry = entry?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with(".master.") && name.ends_with(".tmp") {
                        fs::remove_file(entry.path())?;
                    }
                }
            }
            if state == "cancel_requested" {
                self.connection.execute(
                    "UPDATE jobs SET state='cancelled',stage=NULL,progress_completed=NULL,
                     progress_total=NULL,progress_unit=NULL,error_code=NULL,error_message=NULL,
                     error_retryable=0,stop_reason='cancel',revision=revision+1,updated_at=?2
                     WHERE id=?1 AND state='cancel_requested'",
                    params![id, now_rfc3339()],
                )?;
                let job = self
                    .job_by_id(&id)?
                    .context("cancelled recovery job disappeared")?;
                write_status(&artifacts, &job, attempt)?;
                continue;
            }
            if state == "pause_requested" {
                self.connection.execute(
                    "UPDATE jobs SET state='paused',stage=?3,active_checkpoint=?4,
                     checkpoint_outcome=?5,progress_completed=NULL,progress_total=NULL,
                     progress_unit=NULL,stop_reason=COALESCE(stop_reason,'pause'),
                     revision=revision+1,updated_at=?2
                     WHERE id=?1 AND state='pause_requested'",
                    params![
                        id,
                        now_rfc3339(),
                        recovery.stage,
                        recovery.metadata_path,
                        recovery.outcome
                    ],
                )?;
                let job = self
                    .job_by_id(&id)?
                    .context("paused recovery job disappeared")?;
                write_status(&artifacts, &job, attempt)?;
                continue;
            }
            continue_recovery(
                &self.connection,
                &id,
                attempt,
                failures,
                &artifacts,
                &recovery,
            )?;
        }

        let mut statement = self
            .connection
            .prepare("SELECT j.id,j.principal_id FROM jobs j WHERE j.state='completed'")?;
        let completed = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (id, principal) in completed {
            let principal_id = principal.parse::<PrincipalId>()?;
            if let Err(error) = self.verified_master_path(principal_id, &id) {
                eprintln!("completed artifact check failed for {id}: {error:#}");
                let path = self
                    .root
                    .join("jobs")
                    .join(&principal)
                    .join(&id)
                    .join("artifacts/master.wav");
                if path.exists() {
                    self.quarantine(&path)?;
                }
                self.fail_corrupt_completed_song(&id)?;
            } else {
                self.write_indexed_artifact_manifest(&id)?;
            }
        }
        Ok(())
    }

    fn quarantine(&self, path: &Path) -> Result<()> {
        let destination = self
            .root
            .join("quarantine")
            .join(Uuid::new_v4().to_string());
        fs::rename(path, destination)
            .with_context(|| format!("failed to quarantine {}", path.display()))
    }
}

fn continue_recovery(
    connection: &Connection,
    id: &str,
    attempt: u32,
    consecutive_failures: u32,
    artifacts: &Path,
    recovery: &RecoverySource,
) -> Result<()> {
    if artifacts.is_dir() {
        for entry in fs::read_dir(artifacts)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".master.") && name.ends_with(".tmp") {
                fs::remove_file(entry.path())?;
            }
        }
    }
    connection.execute(
        "UPDATE jobs SET state='recovering',stage=?3,active_checkpoint=?4,
         checkpoint_outcome=?5,
         progress_completed=NULL,progress_total=NULL,progress_unit=NULL,
         revision=revision+1,updated_at=?2 WHERE id=?1",
        params![
            id,
            now_rfc3339(),
            recovery.stage,
            recovery.metadata_path,
            recovery.outcome
        ],
    )?;
    let failures = consecutive_failures.saturating_add(1);
    let terminal = failures >= MAX_ATTEMPTS;
    connection.execute(
        "UPDATE jobs SET state=?2,error_code=?3,error_message=?4,
         error_retryable=?5,consecutive_failures=?6,
         revision=revision+1,updated_at=?7 WHERE id=?1 AND state='recovering'",
        params![
            id,
            if terminal { "failed" } else { "queued" },
            terminal.then_some("internal"),
            terminal.then_some("Generation was interrupted three times."),
            terminal,
            failures,
            now_rfc3339()
        ],
    )?;
    let job = connection.query_row(
        &format!("SELECT {JOB_VIEW_COLUMNS} FROM jobs WHERE id=?1"),
        params![id],
        |row| job_from_row(row, 0),
    )?;
    write_status(artifacts, &job, attempt)
}

struct RecoverySource {
    stage: String,
    metadata_path: Option<String>,
    outcome: Option<String>,
}

fn select_recovery_source(
    root: &Path,
    connection: &Connection,
    principal: &str,
    id: &str,
) -> Result<RecoverySource> {
    let sidecar = accepted_sidecar_for(root, principal, id)?;
    let request_hash: String = connection.query_row(
        "SELECT request_hash FROM jobs WHERE principal_id=?1 AND id=?2",
        params![principal, id],
        |row| row.get(0),
    )?;
    let expectation = crate::checkpoints::CheckpointExpectation {
        job_id: id,
        request_hash: &request_hash,
        model_selector: &sidecar.model.selector,
        component_digests: &sidecar.model.component_digests,
    };
    let job_directory = root.join("jobs").join(principal).join(id);
    let selection = crate::checkpoints::select(&job_directory, &expectation, None)?;
    for rejected in selection.rejected {
        eprintln!("checkpoint.rejected job={id} reason={rejected}");
    }
    let Some(source) = selection.source else {
        return Ok(RecoverySource {
            stage: enum_text(GenerationStage::Plan)?,
            metadata_path: None,
            outcome: None,
        });
    };
    Ok(RecoverySource {
        stage: enum_text(crate::checkpoints::protocol_stage(source.stage))?,
        metadata_path: Some(source.reference.metadata_path),
        outcome: Some(enum_text(source.reference.outcome)?),
    })
}

//! Durable, owner-scoped job acceptance and queries.
//!
//! SQLite owns identity, uniqueness, ordering, and state. The filesystem owns
//! immutable request/provenance bytes. Acceptance writes sidecars first, then
//! commits the row, and only then may the protocol acknowledge the job.

mod jobs;
mod rows;
mod schema;

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cantor_proto::{GenerationRequest, GenerationStage, JobView};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use self::jobs::MAX_ATTEMPTS;
pub use self::jobs::{ControlResult, FinishResult, JobControl, Submission, SubmitResult, WorkItem};
use self::rows::{JOB_VIEW_COLUMNS, enum_text, job_from_row};
use crate::config::now_rfc3339;
use crate::principal::PrincipalId;

#[cfg(test)]
use crate::store::InstalledVariant;
#[cfg(test)]
use cantor_proto::{ErrorCode, JobState, ProgressUnit};

const DIRECTORY_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ArtifactRecord {
    pub kind: String,
    pub profile: String,
    pub relative_path: String,
    pub media_type: String,
    pub byte_length: u64,
    pub sha256: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_ms: u64,
    pub created_at: String,
}

#[derive(Serialize)]
struct RequestSidecar<'a> {
    schema: u8,
    job_id: &'a str,
    principal_id: &'a str,
    client_request_id: &'a str,
    accepted_at: &'a str,
    model: AcceptedModel<'a>,
    generation: &'a GenerationRequest,
}

#[derive(Serialize)]
struct AcceptedModel<'a> {
    selector: String,
    engine: &'a str,
    component_digests: Vec<&'a str>,
}

#[derive(Deserialize)]
struct AcceptedRequestSidecar {
    schema: u8,
    job_id: String,
    principal_id: String,
    model: AcceptedModelOwned,
    generation: GenerationRequest,
}

#[derive(Deserialize)]
struct AcceptedModelOwned {
    selector: String,
    engine: String,
    component_digests: Vec<String>,
}

pub struct Library {
    pub(crate) root: PathBuf,
    pub(crate) connection: Connection,
    pub(crate) cursor_key: [u8; 32],
}

impl Library {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        prepare_real_directory(&root)?;
        for child in ["jobs", "tmp", "trash", "quarantine"] {
            prepare_real_directory(&root.join(child))?;
        }
        let database = root.join("library.db");
        let connection = Connection::open(&database)
            .with_context(|| format!("failed to open {}", database.display()))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        schema::migrate(&connection)?;
        fs::set_permissions(&database, fs::Permissions::from_mode(FILE_MODE))?;
        let cursor_key = crate::songs::load_or_create_cursor_key(&root)?;
        let mut library = Self {
            root,
            connection,
            cursor_key,
        };
        library.reconcile_startup()?;
        library.recover_interrupted_jobs()?;
        library.backfill_completed_songs()?;
        Ok(library)
    }

    /// Writes, verifies, atomically publishes and indexes the canonical WAV.
    /// The completed transition happens last, in the artifact transaction.
    pub fn complete(
        &mut self,
        work: &WorkItem,
        audio: &crate::generate::Audio,
    ) -> Result<Option<(JobView, ArtifactRecord, cantor_proto::SongHeader, u64)>> {
        prepare_real_directory(&work.artifact_directory)?;
        let temporary = work
            .artifact_directory
            .join(format!(".master.{}.tmp", Uuid::new_v4()));
        audio.write_wav(&temporary)?;
        let inspected = inspect_wav(&temporary)?;
        if inspected.sample_rate != audio.sample_rate || inspected.frames != audio.frames() as u64 {
            bail!("written WAV properties do not match the engine output");
        }
        let final_path = work.artifact_directory.join("master.wav");
        if final_path.exists() {
            bail!("a canonical master already exists for job {}", work.id);
        }
        fs::rename(&temporary, &final_path)?;
        File::open(&work.artifact_directory)?.sync_all()?;

        let now = now_rfc3339();
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
            created_at: now.clone(),
        };
        write_artifact_manifest(&work.artifact_directory, &work.id, &record)?;

        let transaction = self.connection.transaction()?;
        let state: Option<(String, u32)> = transaction
            .query_row(
                "SELECT state,attempt FROM jobs WHERE id=?1",
                params![work.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if state != Some(("finalizing".into(), work.attempt)) {
            transaction.rollback()?;
            return Ok(None);
        }
        insert_artifact(&transaction, &work.id, &record)?;
        transaction.execute(
            "UPDATE jobs SET state='completed',error_retryable=0,consecutive_failures=0,
             revision=revision+1,updated_at=?2
             WHERE id=?1 AND state='finalizing' AND attempt=?3",
            params![work.id, now, work.attempt],
        )?;
        let job = transaction.query_row(
            &format!("SELECT {JOB_VIEW_COLUMNS} FROM jobs WHERE id=?1"),
            params![work.id],
            |row| job_from_row(row, 0),
        )?;
        let (song, library_revision) = crate::songs::publish_song(&transaction, &work.id)?;
        transaction.commit()?;
        write_status(&work.artifact_directory, &job, work.attempt)?;
        Ok(Some((job, record, song, library_revision)))
    }

    pub fn verified_master_path(&self, principal: PrincipalId, id: &str) -> Result<PathBuf> {
        let artifact = self
            .connection
            .query_row(
                "SELECT a.relative_path,a.sha256 FROM artifacts a
                 JOIN jobs j ON j.id=a.job_id
                 WHERE j.principal_id=?1 AND j.id=?2 AND j.state='completed' AND a.kind='master'",
                params![principal.to_string(), id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .context("completed job has no indexed master artifact")?;
        if artifact.0 != "artifacts/master.wav" {
            bail!("master artifact path is not canonical");
        }
        let path = self
            .root
            .join("jobs")
            .join(principal.to_string())
            .join(id)
            .join(&artifact.0);
        let inspected = inspect_wav(&path)?;
        if inspected.sha256 != artifact.1 {
            bail!("master artifact digest does not match its index");
        }
        Ok(path)
    }

    pub fn export_master(
        &self,
        principal: PrincipalId,
        id: &str,
        destination: &Path,
    ) -> Result<()> {
        let source = self.verified_master_path(principal, id)?;
        let parent = destination
            .parent()
            .context("export destination has no parent directory")?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".cantor-export.")
            .tempfile_in(parent)?;
        let mut input = File::open(&source)?;
        std::io::copy(&mut input, temporary.as_file_mut())?;
        temporary.as_file().sync_all()?;
        let temporary = temporary.into_temp_path();
        temporary
            .persist(destination)
            .map_err(|error| error.error)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn reconcile_startup(&self) -> Result<()> {
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
    fn recover_interrupted_jobs(&mut self) -> Result<()> {
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
                crate::songs::publish_song(&transaction, &id)?;
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

fn accepted_sidecar_for(root: &Path, principal: &str, id: &str) -> Result<AcceptedRequestSidecar> {
    let path = root
        .join("jobs")
        .join(principal)
        .join(id)
        .join("request.json");
    serde_json::from_reader(File::open(&path)?)
        .with_context(|| format!("failed to read {}", path.display()))
}

fn write_status(artifact_directory: &Path, job: &JobView, attempt: u32) -> Result<()> {
    let job_directory = artifact_directory
        .parent()
        .context("artifact directory has no job parent")?;
    write_json_atomic(
        &job_directory.join("status.json"),
        &serde_json::json!({
            "schema": 2,
            "state": job.state,
            "stage": job.stage,
            "progress": job.progress,
            "revision": job.revision,
            "attempt": attempt,
            "updated_at": job.updated_at,
            "error": job.error,
        }),
    )
}

pub(crate) fn insert_artifact(
    transaction: &rusqlite::Transaction<'_>,
    job_id: &str,
    record: &ArtifactRecord,
) -> Result<()> {
    transaction.execute(
        "INSERT OR REPLACE INTO artifacts(job_id,kind,profile,relative_path,media_type,
         byte_length,sha256,sample_rate,channels,duration_ms,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            job_id,
            record.kind,
            record.profile,
            record.relative_path,
            record.media_type,
            record.byte_length,
            record.sha256,
            record.sample_rate,
            record.channels,
            record.duration_ms,
            record.created_at
        ],
    )?;
    Ok(())
}

struct InspectedWav {
    byte_length: u64,
    sha256: String,
    sample_rate: u32,
    channels: u16,
    frames: u64,
    duration_ms: u64,
}

fn inspect_wav(path: &Path) -> Result<InspectedWav> {
    let mut file = File::open(path)?;
    let byte_length = file.metadata()?.len();
    if byte_length <= 44 {
        bail!("WAV is empty or truncated");
    }
    let mut header = [0_u8; 44];
    file.read_exact(&mut header)?;
    if &header[0..4] != b"RIFF"
        || &header[8..12] != b"WAVE"
        || &header[12..16] != b"fmt "
        || &header[36..40] != b"data"
    {
        bail!("WAV header is not canonical PCM");
    }
    let format = u16::from_le_bytes(header[20..22].try_into()?);
    let channels = u16::from_le_bytes(header[22..24].try_into()?);
    let sample_rate = u32::from_le_bytes(header[24..28].try_into()?);
    let bits = u16::from_le_bytes(header[34..36].try_into()?);
    let data_bytes = u32::from_le_bytes(header[40..44].try_into()?) as u64;
    if format != 1 || channels == 0 || sample_rate == 0 || bits != 16 {
        bail!("WAV properties are not supported PCM");
    }
    if data_bytes + 44 != byte_length {
        bail!("WAV data length does not match the durable file");
    }
    let bytes_per_frame = u64::from(channels) * 2;
    if data_bytes % bytes_per_frame != 0 {
        bail!("WAV ends inside an audio frame");
    }
    let frames = data_bytes / bytes_per_frame;
    if frames == 0 {
        bail!("WAV contains no audio frames");
    }
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Ok(InspectedWav {
        byte_length,
        sha256: hex(&digest),
        sample_rate,
        channels,
        frames,
        duration_ms: frames.saturating_mul(1_000) / u64::from(sample_rate),
    })
}

fn prepare_real_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("library path must be a real directory: {}", path.display());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(DIRECTORY_MODE))?;
    Ok(())
}

fn clear_ephemeral_directory(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path)?;
        if metadata.is_dir() {
            fs::remove_dir_all(entry_path)?;
        } else {
            fs::remove_file(entry_path)?;
        }
    }
    Ok(())
}

fn is_known_incomplete_job(path: &Path) -> Result<bool> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(entry.path())?;
        let known_regular = matches!(
            name.as_str(),
            "request.json" | "status.json" | "manifest.json"
        ) || name.starts_with(".sidecar.");
        let known_empty_directory = matches!(name.as_str(), "checkpoints" | "artifacts")
            && metadata.is_dir()
            && fs::read_dir(entry.path())?.next().is_none();
        if !(metadata.is_file() && known_regular || known_empty_directory) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn write_artifact_manifest(
    artifact_directory: &Path,
    job_id: &str,
    record: &ArtifactRecord,
) -> Result<()> {
    let job_directory = artifact_directory
        .parent()
        .context("artifact directory has no job directory")?;
    write_json_atomic(
        &job_directory.join("manifest.json"),
        &serde_json::json!({"schema":3,"job_id":job_id,"artifacts":[record]}),
    )
}

pub(crate) fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("sidecar path has no parent")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".sidecar.")
        .tempfile_in(parent)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(FILE_MODE))?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), value)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn hex<const N: usize>(bytes: &[u8; N]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Component;
    use tempfile::tempdir;

    fn principal(fill: u8) -> PrincipalId {
        PrincipalId::from_bytes_for_test([fill; 32])
    }

    fn variant() -> InstalledVariant {
        InstalledVariant {
            model: "acestep".into(),
            tag: "1.5-fast".into(),
            licence: String::new(),
            components: vec![Component {
                role: "model".into(),
                blob: format!("sha256:{}", "a".repeat(64)),
                url: "u".into(),
                bytes: 1,
                quant: None,
            }],
            installed_at: String::new(),
            engine: "acestep".into(),
            vram_bytes: 0,
        }
    }
    fn submission(caption: &str) -> Submission {
        Submission {
            client_request_id: Uuid::new_v4().to_string(),
            model: "acestep:1.5-fast".into(),
            generation: GenerationRequest {
                caption: caption.into(),
                lyrics: None,
                duration: Some(60),
                steps: None,
                cfg: None,
                seed: Some(7),
            },
        }
    }

    #[test]
    fn migration_reopens_and_acceptance_is_idempotent() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        let request = submission("one");
        let first = library
            .submit(principal(1), &[2; 32], &request, &variant(), 20, 0)
            .unwrap();
        let second = library
            .submit(principal(1), &[2; 32], &request, &variant(), 20, 0)
            .unwrap();
        assert_eq!(first, second);
        drop(library);
        assert_eq!(
            Library::open(temporary.path())
                .unwrap()
                .queued_count()
                .unwrap(),
            1
        );
    }

    #[test]
    fn migration_history_is_complete_ordered_and_idempotent_on_reopen() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let versions = {
            let mut statement = library
                .connection
                .prepare("SELECT version FROM schema_migrations ORDER BY version")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, u32>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(versions, vec![1, 2, 3, 4, 5]);
        drop(library);

        let reopened = Library::open(temporary.path()).unwrap();
        let versions_after_reopen = {
            let mut statement = reopened
                .connection
                .prepare("SELECT version FROM schema_migrations ORDER BY version")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, u32>(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(versions_after_reopen, versions);
        assert_eq!(
            reopened
                .connection
                .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }

    #[test]
    fn conflict_and_owner_isolation_are_enforced() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        let request = submission("one");
        library
            .submit(principal(1), &[2; 32], &request, &variant(), 20, 0)
            .unwrap();
        let mut changed = request.clone();
        changed.generation.caption = "different".into();
        assert_eq!(
            library
                .submit(principal(1), &[2; 32], &changed, &variant(), 20, 0)
                .unwrap(),
            SubmitResult::Conflict
        );
        assert_eq!(library.list(principal(1), 20).unwrap().len(), 1);
        assert!(library.list(principal(3), 20).unwrap().is_empty());
        let id = library.list(principal(1), 20).unwrap()[0].id.clone();
        assert!(library.get(principal(3), &id).unwrap().is_none());
    }

    #[test]
    fn idempotent_retry_succeeds_even_when_queue_is_full() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        let request = submission("one");
        let accepted = library
            .submit(principal(1), &[2; 32], &request, &variant(), 1, 0)
            .unwrap();
        assert_eq!(
            library
                .submit(principal(1), &[2; 32], &request, &variant(), 1, u64::MAX)
                .unwrap(),
            accepted
        );
        assert_eq!(
            library
                .submit(principal(1), &[2; 32], &submission("two"), &variant(), 1, 0)
                .unwrap(),
            SubmitResult::QueueFull
        );
    }

    #[test]
    fn admission_failure_creates_no_job_and_request_ids_are_owner_scoped() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        let request = submission("one");
        assert_eq!(
            library
                .submit(principal(1), &[2; 32], &request, &variant(), 20, u64::MAX,)
                .unwrap(),
            SubmitResult::InsufficientDisk
        );
        assert!(library.list(principal(1), 20).unwrap().is_empty());
        assert_eq!(
            fs::read_dir(library.root().join("jobs")).unwrap().count(),
            0
        );

        let first = library
            .submit(principal(1), &[2; 32], &request, &variant(), 20, 0)
            .unwrap();
        let second = library
            .submit(principal(3), &[4; 32], &request, &variant(), 20, 0)
            .unwrap();
        assert_ne!(first, second);
        assert_eq!(library.queued_count().unwrap(), 2);
    }

    #[test]
    fn startup_deletes_known_orphans_and_quarantines_ambiguous_ones() {
        let temporary = tempdir().unwrap();
        let library = Library::open(temporary.path()).unwrap();
        let principal = "a".repeat(64);
        let safe = library
            .root()
            .join("jobs")
            .join(&principal)
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(safe.join("artifacts")).unwrap();
        fs::write(safe.join("request.json"), b"incomplete").unwrap();
        let ambiguous = library
            .root()
            .join("jobs")
            .join(&principal)
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&ambiguous).unwrap();
        fs::write(ambiguous.join("unknown.bin"), b"do not delete").unwrap();
        drop(library);

        let reopened = Library::open(temporary.path()).unwrap();
        assert!(!safe.exists());
        assert!(!ambiguous.exists());
        assert_eq!(
            fs::read_dir(reopened.root().join("quarantine"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn fifo_claim_progress_and_verified_completion_are_durable() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        for caption in ["first", "second"] {
            library
                .submit(
                    principal(1),
                    &[2; 32],
                    &submission(caption),
                    &variant(),
                    20,
                    0,
                )
                .unwrap();
        }
        let (work, preparing) = library.claim_next().unwrap().unwrap();
        assert_eq!(work.generation.caption, "first");
        assert_eq!(work.attempt, 1);
        assert_eq!(preparing.state, JobState::Preparing);
        assert!(library.claim_next().unwrap().is_none());
        let running = library
            .record_progress(
                &work,
                GenerationStage::Diffuse,
                2,
                Some(10),
                ProgressUnit::Steps,
            )
            .unwrap()
            .unwrap();
        assert_eq!(running.revision, preparing.revision + 1);
        assert_eq!(running.progress.unwrap().completed, 2);
        assert_eq!(
            library.begin_finalizing(&work).unwrap().unwrap().state,
            JobState::Finalizing
        );
        let audio = crate::generate::Audio {
            planar: vec![0.0, 0.5, -0.5, 0.0],
            sample_rate: 1_000,
        };
        let (completed, artifact, song, library_revision) =
            library.complete(&work, &audio).unwrap().unwrap();
        assert_eq!(completed.state, JobState::Completed);
        assert_eq!(song.id, work.id);
        assert_eq!(library_revision, 1);
        assert!(artifact.byte_length > 44);
        assert_eq!(artifact.channels, 2);
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(
                work.artifact_directory
                    .parent()
                    .unwrap()
                    .join("manifest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["schema"], 3);
        assert_eq!(manifest["job_id"], work.id);
        assert_eq!(manifest["artifacts"][0]["sha256"], artifact.sha256);
        assert_eq!(
            manifest["artifacts"][0]["relative_path"],
            "artifacts/master.wav"
        );
        assert_eq!(
            library.active_count().unwrap() + library.queued_count().unwrap(),
            1
        );
        assert!(
            library
                .verified_master_path(principal(1), &work.id)
                .unwrap()
                .is_file()
        );
        assert!(
            library
                .record_progress(
                    &work,
                    GenerationStage::Decode,
                    1,
                    Some(1),
                    ProgressUnit::Tiles,
                )
                .unwrap()
                .is_none()
        );
        drop(library);
        assert_eq!(
            Library::open(temporary.path())
                .unwrap()
                .get(principal(1), &work.id)
                .unwrap()
                .unwrap()
                .state,
            JobState::Completed
        );
    }

    #[test]
    fn an_interrupted_claim_requeues_without_consuming_a_second_attempt() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("restart"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let (first, _) = library.claim_next().unwrap().unwrap();
        assert_eq!(first.attempt, 1);
        drop(library);

        let mut reopened = Library::open(temporary.path()).unwrap();
        let recovered = reopened.get(principal(1), &first.id).unwrap().unwrap();
        assert_eq!(recovered.state, JobState::Queued);
        let (second, _) = reopened.claim_next().unwrap().unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.attempt, 2);
    }

    #[test]
    fn callbacks_from_a_superseded_attempt_cannot_mutate_the_new_claim() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("stale worker"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let (stale, _) = library.claim_next().unwrap().unwrap();
        assert!(matches!(
            library
                .finish_failure(&stale, ErrorCode::TemporarilyUnavailable, "retry", true,)
                .unwrap(),
            Some(FinishResult::Requeued(_))
        ));
        let (current, preparing) = library.claim_next().unwrap().unwrap();
        assert_eq!(current.attempt, stale.attempt + 1);

        assert!(
            library
                .record_progress(
                    &stale,
                    GenerationStage::Diffuse,
                    9,
                    Some(10),
                    ProgressUnit::Steps,
                )
                .unwrap()
                .is_none()
        );
        assert!(library.finish_cancelled(&stale).unwrap().is_none());

        let unchanged = library.get(principal(1), &current.id).unwrap().unwrap();
        assert_eq!(unchanged.state, JobState::Preparing);
        assert_eq!(unchanged.revision, preparing.revision);
        assert!(unchanged.progress.is_none());
    }

    #[test]
    fn controls_are_owner_scoped_idempotent_and_preserve_intent_across_restart() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        let accepted = match library
            .submit(
                principal(1),
                &[2; 32],
                &submission("controlled"),
                &variant(),
                20,
                0,
            )
            .unwrap()
        {
            SubmitResult::Accepted(job) => job,
            other => panic!("unexpected submission: {other:?}"),
        };
        assert!(matches!(
            library
                .control_job(principal(3), &accepted.id, None, JobControl::Pause)
                .unwrap(),
            ControlResult::NotFound
        ));
        let paused = match library
            .control_job(
                principal(1),
                &accepted.id,
                Some(accepted.revision),
                JobControl::Pause,
            )
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected pause: {other:?}"),
        };
        assert_eq!(paused.state, JobState::Paused);
        let repeated = match library
            .control_job(principal(1), &accepted.id, None, JobControl::Pause)
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected repeat: {other:?}"),
        };
        assert_eq!(repeated.revision, paused.revision);
        assert!(matches!(
            library
                .control_job(
                    principal(1),
                    &accepted.id,
                    Some(accepted.revision),
                    JobControl::Resume,
                )
                .unwrap(),
            ControlResult::Conflict(_)
        ));
        let resumed = match library
            .control_job(
                principal(1),
                &accepted.id,
                Some(paused.revision),
                JobControl::Resume,
            )
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected resume: {other:?}"),
        };
        assert_eq!(resumed.state, JobState::Queued);

        let (first_work, preparing) = library.claim_next().unwrap().unwrap();
        let requested = match library
            .control_job(
                principal(1),
                &accepted.id,
                Some(preparing.revision),
                JobControl::Pause,
            )
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected active pause: {other:?}"),
        };
        assert_eq!(requested.state, JobState::PauseRequested);
        drop(library);

        let mut reopened = Library::open(temporary.path()).unwrap();
        let held = reopened.get(principal(1), &accepted.id).unwrap().unwrap();
        assert_eq!(held.state, JobState::Paused);
        assert_eq!(held.stage, Some(GenerationStage::Plan));
        let resumed = match reopened
            .control_job(
                principal(1),
                &accepted.id,
                Some(held.revision),
                JobControl::Resume,
            )
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected recovered resume: {other:?}"),
        };
        assert_eq!(resumed.state, JobState::Queued);
        let (_second_work, preparing) = reopened.claim_next().unwrap().unwrap();
        assert_eq!(first_work.id, accepted.id);
        let cancelling = match reopened
            .control_job(
                principal(1),
                &accepted.id,
                Some(preparing.revision),
                JobControl::Cancel,
            )
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected cancel: {other:?}"),
        };
        assert_eq!(cancelling.state, JobState::CancelRequested);
        drop(reopened);

        let reopened = Library::open(temporary.path()).unwrap();
        assert_eq!(
            reopened
                .get(principal(1), &accepted.id)
                .unwrap()
                .unwrap()
                .state,
            JobState::Cancelled
        );
    }

    #[test]
    fn corrupt_paused_checkpoint_falls_back_to_the_immutable_request() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("fallback"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let (work, _) = library.claim_next().unwrap().unwrap();
        let reference = crate::checkpoints::write(
            &work.job_directory().join("checkpoints"),
            &work.checkpoint_expectation(),
            work.attempt,
            crate::engine::Stage::Plan,
            crate::checkpoints::CheckpointOutcome::Paused,
            crate::checkpoints::EngineProvenance {
                family: "acestep".into(),
                abi: 1,
                build: "build".into(),
                backend: "cpu".into(),
            },
            b"opaque",
        )
        .unwrap();
        library
            .record_checkpoint(&work, &reference, GenerationStage::Plan)
            .unwrap();
        let paused = library
            .finish_paused(&work, Some(&reference), GenerationStage::Plan, "pause")
            .unwrap()
            .unwrap();
        let metadata_path = work.job_directory().join(&reference.metadata_path);
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        let blob = metadata["blob"].as_str().unwrap();
        fs::write(work.job_directory().join("checkpoints").join(blob), b"bad").unwrap();

        let resumed = match library
            .control_job(
                principal(1),
                &work.id,
                Some(paused.revision),
                JobControl::Resume,
            )
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected resume fallback: {other:?}"),
        };
        assert_eq!(resumed.state, JobState::Queued);
        let active: Option<String> = library
            .connection
            .query_row(
                "SELECT active_checkpoint FROM jobs WHERE id=?1",
                params![work.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(active.is_none());
    }

    #[test]
    fn retry_is_exposed_only_after_bounded_automatic_attempts() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("retry"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let mut final_job = None;
        for expected_attempt in 1..=MAX_ATTEMPTS {
            let (work, _) = library.claim_next().unwrap().unwrap();
            assert_eq!(work.attempt, expected_attempt);
            let result = library
                .finish_failure(&work, ErrorCode::TemporarilyUnavailable, "temporary", true)
                .unwrap()
                .unwrap();
            match result {
                FinishResult::Requeued(job) => {
                    assert!(expected_attempt < MAX_ATTEMPTS && job.error.is_none())
                }
                FinishResult::Failed(job) => final_job = Some(job),
            }
        }
        let failed = final_job.unwrap();
        assert!(failed.error.as_ref().unwrap().retryable);
        let retried = match library
            .control_job(
                principal(1),
                &failed.id,
                Some(failed.revision),
                JobControl::Retry,
            )
            .unwrap()
        {
            ControlResult::Updated(job) => job,
            other => panic!("unexpected explicit retry: {other:?}"),
        };
        assert_eq!(retried.state, JobState::Queued);
        assert!(retried.error.is_none());
    }

    fn complete_next(library: &mut Library) -> (WorkItem, cantor_proto::SongHeader) {
        let (work, _) = library.claim_next().unwrap().unwrap();
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .unwrap();
        library.begin_finalizing(&work).unwrap();
        let (_, _, song, _) = library
            .complete(
                &work,
                &crate::generate::Audio {
                    planar: vec![0.0, 0.5, -0.5, 0.0],
                    sample_rate: 1_000,
                },
            )
            .unwrap()
            .unwrap();
        (work, song)
    }

    #[test]
    fn completed_jobs_publish_once_and_backfill_is_idempotent() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("Música nocturna"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let (work, song) = complete_next(&mut library);
        assert_eq!(song.id, work.id);
        assert_eq!(song.title, "Música nocturna");
        assert_eq!(song.revision, 1);
        assert_eq!(library.library_revision(principal(1)).unwrap(), 1);
        assert_eq!(
            library
                .song_detail(principal(1), &work.id)
                .unwrap()
                .unwrap()
                .generation
                .seed,
            Some(7)
        );
        assert!(
            library
                .song_detail(principal(3), &work.id)
                .unwrap()
                .is_none()
        );

        library
            .connection
            .execute("DELETE FROM library_changes", [])
            .unwrap();
        library.connection.execute("DELETE FROM songs", []).unwrap();
        library
            .connection
            .execute("UPDATE principals SET library_revision=0", [])
            .unwrap();
        drop(library);

        let reopened = Library::open(temporary.path()).unwrap();
        assert_eq!(reopened.library_revision(principal(1)).unwrap(), 1);
        drop(reopened);
        let reopened = Library::open(temporary.path()).unwrap();
        assert_eq!(reopened.library_revision(principal(1)).unwrap(), 1);
        assert!(
            reopened
                .song_detail(principal(1), &work.id)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn failed_song_publication_rolls_back_sql_and_restart_adopts_the_master() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("transaction boundary"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let (work, _) = library.claim_next().unwrap().unwrap();
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .unwrap();
        library.begin_finalizing(&work).unwrap().unwrap();
        library
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_song_publication
                 BEFORE INSERT ON songs BEGIN
                   SELECT RAISE(ABORT, 'forced song publication failure');
                 END;",
            )
            .unwrap();

        let completion = library.complete(
            &work,
            &crate::generate::Audio {
                planar: vec![0.0, 0.5, -0.5, 0.0],
                sample_rate: 1_000,
            },
        );
        assert!(completion.is_err());
        assert!(work.artifact_directory.join("master.wav").is_file());
        assert_eq!(
            library.get(principal(1), &work.id).unwrap().unwrap().state,
            JobState::Finalizing
        );
        for table in ["artifacts", "songs", "library_changes"] {
            let count: u32 = library
                .connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} escaped the failed transaction");
        }
        assert_eq!(library.library_revision(principal(1)).unwrap(), 0);
        drop(library); // Also drops the deliberately connection-local trigger.

        let reopened = Library::open(temporary.path()).unwrap();
        assert_eq!(
            reopened.get(principal(1), &work.id).unwrap().unwrap().state,
            JobState::Completed
        );
        assert_eq!(reopened.library_revision(principal(1)).unwrap(), 1);
        assert!(
            reopened
                .song_detail(principal(1), &work.id)
                .unwrap()
                .is_some()
        );
        assert!(
            reopened
                .verified_master_path(principal(1), &work.id)
                .unwrap()
                .is_file()
        );
    }

    #[test]
    fn signed_pages_sync_mutations_and_privacy_converge() {
        use crate::songs::{ChangePageResult, MutationResult, PresenceMutation, SongPageResult};
        use cantor_proto::SongPatch;

        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        for caption in ["first song", "second song"] {
            library
                .submit(
                    principal(1),
                    &[2; 32],
                    &submission(caption),
                    &variant(),
                    20,
                    0,
                )
                .unwrap();
        }
        let (first, _) = complete_next(&mut library);
        complete_next(&mut library);

        let first_page = match library.list_songs(principal(1), 1, None, false).unwrap() {
            SongPageResult::Page(page) => page,
            SongPageResult::InvalidCursor => panic!("fresh page cursor"),
        };
        assert_eq!(first_page.snapshot_revision, 2);
        assert_eq!(first_page.songs.len(), 1);
        let cursor = first_page.next_cursor.unwrap();
        assert!(matches!(
            library
                .list_songs(principal(3), 1, Some(&cursor), false)
                .unwrap(),
            SongPageResult::InvalidCursor
        ));
        drop(library);
        let mut library = Library::open(temporary.path()).unwrap();
        assert!(matches!(
            library
                .list_songs(principal(1), 1, Some(&cursor), false)
                .unwrap(),
            SongPageResult::Page(_)
        ));

        let updated = match library
            .patch_song(
                principal(1),
                &first.id,
                1,
                &SongPatch {
                    title: Some("After Midnight".into()),
                    favorite: Some(true),
                    tags: Some(vec!["bolero".into(), "guitar".into()]),
                },
            )
            .unwrap()
        {
            MutationResult::Updated(song) => song,
            _ => panic!("owner patch failed"),
        };
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.title, "After Midnight");
        assert!(matches!(
            library
                .patch_song(
                    principal(3),
                    &first.id,
                    2,
                    &SongPatch {
                        title: Some("stolen".into()),
                        favorite: None,
                        tags: None,
                    }
                )
                .unwrap(),
            MutationResult::NotFound
        ));
        assert!(matches!(
            library
                .patch_song(
                    principal(1),
                    &first.id,
                    1,
                    &SongPatch {
                        title: Some("stale".into()),
                        favorite: None,
                        tags: None,
                    }
                )
                .unwrap(),
            MutationResult::Conflict(_)
        ));
        let trashed = match library
            .change_song_presence(principal(1), &first.id, 2, PresenceMutation::Trash)
            .unwrap()
        {
            MutationResult::Updated(song) => song,
            _ => panic!("trash failed"),
        };
        assert!(trashed.trashed);
        let ordinary = match library.list_songs(principal(1), 10, None, false).unwrap() {
            SongPageResult::Page(page) => page,
            SongPageResult::InvalidCursor => panic!("fresh list"),
        };
        assert!(!ordinary.songs.iter().any(|song| song.id == first.id));
        let changes = match library.sync_songs(principal(1), 0, 10).unwrap() {
            ChangePageResult::Page(page) => page,
            _ => panic!("sync failed"),
        };
        assert_eq!(changes.through_revision, 4);
        assert_eq!(changes.changes.len(), 4);
        assert!(
            changes
                .changes
                .windows(2)
                .all(|pair| pair[0].revision < pair[1].revision)
        );
    }

    #[test]
    fn startup_adopts_a_finalizing_master_and_repairs_its_manifest() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("adopt"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let (work, _) = library.claim_next().unwrap().unwrap();
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .unwrap();
        library.begin_finalizing(&work).unwrap();
        let audio = crate::generate::Audio {
            planar: vec![0.0, 0.5, -0.5, 0.0],
            sample_rate: 1_000,
        };
        audio
            .write_wav(&work.artifact_directory.join("master.wav"))
            .unwrap();
        drop(library);

        let reopened = Library::open(temporary.path()).unwrap();
        let recovered = reopened.get(principal(1), &work.id).unwrap().unwrap();
        assert_eq!(recovered.state, JobState::Completed);
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(
                work.artifact_directory
                    .parent()
                    .unwrap()
                    .join("manifest.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["schema"], 3);
        assert_eq!(manifest["job_id"], work.id);
        assert_eq!(
            manifest["artifacts"][0]["relative_path"],
            "artifacts/master.wav"
        );
    }

    #[test]
    fn corrupt_completed_audio_is_quarantined_and_never_served_as_complete() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        library
            .submit(
                principal(1),
                &[2; 32],
                &submission("corrupt"),
                &variant(),
                20,
                0,
            )
            .unwrap();
        let (work, _) = library.claim_next().unwrap().unwrap();
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .unwrap();
        library.begin_finalizing(&work).unwrap();
        library
            .complete(
                &work,
                &crate::generate::Audio {
                    planar: vec![0.0, 0.0],
                    sample_rate: 1_000,
                },
            )
            .unwrap();
        let master = library
            .verified_master_path(principal(1), &work.id)
            .unwrap();
        fs::write(&master, b"truncated").unwrap();
        drop(library);

        let reopened = Library::open(temporary.path()).unwrap();
        let job = reopened.get(principal(1), &work.id).unwrap().unwrap();
        assert_eq!(job.state, JobState::Failed);
        assert!(job.error.is_some());
        assert!(!master.exists());
        assert_eq!(
            fs::read_dir(reopened.root().join("quarantine"))
                .unwrap()
                .count(),
            1
        );
    }
}

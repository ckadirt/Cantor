//! Canonical artifact publication, verification, export, and indexed records.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use cantor_proto::JobView;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::principal::PrincipalId;

use super::rows::{JOB_VIEW_COLUMNS, job_from_row};
use super::{Library, WorkItem, prepare_real_directory, write_json_atomic, write_status};

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

impl Library {
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

pub(super) struct InspectedWav {
    pub(super) byte_length: u64,
    pub(super) sha256: String,
    pub(super) sample_rate: u32,
    pub(super) channels: u16,
    pub(super) frames: u64,
    pub(super) duration_ms: u64,
}

pub(super) fn inspect_wav(path: &Path) -> Result<InspectedWav> {
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

pub(super) fn write_artifact_manifest(
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

pub(super) fn hex<const N: usize>(bytes: &[u8; N]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

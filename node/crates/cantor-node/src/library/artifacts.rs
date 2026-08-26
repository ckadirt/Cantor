//! Canonical artifact publication, verification, export, and indexed records.

use std::collections::HashSet;
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

use super::durable_fs::{prepare_real_directory, write_json_atomic};
use super::rows::{JOB_VIEW_COLUMNS, job_from_row};
use super::sidecars::write_status;
use super::{Library, WorkItem};

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

pub const DELIVERY_PROFILE: &str = "opus-stereo-160k-v1";
pub const DELIVERY_MEDIA_TYPE: &str = "audio/ogg; codecs=opus";
const DELIVERY_RELATIVE_PATH: &str = "artifacts/delivery.opus";
pub(crate) const DELIVERY_SAMPLE_RATE: u32 = 48_000;
pub(crate) const DELIVERY_CHANNELS: u16 = 2;

#[derive(Clone, Debug)]
pub struct DeliveryCandidate {
    pub job_id: String,
    pub principal_id: PrincipalId,
    pub master_path: PathBuf,
    pub final_path: PathBuf,
    pub duration_ms: u64,
}

#[derive(Debug)]
pub struct InspectedDelivery {
    pub byte_length: u64,
    pub sha256: String,
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
        let (song, library_revision) = super::songs::publish_song(&transaction, &work.id)?;
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

    pub fn next_delivery_candidate(
        &self,
        skipped: &HashSet<String>,
    ) -> Result<Option<DeliveryCandidate>> {
        let mut statement = self.connection.prepare(
            "SELECT j.id,j.principal_id,a.duration_ms
                 FROM jobs j
                 JOIN songs s ON s.id=j.id AND s.trashed_at IS NULL
                 JOIN artifacts a ON a.job_id=j.id AND a.kind='master'
                 LEFT JOIN artifacts d ON d.job_id=j.id AND d.kind='delivery'
                 WHERE j.state='completed' AND d.job_id IS NULL
                 ORDER BY j.updated_at DESC,j.id DESC",
        )?;
        let candidates = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let Some((job_id, principal, duration_ms)) = candidates
            .into_iter()
            .find(|(job_id, _, _)| !skipped.contains(job_id))
        else {
            return Ok(None);
        };
        let principal_id = parse_principal(&principal)?;
        let master_path = self.verified_master_path(principal_id, &job_id)?;
        let final_path = self
            .root
            .join("jobs")
            .join(&principal)
            .join(&job_id)
            .join(DELIVERY_RELATIVE_PATH);
        Ok(Some(DeliveryCandidate {
            job_id,
            principal_id,
            master_path,
            final_path,
            duration_ms,
        }))
    }

    pub fn publish_delivery(
        &mut self,
        candidate: &DeliveryCandidate,
        inspected: InspectedDelivery,
    ) -> Result<u64> {
        let record = ArtifactRecord {
            kind: "delivery".into(),
            profile: DELIVERY_PROFILE.into(),
            relative_path: DELIVERY_RELATIVE_PATH.into(),
            media_type: DELIVERY_MEDIA_TYPE.into(),
            byte_length: inspected.byte_length,
            sha256: inspected.sha256,
            sample_rate: DELIVERY_SAMPLE_RATE,
            channels: DELIVERY_CHANNELS,
            duration_ms: candidate.duration_ms,
            created_at: now_rfc3339(),
        };
        let transaction = self.connection.transaction()?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE job_id=?1 AND kind='delivery')",
            params![candidate.job_id],
            |row| row.get(0),
        )?;
        if exists {
            transaction.rollback()?;
            return self.library_revision(candidate.principal_id);
        }
        insert_artifact(&transaction, &candidate.job_id, &record)?;
        let (principal, revision) =
            super::songs::publish_delivery(&transaction, &candidate.job_id)?;
        if principal != candidate.principal_id {
            bail!("delivery owner changed during publication");
        }
        transaction.commit()?;
        self.write_indexed_artifact_manifest(&candidate.job_id)?;
        Ok(revision)
    }

    pub fn verified_delivery_artifact(
        &self,
        principal: PrincipalId,
        song_id: &str,
        profile: &str,
    ) -> Result<Option<(ArtifactRecord, PathBuf)>> {
        if profile != DELIVERY_PROFILE {
            return Ok(None);
        }
        let owner = principal.to_string();
        let record = self
            .connection
            .query_row(
                "SELECT a.kind,a.profile,a.relative_path,a.media_type,a.byte_length,a.sha256,
                 a.sample_rate,a.channels,a.duration_ms,a.created_at
                 FROM artifacts a JOIN songs s ON s.id=a.job_id
                 WHERE a.job_id=?1 AND a.kind='delivery' AND a.profile=?2
                   AND s.principal_id=?3 AND s.trashed_at IS NULL",
                params![song_id, profile, owner],
                |row| {
                    Ok(ArtifactRecord {
                        kind: row.get(0)?,
                        profile: row.get(1)?,
                        relative_path: row.get(2)?,
                        media_type: row.get(3)?,
                        byte_length: row.get(4)?,
                        sha256: row.get(5)?,
                        sample_rate: row.get(6)?,
                        channels: row.get(7)?,
                        duration_ms: row.get(8)?,
                        created_at: row.get(9)?,
                    })
                },
            )
            .optional()?;
        let Some(record) = record else {
            return Ok(None);
        };
        if record.relative_path != DELIVERY_RELATIVE_PATH {
            bail!("delivery artifact path is not canonical");
        }
        let path = self
            .root
            .join("jobs")
            .join(owner)
            .join(song_id)
            .join(&record.relative_path);
        let inspected = inspect_delivery(&path)?;
        if inspected.byte_length != record.byte_length || inspected.sha256 != record.sha256 {
            bail!("delivery artifact does not match its index");
        }
        Ok(Some((record, path)))
    }

    pub fn write_indexed_artifact_manifest(&self, job_id: &str) -> Result<()> {
        let mut statement = self.connection.prepare(
            "SELECT kind,profile,relative_path,media_type,byte_length,sha256,
             sample_rate,channels,duration_ms,created_at
             FROM artifacts WHERE job_id=?1 ORDER BY kind ASC",
        )?;
        let records = statement
            .query_map(params![job_id], |row| {
                Ok(ArtifactRecord {
                    kind: row.get(0)?,
                    profile: row.get(1)?,
                    relative_path: row.get(2)?,
                    media_type: row.get(3)?,
                    byte_length: row.get(4)?,
                    sha256: row.get(5)?,
                    sample_rate: row.get(6)?,
                    channels: row.get(7)?,
                    duration_ms: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let principal: String = self.connection.query_row(
            "SELECT principal_id FROM jobs WHERE id=?1",
            params![job_id],
            |row| row.get(0),
        )?;
        let manifest = self
            .root
            .join("jobs")
            .join(principal)
            .join(job_id)
            .join("manifest.json");
        write_json_atomic(
            &manifest,
            &serde_json::json!({"schema":3,"job_id":job_id,"artifacts":records}),
        )
    }
}

pub(super) fn insert_artifact(
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

pub(crate) fn inspect_delivery(path: &Path) -> Result<InspectedDelivery> {
    let mut file = File::open(path)?;
    let byte_length = file.metadata()?.len();
    if byte_length < 64 {
        bail!("delivery artifact is empty or truncated");
    }
    let mut magic = [0_u8; 4];
    file.read_exact(&mut magic)?;
    if &magic != b"OggS" {
        bail!("delivery artifact is not an Ogg stream");
    }
    file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(InspectedDelivery {
        byte_length,
        sha256: format!("{:x}", digest.finalize()),
    })
}

fn parse_principal(value: &str) -> Result<PrincipalId> {
    if value.len() != 64 {
        bail!("principal id is not 32-byte hex");
    }
    value.parse().map_err(Into::into)
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

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;

    use cantor_proto::{GenerationRequest, GenerationStage, ProgressUnit};
    use serde_json::Value;

    use super::{DELIVERY_PROFILE, DeliveryCandidate, inspect_delivery};
    use crate::catalog::Component;
    use crate::library::{Library, Submission};
    use crate::principal::PrincipalId;
    use crate::store::InstalledVariant;

    fn principal() -> PrincipalId {
        PrincipalId::from_bytes_for_test([0x41; 32])
    }

    fn variant() -> InstalledVariant {
        InstalledVariant {
            model: "acestep".into(),
            tag: "test".into(),
            licence: String::new(),
            components: vec![Component {
                role: "model".into(),
                blob: format!("sha256:{}", "a".repeat(64)),
                url: "unused".into(),
                bytes: 1,
                quant: None,
            }],
            installed_at: String::new(),
            engine: "acestep".into(),
            vram_bytes: 0,
            stages: Vec::new(),
            parameters: Vec::new(),
        }
    }

    fn complete_song(library: &mut Library, caption: &str) -> String {
        library
            .submit(
                principal(),
                &[2_u8; 32],
                &Submission {
                    client_request_id: uuid::Uuid::new_v4().to_string(),
                    model: variant().selector(),
                    generation: GenerationRequest {
                        caption: caption.into(),
                        lyrics: None,
                        duration: Some(15),
                        steps: Some(1),
                        cfg: None,
                        seed: Some(7),
                        extensions: None,
                    },
                },
                &variant(),
                20,
                0,
            )
            .expect("submission");
        let (work, _) = library
            .claim_next()
            .expect("claim query")
            .expect("queued job");
        library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Tiles,
            )
            .expect("progress")
            .expect("current claim");
        library
            .begin_finalizing(&work)
            .expect("begin finalizing")
            .expect("current claim");
        library
            .complete(
                &work,
                &crate::generate::Audio {
                    planar: vec![0.0; 960 * 2],
                    sample_rate: 48_000,
                },
            )
            .expect("completion")
            .expect("current claim");
        work.id
    }

    fn write_delivery(candidate: &DeliveryCandidate) -> super::InspectedDelivery {
        let mut bytes = vec![0_u8; 100];
        bytes[..4].copy_from_slice(b"OggS");
        fs::write(&candidate.final_path, bytes).expect("delivery bytes");
        inspect_delivery(&candidate.final_path).expect("delivery inspection")
    }

    #[test]
    fn delivery_candidates_keep_newest_order_skips_and_trash_filtering() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let mut library = Library::open(temporary.path()).expect("library");
        let older = complete_song(&mut library, "older delivery");
        let newer = complete_song(&mut library, "newer delivery");
        library
            .connection
            .execute(
                "UPDATE jobs SET updated_at=CASE id WHEN ?1 THEN ?3 ELSE ?4 END
                 WHERE id IN (?1,?2)",
                rusqlite::params![older, newer, "2026-08-11T00:00:00Z", "2026-08-11T00:00:01Z"],
            )
            .expect("stable delivery order");

        let candidate = library
            .next_delivery_candidate(&HashSet::new())
            .expect("candidate query")
            .expect("newest candidate");
        assert_eq!(candidate.job_id, newer);

        let skipped = HashSet::from([newer.clone()]);
        let candidate = library
            .next_delivery_candidate(&skipped)
            .expect("skipped candidate query")
            .expect("older candidate");
        assert_eq!(candidate.job_id, older);

        library
            .connection
            .execute(
                "UPDATE songs SET trashed_at='2026-08-11T00:00:02Z' WHERE id=?1",
                rusqlite::params![newer],
            )
            .expect("trash newest song");
        let candidate = library
            .next_delivery_candidate(&HashSet::new())
            .expect("trashed candidate query")
            .expect("untrashed candidate");
        assert_eq!(candidate.job_id, older);
    }

    #[test]
    fn delivery_publication_failure_rolls_back_artifact_song_and_revision() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let mut library = Library::open(temporary.path()).expect("library");
        let song_id = complete_song(&mut library, "rollback delivery");
        let candidate = library
            .next_delivery_candidate(&HashSet::new())
            .expect("candidate query")
            .expect("delivery candidate");
        let inspected = write_delivery(&candidate);
        library
            .connection
            .execute_batch(
                "CREATE TEMP TRIGGER fail_delivery_change
                 BEFORE INSERT ON library_changes
                 BEGIN SELECT RAISE(FAIL,'forced delivery publication failure'); END;",
            )
            .expect("failure trigger");

        assert!(library.publish_delivery(&candidate, inspected).is_err());
        let delivery_rows: u32 = library
            .connection
            .query_row(
                "SELECT count(*) FROM artifacts WHERE job_id=?1 AND kind='delivery'",
                rusqlite::params![song_id],
                |row| row.get(0),
            )
            .expect("delivery count");
        let song_revision: u32 = library
            .connection
            .query_row(
                "SELECT metadata_revision FROM songs WHERE id=?1",
                rusqlite::params![song_id],
                |row| row.get(0),
            )
            .expect("song revision");
        assert_eq!(delivery_rows, 0);
        assert_eq!(song_revision, 1);
        assert_eq!(library.library_revision(principal()).expect("revision"), 1);
    }

    #[test]
    fn delivery_manifest_is_canonical_and_a_write_failure_follows_the_sql_commit() {
        let temporary = tempfile::tempdir().expect("sandbox");
        let mut library = Library::open(temporary.path()).expect("library");
        let first = complete_song(&mut library, "manifest delivery");
        let candidate = library
            .next_delivery_candidate(&HashSet::new())
            .expect("candidate query")
            .expect("delivery candidate");
        assert_eq!(candidate.job_id, first);
        let inspected = write_delivery(&candidate);
        let expected_digest = inspected.sha256.clone();
        assert_eq!(
            library
                .publish_delivery(&candidate, inspected)
                .expect("delivery publication"),
            2
        );
        let verified = library
            .verified_delivery_artifact(principal(), &first, DELIVERY_PROFILE)
            .expect("delivery verification")
            .expect("delivery artifact");
        assert_eq!(verified.1, candidate.final_path);

        let manifest_path = candidate
            .final_path
            .parent()
            .expect("artifact directory")
            .parent()
            .expect("job directory")
            .join("manifest.json");
        let manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("indexed artifact manifest"))
                .expect("manifest JSON");
        assert_eq!(manifest["schema"], 3);
        assert_eq!(manifest["job_id"], first);
        assert_eq!(manifest["artifacts"][0]["kind"], "delivery");
        assert_eq!(
            manifest["artifacts"][0]["relative_path"],
            "artifacts/delivery.opus"
        );
        assert_eq!(manifest["artifacts"][0]["profile"], DELIVERY_PROFILE);
        assert_eq!(manifest["artifacts"][0]["sha256"], expected_digest);
        assert_eq!(manifest["artifacts"][1]["kind"], "master");

        let second = complete_song(&mut library, "post-commit manifest failure");
        let candidate = library
            .next_delivery_candidate(&HashSet::new())
            .expect("second candidate query")
            .expect("second delivery candidate");
        assert_eq!(candidate.job_id, second);
        let inspected = write_delivery(&candidate);
        let manifest_path = candidate
            .final_path
            .parent()
            .expect("artifact directory")
            .parent()
            .expect("job directory")
            .join("manifest.json");
        fs::remove_file(&manifest_path).expect("remove manifest file");
        fs::create_dir(&manifest_path).expect("blocking manifest directory");

        assert!(library.publish_delivery(&candidate, inspected).is_err());
        let delivery_rows: u32 = library
            .connection
            .query_row(
                "SELECT count(*) FROM artifacts WHERE job_id=?1 AND kind='delivery'",
                rusqlite::params![second],
                |row| row.get(0),
            )
            .expect("committed delivery count");
        let song_revision: u32 = library
            .connection
            .query_row(
                "SELECT metadata_revision FROM songs WHERE id=?1",
                rusqlite::params![second],
                |row| row.get(0),
            )
            .expect("committed song revision");
        assert_eq!(delivery_rows, 1);
        assert_eq!(song_revision, 2);
        assert_eq!(library.library_revision(principal()).expect("revision"), 4);
    }
}

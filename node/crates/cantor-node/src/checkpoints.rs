//! Durable envelopes around engine-owned opaque stage state.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cantor_proto::GenerationStage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::engine::Stage;

const FILE_MODE: u32 = 0o600;
const DIRECTORY_MODE: u32 = 0o700;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
pub const MAX_CHECKPOINT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointOutcome {
    Done,
    Paused,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct EngineProvenance {
    pub family: String,
    pub abi: u32,
    pub build: String,
    pub backend: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CheckpointMetadata {
    pub schema: u8,
    pub job_id: String,
    pub attempt: u32,
    pub stage: GenerationStage,
    pub outcome: CheckpointOutcome,
    pub resumes_stage: GenerationStage,
    pub created_at: String,
    pub blob: String,
    pub byte_length: u64,
    pub sha256: String,
    pub request_hash: String,
    pub model_selector: String,
    pub component_digests: Vec<String>,
    pub engine: EngineProvenance,
}

#[derive(Clone, Debug)]
pub struct CheckpointExpectation<'a> {
    pub job_id: &'a str,
    pub request_hash: &'a str,
    pub model_selector: &'a str,
    pub component_digests: &'a [String],
}

#[derive(Clone, Debug)]
pub struct CheckpointReference {
    pub metadata_path: String,
    pub outcome: CheckpointOutcome,
}

#[derive(Debug)]
pub struct ResumeSource {
    pub stage: Stage,
    pub input: Vec<u8>,
    pub reference: CheckpointReference,
}

#[derive(Debug, Default)]
pub struct Selection {
    pub source: Option<ResumeSource>,
    pub rejected: Vec<String>,
}

pub fn write(
    directory: &Path,
    expectation: &CheckpointExpectation<'_>,
    attempt: u32,
    stage: Stage,
    outcome: CheckpointOutcome,
    engine: EngineProvenance,
    bytes: &[u8],
) -> Result<CheckpointReference> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
        bail!("checkpoint blob size is outside the configured bound");
    }
    prepare_directory(directory)?;
    let stage_name = stage.as_str();
    let outcome_name = match outcome {
        CheckpointOutcome::Done => "done",
        CheckpointOutcome::Paused => "resume",
    };
    let stem = format!(
        "attempt-{attempt}.{stage_name}.{outcome_name}.{}",
        Uuid::new_v4()
    );
    let blob_name = format!("{stem}.bin");
    let metadata_name = format!("{stem}.json");
    let blob_path = directory.join(&blob_name);
    let metadata_path = directory.join(&metadata_name);
    if blob_path.exists() || metadata_path.exists() {
        bail!("checkpoint for this attempt/stage/outcome already exists");
    }

    let mut blob_temp = tempfile::Builder::new()
        .prefix(".checkpoint-blob.")
        .tempfile_in(directory)?;
    blob_temp
        .as_file()
        .set_permissions(fs::Permissions::from_mode(FILE_MODE))?;
    blob_temp.as_file_mut().write_all(bytes)?;
    blob_temp.as_file().sync_all()?;
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    let stage = protocol_stage(stage);
    let resumes_stage = match outcome {
        CheckpointOutcome::Paused => stage,
        CheckpointOutcome::Done => next_stage(stage).unwrap_or(stage),
    };
    let metadata = CheckpointMetadata {
        schema: 1,
        job_id: expectation.job_id.to_owned(),
        attempt,
        stage,
        outcome,
        resumes_stage,
        created_at: now_rfc3339(),
        blob: blob_name,
        byte_length: bytes.len() as u64,
        sha256: hex(&digest),
        request_hash: expectation.request_hash.to_owned(),
        model_selector: expectation.model_selector.to_owned(),
        component_digests: expectation.component_digests.to_vec(),
        engine,
    };
    let mut metadata_temp = tempfile::Builder::new()
        .prefix(".checkpoint-meta.")
        .tempfile_in(directory)?;
    metadata_temp
        .as_file()
        .set_permissions(fs::Permissions::from_mode(FILE_MODE))?;
    serde_json::to_writer_pretty(metadata_temp.as_file_mut(), &metadata)?;
    metadata_temp.as_file().sync_all()?;

    blob_temp
        .persist_noclobber(&blob_path)
        .map_err(|error| error.error)?;
    metadata_temp
        .persist_noclobber(&metadata_path)
        .map_err(|error| error.error)?;
    write_json_atomic(
        &directory.join("active.json"),
        &serde_json::json!({"schema":1,"metadata":metadata_name}),
    )?;
    File::open(directory)?.sync_all()?;
    Ok(CheckpointReference {
        metadata_path: format!(
            "checkpoints/{}",
            metadata_path.file_name().unwrap().to_string_lossy()
        ),
        outcome,
    })
}

pub fn select(
    job_directory: &Path,
    expectation: &CheckpointExpectation<'_>,
    engine: Option<&EngineProvenance>,
) -> Result<Selection> {
    let directory = job_directory.join("checkpoints");
    if !directory.exists() {
        return Ok(Selection::default());
    }
    require_real_directory(&directory)?;
    let mut candidates = Vec::new();
    let mut rejected = Vec::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") || name == "active.json" || name.starts_with('.') {
            continue;
        }
        match verify(&entry.path(), expectation, engine) {
            Ok((metadata, input)) => {
                let stage = engine_stage(metadata.resumes_stage);
                candidates.push((metadata, stage, input, name));
            }
            Err(error) => rejected.push(format!("{name}: {error}")),
        }
    }
    candidates.sort_by(|left, right| {
        checkpoint_rank(&right.0)
            .cmp(&checkpoint_rank(&left.0))
            .then_with(|| right.0.created_at.cmp(&left.0.created_at))
    });
    let source = candidates
        .into_iter()
        .next()
        .map(|(metadata, stage, input, metadata_name)| ResumeSource {
            stage,
            input,
            reference: CheckpointReference {
                metadata_path: format!("checkpoints/{metadata_name}"),
                outcome: metadata.outcome,
            },
        });
    Ok(Selection { source, rejected })
}

pub fn clear_temps(directory: &Path) -> Result<()> {
    if !directory.exists() {
        return Ok(());
    }
    require_real_directory(directory)?;
    let mut referenced_blobs = HashSet::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".checkpoint-") || name.starts_with(".sidecar.") {
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                fs::remove_dir_all(entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        } else if name.ends_with(".json")
            && name != "active.json"
            && let Ok(metadata) = read_metadata(&entry.path())
            && canonical_filename(&metadata.blob, ".bin")
        {
            referenced_blobs.insert(metadata.blob);
        }
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if canonical_filename(&name, ".bin") && !referenced_blobs.contains(&name) {
            fs::remove_file(entry.path())?;
        }
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub fn prune_rolling(directory: &Path, active_metadata_path: &str) -> Result<()> {
    require_real_directory(directory)?;
    let active_name = Path::new(active_metadata_path)
        .file_name()
        .context("active checkpoint has no filename")?
        .to_string_lossy()
        .into_owned();
    let active_stage = filename_stage(&active_name).unwrap_or(0);
    let mut prior_done: Option<(u8, String)> = None;
    let mut metadata_files = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".json") && name != "active.json" && !name.starts_with('.') {
            if name.contains(".done.") {
                let rank = filename_stage(&name).unwrap_or(0);
                if rank < active_stage && prior_done.as_ref().is_none_or(|old| rank > old.0) {
                    prior_done = Some((rank, name.clone()));
                }
            }
            metadata_files.push(name);
        }
    }
    let keep_prior = prior_done.map(|value| value.1);
    for name in metadata_files {
        if name == active_name || keep_prior.as_deref() == Some(name.as_str()) {
            continue;
        }
        let metadata_path = directory.join(&name);
        if let Ok(metadata) = read_metadata(&metadata_path) {
            let blob = directory.join(metadata.blob);
            if blob.is_file() {
                fs::remove_file(blob)?;
            }
        }
        fs::remove_file(metadata_path)?;
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}

/// Removes only terminal-job checkpoint state after the full grace period.
/// The caller owns the terminal-state check; immutable requests and canonical
/// artifacts live outside this directory and are never part of this GC.
pub fn prune_terminal(directory: &Path, grace: Duration) -> Result<bool> {
    if !directory.exists() {
        return Ok(false);
    }
    require_real_directory(directory)?;
    let mut newest: Option<std::time::SystemTime> = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        let modified = metadata.modified()?;
        newest = Some(newest.map_or(modified, |current| current.max(modified)));
    }
    let Some(newest) = newest else {
        return Ok(false);
    };
    if newest.elapsed().unwrap_or_default() < grace {
        return Ok(false);
    }
    fs::remove_dir_all(directory)?;
    if let Some(parent) = directory.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(true)
}

fn verify(
    metadata_path: &Path,
    expectation: &CheckpointExpectation<'_>,
    engine: Option<&EngineProvenance>,
) -> Result<(CheckpointMetadata, Vec<u8>)> {
    let metadata = read_metadata(metadata_path)?;
    if metadata.schema != 1
        || metadata.job_id != expectation.job_id
        || metadata.request_hash != expectation.request_hash
        || metadata.model_selector != expectation.model_selector
        || metadata.component_digests != expectation.component_digests
    {
        bail!("checkpoint identity/model provenance mismatch");
    }
    if let Some(engine) = engine
        && &metadata.engine != engine
    {
        bail!("checkpoint engine build/backend provenance mismatch");
    }
    let valid_relationship = match metadata.outcome {
        CheckpointOutcome::Paused => metadata.resumes_stage == metadata.stage,
        CheckpointOutcome::Done => next_stage(metadata.stage) == Some(metadata.resumes_stage),
    };
    if !valid_relationship {
        bail!("checkpoint stage/outcome relationship is invalid");
    }
    if !canonical_filename(&metadata.blob, ".bin") {
        bail!("checkpoint blob name is not canonical");
    }
    let directory = metadata_path
        .parent()
        .context("checkpoint has no directory")?;
    let blob_path = directory.join(&metadata.blob);
    let file_metadata = fs::symlink_metadata(&blob_path)?;
    if file_metadata.file_type().is_symlink() || !file_metadata.is_file() {
        bail!("checkpoint blob is not a regular file");
    }
    if file_metadata.len() == 0
        || file_metadata.len() > MAX_CHECKPOINT_BYTES
        || file_metadata.len() != metadata.byte_length
    {
        bail!("checkpoint blob length is invalid");
    }
    let file = File::open(&blob_path)?;
    let mut bytes = Vec::with_capacity(metadata.byte_length as usize);
    file.take(MAX_CHECKPOINT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != metadata.byte_length {
        bail!("checkpoint blob changed while reading");
    }
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    if hex(&digest) != metadata.sha256 {
        bail!("checkpoint blob digest mismatch");
    }
    Ok((metadata, bytes))
}

fn read_metadata(path: &Path) -> Result<CheckpointMetadata> {
    let file_metadata = fs::symlink_metadata(path)?;
    if file_metadata.file_type().is_symlink()
        || !file_metadata.is_file()
        || file_metadata.len() == 0
        || file_metadata.len() > MAX_METADATA_BYTES
    {
        bail!("checkpoint metadata is not a bounded regular file");
    }
    let file = File::open(path)?;
    serde_json::from_reader(file).context("checkpoint metadata is invalid JSON")
}

fn prepare_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    require_real_directory(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(DIRECTORY_MODE))?;
    Ok(())
}

fn require_real_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("checkpoint path is not a real directory");
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("checkpoint sidecar has no parent")?;
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

fn canonical_filename(value: &str, suffix: &str) -> bool {
    !value.is_empty()
        && value.ends_with(suffix)
        && Path::new(value).components().count() == 1
        && !value.starts_with('.')
}

fn checkpoint_rank(metadata: &CheckpointMetadata) -> (u8, u32, u8) {
    (
        stage_rank(metadata.resumes_stage),
        metadata.attempt,
        u8::from(metadata.outcome == CheckpointOutcome::Paused),
    )
}

fn filename_stage(name: &str) -> Option<u8> {
    ["plan", "codes", "diffuse", "decode"]
        .into_iter()
        .position(|stage| name.contains(&format!(".{stage}.")))
        .map(|index| index as u8 + 1)
}

fn stage_rank(stage: GenerationStage) -> u8 {
    match stage {
        GenerationStage::Plan => 1,
        GenerationStage::Codes => 2,
        GenerationStage::Diffuse => 3,
        GenerationStage::Decode => 4,
    }
}

pub fn protocol_stage(stage: Stage) -> GenerationStage {
    match stage {
        Stage::Plan => GenerationStage::Plan,
        Stage::Codes => GenerationStage::Codes,
        Stage::Diffuse => GenerationStage::Diffuse,
        Stage::Decode => GenerationStage::Decode,
    }
}

pub fn engine_stage(stage: GenerationStage) -> Stage {
    match stage {
        GenerationStage::Plan => Stage::Plan,
        GenerationStage::Codes => Stage::Codes,
        GenerationStage::Diffuse => Stage::Diffuse,
        GenerationStage::Decode => Stage::Decode,
    }
}

pub fn next_stage(stage: GenerationStage) -> Option<GenerationStage> {
    match stage {
        GenerationStage::Plan => Some(GenerationStage::Codes),
        GenerationStage::Codes => Some(GenerationStage::Diffuse),
        GenerationStage::Diffuse => Some(GenerationStage::Decode),
        GenerationStage::Decode => None,
    }
}

fn hex<const N: usize>(bytes: &[u8; N]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expectation<'a>(digests: &'a [String]) -> CheckpointExpectation<'a> {
        CheckpointExpectation {
            job_id: "job",
            request_hash: "request",
            model_selector: "model",
            component_digests: digests,
        }
    }

    fn engine() -> EngineProvenance {
        EngineProvenance {
            family: "acestep".into(),
            abi: 1,
            build: "build-1".into(),
            backend: "cpu".into(),
        }
    }

    #[test]
    fn a_checkpoint_round_trips_and_rejects_corruption_before_use() {
        let temporary = tempfile::tempdir().unwrap();
        let job = temporary.path().join("job");
        let directory = job.join("checkpoints");
        let digests = vec!["a".repeat(64)];
        let expectation = expectation(&digests);
        let reference = write(
            &directory,
            &expectation,
            1,
            Stage::Diffuse,
            CheckpointOutcome::Paused,
            engine(),
            b"opaque-resume",
        )
        .unwrap();
        let selected = select(&job, &expectation, Some(&engine())).unwrap();
        let source = selected.source.unwrap();
        assert_eq!(source.stage, Stage::Diffuse);
        assert_eq!(source.input, b"opaque-resume");
        assert_eq!(source.reference.metadata_path, reference.metadata_path);
        let metadata_path =
            directory.join(Path::new(&reference.metadata_path).file_name().unwrap());
        let (_, bytes) = verify(&metadata_path, &expectation, Some(&engine())).unwrap();
        assert_eq!(bytes, b"opaque-resume");
        let metadata = read_metadata(&metadata_path).unwrap();
        fs::write(directory.join(metadata.blob), b"bitflip").unwrap();
        assert!(verify(&metadata_path, &expectation, Some(&engine())).is_err());
        let selected = select(&job, &expectation, Some(&engine())).unwrap();
        assert!(selected.source.is_none());
        assert_eq!(selected.rejected.len(), 1);
    }

    #[test]
    fn engine_backend_mismatch_is_rejected() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("checkpoints");
        let digests = vec!["a".repeat(64)];
        let expectation = expectation(&digests);
        let reference = write(
            &directory,
            &expectation,
            2,
            Stage::Plan,
            CheckpointOutcome::Done,
            engine(),
            b"opaque-plan",
        )
        .unwrap();
        let mut changed = engine();
        changed.backend = "vulkan".into();
        let path = directory.join(Path::new(&reference.metadata_path).file_name().unwrap());
        assert!(verify(&path, &expectation, Some(&changed)).is_err());
    }

    #[test]
    fn rolling_retention_keeps_active_and_one_prior_boundary() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("checkpoints");
        let digests = vec!["a".repeat(64)];
        let expectation = expectation(&digests);
        let plan = write(
            &directory,
            &expectation,
            1,
            Stage::Plan,
            CheckpointOutcome::Done,
            engine(),
            b"plan",
        )
        .unwrap();
        let codes = write(
            &directory,
            &expectation,
            1,
            Stage::Codes,
            CheckpointOutcome::Done,
            engine(),
            b"codes",
        )
        .unwrap();
        let diffuse = write(
            &directory,
            &expectation,
            1,
            Stage::Diffuse,
            CheckpointOutcome::Paused,
            engine(),
            b"diffuse",
        )
        .unwrap();
        prune_rolling(&directory, &diffuse.metadata_path).unwrap();
        let metadata_exists = |reference: &CheckpointReference| {
            directory
                .join(Path::new(&reference.metadata_path).file_name().unwrap())
                .exists()
        };
        assert!(!metadata_exists(&plan));
        assert!(metadata_exists(&codes));
        assert!(metadata_exists(&diffuse));
    }

    #[test]
    fn selection_falls_back_before_any_corrupt_blob_reaches_the_engine() {
        let temporary = tempfile::tempdir().unwrap();
        let job = temporary.path().join("job");
        let directory = job.join("checkpoints");
        let digests = vec!["a".repeat(64)];
        let expectation = expectation(&digests);
        write(
            &directory,
            &expectation,
            1,
            Stage::Plan,
            CheckpointOutcome::Done,
            engine(),
            b"valid-plan-output",
        )
        .unwrap();
        let newest = write(
            &directory,
            &expectation,
            1,
            Stage::Codes,
            CheckpointOutcome::Done,
            engine(),
            b"codes-output",
        )
        .unwrap();
        let metadata_path = directory.join(Path::new(&newest.metadata_path).file_name().unwrap());
        let metadata = read_metadata(&metadata_path).unwrap();
        fs::write(directory.join(metadata.blob), b"corrupt").unwrap();

        let selected = select(&job, &expectation, Some(&engine())).unwrap();
        let source = selected.source.unwrap();
        assert_eq!(source.stage, Stage::Codes);
        assert_eq!(source.input, b"valid-plan-output");
        assert_eq!(selected.rejected.len(), 1);
    }

    #[test]
    fn terminal_gc_removes_only_the_checkpoint_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let job = temporary.path().join("job");
        let directory = job.join("checkpoints");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("old.bin"), b"checkpoint").unwrap();
        fs::write(job.join("request.json"), b"request").unwrap();
        fs::write(job.join("master.wav"), b"audio").unwrap();

        assert!(prune_terminal(&directory, Duration::ZERO).unwrap());
        assert!(!directory.exists());
        assert!(job.join("request.json").exists());
        assert!(job.join("master.wav").exists());
    }

    #[test]
    fn startup_cleanup_removes_temps_and_orphan_blobs_but_keeps_valid_state() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("checkpoints");
        let digests = vec!["a".repeat(64)];
        let expectation = expectation(&digests);
        let valid = write(
            &directory,
            &expectation,
            1,
            Stage::Plan,
            CheckpointOutcome::Done,
            engine(),
            b"valid",
        )
        .unwrap();
        fs::write(directory.join("orphan.bin"), b"orphan").unwrap();
        fs::write(directory.join(".checkpoint-blob.crash"), b"temp").unwrap();

        clear_temps(&directory).unwrap();

        assert!(!directory.join("orphan.bin").exists());
        assert!(!directory.join(".checkpoint-blob.crash").exists());
        let valid_path = directory.join(Path::new(&valid.metadata_path).file_name().unwrap());
        let metadata = read_metadata(&valid_path).unwrap();
        assert!(directory.join(metadata.blob).exists());
    }
}

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use cantor_proto::{GenerationRequest, GenerationStage, JobState, JobView, ProgressUnit};
use serde_json::{Value, json};
use tempfile::tempdir;
use uuid::Uuid;

use super::{Library, Submission, SubmitResult};
use crate::catalog::Component;
use crate::principal::PrincipalId;
use crate::store::InstalledVariant;

const OWNER_DIRECTORY_MODE: u32 = 0o700;
const OWNER_FILE_MODE: u32 = 0o600;

fn principal() -> PrincipalId {
    PrincipalId::from_bytes_for_test([0x31; 32])
}

fn variant() -> InstalledVariant {
    InstalledVariant {
        model: "acestep".into(),
        tag: "1.5-fast".into(),
        licence: String::new(),
        components: vec![Component {
            role: "model".into(),
            blob: format!("sha256:{}", "a".repeat(64)),
            url: "https://example.invalid/model".into(),
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
            extensions: None,
        },
    }
}

fn accept(library: &mut Library, caption: &str) -> (Submission, JobView, PathBuf) {
    let request = submission(caption);
    let job = match library
        .submit(principal(), &[0x42; 32], &request, &variant(), 20, 0)
        .expect("submission")
    {
        SubmitResult::Accepted(job) => job,
        other => panic!("unexpected submission result: {other:?}"),
    };
    let directory = library
        .root()
        .join("jobs")
        .join(principal().to_string())
        .join(&job.id);
    (request, job, directory)
}

fn exact_mode(path: &Path) -> u32 {
    fs::symlink_metadata(path)
        .unwrap_or_else(|error| panic!("failed to inspect {}: {error}", path.display()))
        .permissions()
        .mode()
        & 0o777
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(
        &fs::read(path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display())),
    )
    .unwrap_or_else(|error| panic!("failed to decode {}: {error}", path.display()))
}

fn assert_no_temporary_files(root: &Path) {
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .unwrap_or_else(|error| panic!("failed to list {}: {error}", directory.display()))
        {
            let entry = entry.expect("directory entry");
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).expect("entry metadata");
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            assert!(
                !name.starts_with(".sidecar.") && !name.starts_with(".cursor-key."),
                "temporary durable-write file remained at {}",
                path.display()
            );
        }
    }
}

#[test]
fn open_rejects_symlinked_roots_and_managed_children_without_touching_targets() {
    let temporary = tempdir().expect("sandbox");

    let root_target = temporary.path().join("root-target");
    fs::create_dir(&root_target).expect("root target");
    fs::set_permissions(&root_target, fs::Permissions::from_mode(0o751)).expect("root target mode");
    let root_sentinel = root_target.join("sentinel");
    fs::write(&root_sentinel, b"root target bytes").expect("root sentinel");
    let linked_root = temporary.path().join("linked-library");
    symlink(&root_target, &linked_root).expect("root symlink");

    assert!(Library::open(&linked_root).is_err());
    assert_eq!(
        fs::read(&root_sentinel).expect("root sentinel"),
        b"root target bytes"
    );
    assert_eq!(exact_mode(&root_target), 0o751);
    assert!(
        fs::symlink_metadata(&linked_root)
            .expect("linked root")
            .file_type()
            .is_symlink()
    );

    let library_root = temporary.path().join("library");
    fs::create_dir(&library_root).expect("library root");
    let jobs_target = temporary.path().join("jobs-target");
    fs::create_dir(&jobs_target).expect("jobs target");
    fs::set_permissions(&jobs_target, fs::Permissions::from_mode(0o705)).expect("jobs target mode");
    let jobs_sentinel = jobs_target.join("sentinel");
    fs::write(&jobs_sentinel, b"jobs target bytes").expect("jobs sentinel");
    symlink(&jobs_target, library_root.join("jobs")).expect("jobs symlink");

    assert!(Library::open(&library_root).is_err());
    assert_eq!(
        fs::read(&jobs_sentinel).expect("jobs sentinel"),
        b"jobs target bytes"
    );
    assert_eq!(exact_mode(&jobs_target), 0o705);
    assert!(
        fs::symlink_metadata(library_root.join("jobs"))
            .expect("linked jobs")
            .file_type()
            .is_symlink()
    );
}

#[test]
fn acceptance_preserves_layout_permissions_exact_sidecars_and_temp_cleanup() {
    let temporary = tempdir().expect("sandbox");
    let root = temporary.path().join("library");
    let mut library = Library::open(&root).expect("library");
    let (request, job, job_directory) = accept(&mut library, "Durable contract");

    for directory in [
        root.as_path(),
        &root.join("jobs"),
        &root.join("tmp"),
        &root.join("trash"),
        &root.join("quarantine"),
        job_directory.parent().expect("principal directory"),
        job_directory.as_path(),
        &job_directory.join("checkpoints"),
        &job_directory.join("artifacts"),
    ] {
        assert_eq!(
            exact_mode(directory),
            OWNER_DIRECTORY_MODE,
            "unexpected directory mode for {}",
            directory.display()
        );
    }

    for file in [
        root.join("library.db"),
        root.join("cursor.key"),
        job_directory.join("request.json"),
        job_directory.join("status.json"),
        job_directory.join("manifest.json"),
    ] {
        assert_eq!(
            exact_mode(&file),
            OWNER_FILE_MODE,
            "unexpected file mode for {}",
            file.display()
        );
    }

    assert_eq!(
        read_json(&job_directory.join("request.json")),
        json!({
            "schema": 1,
            "job_id": job.id,
            "principal_id": principal().to_string(),
            "client_request_id": request.client_request_id,
            "accepted_at": job.created_at,
            "model": {
                "selector": "acestep:1.5-fast",
                "engine": "acestep",
                "component_digests": ["a".repeat(64)],
            },
            "generation": {
                "caption": "Durable contract",
                "duration": 60,
                "seed": 7,
            },
        })
    );
    assert_eq!(
        read_json(&job_directory.join("status.json")),
        json!({
            "schema": 1,
            "state": "queued",
            "revision": 1,
            "updated_at": job.updated_at,
        })
    );
    assert_eq!(
        read_json(&job_directory.join("manifest.json")),
        json!({"schema": 1, "job_id": job.id, "artifacts": []})
    );
    assert_no_temporary_files(&root);
}

#[test]
fn master_collision_never_overwrites_or_publishes_the_existing_path() {
    let temporary = tempdir().expect("sandbox");
    let mut library = Library::open(temporary.path().join("library")).expect("library");
    let (_, _, job_directory) = accept(&mut library, "Collision contract");
    let (work, _) = library.claim_next().expect("claim").expect("queued job");
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

    let canonical = work.artifact_directory.join("master.wav");
    let sentinel = b"existing canonical bytes";
    fs::write(&canonical, sentinel).expect("pre-existing canonical master");
    let manifest_before = fs::read(job_directory.join("manifest.json")).expect("manifest");

    let result = library.complete(
        &work,
        &crate::generate::Audio {
            planar: vec![0.0, 0.5, -0.5, 0.0],
            sample_rate: 1_000,
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&canonical).expect("canonical master"), sentinel);
    assert_eq!(
        fs::read(job_directory.join("manifest.json")).expect("manifest"),
        manifest_before
    );
    assert_eq!(
        library
            .get(principal(), &work.id)
            .expect("job query")
            .expect("job")
            .state,
        JobState::Finalizing
    );
    for table in ["artifacts", "songs", "library_changes"] {
        let rows: u32 = library
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("row count");
        assert_eq!(rows, 0, "{table} changed despite the collision");
    }
    assert_eq!(library.library_revision(principal()).expect("revision"), 0);
}

#[test]
fn export_atomically_replaces_the_destination_with_exact_verified_bytes() {
    let temporary = tempdir().expect("sandbox");
    let mut library = Library::open(temporary.path().join("library")).expect("library");
    accept(&mut library, "Export contract");
    let (work, _) = library.claim_next().expect("claim").expect("queued job");
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
                planar: vec![0.0, 0.5, -0.5, 0.0],
                sample_rate: 1_000,
            },
        )
        .expect("completion")
        .expect("current claim");

    let canonical = library
        .verified_master_path(principal(), &work.id)
        .expect("verified master");
    let expected = fs::read(&canonical).expect("canonical bytes");
    let export_directory = temporary.path().join("exports");
    fs::create_dir(&export_directory).expect("export directory");
    let destination = export_directory.join("song.wav");
    fs::write(&destination, b"stale destination bytes").expect("old destination");

    library
        .export_master(principal(), &work.id, &destination)
        .expect("export");

    assert_eq!(fs::read(&destination).expect("exported bytes"), expected);
    assert_eq!(fs::read(&canonical).expect("canonical bytes"), expected);
    assert!(
        fs::read_dir(&export_directory)
            .expect("export directory")
            .all(|entry| !entry
                .expect("export entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".cantor-export."))
    );
}

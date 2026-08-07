//! Durable, owner-scoped job acceptance and queries.
//!
//! SQLite owns identity, uniqueness, ordering, and state. The filesystem owns
//! immutable request/provenance bytes. Acceptance writes sidecars first, then
//! commits the row, and only then may the protocol acknowledge the job.

use std::ffi::CString;
use std::fs::{self, File};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use cantor_proto::{GenerationRequest, JobState, JobView};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::store::InstalledVariant;

const DIRECTORY_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;
const MIGRATION_001: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, binary_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, public_key TEXT UNIQUE,
  created_at TEXT NOT NULL, library_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  client_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  model_selector TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL,
  stage TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(principal_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS jobs_owner_created
  ON jobs(principal_id, created_at DESC, id DESC);
"#;

#[derive(Clone, Debug)]
pub struct Submission {
    pub client_request_id: String,
    pub model: String,
    pub generation: GenerationRequest,
}

#[derive(Debug, PartialEq)]
pub enum SubmitResult {
    Accepted(JobView),
    Conflict,
    QueueFull,
    InsufficientDisk,
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

pub struct Library {
    root: PathBuf,
    connection: Connection,
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
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;",
        )?;
        connection.execute_batch(MIGRATION_001)?;
        connection.execute(
            "INSERT OR IGNORE INTO schema_migrations(version,applied_at,binary_version) VALUES(1,?1,?2)",
            params![now_rfc3339(), env!("CARGO_PKG_VERSION")],
        )?;
        let check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if check != "ok" {
            bail!("library database quick_check failed");
        }
        fs::set_permissions(&database, fs::Permissions::from_mode(FILE_MODE))?;
        let library = Self { root, connection };
        library.reconcile_startup()?;
        Ok(library)
    }

    pub fn submit(
        &mut self,
        principal: &[u8; 32],
        public_key: &[u8; 32],
        submission: &Submission,
        variant: &InstalledVariant,
        max_queued_per_principal: u32,
        minimum_free_bytes: u64,
    ) -> Result<SubmitResult> {
        let principal = hex(principal);
        let public_key = bs58::encode(public_key).into_string();
        let normalized = serde_json::to_string(&submission.generation)?;
        let request_hash =
            hex(&Sha256::digest(format!("{}\0{}", submission.model, normalized)).into());
        if let Some((existing_hash, job)) = self
            .connection
            .query_row(
                "SELECT request_hash,id,revision,state,model_selector,created_at,updated_at,error_code,error_message
                 FROM jobs WHERE principal_id=?1 AND client_request_id=?2",
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

    pub fn list(&self, principal: &[u8; 32], limit: u32) -> Result<Vec<JobView>> {
        let mut statement = self.connection.prepare(
            "SELECT id,revision,state,model_selector,created_at,updated_at,error_code,error_message
             FROM jobs WHERE principal_id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2",
        )?;
        statement
            .query_map(params![hex(principal), limit], |row| job_from_row(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get(&self, principal: &[u8; 32], id: &str) -> Result<Option<JobView>> {
        self.connection
            .query_row(
                "SELECT id,revision,state,model_selector,created_at,updated_at,error_code,error_message
                 FROM jobs WHERE principal_id=?1 AND id=?2",
                params![hex(principal), id],
                |row| job_from_row(row, 0),
            )
            .optional()
            .map_err(Into::into)
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
            if !metadata.is_dir() || !is_lower_hex(&principal, 64) {
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
                let committed: bool = self.connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM jobs WHERE principal_id=?1 AND id=?2)",
                    params![principal, id],
                    |row| row.get(0),
                )?;
                if !committed {
                    if is_known_incomplete_job(&job_path)? {
                        fs::remove_dir_all(&job_path)?;
                    } else {
                        self.quarantine(&job_path)?;
                    }
                }
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

fn job_from_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<JobView> {
    let state: String = row.get(offset + 2)?;
    let state = serde_json::from_value(serde_json::Value::String(state)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            offset + 2,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let error_code: Option<String> = row.get(offset + 6)?;
    let error_message: Option<String> = row.get(offset + 7)?;
    let error = error_code.zip(error_message).and_then(|(code, message)| {
        serde_json::from_value(serde_json::Value::String(code))
            .ok()
            .map(|code| cantor_proto::JobError { code, message })
    });
    Ok(JobView {
        id: row.get(offset)?,
        revision: row.get(offset + 1)?,
        state,
        stage: None,
        progress: None,
        model: row.get(offset + 3)?,
        created_at: row.get(offset + 4)?,
        updated_at: row.get(offset + 5)?,
        error,
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

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
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
            .submit(&[1; 32], &[2; 32], &request, &variant(), 20, 0)
            .unwrap();
        let second = library
            .submit(&[1; 32], &[2; 32], &request, &variant(), 20, 0)
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
    fn conflict_and_owner_isolation_are_enforced() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        let request = submission("one");
        library
            .submit(&[1; 32], &[2; 32], &request, &variant(), 20, 0)
            .unwrap();
        let mut changed = request.clone();
        changed.generation.caption = "different".into();
        assert_eq!(
            library
                .submit(&[1; 32], &[2; 32], &changed, &variant(), 20, 0)
                .unwrap(),
            SubmitResult::Conflict
        );
        assert_eq!(library.list(&[1; 32], 20).unwrap().len(), 1);
        assert!(library.list(&[3; 32], 20).unwrap().is_empty());
        let id = library.list(&[1; 32], 20).unwrap()[0].id.clone();
        assert!(library.get(&[3; 32], &id).unwrap().is_none());
    }

    #[test]
    fn idempotent_retry_succeeds_even_when_queue_is_full() {
        let temporary = tempdir().unwrap();
        let mut library = Library::open(temporary.path()).unwrap();
        let request = submission("one");
        let accepted = library
            .submit(&[1; 32], &[2; 32], &request, &variant(), 1, 0)
            .unwrap();
        assert_eq!(
            library
                .submit(&[1; 32], &[2; 32], &request, &variant(), 1, u64::MAX)
                .unwrap(),
            accepted
        );
        assert_eq!(
            library
                .submit(&[1; 32], &[2; 32], &submission("two"), &variant(), 1, 0)
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
                .submit(&[1; 32], &[2; 32], &request, &variant(), 20, u64::MAX,)
                .unwrap(),
            SubmitResult::InsufficientDisk
        );
        assert!(library.list(&[1; 32], 20).unwrap().is_empty());
        assert_eq!(
            fs::read_dir(library.root().join("jobs")).unwrap().count(),
            0
        );

        let first = library
            .submit(&[1; 32], &[2; 32], &request, &variant(), 20, 0)
            .unwrap();
        let second = library
            .submit(&[3; 32], &[4; 32], &request, &variant(), 20, 0)
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
}

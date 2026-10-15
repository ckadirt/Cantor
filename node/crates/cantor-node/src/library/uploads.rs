//! Files sent from a phone for an audio act: a tune, or a song from its
//! library.
//!
//! An upload is owner-scoped like everything else here. It is received in
//! order, each slice written and synced before the row moves past it, so a
//! resumed upload continues from bytes that are really on disk. Commit checks
//! the hash and that the node can read the file as audio, once, so admission
//! never has to.
//!
//! Retention: an upload a job refers to is pinned in the transaction that
//! admits the job, and kept with its song. One nobody uses expires a day after
//! it was last touched; forgetting the job that used it starts that clock
//! again.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::principal::PrincipalId;

use super::Library;
use super::artifacts::hex;
use super::durable_fs::prepare_real_directory;

/// KNOBS
/// Largest file an upload may be: a long lossless album track.
pub const MAX_UPLOAD_BYTES: u64 = 200 * 1024 * 1024;
/// How long an upload no job uses is kept after it was last touched.
pub const UNUSED_UPLOAD_SECONDS: i64 = 24 * 60 * 60;

const RECEIVING_FILE: &str = "data.part";

#[derive(Clone, Debug, PartialEq)]
pub enum UploadOpen {
    /// Send from `received`. Equal to the size when every byte is already here.
    Ready {
        id: String,
        received: u64,
    },
    TooLarge,
    /// The same bytes are already being received under another media type.
    Conflict,
}

#[derive(Clone, Debug, PartialEq)]
pub enum UploadChunk {
    Ack {
        next: u64,
    },
    /// The node expected `expected`: resend from there.
    WrongOffset {
        expected: u64,
    },
    /// More bytes than were announced.
    TooLong,
    NotFound,
}

#[derive(Clone, Debug, PartialEq)]
pub enum UploadCommit {
    Committed {
        sha256: String,
        bytes: u64,
        seconds: f64,
    },
    Incomplete {
        received: u64,
    },
    /// The bytes do not hash to what was announced. The upload is discarded.
    HashMismatch,
    /// Not audio this node can read, or longer than allowed. Discarded.
    Unreadable(String),
    NotFound,
}

/// A committed upload, ready to be a source.
#[derive(Clone, Debug, PartialEq)]
pub struct CommittedUpload {
    pub path: PathBuf,
    pub seconds: f64,
    pub media_type: String,
}

pub(super) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// The extension a decoder's probe can use as a hint. The bytes decide; this
/// only helps symphonia guess faster and is never trusted for anything else.
fn extension_for(media_type: &str) -> &'static str {
    match media_type.split(';').next().unwrap_or("").trim() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/wave" | "audio/x-wav" | "audio/vnd.wave" => "wav",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" | "audio/aac" | "audio/x-aac" => "m4a",
        "audio/ogg" | "audio/vorbis" | "application/ogg" => "ogg",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        "audio/x-caf" => "caf",
        "audio/webm" | "audio/x-matroska" => "mka",
        _ => "bin",
    }
}

impl Library {
    fn upload_directory(&self, principal: &str, id: &str) -> PathBuf {
        self.root.join("uploads").join(principal).join(id)
    }

    fn committed_file(&self, principal: &str, id: &str, media_type: &str) -> PathBuf {
        self.upload_directory(principal, id)
            .join(format!("source.{}", extension_for(media_type)))
    }

    pub fn open_upload(
        &mut self,
        principal: PrincipalId,
        public_key: &[u8; 32],
        sha256: &str,
        bytes: u64,
        media_type: &str,
    ) -> Result<UploadOpen> {
        if bytes == 0 || bytes > MAX_UPLOAD_BYTES {
            return Ok(UploadOpen::TooLarge);
        }
        let principal = principal.to_string();
        let now = unix_now();
        let existing = self
            .connection
            .query_row(
                "SELECT id,bytes,media_type,received FROM uploads WHERE principal_id=?1 AND sha256=?2",
                params![principal, sha256],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u64>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((id, known_bytes, known_type, received)) = existing {
            if known_bytes != bytes || known_type != media_type {
                return Ok(UploadOpen::Conflict);
            }
            // Touching an unused upload keeps it another day.
            self.connection.execute(
                "UPDATE uploads SET expires_at=?3 WHERE principal_id=?1 AND id=?2 AND expires_at IS NOT NULL",
                params![principal, id, now + UNUSED_UPLOAD_SECONDS],
            )?;
            return Ok(UploadOpen::Ready { id, received });
        }

        let id = Uuid::now_v7().to_string();
        let principal_directory = self.root.join("uploads").join(&principal);
        prepare_real_directory(&principal_directory)?;
        let directory = principal_directory.join(&id);
        prepare_real_directory(&directory)?;
        File::create(directory.join(RECEIVING_FILE))?.sync_all()?;
        let public_key = bs58::encode(public_key).into_string();
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT OR IGNORE INTO principals(id,kind,public_key,created_at) VALUES(?1,'app_key',?2,?3)",
            params![principal, public_key, now_rfc3339()],
        )?;
        transaction.execute(
            "INSERT INTO uploads(id,principal_id,sha256,bytes,media_type,state,received,created_at,expires_at)
             VALUES(?1,?2,?3,?4,?5,'receiving',0,?6,?7)",
            params![id, principal, sha256, bytes, media_type, now, now + UNUSED_UPLOAD_SECONDS],
        )?;
        transaction.commit()?;
        Ok(UploadOpen::Ready { id, received: 0 })
    }

    pub fn write_upload_chunk(
        &mut self,
        principal: PrincipalId,
        id: &str,
        offset: u64,
        data: &[u8],
    ) -> Result<UploadChunk> {
        let principal = principal.to_string();
        let Some((bytes, received, state)) = self
            .connection
            .query_row(
                "SELECT bytes,received,state FROM uploads WHERE principal_id=?1 AND id=?2",
                params![principal, id],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(UploadChunk::NotFound);
        };
        if state != "receiving" {
            // Already committed: every byte is here.
            return Ok(if offset == bytes {
                UploadChunk::Ack { next: bytes }
            } else {
                UploadChunk::WrongOffset { expected: bytes }
            });
        }
        if offset != received {
            return Ok(UploadChunk::WrongOffset { expected: received });
        }
        let next = received + data.len() as u64;
        if next > bytes {
            return Ok(UploadChunk::TooLong);
        }
        let path = self.upload_directory(&principal, id).join(RECEIVING_FILE);
        let mut file = OpenOptions::new()
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        // Anything past `received` is a slice that was written but never
        // acknowledged; it is overwritten, not appended after.
        file.set_len(received)?;
        file.seek(SeekFrom::Start(received))?;
        file.write_all(data)?;
        file.sync_data()?;
        self.connection.execute(
            "UPDATE uploads SET received=?3,expires_at=?4 WHERE principal_id=?1 AND id=?2 AND state='receiving'",
            params![principal, id, next, unix_now() + UNUSED_UPLOAD_SECONDS],
        )?;
        Ok(UploadChunk::Ack { next })
    }

    /// Verify and keep a fully received upload. `measure` reads the file as
    /// audio and returns its length in seconds, or why it cannot.
    pub fn commit_upload(
        &mut self,
        principal: PrincipalId,
        id: &str,
        measure: impl FnOnce(&Path) -> Result<f64>,
    ) -> Result<UploadCommit> {
        let principal_hex = principal.to_string();
        let Some((sha256, bytes, received, media_type, state, seconds)) = self
            .connection
            .query_row(
                "SELECT sha256,bytes,received,media_type,state,seconds FROM uploads
                 WHERE principal_id=?1 AND id=?2",
                params![principal_hex, id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, u64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<f64>>(5)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(UploadCommit::NotFound);
        };
        if state == "committed" {
            return Ok(UploadCommit::Committed {
                sha256,
                bytes,
                seconds: seconds.unwrap_or(0.0),
            });
        }
        if received != bytes {
            return Ok(UploadCommit::Incomplete { received });
        }
        let receiving = self
            .upload_directory(&principal_hex, id)
            .join(RECEIVING_FILE);
        let mut hasher = Sha256::new();
        let mut file = File::open(&receiving)?;
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        if hex(&hasher.finalize().into()) != sha256 {
            self.discard_upload(&principal_hex, id)?;
            return Ok(UploadCommit::HashMismatch);
        }
        let committed = self.committed_file(&principal_hex, id, &media_type);
        fs::rename(&receiving, &committed)?;
        let measured = match measure(&committed) {
            Ok(seconds) => seconds,
            Err(error) => {
                self.discard_upload(&principal_hex, id)?;
                return Ok(UploadCommit::Unreadable(format!("{error:#}")));
            }
        };
        if let Some(directory) = committed.parent() {
            File::open(directory)?.sync_all()?;
        }
        self.connection.execute(
            "UPDATE uploads SET state='committed',seconds=?3 WHERE principal_id=?1 AND id=?2",
            params![principal_hex, id, measured],
        )?;
        Ok(UploadCommit::Committed {
            sha256,
            bytes,
            seconds: measured,
        })
    }

    pub fn committed_upload(
        &self,
        principal: PrincipalId,
        id: &str,
    ) -> Result<Option<CommittedUpload>> {
        let principal_hex = principal.to_string();
        let Some((media_type, seconds)) = self
            .connection
            .query_row(
                "SELECT media_type,seconds FROM uploads
                 WHERE principal_id=?1 AND id=?2 AND state='committed'",
                params![principal_hex, id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<f64>>(1)?)),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let path = self.committed_file(&principal_hex, id, &media_type);
        if !path.is_file() {
            return Ok(None);
        }
        Ok(Some(CommittedUpload {
            path,
            seconds: seconds.unwrap_or(0.0),
            media_type,
        }))
    }

    /// How long an audio prompt's source is, if this principal has it ready:
    /// a song with a published master, or a committed upload.
    pub fn audio_source_seconds(
        &self,
        principal: PrincipalId,
        source: &cantor_proto::AudioSource,
    ) -> Result<Option<f64>> {
        let principal_hex = principal.to_string();
        Ok(match source {
            cantor_proto::AudioSource::Song { song_id } => self
                .connection
                .query_row(
                    "SELECT s.duration_ms FROM songs s
                     JOIN artifacts a ON a.job_id=s.id AND a.kind='master'
                     WHERE s.id=?1 AND s.principal_id=?2",
                    params![song_id, principal_hex],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .map(|ms| ms as f64 / 1000.0),
            cantor_proto::AudioSource::Upload { upload_id } => self
                .connection
                .query_row(
                    "SELECT seconds FROM uploads
                     WHERE id=?1 AND principal_id=?2 AND state='committed'",
                    params![upload_id, principal_hex],
                    |row| row.get::<_, Option<f64>>(0),
                )
                .optional()?
                .flatten(),
        })
    }

    fn discard_upload(&mut self, principal: &str, id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM uploads WHERE principal_id=?1 AND id=?2",
            params![principal, id],
        )?;
        let directory = self.upload_directory(principal, id);
        if directory.exists() {
            fs::remove_dir_all(&directory)
                .with_context(|| format!("failed to remove {}", directory.display()))?;
        }
        Ok(())
    }

    /// Remove uploads no job uses whose time is up. Row first, then bytes: a
    /// crash between leaves a directory with no row, which the next sweep
    /// removes too.
    pub fn sweep_uploads(&mut self) -> Result<usize> {
        let now = unix_now();
        let expired: Vec<(String, String)> = {
            let mut statement = self.connection.prepare(
                "SELECT principal_id,id FROM uploads WHERE expires_at IS NOT NULL AND expires_at < ?1",
            )?;
            statement
                .query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (principal, id) in &expired {
            self.discard_upload(principal, id)?;
        }
        let mut orphans = 0;
        let uploads = self.root.join("uploads");
        if let Ok(principals) = fs::read_dir(&uploads) {
            for principal in principals.flatten() {
                let Ok(entries) = fs::read_dir(principal.path()) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let id = entry.file_name().to_string_lossy().into_owned();
                    let principal_name = principal.file_name().to_string_lossy().into_owned();
                    let known: bool = self.connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM uploads WHERE principal_id=?1 AND id=?2)",
                        params![principal_name, id],
                        |row| row.get(0),
                    )?;
                    if !known {
                        fs::remove_dir_all(entry.path()).ok();
                        orphans += 1;
                    }
                }
            }
        }
        Ok(expired.len() + orphans)
    }
}

/// Pin an upload a job is being admitted with, inside that admission's
/// transaction. False when it is not a committed upload of this principal, in
/// which case the admission must not happen.
pub(super) fn pin_for_job(
    transaction: &rusqlite::Transaction<'_>,
    principal: &str,
    id: &str,
) -> Result<bool> {
    Ok(transaction.execute(
        "UPDATE uploads SET expires_at=NULL WHERE principal_id=?1 AND id=?2 AND state='committed'",
        params![principal, id],
    )? == 1)
}

/// Let an upload expire again once the job that pinned it is forgotten, unless
/// another job still uses it.
pub(super) fn release_for_job(
    transaction: &rusqlite::Transaction<'_>,
    principal: &str,
    id: &str,
) -> Result<()> {
    let still_used: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM jobs WHERE principal_id=?1
           AND json_extract(request_json,'$.audio.source.upload_id')=?2)",
        params![principal, id],
        |row| row.get(0),
    )?;
    if !still_used {
        transaction.execute(
            "UPDATE uploads SET expires_at=?3 WHERE principal_id=?1 AND id=?2",
            params![principal, id, unix_now() + UNUSED_UPLOAD_SECONDS],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use cantor_proto::{AudioAct, AudioPrompt, AudioSource, GenerationRequest};
    use rusqlite::params;
    use tempfile::tempdir;

    use super::{UNUSED_UPLOAD_SECONDS, UploadCommit, UploadOpen, unix_now};
    use crate::catalog::Component;
    use crate::library::{ForgetResult, Library, Submission, SubmitResult};
    use crate::principal::PrincipalId;
    use crate::store::InstalledVariant;

    const KEY: [u8; 32] = [5; 32];

    fn principal() -> PrincipalId {
        PrincipalId::from_client_public_key(&KEY)
    }

    fn variant() -> InstalledVariant {
        InstalledVariant {
            model: "acestep".into(),
            tag: "1.5-fast".into(),
            licence: String::new(),
            components: vec![Component {
                role: "dit".into(),
                blob: format!("sha256:{}", "a".repeat(64)),
                url: "u".into(),
                bytes: 1,
                quant: None,
            }],
            installed_at: String::new(),
            engine: "acestep".into(),
            vram_bytes: 0,
            stages: Vec::new(),
            parameters: Vec::new(),
            lyrics: None,
            capabilities: None,
            audio: None,
        }
    }

    fn with_upload(upload_id: &str) -> Submission {
        Submission {
            client_request_id: uuid::Uuid::new_v4().to_string(),
            model: "acestep:1.5-fast".into(),
            generation: GenerationRequest {
                caption: "a version".into(),
                lyrics: None,
                duration: None,
                steps: None,
                cfg: None,
                seed: None,
                extensions: None,
                audio: Some(Box::new(AudioPrompt {
                    source: AudioSource::Upload {
                        upload_id: upload_id.into(),
                    },
                    act: AudioAct::Cover,
                    closeness: Some(0.5),
                    keep_voice: None,
                    extend_seconds: None,
                    extend_at: None,
                    tile_to_seconds: None,
                    tune: Some(true),
                })),
            },
        }
    }

    /// An upload of `bytes`, sent whole and committed as `seconds` long.
    fn committed(library: &mut Library, bytes: &[u8], seconds: f64) -> String {
        let sha = super::hex(
            &sha2::Digest::finalize(sha2::Digest::chain_update(
                <sha2::Sha256 as sha2::Digest>::new(),
                bytes,
            ))
            .into(),
        );
        let UploadOpen::Ready { id, .. } = library
            .open_upload(principal(), &KEY, &sha, bytes.len() as u64, "audio/wav")
            .expect("open")
        else {
            panic!("expected ready");
        };
        library
            .write_upload_chunk(principal(), &id, 0, bytes)
            .expect("chunk");
        assert!(matches!(
            library
                .commit_upload(principal(), &id, |_| Ok(seconds))
                .expect("commit"),
            UploadCommit::Committed { .. }
        ));
        id
    }

    fn expires_at(library: &Library, id: &str) -> Option<i64> {
        library
            .connection
            .query_row(
                "SELECT expires_at FROM uploads WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .expect("row")
    }

    #[test]
    fn admission_pins_a_committed_upload_and_refuses_one_that_is_not() {
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let id = committed(&mut library, b"one", 3.0);
        assert!(expires_at(&library, &id).is_some(), "unused uploads expire");

        let accepted = library
            .submit(principal(), &KEY, &with_upload(&id), &variant(), 10, 0)
            .expect("submit");
        assert!(matches!(accepted, SubmitResult::Accepted(_)));
        assert_eq!(expires_at(&library, &id), None, "a job's source is kept");

        let UploadOpen::Ready { id: receiving, .. } = library
            .open_upload(principal(), &KEY, &"b".repeat(64), 10, "audio/wav")
            .expect("open")
        else {
            panic!("expected ready");
        };
        let jobs_before =
            std::fs::read_dir(directory.path().join("jobs").join(principal().to_string()))
                .expect("jobs")
                .count();
        let refused = library
            .submit(
                principal(),
                &KEY,
                &with_upload(&receiving),
                &variant(),
                10,
                0,
            )
            .expect("submit");
        assert!(matches!(refused, SubmitResult::SourceUnavailable));
        let jobs_after =
            std::fs::read_dir(directory.path().join("jobs").join(principal().to_string()))
                .expect("jobs")
                .count();
        assert_eq!(
            jobs_before, jobs_after,
            "a refused admission leaves no job directory"
        );

        let stranger = PrincipalId::from_client_public_key(&[6; 32]);
        let theirs = library
            .submit(stranger, &[6; 32], &with_upload(&id), &variant(), 10, 0)
            .expect("submit");
        assert!(
            matches!(theirs, SubmitResult::SourceUnavailable),
            "uploads are owner-scoped"
        );
    }

    #[test]
    fn forgetting_the_job_lets_its_upload_expire_again() {
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let id = committed(&mut library, b"two", 3.0);
        let SubmitResult::Accepted(job) = library
            .submit(principal(), &KEY, &with_upload(&id), &variant(), 10, 0)
            .expect("submit")
        else {
            panic!("accepted");
        };
        library
            .connection
            .execute(
                "UPDATE jobs SET state='failed' WHERE id=?1",
                params![job.id],
            )
            .expect("fail it");
        assert!(matches!(
            library
                .forget_job(principal(), &job.id, None)
                .expect("forget"),
            ForgetResult::Forgotten
        ));
        let expiry = expires_at(&library, &id).expect("expires again");
        assert!(expiry > unix_now() + UNUSED_UPLOAD_SECONDS - 60);
    }

    #[test]
    fn the_sweep_removes_what_expired_and_strays_but_keeps_what_a_job_uses() {
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let kept = committed(&mut library, b"kept", 3.0);
        library
            .submit(principal(), &KEY, &with_upload(&kept), &variant(), 10, 0)
            .expect("submit");
        let stale = committed(&mut library, b"stale", 3.0);
        library
            .connection
            .execute(
                "UPDATE uploads SET expires_at=1 WHERE id=?1",
                params![stale],
            )
            .expect("age it");
        let stray = directory
            .path()
            .join("uploads")
            .join(principal().to_string())
            .join("not-a-row");
        std::fs::create_dir_all(&stray).expect("stray");

        assert_eq!(library.sweep_uploads().expect("sweep"), 2);
        assert!(
            library
                .committed_upload(principal(), &kept)
                .expect("query")
                .is_some()
        );
        assert!(
            library
                .committed_upload(principal(), &stale)
                .expect("query")
                .is_none()
        );
        assert!(!stray.exists());
    }

    #[test]
    fn a_committed_upload_reports_its_length_as_a_source() {
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let id = committed(&mut library, b"three", 12.5);
        let seconds = library
            .audio_source_seconds(principal(), &AudioSource::Upload { upload_id: id })
            .expect("query");
        assert_eq!(seconds, Some(12.5));
        let missing = library
            .audio_source_seconds(
                principal(),
                &AudioSource::Song {
                    song_id: uuid::Uuid::new_v4().to_string(),
                },
            )
            .expect("query");
        assert_eq!(missing, None);
    }
}

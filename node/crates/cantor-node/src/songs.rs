//! Principal-scoped song publication, metadata mutation, and revision sync.

use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cantor_proto::{
    ArtifactView, GenerationRequest, LibraryChange, LibraryChangeKind, MAX_TAG_BYTES, MAX_TAGS,
    MAX_TITLE_BYTES, SongDetail, SongHeader, SongPatch,
};
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use uuid::Uuid;

use crate::config::now_rfc3339;
use crate::library::{ArtifactRecord, Library};

const FILE_MODE: u32 = 0o600;
const CAPTION_SUMMARY_BYTES: usize = 240;

const MIGRATION_003: &str = r#"
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY REFERENCES jobs(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  title TEXT NOT NULL,
  caption_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
  model_selector TEXT NOT NULL,
  seed TEXT,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
  tags_json TEXT NOT NULL DEFAULT '[]',
  metadata_revision INTEGER NOT NULL DEFAULT 1 CHECK(metadata_revision >= 1),
  published_revision INTEGER NOT NULL CHECK(published_revision >= 1),
  changed_revision INTEGER NOT NULL CHECK(changed_revision >= 1),
  trashed_at TEXT
);
CREATE INDEX IF NOT EXISTS songs_owner_order
  ON songs(principal_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS library_changes (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upsert','trash','restore','tombstone')),
  changed_at TEXT NOT NULL,
  PRIMARY KEY(principal_id,revision)
);
"#;

pub struct SongPage {
    pub snapshot_revision: u64,
    pub songs: Vec<SongHeader>,
    pub next_cursor: Option<String>,
}

pub enum SongPageResult {
    Page(SongPage),
    InvalidCursor,
}

pub struct ChangePage {
    pub through_revision: u64,
    pub changes: Vec<LibraryChange>,
    pub has_more: bool,
}

pub enum ChangePageResult {
    Page(ChangePage),
    FullSyncRequired { minimum_revision: u64 },
    InvalidRevision,
}

pub enum MutationResult {
    Updated(SongHeader),
    Conflict(SongHeader),
    NotFound,
    InvalidPatch,
}

#[derive(Clone, Copy)]
pub enum PresenceMutation {
    Trash,
    Restore,
}

#[derive(Deserialize, Serialize)]
struct CursorPayload {
    schema: u8,
    principal: String,
    snapshot_revision: u64,
    last_created_at: String,
    last_id: String,
    include_trashed: bool,
}

pub fn migrate(connection: &Connection) -> Result<()> {
    connection.execute_batch(MIGRATION_003)?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at,binary_version)
         VALUES(3,?1,?2)",
        params![now_rfc3339(), env!("CARGO_PKG_VERSION")],
    )?;
    Ok(())
}

pub fn load_or_create_cursor_key(root: &Path) -> Result<[u8; 32]> {
    let path = root.join("cursor.key");
    if path.exists() {
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("library cursor key is not a regular file");
        }
        let bytes = fs::read(&path)?;
        return <[u8; 32]>::try_from(bytes.as_slice())
            .map_err(|_| anyhow::anyhow!("library cursor key has an invalid length"));
    }
    let mut key = [0_u8; 32];
    getrandom::fill(&mut key).context("failed to generate library cursor key")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".cursor-key.")
        .tempfile_in(root)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(FILE_MODE))?;
    std::io::Write::write_all(temporary.as_file_mut(), &key)?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path).map_err(|error| error.error)?;
    File::open(root)?.sync_all()?;
    Ok(key)
}

/// Called inside the M2 finalization transaction. The artifact row must already
/// exist; job completion and this publication commit together.
pub fn publish_song(transaction: &Transaction<'_>, id: &str) -> Result<(SongHeader, u64)> {
    if let Some(song) = header_by_id(transaction, None, id)? {
        let revision = library_revision_for_hex(transaction, &song.1)?;
        return Ok((song.0, revision));
    }
    let (principal, request_json, model, created_at): (String, String, String, String) =
        transaction.query_row(
            "SELECT principal_id,request_json,model_selector,created_at FROM jobs WHERE id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    let generation: GenerationRequest =
        serde_json::from_str(&request_json).context("completed job request is not valid JSON")?;
    let artifact = artifact_record(transaction, id)?;
    let revision = allocate_revision(transaction, &principal)?;
    let caption_summary = bounded_text(&generation.caption, CAPTION_SUMMARY_BYTES);
    let title = bounded_text(&generation.caption, MAX_TITLE_BYTES);
    let title = if title.is_empty() {
        "Untitled song".to_owned()
    } else {
        title
    };
    transaction.execute(
        "INSERT INTO songs(id,principal_id,title,caption_summary,created_at,duration_ms,
         model_selector,seed,published_revision,changed_revision)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
        params![
            id,
            principal,
            title,
            caption_summary,
            created_at,
            artifact.duration_ms,
            model,
            generation.seed.map(|seed| seed.to_string()),
            revision,
        ],
    )?;
    append_change(
        transaction,
        &principal,
        revision,
        id,
        LibraryChangeKind::Upsert,
    )?;
    let song = header_by_id(transaction, Some(&principal), id)?
        .context("published song disappeared")?
        .0;
    Ok((song, revision))
}

impl Library {
    pub fn backfill_completed_songs(&mut self) -> Result<()> {
        let mut statement = self.connection.prepare(
            "SELECT j.id FROM jobs j
             JOIN artifacts a ON a.job_id=j.id AND a.kind='master'
             LEFT JOIN songs s ON s.id=j.id
             WHERE j.state='completed' AND s.id IS NULL
             ORDER BY j.updated_at ASC,j.id ASC",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for id in ids {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            publish_song(&transaction, &id)
                .with_context(|| format!("failed to backfill completed song {id}"))?;
            transaction.commit()?;
        }
        Ok(())
    }

    pub fn library_revision(&self, principal: &[u8; 32]) -> Result<u64> {
        library_revision_for_hex(&self.connection, &hex(principal))
    }

    pub fn list_songs(
        &self,
        principal: &[u8; 32],
        limit: u32,
        cursor: Option<&str>,
        include_trashed: bool,
    ) -> Result<SongPageResult> {
        let principal = hex(principal);
        let current_revision = library_revision_for_hex(&self.connection, &principal)?;
        let decoded = match cursor {
            Some(cursor) => match decode_cursor(cursor, &self.cursor_key) {
                Ok(cursor)
                    if cursor.schema == 1
                        && cursor.principal == principal
                        && cursor.include_trashed == include_trashed
                        && cursor.snapshot_revision <= current_revision
                        && Uuid::parse_str(&cursor.last_id).is_ok()
                        && !cursor.last_created_at.is_empty() =>
                {
                    Some(cursor)
                }
                _ => return Ok(SongPageResult::InvalidCursor),
            },
            None => None,
        };
        let snapshot_revision = decoded
            .as_ref()
            .map_or(current_revision, |cursor| cursor.snapshot_revision);
        let boundary_created = decoded
            .as_ref()
            .map(|cursor| cursor.last_created_at.as_str());
        let boundary_id = decoded.as_ref().map(|cursor| cursor.last_id.as_str());
        let mut statement = self.connection.prepare(
            "SELECT s.id FROM songs s
             WHERE s.principal_id=?1 AND s.published_revision<=?2
               AND (?3=1 OR s.trashed_at IS NULL)
               AND (?4 IS NULL OR s.created_at<?4 OR (s.created_at=?4 AND s.id<?5))
             ORDER BY s.created_at DESC,s.id DESC LIMIT ?6",
        )?;
        let ids = statement
            .query_map(
                params![
                    principal,
                    snapshot_revision,
                    include_trashed,
                    boundary_created,
                    boundary_id,
                    limit + 1
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = ids.len() > limit as usize;
        let mut songs = Vec::with_capacity(ids.len().min(limit as usize));
        for id in ids.into_iter().take(limit as usize) {
            songs.push(
                header_by_id(&self.connection, Some(&principal), &id)?
                    .context("listed song disappeared")?
                    .0,
            );
        }
        let next_cursor = if has_more {
            let last = songs.last().context("cursor page has no last song")?;
            Some(encode_cursor(
                &CursorPayload {
                    schema: 1,
                    principal,
                    snapshot_revision,
                    last_created_at: last.created_at.clone(),
                    last_id: last.id.clone(),
                    include_trashed,
                },
                &self.cursor_key,
            )?)
        } else {
            None
        };
        Ok(SongPageResult::Page(SongPage {
            snapshot_revision,
            songs,
            next_cursor,
        }))
    }

    pub fn sync_songs(
        &self,
        principal: &[u8; 32],
        since_revision: u64,
        limit: u32,
    ) -> Result<ChangePageResult> {
        let principal = hex(principal);
        let current = library_revision_for_hex(&self.connection, &principal)?;
        if since_revision > current {
            return Ok(ChangePageResult::InvalidRevision);
        }
        let minimum: Option<u64> = self.connection.query_row(
            "SELECT min(revision) FROM library_changes WHERE principal_id=?1",
            params![principal],
            |row| row.get(0),
        )?;
        if let Some(minimum) = minimum
            && since_revision.saturating_add(1) < minimum
        {
            return Ok(ChangePageResult::FullSyncRequired {
                minimum_revision: minimum.saturating_sub(1),
            });
        }
        let mut statement = self.connection.prepare(
            "SELECT revision,entity_id,kind,changed_at FROM library_changes
             WHERE principal_id=?1 AND revision>?2 ORDER BY revision ASC LIMIT ?3",
        )?;
        let rows = statement
            .query_map(params![principal, since_revision, limit + 1], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = rows.len() > limit as usize;
        let mut changes = Vec::with_capacity(rows.len().min(limit as usize));
        for (revision, song_id, kind, changed_at) in rows.into_iter().take(limit as usize) {
            let kind = change_kind(&kind)?;
            let song = if kind == LibraryChangeKind::Tombstone {
                None
            } else {
                header_by_id(&self.connection, Some(&principal), &song_id)?.map(|value| value.0)
            };
            changes.push(LibraryChange {
                revision,
                song_id,
                kind,
                changed_at,
                song,
            });
        }
        let through_revision = changes.last().map_or(current, |change| change.revision);
        Ok(ChangePageResult::Page(ChangePage {
            through_revision,
            changes,
            has_more,
        }))
    }

    pub fn song_detail(&self, principal: &[u8; 32], id: &str) -> Result<Option<SongDetail>> {
        let principal = hex(principal);
        let Some((song, _)) = header_by_id(&self.connection, Some(&principal), id)? else {
            return Ok(None);
        };
        let (request_json, attempt): (String, u32) = self.connection.query_row(
            "SELECT request_json,attempt FROM jobs WHERE principal_id=?1 AND id=?2",
            params![principal, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let generation = serde_json::from_str(&request_json)?;
        let sidecar: serde_json::Value = serde_json::from_reader(File::open(
            self.root
                .join("jobs")
                .join(&principal)
                .join(id)
                .join("request.json"),
        )?)?;
        let engine = sidecar
            .pointer("/model/engine")
            .and_then(serde_json::Value::as_str)
            .context("request provenance has no engine")?
            .to_owned();
        let component_digests = sidecar
            .pointer("/model/component_digests")
            .and_then(serde_json::Value::as_array)
            .context("request provenance has no component digests")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .context("request component digest is not text")
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(SongDetail {
            song,
            generation,
            engine,
            component_digests,
            attempts: attempt,
        }))
    }

    pub fn patch_song(
        &mut self,
        principal: &[u8; 32],
        id: &str,
        expected_revision: u32,
        patch: &SongPatch,
    ) -> Result<MutationResult> {
        if !valid_patch(patch) {
            return Ok(MutationResult::InvalidPatch);
        }
        let principal = hex(principal);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((current, _)) = header_by_id(&transaction, Some(&principal), id)? else {
            transaction.rollback()?;
            return Ok(MutationResult::NotFound);
        };
        if current.revision != expected_revision {
            transaction.rollback()?;
            return Ok(MutationResult::Conflict(current));
        }
        let title = patch
            .title
            .as_ref()
            .map(|value| value.trim())
            .unwrap_or(&current.title);
        let favorite = patch.favorite.unwrap_or(current.favorite);
        let tags = patch.tags.as_ref().unwrap_or(&current.tags);
        if title == current.title && favorite == current.favorite && tags == &current.tags {
            transaction.rollback()?;
            return Ok(MutationResult::Updated(current));
        }
        let revision = allocate_revision(&transaction, &principal)?;
        transaction.execute(
            "UPDATE songs SET title=?3,favorite=?4,tags_json=?5,
             metadata_revision=metadata_revision+1,changed_revision=?6
             WHERE principal_id=?1 AND id=?2 AND metadata_revision=?7",
            params![
                principal,
                id,
                title,
                favorite,
                serde_json::to_string(tags)?,
                revision,
                expected_revision,
            ],
        )?;
        append_change(
            &transaction,
            &principal,
            revision,
            id,
            LibraryChangeKind::Upsert,
        )?;
        let song = header_by_id(&transaction, Some(&principal), id)?
            .context("patched song disappeared")?
            .0;
        transaction.commit()?;
        Ok(MutationResult::Updated(song))
    }

    pub fn change_song_presence(
        &mut self,
        principal: &[u8; 32],
        id: &str,
        expected_revision: u32,
        mutation: PresenceMutation,
    ) -> Result<MutationResult> {
        let principal = hex(principal);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((current, _)) = header_by_id(&transaction, Some(&principal), id)? else {
            transaction.rollback()?;
            return Ok(MutationResult::NotFound);
        };
        if current.revision != expected_revision {
            transaction.rollback()?;
            return Ok(MutationResult::Conflict(current));
        }
        let should_be_trashed = matches!(mutation, PresenceMutation::Trash);
        if current.trashed == should_be_trashed {
            transaction.rollback()?;
            return Ok(MutationResult::Updated(current));
        }
        let revision = allocate_revision(&transaction, &principal)?;
        let changed_at = now_rfc3339();
        transaction.execute(
            "UPDATE songs SET trashed_at=?3,metadata_revision=metadata_revision+1,
             changed_revision=?4 WHERE principal_id=?1 AND id=?2 AND metadata_revision=?5",
            params![
                principal,
                id,
                should_be_trashed.then_some(changed_at),
                revision,
                expected_revision,
            ],
        )?;
        append_change(
            &transaction,
            &principal,
            revision,
            id,
            if should_be_trashed {
                LibraryChangeKind::Trash
            } else {
                LibraryChangeKind::Restore
            },
        )?;
        let song = header_by_id(&transaction, Some(&principal), id)?
            .context("updated song disappeared")?
            .0;
        transaction.commit()?;
        Ok(MutationResult::Updated(song))
    }

    pub fn fail_corrupt_completed_song(&mut self, id: &str) -> Result<Option<u64>> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let principal: Option<String> = transaction
            .query_row(
                "SELECT principal_id FROM songs WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        transaction.execute(
            "UPDATE jobs SET state='failed',error_code='internal',
             error_message='The completed audio artifact is missing or corrupt.',
             revision=revision+1,updated_at=?2 WHERE id=?1 AND state='completed'",
            params![id, now_rfc3339()],
        )?;
        let revision = if let Some(principal) = principal {
            let revision = allocate_revision(&transaction, &principal)?;
            transaction.execute("DELETE FROM songs WHERE id=?1", params![id])?;
            append_change(
                &transaction,
                &principal,
                revision,
                id,
                LibraryChangeKind::Tombstone,
            )?;
            Some(revision)
        } else {
            None
        };
        transaction.commit()?;
        Ok(revision)
    }
}

fn valid_patch(patch: &SongPatch) -> bool {
    if patch.title.is_none() && patch.favorite.is_none() && patch.tags.is_none() {
        return false;
    }
    if patch.title.as_ref().is_some_and(|title| {
        title.trim().is_empty()
            || title.len() > MAX_TITLE_BYTES
            || title.chars().any(char::is_control)
    }) {
        return false;
    }
    patch.tags.as_ref().is_none_or(|tags| {
        tags.len() <= MAX_TAGS
            && tags.iter().all(|tag| {
                !tag.trim().is_empty()
                    && tag.len() <= MAX_TAG_BYTES
                    && !tag.chars().any(char::is_control)
            })
    })
}

fn bounded_text(value: &str, maximum_bytes: usize) -> String {
    let value = value.trim();
    let mut result = String::new();
    for character in value.chars() {
        if character.is_control() {
            continue;
        }
        if result.len() + character.len_utf8() > maximum_bytes {
            break;
        }
        result.push(character);
    }
    result.trim_end().to_owned()
}

fn allocate_revision(transaction: &Transaction<'_>, principal: &str) -> Result<u64> {
    let changed = transaction.execute(
        "UPDATE principals SET library_revision=library_revision+1 WHERE id=?1",
        params![principal],
    )?;
    if changed != 1 {
        bail!("song owner principal does not exist");
    }
    library_revision_for_hex(transaction, principal)
}

fn library_revision_for_hex(connection: &Connection, principal: &str) -> Result<u64> {
    Ok(connection
        .query_row(
            "SELECT library_revision FROM principals WHERE id=?1",
            params![principal],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

fn append_change(
    transaction: &Transaction<'_>,
    principal: &str,
    revision: u64,
    id: &str,
    kind: LibraryChangeKind,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO library_changes(principal_id,revision,entity_id,kind,changed_at)
         VALUES(?1,?2,?3,?4,?5)",
        params![
            principal,
            revision,
            id,
            change_kind_text(kind),
            now_rfc3339()
        ],
    )?;
    Ok(())
}

fn header_by_id(
    connection: &Connection,
    principal: Option<&str>,
    id: &str,
) -> Result<Option<(SongHeader, String)>> {
    connection
        .query_row(
            "SELECT s.id,s.metadata_revision,s.title,s.caption_summary,s.created_at,
             s.duration_ms,s.model_selector,s.seed,s.favorite,s.tags_json,
             s.trashed_at,s.principal_id,
             a.kind,a.media_type,a.byte_length,a.sha256,a.sample_rate,a.channels
             FROM songs s JOIN artifacts a ON a.job_id=s.id AND a.kind='master'
             WHERE s.id=?1 AND (?2 IS NULL OR s.principal_id=?2)",
            params![id, principal],
            |row| {
                let seed = row
                    .get::<_, Option<String>>(7)?
                    .map(|seed| {
                        seed.parse::<u64>().map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                7,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .transpose()?;
                let tags = serde_json::from_str::<Vec<String>>(&row.get::<_, String>(9)?).map_err(
                    |error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            9,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    },
                )?;
                Ok((
                    SongHeader {
                        id: row.get(0)?,
                        revision: row.get(1)?,
                        title: row.get(2)?,
                        caption_summary: row.get(3)?,
                        created_at: row.get(4)?,
                        duration_ms: row.get(5)?,
                        model: row.get(6)?,
                        seed,
                        favorite: row.get(8)?,
                        tags,
                        trashed: row.get::<_, Option<String>>(10)?.is_some(),
                        artifacts: vec![ArtifactView {
                            kind: row.get(12)?,
                            media_type: row.get(13)?,
                            byte_length: row.get(14)?,
                            sha256: row.get(15)?,
                            sample_rate: row.get(16)?,
                            channels: row.get(17)?,
                        }],
                    },
                    row.get(11)?,
                ))
            },
        )
        .optional()
        .map_err(Into::into)
}

fn artifact_record(connection: &Connection, id: &str) -> Result<ArtifactRecord> {
    connection
        .query_row(
            "SELECT kind,relative_path,media_type,byte_length,sha256,sample_rate,
             channels,duration_ms,created_at FROM artifacts WHERE job_id=?1 AND kind='master'",
            params![id],
            |row| {
                Ok(ArtifactRecord {
                    kind: row.get(0)?,
                    relative_path: row.get(1)?,
                    media_type: row.get(2)?,
                    byte_length: row.get(3)?,
                    sha256: row.get(4)?,
                    sample_rate: row.get(5)?,
                    channels: row.get(6)?,
                    duration_ms: row.get(7)?,
                    created_at: row.get(8)?,
                })
            },
        )
        .map_err(Into::into)
}

fn encode_cursor(payload: &CursorPayload, key: &[u8; 32]) -> Result<String> {
    let payload = serde_json::to_vec(payload)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts a 32-byte key");
    mac.update(&payload);
    let signature = mac.finalize().into_bytes();
    Ok(format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

fn decode_cursor(cursor: &str, key: &[u8; 32]) -> Result<CursorPayload> {
    let (payload, signature) = cursor.split_once('.').context("cursor has no signature")?;
    let payload = URL_SAFE_NO_PAD.decode(payload)?;
    let signature = URL_SAFE_NO_PAD.decode(signature)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts a 32-byte key");
    mac.update(&payload);
    mac.verify_slice(&signature)
        .map_err(|_| anyhow::anyhow!("cursor signature is invalid"))?;
    serde_json::from_slice(&payload).map_err(Into::into)
}

fn change_kind_text(kind: LibraryChangeKind) -> &'static str {
    match kind {
        LibraryChangeKind::Upsert => "upsert",
        LibraryChangeKind::Trash => "trash",
        LibraryChangeKind::Restore => "restore",
        LibraryChangeKind::Tombstone => "tombstone",
    }
}

fn change_kind(value: &str) -> Result<LibraryChangeKind> {
    match value {
        "upsert" => Ok(LibraryChangeKind::Upsert),
        "trash" => Ok(LibraryChangeKind::Trash),
        "restore" => Ok(LibraryChangeKind::Restore),
        "tombstone" => Ok(LibraryChangeKind::Tombstone),
        _ => bail!("library change kind is invalid"),
    }
}

fn hex<const N: usize>(bytes: &[u8; N]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{bounded_text, valid_patch};
    use cantor_proto::SongPatch;

    #[test]
    fn title_and_tag_validation_preserves_bounded_unicode() {
        assert_eq!(bounded_text("  música nocturna  ", 160), "música nocturna");
        assert!(!valid_patch(&SongPatch::default()));
        assert!(valid_patch(&SongPatch {
            title: Some("Música nocturna".into()),
            favorite: Some(true),
            tags: Some(vec!["guitarra".into()]),
        }));
        assert!(!valid_patch(&SongPatch {
            title: Some("bad\nname".into()),
            favorite: None,
            tags: None,
        }));
    }
}

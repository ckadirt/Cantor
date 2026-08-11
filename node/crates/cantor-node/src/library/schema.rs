//! SQLite schema ownership and ordered migrations for the library.

use anyhow::{Result, bail};
use rusqlite::{Connection, params};

use crate::config::now_rfc3339;

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

const MIGRATION_002: &str = r#"
CREATE TABLE IF NOT EXISTS artifacts (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  sha256 TEXT NOT NULL,
  sample_rate INTEGER NOT NULL CHECK(sample_rate > 0),
  channels INTEGER NOT NULL CHECK(channels > 0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, kind)
);
CREATE INDEX IF NOT EXISTS jobs_scheduler
  ON jobs(state, priority DESC, created_at ASC, id ASC);
"#;

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

pub(super) fn migrate(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;",
    )?;
    connection.execute_batch(MIGRATION_001)?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at,binary_version) VALUES(1,?1,?2)",
        params![now_rfc3339(), env!("CARGO_PKG_VERSION")],
    )?;
    add_column_if_missing(connection, "jobs", "priority", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(connection, "jobs", "progress_completed", "INTEGER")?;
    add_column_if_missing(connection, "jobs", "progress_total", "INTEGER")?;
    add_column_if_missing(connection, "jobs", "progress_unit", "TEXT")?;
    connection.execute_batch(MIGRATION_002)?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at,binary_version) VALUES(2,?1,?2)",
        params![now_rfc3339(), env!("CARGO_PKG_VERSION")],
    )?;
    connection.execute_batch(MIGRATION_003)?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at,binary_version)
         VALUES(3,?1,?2)",
        params![now_rfc3339(), env!("CARGO_PKG_VERSION")],
    )?;
    add_column_if_missing(connection, "jobs", "active_checkpoint", "TEXT")?;
    add_column_if_missing(connection, "jobs", "checkpoint_outcome", "TEXT")?;
    add_column_if_missing(connection, "jobs", "control_requested_at", "TEXT")?;
    add_column_if_missing(connection, "jobs", "stop_reason", "TEXT")?;
    add_column_if_missing(
        connection,
        "jobs",
        "error_retryable",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        connection,
        "jobs",
        "consecutive_failures",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at,binary_version) VALUES(4,?1,?2)",
        params![now_rfc3339(), env!("CARGO_PKG_VERSION")],
    )?;
    add_column_if_missing(
        connection,
        "artifacts",
        "profile",
        "TEXT NOT NULL DEFAULT 'pcm16-wav-v1'",
    )?;
    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at,binary_version) VALUES(5,?1,?2)",
        params![now_rfc3339(), env!("CARGO_PKG_VERSION")],
    )?;
    let check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if check != "ok" {
        bail!("library database quick_check failed");
    }
    Ok(())
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|existing| existing == column) {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
        ))?;
    }
    Ok(())
}

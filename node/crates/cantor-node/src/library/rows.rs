//! Stable SQLite row and protocol-enum codecs used by library queries.

use anyhow::{Result, bail};
use cantor_proto::{ErrorCode, JobError, JobProgress, JobView};
use serde::{Deserialize, Serialize};

pub(super) const JOB_VIEW_COLUMNS: &str = "id,revision,state,stage,progress_completed,progress_total,progress_unit,\
     model_selector,created_at,updated_at,error_code,error_message,error_retryable,request_json";

/// Just the caption out of a stored request.
///
/// The immutable request holds lyrics too, and a job list must not carry tens
/// of kilobytes per row to answer "which one was this?".
#[derive(Deserialize)]
struct SubmittedCaption {
    caption: String,
}

pub(super) fn job_from_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<JobView> {
    let state: String = row.get(offset + 2)?;
    let state = enum_from_sql(&state, offset + 2)?;
    let stage: Option<String> = row.get(offset + 3)?;
    let stage = stage
        .as_deref()
        .map(|value| enum_from_sql(value, offset + 3))
        .transpose()?;
    let completed: Option<u32> = row.get(offset + 4)?;
    let total: Option<u32> = row.get(offset + 5)?;
    let unit: Option<String> = row.get(offset + 6)?;
    let progress = completed
        .zip(unit)
        .map(|(completed, unit)| {
            Ok::<JobProgress, rusqlite::Error>(JobProgress {
                completed,
                total,
                unit: enum_from_sql(&unit, offset + 6)?,
            })
        })
        .transpose()?;
    let request_json: String = row.get(offset + 13)?;
    // A request that no longer parses is a corrupt row, not a missing caption;
    // every other column is still worth returning, so the job stays listable.
    let caption = serde_json::from_str::<SubmittedCaption>(&request_json)
        .ok()
        .map(|request| request.caption);
    let error_code: Option<String> = row.get(offset + 10)?;
    let error_message: Option<String> = row.get(offset + 11)?;
    let error_retryable: bool = row.get(offset + 12)?;
    let error = error_code.zip(error_message).and_then(|(code, message)| {
        serde_json::from_value::<ErrorCode>(serde_json::Value::String(code))
            .ok()
            .map(|code| JobError {
                code,
                message,
                retryable: error_retryable,
            })
    });
    Ok(JobView {
        id: row.get(offset)?,
        revision: row.get(offset + 1)?,
        state,
        stage,
        progress,
        model: row.get(offset + 7)?,
        caption,
        created_at: row.get(offset + 8)?,
        updated_at: row.get(offset + 9)?,
        error,
    })
}

pub(super) fn enum_text(value: impl Serialize) -> Result<String> {
    match serde_json::to_value(value)? {
        serde_json::Value::String(value) => Ok(value),
        _ => bail!("protocol enum did not serialize as text"),
    }
}

fn enum_from_sql<T: serde::de::DeserializeOwned>(
    value: &str,
    column: usize,
) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

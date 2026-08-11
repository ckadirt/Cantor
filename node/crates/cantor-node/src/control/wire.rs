//! Local control protocol envelopes and newline-delimited JSON framing.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncWrite, AsyncWriteExt};

use crate::config::Pairing;
use crate::store::InstalledVariant;

pub const CONTROL_VERSION: u8 = 1;
pub(super) const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub(super) enum Request {
    #[serde(rename = "status")]
    Status { v: u8, id: String },
    #[serde(rename = "pair")]
    Pair {
        v: u8,
        id: String,
        #[serde(default)]
        expires_in: Option<u64>,
    },
    #[serde(rename = "pairings")]
    Pairings { v: u8, id: String },
    #[serde(rename = "revoke")]
    Revoke { v: u8, id: String, selector: String },
    #[serde(rename = "rename")]
    Rename {
        v: u8,
        id: String,
        selector: String,
        petname: String,
    },
    #[serde(rename = "rename-node")]
    RenameNode { v: u8, id: String, name: String },
    #[serde(rename = "list")]
    List { v: u8, id: String },
    #[serde(rename = "rm")]
    Remove { v: u8, id: String, selector: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "t")]
pub enum Response {
    #[serde(rename = "status")]
    Status {
        v: u8,
        id: String,
        name: String,
        pubkey: String,
        relay_url: String,
        connected: bool,
        pairings: usize,
        pair_expires_in: Option<u64>,
    },
    #[serde(rename = "pair")]
    Pair {
        v: u8,
        id: String,
        uri: String,
        expires_in: u64,
    },
    #[serde(rename = "pairings")]
    Pairings {
        v: u8,
        id: String,
        pairings: Vec<Pairing>,
    },
    #[serde(rename = "ok")]
    Ok { v: u8, id: String },
    #[serde(rename = "list")]
    List {
        v: u8,
        id: String,
        installed: Vec<InstalledVariant>,
        available_bytes: u64,
    },
    #[serde(rename = "removed")]
    Removed {
        v: u8,
        id: String,
        reclaimed_bytes: u64,
    },
    #[serde(rename = "error")]
    Error {
        v: u8,
        id: String,
        code: String,
        msg: String,
    },
}

impl Response {
    pub(super) fn error(id: impl Into<String>, code: &str, msg: impl Into<String>) -> Self {
        Self::Error {
            v: CONTROL_VERSION,
            id: id.into(),
            code: code.to_owned(),
            msg: msg.into(),
        }
    }
}

pub(super) fn reject_version(v: u8, id: &str) -> Result<()> {
    if v != CONTROL_VERSION {
        bail!("control protocol version {v} is not supported (id {id})");
    }
    Ok(())
}

pub(super) fn frame_kind(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("t").and_then(Value::as_str).map(str::to_owned))
}

pub(super) async fn write_response_line<W: AsyncWrite + Unpin>(
    writer: &mut W,
    response: &Response,
) -> Result<()> {
    let mut encoded = serde_json::to_string(response).context("failed to encode response")?;
    encoded.push('\n');
    writer.write_all(encoded.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

pub(super) async fn write_value_line<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<()> {
    let mut encoded = serde_json::to_string(value).context("failed to encode a response")?;
    encoded.push('\n');
    writer.write_all(encoded.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

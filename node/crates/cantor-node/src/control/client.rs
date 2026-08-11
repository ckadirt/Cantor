//! Fresh-connection clients for one-shot and streaming local control calls.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

use super::wire::MAX_REQUEST_BYTES;

/// A control request is local and answered from memory; anything slower than
/// this is a stuck daemon, and the CLI should say so rather than hang.
pub const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

/// Client half: one request, one response, used by the CLI subcommands.
pub async fn request(socket_path: &Path, request: &Value) -> Result<Value> {
    let stream = UnixStream::connect(socket_path).await.with_context(|| {
        format!(
            "could not reach the node at {}. Is it running?",
            socket_path.display()
        )
    })?;
    let (reader, mut writer) = stream.into_split();

    let mut encoded = serde_json::to_string(request).context("failed to encode request")?;
    encoded.push('\n');
    writer.write_all(encoded.as_bytes()).await?;
    writer.flush().await?;

    let mut lines = BufReader::new(reader.take(MAX_REQUEST_BYTES)).lines();
    let line = lines
        .next_line()
        .await?
        .context("the node closed the control connection without answering")?;
    let response: Value =
        serde_json::from_str(&line).context("the node sent an invalid response")?;

    if response.get("t").and_then(Value::as_str) == Some("error") {
        let code = response
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("error");
        let msg = response
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("the node reported an error");
        bail!("{msg} [{code}]");
    }
    Ok(response)
}

/// Client half for commands that report as they go. `on_line` sees every frame;
/// the call ends on the terminal `ok` or `error`.
pub async fn request_streaming(
    socket_path: &Path,
    request: &Value,
    mut on_line: impl FnMut(&Value),
) -> Result<Value> {
    let stream = UnixStream::connect(socket_path).await.with_context(|| {
        format!(
            "could not reach the node at {}. Is it running?",
            socket_path.display()
        )
    })?;
    let (reader, mut writer) = stream.into_split();

    let mut encoded = serde_json::to_string(request).context("failed to encode request")?;
    encoded.push('\n');
    writer.write_all(encoded.as_bytes()).await?;
    writer.flush().await?;

    // No overall deadline: a pull legitimately runs for many minutes. The
    // transfer's own timeouts are what bound it.
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let frame: Value =
            serde_json::from_str(&line).context("the node sent an invalid response")?;
        match frame.get("t").and_then(Value::as_str) {
            Some("error") => {
                let code = frame.get("code").and_then(Value::as_str).unwrap_or("error");
                let msg = frame
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("the node reported an error");
                bail!("{msg} [{code}]");
            }
            Some("ok") | Some("catalog") => return Ok(frame),
            _ => on_line(&frame),
        }
    }
    bail!("the node closed the control connection without finishing")
}

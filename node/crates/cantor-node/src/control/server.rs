//! Unix listener and per-connection loop for the local control surface.

use std::sync::Arc;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use super::wire::{MAX_REQUEST_BYTES, frame_kind, write_response_line};
use super::{dispatch, stream_long_request};
use crate::runtime::{NodeEvent, SharedState};

pub async fn serve(listener: UnixListener, state: SharedState, events: mpsc::Sender<NodeEvent>) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                eprintln!("control socket accept failed: {error}");
                continue;
            }
        };
        let state = Arc::clone(&state);
        let events = events.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_connection(stream, state, events).await {
                eprintln!("control connection ended: {error:#}");
            }
        });
    }
}

pub(super) async fn serve_connection(
    stream: UnixStream,
    state: SharedState,
    events: mpsc::Sender<NodeEvent>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader.take(MAX_REQUEST_BYTES)).lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        // A pull runs for minutes and reports as it goes, so it writes many
        // lines rather than one. Everything else is request/response.
        if let Some(kind) = frame_kind(&line)
            && matches!(kind.as_str(), "pull" | "catalog" | "backends" | "generate")
        {
            stream_long_request(&line, &state, &events, &mut writer, &kind).await?;
            continue;
        }
        let response = dispatch(&line, &state, &events);
        write_response_line(&mut writer, &response).await?;
    }
    Ok(())
}

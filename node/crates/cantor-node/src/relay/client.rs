//! Relay connection, claim, signal, and reconnect policy.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use super::carrier::{IncomingFrame, RELAY_VERSION};
use super::connection::{KEEPALIVE_PONG, run as run_connection};
use super::node_info::static_node_info;
use crate::identity::NodeIdentity;
use crate::runtime::{NodeEvent, SharedState};
use crate::signing::relay_claim_message;

const CHALLENGE_BYTES: usize = 32;
const RECONNECT_BASE_MS: u64 = 1_000;
pub(super) const RECONNECT_MAX_MS: u64 = 30_000;
const RECONNECT_JITTER_MS: u64 = 250;
/// Bounds how many frames the node will skip while waiting for an expected
/// control frame, so an unrecognised relay cannot stall the handshake forever.
const MAX_SKIPPED_HANDSHAKE_FRAMES: usize = 8;

#[derive(Serialize)]
struct RelayClaim<'a> {
    v: u8,
    t: &'static str,
    pubkey: &'a str,
    sig: String,
}

pub async fn run_forever(
    state: SharedState,
    identity: &NodeIdentity,
    events: &mut mpsc::Receiver<NodeEvent>,
    event_sender: &mpsc::Sender<NodeEvent>,
) -> Result<()> {
    let mut reconnect_attempt = 0_u32;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .context("failed to listen for SIGTERM")?;

    loop {
        let connection = serve_once(
            &state,
            identity,
            events,
            event_sender,
            &mut reconnect_attempt,
        );
        tokio::select! {
            signal_result = tokio::signal::ctrl_c() => {
                signal_result.context("failed to listen for Ctrl-C")?;
                println!("shutting down");
                crate::jobs::graceful_shutdown(&state).await;
                return Ok(());
            }
            _ = terminate.recv() => {
                println!("shutting down");
                crate::jobs::graceful_shutdown(&state).await;
                return Ok(());
            }
            result = connection => {
                if let Err(error) = result {
                    eprintln!("relay connection ended: {error:#}");
                }
            }
        }

        let delay = reconnect_delay(reconnect_attempt);
        reconnect_attempt = reconnect_attempt.saturating_add(1);
        eprintln!("reconnecting in {:.2}s", delay.as_secs_f64());
        tokio::select! {
            signal_result = tokio::signal::ctrl_c() => {
                signal_result.context("failed to listen for Ctrl-C")?;
                println!("shutting down");
                crate::jobs::graceful_shutdown(&state).await;
                return Ok(());
            }
            _ = terminate.recv() => {
                println!("shutting down");
                crate::jobs::graceful_shutdown(&state).await;
                return Ok(());
            }
            () = tokio::time::sleep(delay) => {}
        }
    }
}

async fn serve_once(
    state: &SharedState,
    identity: &NodeIdentity,
    events: &mut mpsc::Receiver<NodeEvent>,
    event_sender: &mpsc::Sender<NodeEvent>,
    reconnect_attempt: &mut u32,
) -> Result<()> {
    let public_key = identity.public_key_base58();
    let public_key_bytes = identity.public_key_bytes();
    let (room_url, config_path) = {
        let locked = super::lock(state)?;
        (
            locked.config.room_url(&public_key)?,
            locked.config_path.clone(),
        )
    };
    let (mut socket, _) = connect_async(room_url.as_str())
        .await
        .with_context(|| format!("failed to connect to relay at {room_url}"))?;

    let challenge = next_control_frame(&mut socket).await?;
    let nonce = match challenge {
        IncomingFrame::Challenge { v, nonce } if v == RELAY_VERSION => nonce,
        IncomingFrame::Challenge { v, .. } => {
            bail!("relay protocol version {v} is not supported")
        }
        IncomingFrame::Error { v, code, msg } => super::bail_relay_error(v, &code, &msg)?,
        _ => bail!("relay sent an unexpected frame before the room claim"),
    };

    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(&nonce)
        .context("relay challenge nonce is not valid base64url")?;
    let nonce_bytes = <[u8; CHALLENGE_BYTES]>::try_from(nonce_bytes.as_slice()).map_err(|_| {
        anyhow::anyhow!("relay challenge nonce must contain {CHALLENGE_BYTES} bytes")
    })?;

    // Signed over a domain-separated preimage bound to this room, so the
    // signature cannot double as a client authentication proof (or vice versa).
    let claim_message = relay_claim_message(&identity.public_key_bytes(), &nonce_bytes);
    let claim = RelayClaim {
        v: RELAY_VERSION,
        t: "relay.claim",
        pubkey: &public_key,
        sig: URL_SAFE_NO_PAD.encode(identity.sign(&claim_message).to_bytes()),
    };
    send_json(&mut socket, &claim, "relay claim").await?;

    match next_control_frame(&mut socket).await? {
        IncomingFrame::Ok { v } if v == RELAY_VERSION => {}
        IncomingFrame::Ok { v } => bail!("relay protocol version {v} is not supported"),
        IncomingFrame::Error { v, code, msg } => super::bail_relay_error(v, &code, &msg)?,
        _ => bail!("relay sent an unexpected frame after the room claim"),
    }

    let node_info = {
        let mut locked = super::lock(state)?;
        locked.connected = true;
        static_node_info(&locked.config, &locked.library)
    };
    println!("relay.ok — room claimed as {}", node_info.name);
    *reconnect_attempt = 0;
    run_connection(
        socket,
        state,
        events,
        event_sender,
        &config_path,
        &public_key,
        &public_key_bytes,
        node_info,
    )
    .await
}

pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    let multiplier = 1_u64.checked_shl(attempt.min(15)).unwrap_or(u64::MAX);
    let exponential = RECONNECT_BASE_MS
        .saturating_mul(multiplier)
        .min(RECONNECT_MAX_MS);
    let mut jitter_bytes = [0_u8; 2];
    let jitter = if getrandom::fill(&mut jitter_bytes).is_ok() {
        u64::from(u16::from_le_bytes(jitter_bytes)) % (RECONNECT_JITTER_MS + 1)
    } else {
        0
    };
    Duration::from_millis(exponential + jitter)
}

async fn send_json<S, T>(socket: &mut S, value: &T, description: &str) -> Result<()>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    T: Serialize,
{
    let json =
        serde_json::to_string(value).with_context(|| format!("failed to encode {description}"))?;
    socket
        .send(Message::Text(json.into()))
        .await
        .with_context(|| format!("failed to send {description}"))
}

async fn next_control_frame<S>(socket: &mut S) -> Result<IncomingFrame>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut skipped = 0_usize;
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                if text.as_str() == KEEPALIVE_PONG {
                    continue;
                }
                match serde_json::from_str::<IncomingFrame>(text.as_ref()) {
                    // Unrecognised frames are skipped rather than fatal, but only
                    // a bounded number of them, so the handshake cannot hang.
                    Ok(IncomingFrame::Unknown) | Err(_) => {
                        skipped += 1;
                        if skipped > MAX_SKIPPED_HANDSHAKE_FRAMES {
                            bail!("relay sent only unrecognised frames during the room claim");
                        }
                        eprintln!("ignoring unrecognised relay frame during the room claim");
                    }
                    Ok(frame) => return Ok(frame),
                }
            }
            Some(Ok(Message::Ping(_))) => continue,
            Some(Ok(Message::Close(frame))) => {
                bail!("relay closed the room socket before the claim completed: {frame:?}")
            }
            Some(Ok(_)) => bail!("relay sent a non-text frame during the room claim"),
            Some(Err(error)) => return Err(error).context("relay WebSocket failed"),
            None => bail!("relay disconnected before the room claim completed"),
        }
    }
}

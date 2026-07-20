use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cantor_proto::{NodeInfo, NodeLimits, NodeLoad, NodeMessage};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::config::NodeConfig;
use crate::identity::NodeIdentity;
use crate::session::ClientSession;

const RELAY_VERSION: u8 = 1;
const CHALLENGE_BYTES: usize = 32;
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
const RECONNECT_JITTER_MS: u64 = 250;
const MAX_CLIENT_SESSIONS: usize = 1_024;

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
enum IncomingFrame {
    #[serde(rename = "relay.challenge")]
    Challenge { v: u8, nonce: String },
    #[serde(rename = "relay.ok")]
    Ok { v: u8 },
    #[serde(rename = "relay.error")]
    Error { v: u8, code: String, msg: String },
    #[serde(rename = "relay.detached")]
    Detached { v: u8, sid: String },
    #[serde(rename = "tunnel")]
    Tunnel { v: u8, sid: String, payload: Value },
}

#[derive(Serialize)]
struct RelayClaim<'a> {
    v: u8,
    t: &'static str,
    pubkey: &'a str,
    sig: String,
}

#[derive(Serialize)]
struct RelayTunnel<'a> {
    v: u8,
    t: &'static str,
    sid: &'a str,
    payload: &'a NodeMessage,
}

pub async fn run_forever(
    mut config: NodeConfig,
    config_path: &Path,
    identity: &NodeIdentity,
    mut pair_token: Option<String>,
) -> Result<()> {
    let mut reconnect_attempt = 0_u32;

    loop {
        let connection = serve_once(
            &mut config,
            config_path,
            identity,
            &mut pair_token,
            &mut reconnect_attempt,
        );
        tokio::select! {
            signal_result = tokio::signal::ctrl_c() => {
                signal_result.context("failed to listen for Ctrl-C")?;
                println!("shutting down");
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
                return Ok(());
            }
            () = tokio::time::sleep(delay) => {}
        }
    }
}

async fn serve_once(
    config: &mut NodeConfig,
    config_path: &Path,
    identity: &NodeIdentity,
    pair_token: &mut Option<String>,
    reconnect_attempt: &mut u32,
) -> Result<()> {
    let public_key = identity.public_key_base58();
    let room_url = config.room_url(&public_key)?;
    let (mut socket, _) = connect_async(room_url.as_str())
        .await
        .with_context(|| format!("failed to connect to relay at {room_url}"))?;

    let challenge = next_control_frame(&mut socket).await?;
    let nonce = match challenge {
        IncomingFrame::Challenge { v, nonce } if v == RELAY_VERSION => nonce,
        IncomingFrame::Challenge { v, .. } => {
            bail!("relay protocol version {v} is not supported")
        }
        IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
        _ => bail!("relay sent an unexpected frame before the room claim"),
    };

    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(&nonce)
        .context("relay challenge nonce is not valid base64url")?;
    if nonce_bytes.len() != CHALLENGE_BYTES {
        bail!("relay challenge nonce must contain {CHALLENGE_BYTES} bytes");
    }

    let claim = RelayClaim {
        v: RELAY_VERSION,
        t: "relay.claim",
        pubkey: &public_key,
        sig: URL_SAFE_NO_PAD.encode(identity.sign(&nonce_bytes).to_bytes()),
    };
    send_json(&mut socket, &claim, "relay claim").await?;

    match next_control_frame(&mut socket).await? {
        IncomingFrame::Ok { v } if v == RELAY_VERSION => {}
        IncomingFrame::Ok { v } => bail!("relay protocol version {v} is not supported"),
        IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
        _ => bail!("relay sent an unexpected frame after the room claim"),
    }

    println!("relay.ok — room claimed as {}", config.name);
    *reconnect_attempt = 0;
    let node_info = static_node_info(config);
    let mut sessions = HashMap::<String, ClientSession>::new();

    while let Some(message) = socket.next().await {
        match message.context("relay WebSocket failed")? {
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .await
                .context("failed to answer relay ping")?,
            Message::Close(frame) => bail!("relay closed the room socket: {frame:?}"),
            Message::Text(text) => {
                let frame: IncomingFrame =
                    serde_json::from_str(text.as_ref()).context("relay sent an invalid frame")?;
                match frame {
                    IncomingFrame::Tunnel { v, sid, payload } if v == RELAY_VERSION => {
                        let response =
                            if can_open_client_session(&sessions, &sid, MAX_CLIENT_SESSIONS) {
                                sessions.entry(sid.clone()).or_default().handle(
                                    payload,
                                    config,
                                    config_path,
                                    pair_token,
                                    &public_key,
                                    &node_info,
                                )?
                            } else {
                                NodeMessage::error(
                                    request_id(&payload),
                                    "too-many-sessions",
                                    "This node has reached its client session limit.",
                                )
                            };
                        let tunnel = RelayTunnel {
                            v: RELAY_VERSION,
                            t: "tunnel",
                            sid: &sid,
                            payload: &response,
                        };
                        send_json(&mut socket, &tunnel, "tunnel response").await?;
                    }
                    IncomingFrame::Tunnel { v, .. } => {
                        bail!("relay protocol version {v} is not supported")
                    }
                    IncomingFrame::Detached { v, sid } if v == RELAY_VERSION => {
                        sessions.remove(&sid);
                    }
                    IncomingFrame::Detached { v, .. } => {
                        bail!("relay protocol version {v} is not supported")
                    }
                    IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
                    _ => bail!("relay sent an unexpected control frame after relay.ok"),
                }
            }
            _ => {}
        }
    }
    bail!("relay disconnected")
}

fn can_open_client_session(
    sessions: &HashMap<String, ClientSession>,
    sid: &str,
    limit: usize,
) -> bool {
    sessions.contains_key(sid) || sessions.len() < limit
}

fn request_id(payload: &Value) -> String {
    payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn static_node_info(config: &NodeConfig) -> NodeInfo {
    NodeInfo {
        name: config.name.clone(),
        device_type: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        engine_version: "ace-step-1.5-stub".to_owned(),
        models: vec!["ace-step-1.5".to_owned()],
        limits: NodeLimits {
            max_concurrent_jobs: 0,
            max_song_seconds: 0,
        },
        load: NodeLoad {
            active_jobs: 0,
            queued_jobs: 0,
        },
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
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
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(text.as_ref())
                    .context("relay sent an invalid control frame");
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

fn bail_relay_error<T>(v: u8, code: &str, msg: &str) -> Result<T> {
    if v != RELAY_VERSION {
        bail!("relay protocol version {v} is not supported");
    }
    bail!("relay error ({code}): {msg}")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::session::ClientSession;

    use super::{RECONNECT_MAX_MS, can_open_client_session, reconnect_delay};

    #[test]
    fn reconnect_delay_is_exponential_and_capped() {
        assert!(reconnect_delay(0).as_millis() >= 1_000);
        assert!(reconnect_delay(1).as_millis() >= 2_000);
        assert!(reconnect_delay(20).as_millis() <= u128::from(RECONNECT_MAX_MS + 250));
    }

    #[test]
    fn client_session_limit_allows_existing_sessions_only_when_full() {
        let mut sessions = HashMap::<String, ClientSession>::new();
        sessions.insert("existing".to_owned(), ClientSession::default());

        assert!(can_open_client_session(&sessions, "existing", 1));
        assert!(!can_open_client_session(&sessions, "new", 1));
    }
}

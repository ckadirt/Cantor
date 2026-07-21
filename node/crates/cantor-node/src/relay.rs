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
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::config::NodeConfig;
use crate::control::{ControlEvent, SharedState};
use crate::identity::NodeIdentity;
use crate::session::ClientSession;
use crate::signing::relay_claim_message;

const RELAY_VERSION: u8 = 1;
const CHALLENGE_BYTES: usize = 32;
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;
const RECONNECT_JITTER_MS: u64 = 250;
const MAX_CLIENT_SESSIONS: usize = 1_024;

/// Carrier NAT and intermediate proxies drop idle WebSocket connections after
/// roughly a minute. The relay answers this text frame from
/// `setWebSocketAutoResponse` without waking the Durable Object, so keeping the
/// path warm costs nothing on the relay side.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(25);
const KEEPALIVE_PING: &str = "ping";
const KEEPALIVE_PONG: &str = "pong";

/// Outbound frames are queued rather than written inline so one slow socket
/// write cannot stall the read loop (and, with it, every other client session).
const OUTBOUND_QUEUE_DEPTH: usize = 256;

/// Bounds how many frames the node will skip while waiting for an expected
/// control frame, so an unrecognised relay cannot stall the handshake forever.
const MAX_SKIPPED_HANDSHAKE_FRAMES: usize = 8;

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
    /// Frame types added by a newer relay. Ignored rather than fatal so a relay
    /// deployment can introduce frames without bricking existing nodes.
    #[serde(other)]
    Unknown,
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
    state: SharedState,
    identity: &NodeIdentity,
    events: &mut mpsc::UnboundedReceiver<ControlEvent>,
) -> Result<()> {
    let mut reconnect_attempt = 0_u32;

    loop {
        let connection = serve_once(&state, identity, events, &mut reconnect_attempt);
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
    state: &SharedState,
    identity: &NodeIdentity,
    events: &mut mpsc::UnboundedReceiver<ControlEvent>,
    reconnect_attempt: &mut u32,
) -> Result<()> {
    let public_key = identity.public_key_base58();
    let (room_url, config_path) = {
        let locked = lock(state)?;
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
        IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
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
        IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
        _ => bail!("relay sent an unexpected frame after the room claim"),
    }

    let mut node_info = {
        let mut locked = lock(state)?;
        locked.connected = true;
        static_node_info(&locked.config)
    };
    println!("relay.ok — room claimed as {}", node_info.name);
    *reconnect_attempt = 0;
    let mut sessions = HashMap::<String, ClientSession>::new();

    // The write half moves into its own task and is fed by a queue. Anything
    // holding an `outbound` clone can push a frame at any time, which is what
    // unsolicited job-progress updates will need.
    let (mut writer, mut reader) = socket.split();
    let (outbound, mut queued) = mpsc::channel::<Message>(OUTBOUND_QUEUE_DEPTH);
    let mut writes = tokio::spawn(async move {
        while let Some(message) = queued.recv().await {
            writer.send(message).await?;
        }
        writer.close().await
    });

    let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
    keepalive.tick().await; // The first tick completes immediately.

    let outcome = loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if outbound.send(Message::text(KEEPALIVE_PING)).await.is_err() {
                    break Err(anyhow::anyhow!("relay writer stopped"));
                }
            }
            joined = &mut writes => {
                break match joined {
                    Ok(Ok(())) => Err(anyhow::anyhow!("relay writer closed the room socket")),
                    Ok(Err(error)) => Err(error).context("relay WebSocket write failed"),
                    Err(error) => Err(error).context("relay writer task panicked"),
                };
            }
            event = events.recv() => {
                let Some(event) = event else {
                    break Err(anyhow::anyhow!("control surface stopped"));
                };
                match apply_control_event(event, &mut sessions, state, &mut node_info) {
                    Ok(frames) => {
                        for frame in frames {
                            if outbound.send(frame).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(error) => break Err(error),
                }
            }
            message = reader.next() => {
                let Some(message) = message else {
                    break Err(anyhow::anyhow!("relay disconnected"));
                };
                let message = match message.context("relay WebSocket failed") {
                    Ok(message) => message,
                    Err(error) => break Err(error),
                };
                match message {
                    Message::Ping(payload) => {
                        if outbound.send(Message::Pong(payload)).await.is_err() {
                            break Err(anyhow::anyhow!("relay writer stopped"));
                        }
                    }
                    Message::Close(frame) => {
                        break Err(anyhow::anyhow!("relay closed the room socket: {frame:?}"));
                    }
                    Message::Text(text) => {
                        if text.as_str() == KEEPALIVE_PONG {
                            continue;
                        }
                        let Some(response) = handle_relay_text(
                            text.as_ref(),
                            &mut sessions,
                            state,
                            &config_path,
                            &public_key,
                            &node_info,
                        )? else {
                            continue;
                        };
                        if outbound.send(response).await.is_err() {
                            break Err(anyhow::anyhow!("relay writer stopped"));
                        }
                    }
                    _ => {}
                }
            }
        }
    };

    drop(outbound);
    writes.abort();
    if let Ok(mut locked) = state.lock() {
        locked.connected = false;
    }
    outcome
}

fn lock(state: &SharedState) -> Result<std::sync::MutexGuard<'_, crate::control::NodeState>> {
    state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is poisoned"))
}

/// Turns a control command into the frames that have to go out over the relay.
fn apply_control_event(
    event: ControlEvent,
    sessions: &mut HashMap<String, ClientSession>,
    state: &SharedState,
    node_info: &mut NodeInfo,
) -> Result<Vec<Message>> {
    match event {
        ControlEvent::Revoked(key) => {
            let mut frames = Vec::new();
            for (sid, session) in sessions.iter_mut() {
                if session.authenticated_key() != Some(key.as_str()) {
                    continue;
                }
                session.deauthenticate();
                // `rejected` is the one code the app treats as final, so the
                // device stops retrying instead of spinning against a node that
                // has already said no.
                frames.push(tunnel_frame(
                    sid,
                    &NodeMessage::error("", "rejected", "This client key is no longer authorized."),
                )?);
            }
            println!("revoked {key}; dropped {} live session(s)", frames.len());
            Ok(frames)
        }
        ControlEvent::NodeInfoChanged => {
            *node_info = static_node_info(&lock(state)?.config);
            let push = NodeMessage::NodeInfoChanged {
                v: cantor_proto::PROTOCOL_VERSION,
                node: node_info.clone(),
            };
            sessions
                .iter()
                .filter(|(_, session)| session.authenticated_key().is_some())
                .map(|(sid, _)| tunnel_frame(sid, &push))
                .collect()
        }
    }
}

fn tunnel_frame(sid: &str, payload: &NodeMessage) -> Result<Message> {
    let tunnel = RelayTunnel {
        v: RELAY_VERSION,
        t: "tunnel",
        sid,
        payload,
    };
    let json = serde_json::to_string(&tunnel).context("failed to encode tunnel frame")?;
    Ok(Message::text(json))
}

/// Returns the frame to send back, if any. `Ok(None)` means the frame needed no
/// reply — including frames this node does not recognise, which are logged and
/// skipped so a newer relay cannot take the node down.
fn handle_relay_text(
    text: &str,
    sessions: &mut HashMap<String, ClientSession>,
    state: &SharedState,
    config_path: &Path,
    public_key: &str,
    node_info: &NodeInfo,
) -> Result<Option<Message>> {
    let frame: IncomingFrame = match serde_json::from_str(text) {
        Ok(frame) => frame,
        Err(error) => {
            eprintln!("ignoring unparseable relay frame: {error}");
            return Ok(None);
        }
    };

    match frame {
        IncomingFrame::Tunnel { v, sid, payload } if v == RELAY_VERSION => {
            let response = if can_open_client_session(sessions, &sid, MAX_CLIENT_SESSIONS) {
                let mut locked = lock(state)?;
                let locked = &mut *locked;
                sessions.entry(sid.clone()).or_default().handle(
                    payload,
                    &mut locked.config,
                    config_path,
                    &mut locked.pair_offer,
                    public_key,
                    node_info,
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
            let json =
                serde_json::to_string(&tunnel).context("failed to encode tunnel response")?;
            Ok(Some(Message::text(json)))
        }
        IncomingFrame::Detached { v, sid } if v == RELAY_VERSION => {
            sessions.remove(&sid);
            Ok(None)
        }
        // A relay-level error is about this connection, so it still ends it.
        IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
        other => {
            eprintln!("ignoring unexpected relay frame: {other:?}");
            Ok(None)
        }
    }
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

fn bail_relay_error<T>(v: u8, code: &str, msg: &str) -> Result<T> {
    if v != RELAY_VERSION {
        bail!("relay protocol version {v} is not supported");
    }
    bail!("relay error ({code}): {msg}")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::tempdir;

    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::control::{NodeState, SharedState, shared};
    use crate::session::ClientSession;

    use super::{
        ControlEvent, RECONNECT_MAX_MS, apply_control_event, can_open_client_session,
        handle_relay_text, reconnect_delay, static_node_info,
    };

    fn fixture() -> (SharedState, std::path::PathBuf, tempfile::TempDir) {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let config_path = paths.config.clone();
        let state = shared(NodeState {
            config,
            config_path: paths.config,
            node_public_key: "node-key".to_owned(),
            pair_offer: None,
            connected: true,
        });
        (state, config_path, temporary)
    }

    /// Every frame this build does not understand must be skipped rather than
    /// ending the connection, so a newer relay can add frames without knocking
    /// already-installed nodes offline in a reconnect loop.
    #[test]
    fn unrecognised_frames_are_skipped_without_ending_the_connection() {
        let (state, config_path, _guard) = fixture();
        let node_info = static_node_info(&state.lock().expect("state").config);
        let mut sessions = HashMap::new();

        for frame in [
            r#"{"v":1,"t":"relay.somethingNew","detail":"from a newer relay"}"#,
            r#"{"v":2,"t":"tunnel","sid":"s","payload":{}}"#,
            r#"{"v":2,"t":"relay.detached","sid":"s"}"#,
            "not json at all",
            "",
        ] {
            let response = handle_relay_text(
                frame,
                &mut sessions,
                &state,
                &config_path,
                "node-key",
                &node_info,
            )
            .expect("unrecognised frames must not be errors");
            assert!(response.is_none(), "unexpected reply to {frame}");
        }
    }

    /// A relay-level error is about this connection specifically, so unlike an
    /// unknown frame it still ends it.
    #[test]
    fn a_relay_error_still_ends_the_connection() {
        let (state, config_path, _guard) = fixture();
        let node_info = static_node_info(&state.lock().expect("state").config);

        let result = handle_relay_text(
            r#"{"v":1,"t":"relay.error","code":"bad-claim","msg":"nope"}"#,
            &mut HashMap::new(),
            &state,
            &config_path,
            "node-key",
            &node_info,
        );

        assert!(result.is_err());
    }

    /// Revoking someone who is connected right now has to cut them off, not wait
    /// for their next handshake. `rejected` is the code the app treats as final.
    #[test]
    fn revoking_drops_the_live_sessions_that_used_that_key() {
        let (state, _config_path, _guard) = fixture();
        let mut node_info = static_node_info(&state.lock().expect("state").config);
        let mut sessions = HashMap::new();
        sessions.insert(
            "session-a".to_owned(),
            ClientSession::authenticated_for_test("revoked-key"),
        );
        sessions.insert(
            "session-b".to_owned(),
            ClientSession::authenticated_for_test("other-key"),
        );

        let frames = apply_control_event(
            ControlEvent::Revoked("revoked-key".to_owned()),
            &mut sessions,
            &state,
            &mut node_info,
        )
        .expect("revoke");

        assert_eq!(frames.len(), 1);
        let sent = frames[0].to_text().expect("text frame");
        assert!(sent.contains("\"sid\":\"session-a\""));
        assert!(sent.contains("\"code\":\"rejected\""));
        assert_eq!(sessions["session-a"].authenticated_key(), None);
        // The device that was not revoked keeps its session.
        assert_eq!(sessions["session-b"].authenticated_key(), Some("other-key"));
    }

    /// A connected app is told about a rename rather than showing the old name
    /// until it happens to reconnect.
    #[test]
    fn renaming_the_node_pushes_node_info_to_authenticated_sessions_only() {
        let (state, config_path, _guard) = fixture();
        let mut node_info = static_node_info(&state.lock().expect("state").config);
        let mut sessions = HashMap::new();
        sessions.insert(
            "authed".to_owned(),
            ClientSession::authenticated_for_test("key"),
        );
        sessions.insert("anonymous".to_owned(), ClientSession::default());
        state
            .lock()
            .expect("state")
            .config
            .rename_node(&config_path, "studio-node")
            .expect("rename");

        let frames = apply_control_event(
            ControlEvent::NodeInfoChanged,
            &mut sessions,
            &state,
            &mut node_info,
        )
        .expect("push");

        assert_eq!(frames.len(), 1);
        let sent = frames[0].to_text().expect("text frame");
        assert!(sent.contains("\"sid\":\"authed\""));
        assert!(sent.contains("node.info"));
        assert!(sent.contains("studio-node"));
        assert_eq!(node_info.name, "studio-node");
    }

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

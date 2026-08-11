use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cantor_proto::{
    ErrorCode, MAX_CAPTION_BYTES, MAX_LYRICS_BYTES, MAX_PAGE_LIMIT, MAX_SONG_SECONDS,
    MIN_SONG_SECONDS, ModelView, NodeFeatures, NodeInfo, NodeLimits, NodeLoad, NodeMessage,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::application::ApplicationEffect;
use crate::config::NodeConfig;
use crate::identity::NodeIdentity;
use crate::runtime::{NodeEvent, NodeState, SharedState};
use crate::secure::{MAX_SECURE_CIPHERTEXT_BYTES, SECURE_CARRIER_VERSION};
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
struct RelayTunnel<'a, T> {
    v: u8,
    t: &'static str,
    sid: &'a str,
    payload: &'a T,
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
        static_node_info(&locked.config, &locked.library)
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
                        let Some((response, refresh_node_info)) = handle_relay_text(
                            text.as_ref(),
                            &mut sessions,
                            state,
                            &public_key_bytes,
                        )? else {
                            continue;
                        };
                        if outbound.send(response).await.is_err() {
                            break Err(anyhow::anyhow!("relay writer stopped"));
                        }
                        if refresh_node_info {
                            node_info = {
                                let locked = lock(state)?;
                                static_node_info(&locked.config, &locked.library)
                            };
                            let push = NodeMessage::NodeInfoChanged {
                                v: cantor_proto::PROTOCOL_VERSION,
                                node: node_info.clone(),
                            };
                            for (session_id, session) in &mut sessions {
                                if session.authenticated_key().is_some()
                                {
                                    for frame in encrypted_frames(session_id, session, &push)? {
                                        if outbound.send(frame).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Message::Binary(bytes) => {
                        let Some((frames, refresh_node_info)) = handle_relay_binary(
                            bytes.as_ref(),
                            &mut sessions,
                            state,
                            &config_path,
                            &public_key,
                            &node_info,
                            event_sender,
                        )? else {
                            continue;
                        };
                        for frame in frames {
                            if outbound.send(frame).await.is_err() {
                                break;
                            }
                        }
                        if refresh_node_info {
                            node_info = {
                                let locked = lock(state)?;
                                static_node_info(&locked.config, &locked.library)
                            };
                            let push = NodeMessage::NodeInfoChanged {
                                v: cantor_proto::PROTOCOL_VERSION,
                                node: node_info.clone(),
                            };
                            for (session_id, session) in &mut sessions {
                                if session.authenticated_key().is_some() {
                                    for frame in encrypted_frames(session_id, session, &push)? {
                                        if outbound.send(frame).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
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

fn lock(state: &SharedState) -> Result<std::sync::MutexGuard<'_, crate::runtime::NodeState>> {
    state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is poisoned"))
}

/// Turns a control command into the frames that have to go out over the relay.
fn apply_control_event(
    event: NodeEvent,
    sessions: &mut HashMap<String, ClientSession>,
    state: &SharedState,
    node_info: &mut NodeInfo,
) -> Result<Vec<Message>> {
    match event {
        NodeEvent::Revoked(key) => {
            let mut frames = Vec::new();
            let mut dropped = 0_usize;
            for (sid, session) in sessions.iter_mut() {
                if session.authenticated_key() != Some(key.as_str()) {
                    continue;
                }
                // `rejected` is the one code the app treats as final, so the
                // device stops retrying instead of spinning against a node that
                // has already said no.
                frames.extend(encrypted_frames(
                    sid,
                    session,
                    &NodeMessage::error(
                        None,
                        ErrorCode::Rejected,
                        "This client key is no longer authorized.",
                        false,
                    ),
                )?);
                session.deauthenticate();
                session.close_secure();
                dropped += 1;
            }
            println!("revoked {key}; dropped {dropped} live session(s)");
            Ok(frames)
        }
        NodeEvent::NodeInfoChanged => {
            let locked = lock(state)?;
            *node_info = static_node_info(&locked.config, &locked.library);
            let push = NodeMessage::NodeInfoChanged {
                v: cantor_proto::PROTOCOL_VERSION,
                node: node_info.clone(),
            };
            let mut frames = Vec::new();
            for (sid, session) in sessions.iter_mut() {
                if session.authenticated_key().is_some() {
                    frames.extend(encrypted_frames(sid, session, &push)?);
                }
            }
            Ok(frames)
        }
        NodeEvent::JobUpdated { principal_id, job } => {
            let locked = lock(state)?;
            let refreshed = static_node_info(&locked.config, &locked.library);
            drop(locked);
            let load_changed = node_info.load != refreshed.load;
            *node_info = refreshed;
            let private = NodeMessage::JobUpdated {
                v: cantor_proto::PROTOCOL_VERSION,
                job,
            };
            let mut frames = Vec::new();
            for (sid, session) in sessions.iter_mut() {
                let Some(principal) = session
                    .authenticated()
                    .map(|authenticated| authenticated.principal_id)
                else {
                    continue;
                };
                if principal == principal_id {
                    frames.extend(encrypted_frames(sid, session, &private)?);
                }
                if load_changed {
                    frames.extend(encrypted_frames(
                        sid,
                        session,
                        &NodeMessage::NodeInfoChanged {
                            v: cantor_proto::PROTOCOL_VERSION,
                            node: node_info.clone(),
                        },
                    )?);
                }
            }
            Ok(frames)
        }
        NodeEvent::LibraryChanged {
            principal_id,
            revision,
        } => {
            let changed = NodeMessage::LibraryChanged {
                v: cantor_proto::PROTOCOL_VERSION,
                revision,
            };
            let mut frames = Vec::new();
            for (sid, session) in sessions.iter_mut() {
                if session
                    .authenticated()
                    .is_some_and(|context| context.principal_id == principal_id)
                {
                    frames.extend(encrypted_frames(sid, session, &changed)?);
                }
            }
            Ok(frames)
        }
    }
}

fn tunnel_text_frame<T: Serialize>(sid: &str, payload: &T) -> Result<Message> {
    let tunnel = RelayTunnel {
        v: RELAY_VERSION,
        t: "tunnel",
        sid,
        payload,
    };
    let json = serde_json::to_string(&tunnel).context("failed to encode tunnel frame")?;
    Ok(Message::text(json))
}

fn encrypted_frames(
    sid: &str,
    session: &mut ClientSession,
    payload: &NodeMessage,
) -> Result<Vec<Message>> {
    session
        .encrypt_secure(payload)?
        .into_iter()
        .map(|ciphertext| encode_node_secure_carrier(sid, &ciphertext))
        .collect()
}

fn encode_node_secure_carrier(sid: &str, ciphertext: &[u8]) -> Result<Message> {
    ensure_secure_sid(sid)?;
    let sid = sid.as_bytes();
    if ciphertext.is_empty() || ciphertext.len() > MAX_SECURE_CIPHERTEXT_BYTES {
        bail!("secure ciphertext is outside the relay carrier bound");
    }
    let sid_length = u16::try_from(sid.len()).context("relay session id is too long")?;
    let ciphertext_length =
        u32::try_from(ciphertext.len()).context("secure ciphertext is too long")?;
    let mut frame = Vec::with_capacity(8 + sid.len() + ciphertext.len());
    frame.push(SECURE_CARRIER_VERSION);
    frame.push(1);
    frame.extend_from_slice(&sid_length.to_be_bytes());
    frame.extend_from_slice(sid);
    frame.extend_from_slice(&ciphertext_length.to_be_bytes());
    frame.extend_from_slice(ciphertext);
    Ok(Message::binary(frame))
}

fn parse_node_secure_carrier(frame: &[u8]) -> Result<(&str, &[u8])> {
    if frame.len() < 8 || frame[0] != SECURE_CARRIER_VERSION || frame[1] != 1 {
        bail!("secure relay carrier header is invalid");
    }
    let sid_length = usize::from(u16::from_be_bytes([frame[2], frame[3]]));
    if sid_length == 0 || sid_length > 64 || frame.len() < 8 + sid_length {
        bail!("secure relay session id is outside its bound");
    }
    let sid = std::str::from_utf8(&frame[4..4 + sid_length])
        .context("secure relay session id is not UTF-8")?;
    ensure_secure_sid(sid)?;
    let length_offset = 4 + sid_length;
    let ciphertext_length = usize::try_from(u32::from_be_bytes(
        frame[length_offset..length_offset + 4]
            .try_into()
            .expect("carrier length checked"),
    ))?;
    let ciphertext_offset = length_offset + 4;
    if ciphertext_length == 0
        || ciphertext_length > MAX_SECURE_CIPHERTEXT_BYTES
        || frame.len() != ciphertext_offset + ciphertext_length
    {
        bail!("secure relay ciphertext length is invalid");
    }
    Ok((sid, &frame[ciphertext_offset..]))
}

fn ensure_secure_sid(sid: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(sid).context("relay session id is not a UUID")?;
    if parsed.get_version() != Some(uuid::Version::Random) {
        bail!("relay session id is not a UUIDv4");
    }
    Ok(())
}

/// Returns the frame to send back, if any. `Ok(None)` means the frame needed no
/// reply — including frames this node does not recognise, which are logged and
/// skipped so a newer relay cannot take the node down.
fn handle_relay_text(
    text: &str,
    sessions: &mut HashMap<String, ClientSession>,
    state: &SharedState,
    node_ed25519: &[u8; 32],
) -> Result<Option<(Message, bool)>> {
    let frame: IncomingFrame = match serde_json::from_str(text) {
        Ok(frame) => frame,
        Err(error) => {
            eprintln!("ignoring unparseable relay frame: {error}");
            return Ok(None);
        }
    };

    match frame {
        IncomingFrame::Tunnel { v, sid, payload } if v == RELAY_VERSION => {
            let response = if can_open_client_session(sessions, &sid, MAX_CLIENT_SESSIONS)
                && ensure_secure_sid(&sid).is_ok()
            {
                let transport = lock(state)?.transport_identity.clone();
                let session = sessions.entry(sid.clone()).or_default();
                session.set_relay_session_id(&sid);
                match session.handle_secure_text(&payload, &transport, node_ed25519) {
                    Ok(response) => response,
                    Err(error) => {
                        eprintln!("secure handshake failed for one client: {error:#}");
                        session.close_secure();
                        secure_error_value("handshake-failed")
                    }
                }
            } else {
                secure_error_value("temporarily-unavailable")
            };
            Ok(Some((tunnel_text_frame(&sid, &response)?, false)))
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

#[allow(clippy::too_many_arguments)]
fn handle_relay_binary(
    frame: &[u8],
    sessions: &mut HashMap<String, ClientSession>,
    state: &SharedState,
    config_path: &Path,
    public_key: &str,
    node_info: &NodeInfo,
    event_sender: &mpsc::Sender<NodeEvent>,
) -> Result<Option<(Vec<Message>, bool)>> {
    let (sid, ciphertext) = match parse_node_secure_carrier(frame) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("ignoring invalid secure relay carrier: {error:#}");
            return Ok(None);
        }
    };
    let Some(session) = sessions.get_mut(sid) else {
        return Ok(None);
    };
    if !session.secure_ready() {
        return Ok(None);
    }
    let payload = match session.decrypt_secure(ciphertext) {
        Ok(Some(payload)) => payload,
        Ok(None) => return Ok(None),
        Err(error) => {
            eprintln!("secure client frame failed authentication: {error:#}");
            return Ok(None);
        }
    };
    let (response, refresh_node_info) = dispatch_application(
        session,
        payload,
        state,
        config_path,
        public_key,
        node_info,
        event_sender,
    )?;
    Ok(Some((
        encrypted_frames(sid, session, &response)?,
        refresh_node_info,
    )))
}

#[allow(clippy::too_many_arguments)]
fn dispatch_application(
    session: &mut ClientSession,
    payload: Value,
    state: &SharedState,
    config_path: &Path,
    public_key: &str,
    node_info: &NodeInfo,
    event_sender: &mpsc::Sender<NodeEvent>,
) -> Result<(NodeMessage, bool)> {
    let mut locked = lock(state)?;
    let locked = &mut *locked;
    let outcome = session.handle_application(
        payload,
        &mut locked.config,
        config_path,
        &mut locked.pair_offer,
        public_key,
        node_info,
        &mut locked.library,
    )?;
    let refresh_node_info = execute_application_effects(locked, outcome.effects, event_sender);
    Ok((outcome.response, refresh_node_info))
}

fn execute_application_effects(
    state: &mut NodeState,
    effects: Vec<ApplicationEffect>,
    event_sender: &mpsc::Sender<NodeEvent>,
) -> bool {
    let mut refresh_node_info = false;
    for effect in effects {
        match effect {
            ApplicationEffect::WakeJobWorker => state.job_notify.notify_one(),
            ApplicationEffect::StopActiveJob { job_id, reason } => {
                if let Some(active) = state
                    .active_job
                    .as_ref()
                    .filter(|active| active.job_id == job_id)
                {
                    crate::jobs::request_stop(&active.signal, reason);
                }
            }
            ApplicationEffect::Publish(event) => {
                let _ = event_sender.try_send(event);
            }
            ApplicationEffect::RefreshNodeInfo => refresh_node_info = true,
        }
    }
    refresh_node_info
}

fn secure_error_value(code: &str) -> Value {
    serde_json::json!({
        "v": 1,
        "t": "secure.error",
        "code": code,
        "message": "A secure channel is required.",
    })
}

fn can_open_client_session(
    sessions: &HashMap<String, ClientSession>,
    sid: &str,
    limit: usize,
) -> bool {
    sessions.contains_key(sid) || sessions.len() < limit
}

fn static_node_info(config: &NodeConfig, library: &crate::library::Library) -> NodeInfo {
    // What is actually on disk, so the app never offers a model this node
    // cannot load. Phase C's push is what keeps it current after a pull.
    let models = crate::store::Store::new(config.model_root())
        .installed()
        .into_iter()
        .map(|variant| ModelView {
            selector: variant.selector(),
            family: variant.model.clone(),
            engine: variant.engine().to_owned(),
        })
        .collect();
    let has_disk = library
        .available_bytes()
        .is_ok_and(|bytes| bytes >= config.jobs.minimum_free_bytes);
    NodeInfo {
        name: config.name.clone(),
        device_type: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        engine_version: "engine-abi-1".to_owned(),
        models,
        limits: NodeLimits {
            max_concurrent_jobs: 1,
            max_queued_jobs_per_principal: config.jobs.max_queued_per_principal,
            min_song_seconds: MIN_SONG_SECONDS,
            max_song_seconds: MAX_SONG_SECONDS,
            max_caption_bytes: MAX_CAPTION_BYTES,
            max_lyrics_bytes: MAX_LYRICS_BYTES,
            max_page_limit: MAX_PAGE_LIMIT,
        },
        load: NodeLoad {
            active_jobs: library.active_count().unwrap_or(0),
            queued_jobs: library.queued_count().unwrap_or(0),
            accepting_jobs: has_disk,
            unavailable_reason: (!has_disk).then(|| "insufficient_disk".to_owned()),
        },
        features: NodeFeatures {
            jobs_create: true,
            library_list: true,
            artifacts_transfer: true,
            secure_tunnel: true,
            job_controls: true,
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
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU8, Ordering};

    use futures_util::FutureExt;
    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use crate::catalog::Component;
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::identity::NodeIdentity;
    use crate::jobs::StopReason;
    use crate::library::{ControlResult, Submission, SubmitResult};
    use crate::principal::PrincipalId;
    use crate::runtime::{ActiveJobControl, NodeState, SharedState, shared};
    use crate::secure::TransportIdentity;
    use crate::session::ClientSession;
    use crate::store::InstalledVariant;
    use cantor_proto::{ErrorCode, GenerationStage, JobState, JobView, NodeMessage, ProgressUnit};
    use tempfile::tempdir;

    use super::{
        Message, NodeEvent, RECONNECT_MAX_MS, apply_control_event, can_open_client_session,
        dispatch_application, handle_relay_text, parse_node_secure_carrier, reconnect_delay,
        static_node_info,
    };

    const OWNER_SID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_SID: &str = "22222222-2222-4222-8222-222222222222";

    fn fixture() -> (SharedState, std::path::PathBuf, tempfile::TempDir) {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let config_path = paths.config.clone();
        let library =
            crate::library::Library::open(temporary.path().join("library")).expect("library");
        let (identity, _) = NodeIdentity::load_or_create(&paths.key).expect("identity");
        let node_public_key = identity.public_key_base58();
        let (transport_identity, _) =
            TransportIdentity::load_or_create(&paths.transport_key, &identity)
                .expect("transport identity");
        let state = shared(NodeState {
            config,
            config_path: paths.config,
            node_public_key,
            pair_offer: None,
            connected: true,
            library,
            job_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            delivery_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            active_job: None,
            shutting_down: false,
            transport_identity: std::sync::Arc::new(transport_identity),
        });
        (state, config_path, temporary)
    }

    fn installed_variant() -> InstalledVariant {
        InstalledVariant {
            model: "effect-test".into(),
            tag: "fast".into(),
            licence: String::new(),
            components: vec![Component {
                role: "model".into(),
                blob: format!("sha256:{}", "a".repeat(64)),
                url: "https://example.invalid/model".into(),
                bytes: 1,
                quant: None,
            }],
            installed_at: String::new(),
            engine: "effect-test".into(),
            vram_bytes: 0,
        }
    }

    fn install_variant_for_application(state: &SharedState) -> String {
        let variant = installed_variant();
        let root = {
            let locked = state.lock().expect("state");
            locked.config.model_root()
        };
        let store = crate::store::Store::new(&root);
        store.prepare().expect("model store");
        let model = crate::catalog::Model {
            name: variant.model.clone(),
            licence: variant.licence.clone(),
            engine: Some(variant.engine.clone()),
            variants: Vec::new(),
        };
        let catalog_variant = crate::catalog::Variant {
            tag: variant.tag.clone(),
            components: variant.components.clone(),
            needs: crate::catalog::Needs {
                vram_bytes: variant.vram_bytes,
                backends: Vec::new(),
            },
        };
        store
            .mark_installed(&model, &catalog_variant)
            .expect("installed marker");
        variant.selector()
    }

    fn authenticated_session(key: [u8; 32]) -> ClientSession {
        ClientSession::authenticated_with_bytes_for_test(&bs58::encode(key).into_string(), key)
    }

    fn submit_job(state: &SharedState, key: [u8; 32]) -> JobView {
        let variant = installed_variant();
        let principal_id = PrincipalId::from_client_public_key(&key);
        let mut locked = state.lock().expect("state");
        locked.config.jobs.minimum_free_bytes = 0;
        let result = locked
            .library
            .submit(
                principal_id,
                &key,
                &Submission {
                    client_request_id: uuid::Uuid::new_v4().to_string(),
                    model: variant.selector(),
                    generation: cantor_proto::GenerationRequest {
                        caption: "effect characterization".into(),
                        lyrics: None,
                        duration: Some(15),
                        steps: Some(1),
                        cfg: None,
                        seed: Some(7),
                    },
                },
                &variant,
                20,
                0,
            )
            .expect("submit");
        match result {
            SubmitResult::Accepted(job) => job,
            other => panic!("unexpected submit result: {other:?}"),
        }
    }

    fn complete_song(state: &SharedState, key: [u8; 32]) -> String {
        let _accepted = submit_job(state, key);
        let mut locked = state.lock().expect("state");
        let (work, _) = locked
            .library
            .claim_next()
            .expect("claim")
            .expect("queued job");
        locked
            .library
            .record_progress(
                &work,
                GenerationStage::Decode,
                1,
                Some(1),
                ProgressUnit::Steps,
            )
            .expect("progress")
            .expect("running job");
        locked
            .library
            .begin_finalizing(&work)
            .expect("begin finalizing")
            .expect("finalizing job");
        locked
            .library
            .complete(
                &work,
                &crate::generate::Audio {
                    planar: vec![0.0; 960],
                    sample_rate: 48_000,
                },
            )
            .expect("complete")
            .expect("completed job")
            .2
            .id
    }

    fn dispatch(
        state: &SharedState,
        config_path: &std::path::Path,
        session: &mut ClientSession,
        payload: Value,
        events: &mpsc::Sender<NodeEvent>,
    ) -> NodeMessage {
        dispatch_with_refresh(state, config_path, session, payload, events).0
    }

    fn dispatch_with_refresh(
        state: &SharedState,
        config_path: &std::path::Path,
        session: &mut ClientSession,
        payload: Value,
        events: &mpsc::Sender<NodeEvent>,
    ) -> (NodeMessage, bool) {
        let (node_public_key, node_info) = {
            let locked = state.lock().expect("state");
            (
                locked.node_public_key.clone(),
                static_node_info(&locked.config, &locked.library),
            )
        };
        dispatch_application(
            session,
            payload,
            state,
            config_path,
            &node_public_key,
            &node_info,
            events,
        )
        .expect("application dispatch")
    }

    fn take_job_notification(state: &SharedState) -> bool {
        let notify = Arc::clone(&state.lock().expect("state").job_notify);
        notify.notified().now_or_never().is_some()
    }

    #[test]
    fn accepted_job_wakes_the_worker_without_publishing_a_job_event() {
        let (state, config_path, _guard) = fixture();
        let model = install_variant_for_application(&state);
        state.lock().expect("state").config.jobs.minimum_free_bytes = 0;
        let key = [1_u8; 32];
        let mut session = authenticated_session(key);
        let (events, mut received) = mpsc::channel(4);

        let (response, refresh_node_info) = dispatch_with_refresh(
            &state,
            &config_path,
            &mut session,
            json!({
                "t": "job.create",
                "v": 2,
                "id": "create",
                "client_request_id": uuid::Uuid::new_v4().to_string(),
                "model": model,
                "generation": {
                    "caption": "effect characterization",
                    "duration": 15,
                    "steps": 1,
                    "seed": 7
                }
            }),
            &events,
        );

        assert!(matches!(response, NodeMessage::JobAccepted { .. }));
        assert!(refresh_node_info);
        assert!(take_job_notification(&state));
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn pause_and_cancel_stop_only_the_matching_active_job_and_publish_owner_updates() {
        for (message_type, expected_state, expected_reason) in [
            ("job.pause", JobState::PauseRequested, StopReason::Pause),
            ("job.cancel", JobState::CancelRequested, StopReason::Cancel),
        ] {
            let (state, config_path, _guard) = fixture();
            let key = [1_u8; 32];
            let principal_id = PrincipalId::from_client_public_key(&key);
            submit_job(&state, key);
            let (work, claimed) = state
                .lock()
                .expect("state")
                .library
                .claim_next()
                .expect("claim")
                .expect("claimed job");
            let signal = Arc::new(AtomicU8::new(StopReason::None as u8));
            state.lock().expect("state").active_job = Some(ActiveJobControl {
                job_id: work.id.clone(),
                principal_id,
                signal: Arc::clone(&signal),
            });
            let mut session = authenticated_session(key);
            let (events, mut received) = mpsc::channel(4);

            let response = dispatch(
                &state,
                &config_path,
                &mut session,
                json!({
                    "t": message_type,
                    "v": 2,
                    "id": "control",
                    "job_id": work.id,
                    "expected_revision": claimed.revision
                }),
                &events,
            );

            let controlled = match response {
                NodeMessage::JobControlled { job, .. } => job,
                other => panic!("unexpected control response: {other:?}"),
            };
            assert_eq!(controlled.state, expected_state);
            assert_eq!(signal.load(Ordering::Acquire), expected_reason as u8);
            assert!(!take_job_notification(&state));
            match received.try_recv().expect("owner job event") {
                NodeEvent::JobUpdated {
                    principal_id: event_principal,
                    job,
                } => {
                    assert_eq!(event_principal, principal_id);
                    assert_eq!(job, controlled);
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }

        let (state, config_path, _guard) = fixture();
        let key = [1_u8; 32];
        let principal_id = PrincipalId::from_client_public_key(&key);
        submit_job(&state, key);
        let (work, claimed) = state
            .lock()
            .expect("state")
            .library
            .claim_next()
            .expect("claim")
            .expect("claimed job");
        let unrelated_signal = Arc::new(AtomicU8::new(StopReason::None as u8));
        state.lock().expect("state").active_job = Some(ActiveJobControl {
            job_id: "a-different-job".into(),
            principal_id,
            signal: Arc::clone(&unrelated_signal),
        });
        let mut session = authenticated_session(key);
        let (events, _received) = mpsc::channel(4);

        let (response, refresh_node_info) = dispatch_with_refresh(
            &state,
            &config_path,
            &mut session,
            json!({
                "t": "job.pause",
                "v": 2,
                "id": "control",
                "job_id": work.id,
                "expected_revision": claimed.revision
            }),
            &events,
        );

        assert!(matches!(response, NodeMessage::JobControlled { .. }));
        assert!(refresh_node_info);
        assert_eq!(
            unrelated_signal.load(Ordering::Acquire),
            StopReason::None as u8
        );
    }

    #[test]
    fn resumed_queued_job_wakes_the_worker_and_publishes_the_owner_update() {
        let (state, config_path, _guard) = fixture();
        let key = [1_u8; 32];
        let principal_id = PrincipalId::from_client_public_key(&key);
        let accepted = submit_job(&state, key);
        let paused = {
            let mut locked = state.lock().expect("state");
            match locked
                .library
                .control_job(
                    principal_id,
                    &accepted.id,
                    Some(accepted.revision),
                    crate::library::JobControl::Pause,
                )
                .expect("pause")
            {
                ControlResult::Updated(job) => job,
                other => panic!("unexpected pause result: {other:?}"),
            }
        };
        assert_eq!(paused.state, JobState::Paused);
        let mut session = authenticated_session(key);
        let (events, mut received) = mpsc::channel(4);

        let (response, refresh_node_info) = dispatch_with_refresh(
            &state,
            &config_path,
            &mut session,
            json!({
                "t": "job.resume",
                "v": 2,
                "id": "resume",
                "job_id": paused.id,
                "expected_revision": paused.revision
            }),
            &events,
        );

        let controlled = match response {
            NodeMessage::JobControlled { job, .. } => job,
            other => panic!("unexpected resume response: {other:?}"),
        };
        assert!(refresh_node_info);
        assert_eq!(controlled.state, JobState::Queued);
        assert!(take_job_notification(&state));
        match received.try_recv().expect("owner job event") {
            NodeEvent::JobUpdated {
                principal_id: event_principal,
                job,
            } => {
                assert_eq!(event_principal, principal_id);
                assert_eq!(job, controlled);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn successful_song_update_publishes_the_exact_committed_revision() {
        let (state, config_path, _guard) = fixture();
        let key = [1_u8; 32];
        let principal_id = PrincipalId::from_client_public_key(&key);
        let song_id = complete_song(&state, key);
        let mut session = authenticated_session(key);
        let (events, mut received) = mpsc::channel(4);

        let (response, refresh_node_info) = dispatch_with_refresh(
            &state,
            &config_path,
            &mut session,
            json!({
                "t": "song.patch",
                "v": 2,
                "id": "patch",
                "song_id": song_id,
                "expected_revision": 1,
                "patch": { "favorite": true }
            }),
            &events,
        );

        assert!(matches!(response, NodeMessage::SongUpdated { .. }));
        assert!(!refresh_node_info);
        let committed_revision = state
            .lock()
            .expect("state")
            .library
            .library_revision(principal_id)
            .expect("library revision");
        match received.try_recv().expect("library event") {
            NodeEvent::LibraryChanged {
                principal_id: event_principal,
                revision,
            } => {
                assert_eq!(event_principal, principal_id);
                assert_eq!(revision, committed_revision);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn conflict_response_does_not_wake_stop_or_publish() {
        let (state, config_path, _guard) = fixture();
        let key = [1_u8; 32];
        let principal_id = PrincipalId::from_client_public_key(&key);
        let accepted = submit_job(&state, key);
        let signal = Arc::new(AtomicU8::new(StopReason::None as u8));
        state.lock().expect("state").active_job = Some(ActiveJobControl {
            job_id: accepted.id.clone(),
            principal_id,
            signal: Arc::clone(&signal),
        });
        let mut session = authenticated_session(key);
        let (events, mut received) = mpsc::channel(4);

        let response = dispatch(
            &state,
            &config_path,
            &mut session,
            json!({
                "t": "job.pause",
                "v": 2,
                "id": "conflict",
                "job_id": accepted.id,
                "expected_revision": accepted.revision + 1
            }),
            &events,
        );

        assert!(matches!(
            response,
            NodeMessage::Error {
                code: ErrorCode::RevisionConflict,
                ..
            }
        ));
        assert_eq!(signal.load(Ordering::Acquire), StopReason::None as u8);
        assert!(!take_job_notification(&state));
        assert!(received.try_recv().is_err());

        let response = dispatch(
            &state,
            &config_path,
            &mut session,
            json!({
                "t": "job.pause",
                "v": 2,
                "id": "malformed"
            }),
            &events,
        );

        assert!(matches!(
            response,
            NodeMessage::Error {
                code: ErrorCode::InvalidRequest,
                ..
            }
        ));
        assert_eq!(signal.load(Ordering::Acquire), StopReason::None as u8);
        assert!(!take_job_notification(&state));
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn full_or_closed_event_channel_never_fails_a_control_response() {
        for channel_state in ["full", "closed"] {
            let (state, config_path, _guard) = fixture();
            let key = [1_u8; 32];
            let accepted = submit_job(&state, key);
            let mut session = authenticated_session(key);
            let (events, mut received) = mpsc::channel(1);
            if channel_state == "full" {
                events
                    .try_send(NodeEvent::NodeInfoChanged)
                    .expect("fill event channel");
            } else {
                received.close();
            }

            let response = dispatch(
                &state,
                &config_path,
                &mut session,
                json!({
                    "t": "job.pause",
                    "v": 2,
                    "id": channel_state,
                    "job_id": accepted.id,
                    "expected_revision": accepted.revision
                }),
                &events,
            );

            assert!(matches!(response, NodeMessage::JobControlled { .. }));
        }
    }

    fn secure_authenticated(
        state: &SharedState,
        sid: &str,
        key: &str,
        bytes: [u8; 32],
    ) -> ClientSession {
        let (transport, node_ed25519) = {
            let locked = state.lock().expect("state");
            let node_ed25519: [u8; 32] = bs58::decode(&locked.node_public_key)
                .into_vec()
                .expect("node key")
                .try_into()
                .expect("node key length");
            (locked.transport_identity.clone(), node_ed25519)
        };
        let mut session = ClientSession::authenticated_with_bytes_for_test(key, bytes);
        session.set_relay_session_id(sid);
        session.establish_secure_for_test(&transport, &node_ed25519);
        session
    }

    fn encrypted_bytes(frame: &Message) -> &[u8] {
        let Message::Binary(bytes) = frame else {
            panic!("secure application data must use a binary carrier");
        };
        bytes.as_ref()
    }

    fn encrypted_sid(frame: &Message) -> &str {
        parse_node_secure_carrier(encrypted_bytes(frame))
            .expect("secure carrier")
            .0
    }

    #[test]
    fn private_job_updates_are_sent_only_to_the_owner_principal() {
        let (state, _config_path, _guard) = fixture();
        let mut node_info = {
            let locked = state.lock().expect("state");
            static_node_info(&locked.config, &locked.library)
        };
        let mut sessions = HashMap::from([
            (
                OWNER_SID.to_owned(),
                secure_authenticated(&state, OWNER_SID, "owner-key", [1; 32]),
            ),
            (
                OTHER_SID.to_owned(),
                secure_authenticated(&state, OTHER_SID, "other-key", [2; 32]),
            ),
        ]);
        let principal_id = PrincipalId::from_client_public_key(&[1_u8; 32]);
        let frames = apply_control_event(
            NodeEvent::JobUpdated {
                principal_id,
                job: JobView {
                    id: "job".into(),
                    revision: 2,
                    state: JobState::Running,
                    stage: None,
                    progress: None,
                    model: "model:tag".into(),
                    created_at: "now".into(),
                    updated_at: "now".into(),
                    error: None,
                },
            },
            &mut sessions,
            &state,
            &mut node_info,
        )
        .expect("event");
        assert_eq!(frames.len(), 1);
        assert_eq!(encrypted_sid(&frames[0]), OWNER_SID);
        let bytes = encrypted_bytes(&frames[0]);
        assert!(
            !bytes
                .windows(b"job.updated".len())
                .any(|v| v == b"job.updated")
        );
    }

    #[test]
    fn private_library_hints_are_sent_only_to_the_owner_principal() {
        let (state, _config_path, _guard) = fixture();
        let mut node_info = {
            let locked = state.lock().expect("state");
            static_node_info(&locked.config, &locked.library)
        };
        let mut sessions = HashMap::from([
            (
                OWNER_SID.to_owned(),
                secure_authenticated(&state, OWNER_SID, "owner-key", [1; 32]),
            ),
            (
                OTHER_SID.to_owned(),
                secure_authenticated(&state, OTHER_SID, "other-key", [2; 32]),
            ),
        ]);
        let principal_id = PrincipalId::from_client_public_key(&[1_u8; 32]);
        let frames = apply_control_event(
            NodeEvent::LibraryChanged {
                principal_id,
                revision: 7,
            },
            &mut sessions,
            &state,
            &mut node_info,
        )
        .expect("event");
        assert_eq!(frames.len(), 1);
        assert_eq!(encrypted_sid(&frames[0]), OWNER_SID);
        let bytes = encrypted_bytes(&frames[0]);
        assert!(
            !bytes
                .windows(b"library.changed".len())
                .any(|v| v == b"library.changed")
        );
    }

    /// Every frame this build does not understand must be skipped rather than
    /// ending the connection, so a newer relay can add frames without knocking
    /// already-installed nodes offline in a reconnect loop.
    #[test]
    fn unrecognised_frames_are_skipped_without_ending_the_connection() {
        let (state, _config_path, _guard) = fixture();
        let mut sessions = HashMap::new();
        let node_ed25519 = [9_u8; 32];

        for frame in [
            r#"{"v":1,"t":"relay.somethingNew","detail":"from a newer relay"}"#,
            r#"{"v":2,"t":"tunnel","sid":"s","payload":{}}"#,
            r#"{"v":2,"t":"relay.detached","sid":"s"}"#,
            "not json at all",
            "",
        ] {
            let response = handle_relay_text(frame, &mut sessions, &state, &node_ed25519)
                .expect("unrecognised frames must not be errors");
            assert!(response.is_none(), "unexpected reply to {frame}");
        }
    }

    /// A relay-level error is about this connection specifically, so unlike an
    /// unknown frame it still ends it.
    #[test]
    fn a_relay_error_still_ends_the_connection() {
        let (state, _config_path, _guard) = fixture();

        let result = handle_relay_text(
            r#"{"v":1,"t":"relay.error","code":"bad-claim","msg":"nope"}"#,
            &mut HashMap::new(),
            &state,
            &[9_u8; 32],
        );

        assert!(result.is_err());
    }

    /// Revoking someone who is connected right now has to cut them off, not wait
    /// for their next handshake. `rejected` is the code the app treats as final.
    #[test]
    fn revoking_drops_the_live_sessions_that_used_that_key() {
        let (state, _config_path, _guard) = fixture();
        let locked = state.lock().expect("state");
        let mut node_info = static_node_info(&locked.config, &locked.library);
        drop(locked);
        let mut sessions = HashMap::new();
        sessions.insert(
            OWNER_SID.to_owned(),
            secure_authenticated(&state, OWNER_SID, "revoked-key", [1; 32]),
        );
        sessions.insert(
            OTHER_SID.to_owned(),
            secure_authenticated(&state, OTHER_SID, "other-key", [2; 32]),
        );

        let frames = apply_control_event(
            NodeEvent::Revoked("revoked-key".to_owned()),
            &mut sessions,
            &state,
            &mut node_info,
        )
        .expect("revoke");

        assert_eq!(frames.len(), 1);
        assert_eq!(encrypted_sid(&frames[0]), OWNER_SID);
        assert_eq!(sessions[OWNER_SID].authenticated_key(), None);
        // The device that was not revoked keeps its session.
        assert_eq!(sessions[OTHER_SID].authenticated_key(), Some("other-key"));
    }

    /// A connected app is told about a rename rather than showing the old name
    /// until it happens to reconnect.
    #[test]
    fn renaming_the_node_pushes_node_info_to_authenticated_sessions_only() {
        let (state, config_path, _guard) = fixture();
        let locked = state.lock().expect("state");
        let mut node_info = static_node_info(&locked.config, &locked.library);
        drop(locked);
        let mut sessions = HashMap::new();
        sessions.insert(
            OWNER_SID.to_owned(),
            secure_authenticated(&state, OWNER_SID, "key", [1; 32]),
        );
        sessions.insert(OTHER_SID.to_owned(), ClientSession::default());
        state
            .lock()
            .expect("state")
            .config
            .rename_node(&config_path, "studio-node")
            .expect("rename");

        let frames = apply_control_event(
            NodeEvent::NodeInfoChanged,
            &mut sessions,
            &state,
            &mut node_info,
        )
        .expect("push");

        assert_eq!(frames.len(), 1);
        assert_eq!(encrypted_sid(&frames[0]), OWNER_SID);
        let bytes = encrypted_bytes(&frames[0]);
        assert!(
            !bytes
                .windows(b"studio-node".len())
                .any(|v| v == b"studio-node")
        );
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

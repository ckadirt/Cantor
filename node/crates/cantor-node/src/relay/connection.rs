//! The post-claim relay connection loop.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use cantor_proto::{NodeInfo, NodeMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::node_info::static_node_info;
use super::sessions::SessionRegistry;
use crate::runtime::{NodeEvent, SharedState};

/// Carrier NAT and intermediate proxies drop idle WebSocket connections after
/// roughly a minute. The relay answers this text frame from
/// `setWebSocketAutoResponse` without waking the Durable Object, so keeping the
/// path warm costs nothing on the relay side.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(25);
const KEEPALIVE_PING: &str = "ping";
pub(super) const KEEPALIVE_PONG: &str = "pong";

/// Outbound frames are queued rather than written inline so one slow socket
/// write cannot stall the read loop (and, with it, every other client session).
const OUTBOUND_QUEUE_DEPTH: usize = 256;

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    state: &SharedState,
    events: &mut mpsc::Receiver<NodeEvent>,
    event_sender: &mpsc::Sender<NodeEvent>,
    config_path: &Path,
    public_key: &str,
    public_key_bytes: &[u8; 32],
    mut node_info: NodeInfo,
) -> Result<()> {
    let mut sessions = SessionRegistry::default();

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
                match sessions.apply_control_event(event, state, &mut node_info) {
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
                        let Some((response, refresh_node_info)) = sessions.handle_text(
                            text.as_ref(),
                            state,
                            public_key_bytes,
                        )? else {
                            continue;
                        };
                        if outbound.send(response).await.is_err() {
                            break Err(anyhow::anyhow!("relay writer stopped"));
                        }
                        if refresh_node_info {
                            node_info = {
                                let locked = super::lock(state)?;
                                static_node_info(&locked.config, &locked.library)
                            };
                            let push = NodeMessage::NodeInfoChanged {
                                v: cantor_proto::PROTOCOL_VERSION,
                                node: node_info.clone(),
                            };
                            sessions
                                .stream_authenticated_refresh(&push, &outbound)
                                .await?;
                        }
                    }
                    Message::Binary(bytes) => {
                        let Some((frames, refresh_node_info)) = sessions.handle_binary(
                            bytes.as_ref(),
                            state,
                            config_path,
                            public_key,
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
                                let locked = super::lock(state)?;
                                static_node_info(&locked.config, &locked.library)
                            };
                            let push = NodeMessage::NodeInfoChanged {
                                v: cantor_proto::PROTOCOL_VERSION,
                                node: node_info.clone(),
                            };
                            sessions
                                .stream_authenticated_refresh(&push, &outbound)
                                .await?;
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

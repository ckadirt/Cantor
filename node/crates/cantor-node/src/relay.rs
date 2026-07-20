use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::config::NodeConfig;
use crate::identity::NodeIdentity;

const RELAY_VERSION: u8 = 1;
const CHALLENGE_BYTES: usize = 32;

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
enum IncomingFrame {
    #[serde(rename = "relay.challenge")]
    Challenge { v: u8, nonce: String },
    #[serde(rename = "relay.ok")]
    Ok { v: u8 },
    #[serde(rename = "relay.error")]
    Error { v: u8, code: String, msg: String },
}

#[derive(Serialize)]
struct RelayClaim<'a> {
    v: u8,
    t: &'static str,
    pubkey: &'a str,
    sig: String,
}

pub async fn claim_room(config: &NodeConfig, identity: &NodeIdentity) -> Result<()> {
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
        IncomingFrame::Ok { .. } => bail!("relay sent relay.ok before a challenge"),
    };

    let nonce_bytes = URL_SAFE_NO_PAD
        .decode(&nonce)
        .context("relay challenge nonce is not valid base64url")?;
    if nonce_bytes.len() != CHALLENGE_BYTES {
        bail!("relay challenge nonce must contain {CHALLENGE_BYTES} bytes");
    }

    let signature = identity.sign(&nonce_bytes);
    let claim = RelayClaim {
        v: RELAY_VERSION,
        t: "relay.claim",
        pubkey: &public_key,
        sig: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    };
    let claim_json = serde_json::to_string(&claim).context("failed to encode relay claim")?;
    socket
        .send(Message::Text(claim_json.into()))
        .await
        .context("failed to send relay claim")?;

    match next_control_frame(&mut socket).await? {
        IncomingFrame::Ok { v } if v == RELAY_VERSION => {}
        IncomingFrame::Ok { v } => bail!("relay protocol version {v} is not supported"),
        IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
        IncomingFrame::Challenge { .. } => bail!("relay sent a second challenge"),
    }

    println!("relay.ok — room claimed as {}", config.name);

    loop {
        tokio::select! {
            signal_result = tokio::signal::ctrl_c() => {
                signal_result.context("failed to listen for Ctrl-C")?;
                socket.close(None).await.context("failed to close relay socket")?;
                return Ok(());
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Ping(payload))) => {
                        socket.send(Message::Pong(payload)).await.context("failed to answer relay ping")?;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        bail!("relay closed the room socket: {frame:?}");
                    }
                    Some(Ok(Message::Text(text))) => {
                        let frame: IncomingFrame = serde_json::from_str(text.as_ref())
                            .context("relay sent an invalid control frame")?;
                        match frame {
                            IncomingFrame::Error { v, code, msg } => bail_relay_error(v, &code, &msg)?,
                            _ => bail!("relay sent an unexpected control frame after relay.ok"),
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(error).context("relay WebSocket failed"),
                    None => bail!("relay disconnected"),
                }
            }
        }
    }
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
    bail!("relay rejected the room claim ({code}): {msg}")
}

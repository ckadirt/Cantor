//! The post-claim relay connection loop.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use cantor_proto::{NodeInfo, NodeMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

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
pub(super) async fn run<S>(
    socket: WebSocketStream<S>,
    state: &SharedState,
    events: &mut mpsc::Receiver<NodeEvent>,
    event_sender: &mpsc::Sender<NodeEvent>,
    config_path: &Path,
    public_key: &str,
    public_key_bytes: &[u8; 32],
    mut node_info: NodeInfo,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
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

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use snow::{Builder, TransportState, params::NoiseParams};
    use tempfile::tempdir;
    use tokio::io::DuplexStream;
    use tokio::sync::mpsc;
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::protocol::Role;

    use super::run;
    use crate::catalog::Component;
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::identity::NodeIdentity;
    use crate::library::{Submission, SubmitResult};
    use crate::principal::PrincipalId;
    use crate::relay::carrier::{
        encode_node_secure_carrier, parse_node_secure_carrier, tunnel_text_frame,
    };
    use crate::relay::node_info::static_node_info;
    use crate::runtime::{NodeState, SharedState, shared};
    use crate::secure::{TransportIdentity, handshake_prologue};
    use crate::signing::node_auth_message;
    use crate::store::InstalledVariant;
    use crate::transport::{
        NOISE_PROTOCOL_NAME, SECURE_INNER_VERSION, SECURE_NEGOTIATION_VERSION,
        SECURE_RECORD_VERSION, TRANSPORT_SUITE_ID,
    };

    const SID: &str = "11111111-1111-4111-8111-111111111111";
    const RECORD_FRAGMENT: u8 = 1;
    const INNER_CONTROL: u8 = 1;
    const FRAGMENT_HEADER_BYTES: usize = 18;

    struct Fixture {
        state: SharedState,
        config_path: std::path::PathBuf,
        public_key: String,
        public_key_bytes: [u8; 32],
        _temporary: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let (identity, _) = NodeIdentity::load_or_create(&paths.key).expect("identity");
        let public_key = identity.public_key_base58();
        let public_key_bytes = identity.public_key_bytes();
        let (transport_identity, _) =
            TransportIdentity::load_or_create(&paths.transport_key, &identity)
                .expect("transport identity");
        let library =
            crate::library::Library::open(temporary.path().join("library")).expect("library");
        let state = shared(NodeState {
            config,
            config_path: paths.config.clone(),
            node_public_key: public_key.clone(),
            pair_offer: None,
            connected: true,
            library,
            job_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            delivery_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            active_job: None,
            shutting_down: false,
            transport_identity: std::sync::Arc::new(transport_identity),
        });
        Fixture {
            state,
            config_path: paths.config,
            public_key,
            public_key_bytes,
            _temporary: temporary,
        }
    }

    async fn websocket_pair() -> (WebSocketStream<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (node, relay) = tokio::io::duplex(256 * 1024);
        let node = WebSocketStream::from_raw_socket(node, Role::Server, None).await;
        let relay = WebSocketStream::from_raw_socket(relay, Role::Client, None).await;
        (node, relay)
    }

    fn node_info(state: &SharedState) -> cantor_proto::NodeInfo {
        let locked = state.lock().expect("state");
        static_node_info(&locked.config, &locked.library)
    }

    async fn next_message(socket: &mut WebSocketStream<DuplexStream>) -> Message {
        socket
            .next()
            .await
            .expect("WebSocket remains open")
            .expect("valid WebSocket frame")
    }

    async fn begin_secure_channel(
        socket: &mut WebSocketStream<DuplexStream>,
        node_ed25519: &[u8; 32],
    ) -> TestSecureClient {
        socket
            .send(
                tunnel_text_frame(
                    SID,
                    &json!({
                        "v": SECURE_NEGOTIATION_VERSION,
                        "t": "secure.init",
                        "id": "secure-test",
                        "suite": TRANSPORT_SUITE_ID,
                    }),
                )
                .expect("secure init tunnel"),
            )
            .await
            .expect("send secure init");
        let offer = text_payload(next_message(socket).await);
        assert_eq!(offer["t"], "secure.offer");
        let transport_key: [u8; 32] = URL_SAFE_NO_PAD
            .decode(
                offer["descriptor"]["transport_x25519"]
                    .as_str()
                    .expect("transport key"),
            )
            .expect("transport key base64url")
            .try_into()
            .expect("transport key length");
        let channel_nonce: [u8; 32] = URL_SAFE_NO_PAD
            .decode(offer["channel_nonce"].as_str().expect("channel nonce"))
            .expect("channel nonce base64url")
            .try_into()
            .expect("channel nonce length");
        let prologue = handshake_prologue(node_ed25519, &transport_key, &channel_nonce);
        let parameters: NoiseParams = NOISE_PROTOCOL_NAME.parse().expect("Noise parameters");
        let mut initiator = Builder::new(parameters)
            .remote_public_key(&transport_key)
            .expect("remote transport key")
            .prologue(&prologue)
            .expect("handshake prologue")
            .build_initiator()
            .expect("Noise initiator");
        let mut first = [0_u8; 4 * 1024];
        let first_length = initiator
            .write_message(&[], &mut first)
            .expect("first Noise message");
        socket
            .send(
                tunnel_text_frame(
                    SID,
                    &json!({
                        "v": SECURE_NEGOTIATION_VERSION,
                        "t": "secure.handshake",
                        "id": "secure-test",
                        "step": 1,
                        "data": URL_SAFE_NO_PAD.encode(&first[..first_length]),
                    }),
                )
                .expect("secure handshake tunnel"),
            )
            .await
            .expect("send secure handshake");
        let response = text_payload(next_message(socket).await);
        assert_eq!(response["t"], "secure.handshake");
        let second = URL_SAFE_NO_PAD
            .decode(response["data"].as_str().expect("second Noise message"))
            .expect("second Noise message base64url");
        let mut empty = [];
        initiator
            .read_message(&second, &mut empty)
            .expect("second Noise message authentication");
        TestSecureClient {
            transport: initiator
                .into_transport_mode()
                .expect("Noise transport mode"),
            send_message_id: 0,
            receive_message_id: 0,
        }
    }

    fn text_payload(message: Message) -> Value {
        let Message::Text(text) = message else {
            panic!("secure handshake response must be text");
        };
        let envelope: Value = serde_json::from_str(text.as_ref()).expect("relay tunnel envelope");
        assert_eq!(envelope["v"], 1);
        assert_eq!(envelope["t"], "tunnel");
        assert_eq!(envelope["sid"], SID);
        envelope["payload"].clone()
    }

    struct TestSecureClient {
        transport: TransportState,
        send_message_id: u32,
        receive_message_id: u32,
    }

    impl TestSecureClient {
        fn encrypt(&mut self, payload: &Value) -> Message {
            let json = serde_json::to_vec(payload).expect("application JSON");
            let mut inner = Vec::with_capacity(6 + json.len());
            inner.push(SECURE_INNER_VERSION);
            inner.push(INNER_CONTROL);
            inner.extend_from_slice(&(json.len() as u32).to_be_bytes());
            inner.extend_from_slice(&json);

            let mut record = Vec::with_capacity(FRAGMENT_HEADER_BYTES + inner.len());
            record.push(SECURE_RECORD_VERSION);
            record.push(RECORD_FRAGMENT);
            record.extend_from_slice(&self.send_message_id.to_be_bytes());
            record.extend_from_slice(&0_u16.to_be_bytes());
            record.extend_from_slice(&1_u16.to_be_bytes());
            record.extend_from_slice(&(inner.len() as u32).to_be_bytes());
            record.extend_from_slice(&(inner.len() as u32).to_be_bytes());
            record.extend_from_slice(&inner);
            let mut ciphertext = vec![0_u8; record.len() + 16];
            let length = self
                .transport
                .write_message(&record, &mut ciphertext)
                .expect("encrypt application request");
            ciphertext.truncate(length);
            self.send_message_id += 1;
            encode_node_secure_carrier(SID, &ciphertext).expect("secure carrier")
        }

        fn decrypt(&mut self, message: Message) -> Value {
            let Message::Binary(carrier) = message else {
                panic!("secure application response must be binary");
            };
            let (sid, ciphertext) =
                parse_node_secure_carrier(carrier.as_ref()).expect("secure response carrier");
            assert_eq!(sid, SID);
            let mut record = vec![0_u8; ciphertext.len()];
            let length = self
                .transport
                .read_message(ciphertext, &mut record)
                .expect("decrypt application response");
            record.truncate(length);
            assert!(record.len() >= FRAGMENT_HEADER_BYTES + 6);
            assert_eq!(record[0], SECURE_RECORD_VERSION);
            assert_eq!(record[1], RECORD_FRAGMENT);
            assert_eq!(
                u32::from_be_bytes(record[2..6].try_into().expect("message id")),
                self.receive_message_id
            );
            assert_eq!(&record[6..10], &[0, 0, 0, 1]);
            let inner = &record[FRAGMENT_HEADER_BYTES..];
            assert_eq!(inner[0], SECURE_INNER_VERSION);
            assert_eq!(inner[1], INNER_CONTROL);
            let json_length = usize::try_from(u32::from_be_bytes(
                inner[2..6].try_into().expect("JSON length"),
            ))
            .expect("JSON length fits usize");
            assert_eq!(inner.len(), 6 + json_length);
            self.receive_message_id += 1;
            serde_json::from_slice(&inner[6..]).expect("application response JSON")
        }
    }

    #[tokio::test]
    async fn claimed_runner_starts_the_writer_answers_ping_and_clears_connected_on_tail() {
        let fixture = fixture();
        let (node, mut relay) = websocket_pair().await;
        let (event_sender, mut events) = mpsc::channel(4);
        let info = node_info(&fixture.state);

        let runner = run(
            node,
            &fixture.state,
            &mut events,
            &event_sender,
            &fixture.config_path,
            &fixture.public_key,
            &fixture.public_key_bytes,
            info,
        );
        let client = async {
            let payload = vec![1_u8, 2, 3];
            relay
                .send(Message::Ping(payload.clone().into()))
                .await
                .expect("send Ping");
            assert_eq!(
                next_message(&mut relay).await,
                Message::Pong(payload.into())
            );
            relay.send(Message::Close(None)).await.expect("send Close");
        };
        let (result, ()) = tokio::join!(runner, client);

        assert!(result.is_err(), "relay Close ends the claimed runner");
        assert!(!fixture.state.lock().expect("state").connected);
    }

    #[tokio::test]
    async fn request_response_precedes_its_node_info_refresh_and_tail_clears_connected()
    -> Result<()> {
        let fixture = fixture();
        let client_signing = SigningKey::from_bytes(&[3_u8; 32]);
        let client_key_bytes = client_signing.verifying_key().to_bytes();
        let client_key = bs58::encode(client_key_bytes).into_string();
        let accepted = {
            let mut locked = fixture.state.lock().expect("state");
            locked.config.jobs.minimum_free_bytes = 0;
            locked
                .config
                .authorize_key(&fixture.config_path, &client_key, None)?;
            let variant = InstalledVariant {
                model: "connection-test".into(),
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
                engine: "connection-test".into(),
                vram_bytes: 0,
                stages: Vec::new(),
                parameters: Vec::new(),
            };
            match locked.library.submit(
                PrincipalId::from_client_public_key(&client_key_bytes),
                &client_key_bytes,
                &Submission {
                    client_request_id: uuid::Uuid::new_v4().to_string(),
                    model: variant.selector(),
                    generation: cantor_proto::GenerationRequest {
                        caption: "connection ordering".into(),
                        lyrics: None,
                        duration: Some(15),
                        steps: Some(1),
                        cfg: None,
                        seed: Some(7),
                        extensions: None,
                    },
                },
                &variant,
                20,
                0,
            )? {
                SubmitResult::Accepted(job) => job,
                other => panic!("unexpected submission: {other:?}"),
            }
        };
        let (node, mut relay) = websocket_pair().await;
        let (event_sender, mut events) = mpsc::channel(8);
        let info = node_info(&fixture.state);

        let runner = run(
            node,
            &fixture.state,
            &mut events,
            &event_sender,
            &fixture.config_path,
            &fixture.public_key,
            &fixture.public_key_bytes,
            info,
        );
        let client = async {
            let mut secure = begin_secure_channel(&mut relay, &fixture.public_key_bytes).await;
            relay
                .send(secure.encrypt(&json!({
                    "v": cantor_proto::PROTOCOL_VERSION,
                    "t": "hello",
                    "id": "authenticate",
                    "pubkey": client_key,
                })))
                .await
                .expect("send hello");
            let challenge = secure.decrypt(next_message(&mut relay).await);
            assert_eq!(challenge["t"], "challenge");
            let nonce: [u8; 32] = URL_SAFE_NO_PAD
                .decode(challenge["nonce"].as_str().expect("challenge nonce"))
                .expect("challenge nonce base64url")
                .try_into()
                .expect("challenge nonce length");
            let signature = client_signing.sign(&node_auth_message(
                &fixture.public_key_bytes,
                &client_key_bytes,
                &nonce,
            ));
            relay
                .send(secure.encrypt(&json!({
                    "v": cantor_proto::PROTOCOL_VERSION,
                    "t": "auth",
                    "id": "authenticate",
                    "sig": URL_SAFE_NO_PAD.encode(signature.to_bytes()),
                })))
                .await
                .expect("send auth");
            let welcome = secure.decrypt(next_message(&mut relay).await);
            assert_eq!(welcome["t"], "welcome");

            relay
                .send(secure.encrypt(&json!({
                    "v": cantor_proto::PROTOCOL_VERSION,
                    "t": "job.pause",
                    "id": "pause",
                    "job_id": accepted.id,
                    "expected_revision": accepted.revision,
                })))
                .await
                .expect("send job control");
            let response = secure.decrypt(next_message(&mut relay).await);
            let refresh = secure.decrypt(next_message(&mut relay).await);
            assert_eq!(response["t"], "job.controlled");
            assert_eq!(response["id"], "pause");
            assert_eq!(refresh["t"], "node.info");
            relay.send(Message::Close(None)).await.expect("send Close");
        };
        let (result, ()) = tokio::join!(runner, client);

        assert!(result.is_err(), "relay Close ends the claimed runner");
        assert!(!fixture.state.lock().expect("state").connected);
        Ok(())
    }
}

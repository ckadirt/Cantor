//! The daemon's local control surface.
//!
//! The daemon owns `node.toml` and the in-memory allowlist, so a CLI that wrote
//! those files behind its back would be ignored until the next restart. Every
//! command that mutates state therefore goes through this socket and is applied
//! by the process that is actually serving clients.
//!
//! The wire format is line-delimited JSON using the same `{v, id, t, …}`
//! envelope as the app protocol, so the two stay legible side by side.

use crate::runtime::NodeEvent;

mod client;
mod commands;
mod server;
mod socket;
mod wire;

pub use client::{CLIENT_TIMEOUT, request, request_streaming};
#[cfg(test)]
use commands::dispatch;
pub use server::serve;
#[cfg(test)]
use server::serve_connection;
#[cfg(test)]
use socket::{
    CONTROL_GROUP, MAX_SOCKET_PATH_BYTES, SOCKET_MODE_PRIVATE, SOCKET_MODE_SHARED, group_id,
    is_root,
};
pub use socket::{bind, client_socket_path, default_socket_path, running_as_root};
#[cfg(test)]
use wire::MAX_REQUEST_BYTES;
#[allow(unused_imports)]
// Deliberate wire facade; callers should not reach into the child module.
pub use wire::{CONTROL_VERSION, Response};

// Keep the original control-module entry points available while downstream
// callers migrate to runtime ownership.
#[allow(unused_imports)]
pub use crate::runtime::{NodeState, SharedState, shared};

/// Compatibility name for callers that still treat relay effects as control
/// events. New runtime-facing code should use [`NodeEvent`].
#[allow(dead_code)] // Deliberate migration shim; production code uses NodeEvent.
pub type ControlEvent = NodeEvent;

#[cfg(test)]
mod tests {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt, symlink};
    use std::path::PathBuf;

    use serde_json::json;
    use tempfile::tempdir;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};
    use tokio::sync::mpsc;

    use super::{
        CONTROL_GROUP, ControlEvent, MAX_REQUEST_BYTES, MAX_SOCKET_PATH_BYTES, Response,
        SOCKET_MODE_PRIVATE, SOCKET_MODE_SHARED, bind, dispatch, group_id, is_root, request,
        request_streaming, serve_connection,
    };
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::identity::NodeIdentity;
    use crate::principal::PrincipalId;
    use crate::runtime::{NodeState, SharedState, shared};
    use crate::secure::TransportIdentity;

    fn state() -> (SharedState, tempfile::TempDir) {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let library =
            crate::library::Library::open(temporary.path().join("library")).expect("library");
        let (identity, _) = NodeIdentity::load_or_create(&paths.key).expect("identity");
        let (transport_identity, _) =
            TransportIdentity::load_or_create(&paths.transport_key, &identity)
                .expect("transport identity");
        let state = shared(NodeState {
            config,
            config_path: paths.config,
            node_public_key: bs58::encode([9_u8; 32]).into_string(),
            pair_offer: None,
            connected: true,
            library,
            job_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            delivery_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            active_job: None,
            shutting_down: false,
            transport_identity: std::sync::Arc::new(transport_identity),
        });
        (state, temporary)
    }

    fn encode(response: &Response) -> serde_json::Value {
        serde_json::to_value(response).expect("serialize")
    }

    fn scripted_server(
        reply: &'static str,
    ) -> (tempfile::TempDir, PathBuf, tokio::task::JoinHandle<()>) {
        let temporary = tempdir().expect("temporary directory");
        let socket_path = temporary.path().join("control.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind scripted server");
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept request");
            let mut stream = BufReader::new(stream);
            let mut request_line = String::new();
            stream
                .read_line(&mut request_line)
                .await
                .expect("read request");
            assert!(request_line.ends_with('\n'));
            let mut stream = stream.into_inner();
            if !reply.is_empty() {
                stream
                    .write_all(reply.as_bytes())
                    .await
                    .expect("write scripted response");
                stream.flush().await.expect("flush scripted response");
            }
        });
        (temporary, socket_path, task)
    }

    async fn next_frame(
        lines: &mut tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    ) -> serde_json::Value {
        let line = lines
            .next_line()
            .await
            .expect("read response")
            .expect("response line");
        serde_json::from_str(&line).expect("valid response JSON")
    }

    #[test]
    fn bind_refuses_to_replace_a_symlink() {
        let temporary = tempdir().expect("temporary directory");
        let socket_path = temporary.path().join("control.sock");
        symlink(temporary.path().join("elsewhere"), &socket_path).expect("create symlink");

        let error = bind(&socket_path).expect_err("symlink must be refused");

        assert!(
            error
                .to_string()
                .contains("refusing to replace symlinked control socket")
        );
        assert!(
            std::fs::symlink_metadata(&socket_path)
                .expect("symlink remains")
                .file_type()
                .is_symlink()
        );
    }

    #[tokio::test]
    async fn bind_replaces_a_stale_socket_and_sets_the_selected_mode() {
        let temporary = tempdir().expect("temporary directory");
        let socket_path = temporary.path().join("control.sock");
        let first = bind(&socket_path).expect("first bind");
        drop(first);
        assert!(
            std::fs::symlink_metadata(&socket_path)
                .expect("stale socket")
                .file_type()
                .is_socket()
        );

        let second = bind(&socket_path).expect("replace stale socket");
        let actual_mode = std::fs::metadata(&socket_path)
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777;
        let expected_mode = if is_root() && group_id(CONTROL_GROUP).is_some() {
            SOCKET_MODE_SHARED
        } else {
            SOCKET_MODE_PRIVATE
        };

        assert_eq!(actual_mode, expected_mode);
        drop(second);
    }

    #[test]
    fn bind_rejects_a_path_at_the_kernel_bound() {
        let temporary = tempdir().expect("temporary directory");
        let prefix_bytes = temporary.path().as_os_str().as_bytes().len() + 1;
        let socket_path = temporary
            .path()
            .join("x".repeat(MAX_SOCKET_PATH_BYTES - prefix_bytes));
        assert_eq!(
            socket_path.as_os_str().as_bytes().len(),
            MAX_SOCKET_PATH_BYTES
        );

        let error = bind(&socket_path).expect_err("path at bound must be rejected");

        assert!(error.to_string().contains("the kernel limit is 107"));
        assert!(!socket_path.exists());
    }

    #[tokio::test]
    async fn one_connection_survives_malformed_and_long_request_errors() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);
        let (server, client) = UnixStream::pair().expect("socket pair");
        let server_task = tokio::spawn(serve_connection(server, state, events));
        let (reader, mut writer) = client.into_split();
        let mut lines = BufReader::new(reader).lines();
        let requests = [
            "{not json",
            r#"{"v":9,"id":"short-version","t":"status"}"#,
            r#"{"id":"missing-long-version","t":"generate"}"#,
            r#"{"v":9,"id":"wrong-long-version","t":"generate"}"#,
            r#"{"v":1,"id":"last","t":"status"}"#,
        ];
        for request in requests {
            writer
                .write_all(format!("{request}\n").as_bytes())
                .await
                .expect("write request");
        }
        writer.flush().await.expect("flush requests");

        let malformed = next_frame(&mut lines).await;
        assert_eq!(malformed["t"], "error");
        assert_eq!(malformed["code"], "invalid-request");

        let short_version = next_frame(&mut lines).await;
        assert_eq!(short_version["t"], "error");
        assert_eq!(short_version["code"], "failed");
        assert_eq!(short_version["id"], "short-version");
        assert!(
            short_version["msg"]
                .as_str()
                .expect("message")
                .contains("control protocol version 9 is not supported")
        );

        for id in ["missing-long-version", "wrong-long-version"] {
            let long_version = next_frame(&mut lines).await;
            assert_eq!(long_version["t"], "error");
            assert_eq!(long_version["code"], "failed");
            assert_eq!(long_version["id"], id);
            assert_eq!(long_version["msg"], "generate needs a caption");
        }

        let last = next_frame(&mut lines).await;
        assert_eq!(last["t"], "status");
        assert_eq!(last["id"], "last");

        writer.shutdown().await.expect("close request half");
        server_task
            .await
            .expect("server task")
            .expect("connection completes");
    }

    #[tokio::test]
    async fn request_budget_is_shared_by_the_whole_connection() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);
        let (server, client) = UnixStream::pair().expect("socket pair");
        let server_task = tokio::spawn(serve_connection(server, state, events));
        let (reader, mut writer) = client.into_split();
        let mut lines = BufReader::new(reader).lines();

        let sample = json!({
            "v": 1,
            "id": "first",
            "t": "status",
            "padding": "x",
        })
        .to_string();
        let target_line_bytes = MAX_REQUEST_BYTES as usize - 8 - 1;
        let padding_bytes = target_line_bytes - (sample.len() - 1);
        let first = json!({
            "v": 1,
            "id": "first",
            "t": "status",
            "padding": "x".repeat(padding_bytes),
        })
        .to_string();
        assert_eq!(first.len() + 1, MAX_REQUEST_BYTES as usize - 8);
        let second = json!({"v": 1, "id": "second", "t": "status"}).to_string();

        writer
            .write_all(format!("{first}\n{second}\n").as_bytes())
            .await
            .expect("write requests");
        writer.shutdown().await.expect("close request half");

        let first_response = next_frame(&mut lines).await;
        assert_eq!(first_response["t"], "status");
        assert_eq!(first_response["id"], "first");
        let truncated_response = next_frame(&mut lines).await;
        assert_eq!(truncated_response["t"], "error");
        assert_eq!(truncated_response["code"], "invalid-request");
        assert_ne!(truncated_response["id"], "second");

        server_task
            .await
            .expect("server task")
            .expect("connection completes at byte budget");
    }

    #[tokio::test]
    async fn one_shot_client_characterizes_blank_error_and_eof_responses() {
        let (_guard, path, server) = scripted_server("\n");
        let error = request(&path, &json!({"request": "blank"}))
            .await
            .expect_err("blank response must fail");
        assert!(error.to_string().contains("invalid response"));
        server.await.expect("blank server");

        let (_guard, path, server) = scripted_server(
            "{\"v\":1,\"id\":\"one\",\"t\":\"error\",\"code\":\"bad\",\"msg\":\"boom\"}\n",
        );
        let error = request(&path, &json!({"request": "error"}))
            .await
            .expect_err("error response must fail");
        assert_eq!(error.to_string(), "boom [bad]");
        server.await.expect("error server");

        let (_guard, path, server) = scripted_server("");
        let error = request(&path, &json!({"request": "eof"}))
            .await
            .expect_err("EOF must fail");
        assert_eq!(
            error.to_string(),
            "the node closed the control connection without answering"
        );
        server.await.expect("EOF server");
    }

    #[tokio::test]
    async fn streaming_client_preserves_callback_and_terminal_order() {
        let (_guard, path, server) = scripted_server(
            "{\"v\":1,\"id\":\"s\",\"t\":\"note\"}\n\
             {\"v\":1,\"id\":\"s\",\"t\":\"progress\"}\n\
             {\"v\":1,\"id\":\"s\",\"t\":\"ok\"}\n",
        );
        let mut callbacks = Vec::new();
        let terminal = request_streaming(&path, &json!({"request": "stream"}), |frame| {
            callbacks.push(frame["t"].as_str().expect("frame kind").to_owned());
        })
        .await
        .expect("stream completes");
        assert_eq!(callbacks, ["note", "progress"]);
        assert_eq!(terminal["t"], "ok");
        server.await.expect("stream server");

        let (_guard, path, server) =
            scripted_server("{\"v\":1,\"id\":\"c\",\"t\":\"catalog\",\"models\":[]}\n");
        let mut callbacks = Vec::new();
        let terminal = request_streaming(&path, &json!({"request": "catalog"}), |frame| {
            callbacks.push(frame.clone());
        })
        .await
        .expect("catalog completes");
        assert!(callbacks.is_empty());
        assert_eq!(terminal["t"], "catalog");
        server.await.expect("catalog server");

        let (_guard, path, server) = scripted_server("{\"v\":1,\"id\":\"e\",\"t\":\"note\"}\n");
        let mut callbacks = Vec::new();
        let error = request_streaming(&path, &json!({"request": "eof"}), |frame| {
            callbacks.push(frame["t"].as_str().expect("frame kind").to_owned());
        })
        .await
        .expect_err("EOF before terminal must fail");
        assert_eq!(callbacks, ["note"]);
        assert_eq!(
            error.to_string(),
            "the node closed the control connection without finishing"
        );
        server.await.expect("EOF server");
    }

    #[test]
    fn a_pair_request_creates_a_bounded_offer() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"pair","expires_in":60}).to_string(),
            &state,
            &events,
        );
        let value = encode(&response);
        assert_eq!(value["t"], "pair");
        assert_eq!(value["expires_in"], 60);
        assert!(
            value["uri"]
                .as_str()
                .expect("uri")
                .starts_with("cantor://pair?")
        );
        assert!(state.lock().expect("state").pair_offer.is_some());
    }

    /// Revoking has to disconnect a device that is currently connected, so the
    /// relay loop must be told; the config write alone is not enough.
    #[test]
    fn revoking_writes_the_config_and_signals_the_relay_loop() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);
        {
            let mut locked = state.lock().expect("state");
            let path = locked.config_path.clone();
            locked
                .config
                .authorize_key(&path, "device-key", Some("Phone".to_owned()))
                .expect("authorize");
        }

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"revoke","selector":"Phone"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        assert!(
            !state
                .lock()
                .expect("state")
                .config
                .is_authorized("device-key")
        );
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::Revoked(key) if key == "device-key"
        ));
    }

    #[test]
    fn revoking_a_real_principal_holds_its_queued_work() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);
        let public_key_bytes = [7_u8; 32];
        let public_key = bs58::encode(public_key_bytes).into_string();
        let principal = PrincipalId::from_client_public_key(&public_key_bytes);
        {
            let mut locked = state.lock().expect("state");
            let path = locked.config_path.clone();
            locked
                .config
                .authorize_key(&path, &public_key, Some("Phone".to_owned()))
                .expect("authorize");
            let variant = crate::store::InstalledVariant {
                model: "acestep".into(),
                tag: "1.5-fast".into(),
                licence: String::new(),
                components: vec![crate::catalog::Component {
                    role: "model".into(),
                    blob: format!("sha256:{}", "a".repeat(64)),
                    url: "u".into(),
                    bytes: 1,
                    quant: None,
                }],
                installed_at: String::new(),
                engine: "acestep".into(),
                vram_bytes: 0,
                stages: Vec::new(),
                parameters: Vec::new(),
                lyrics: None,
            };
            locked
                .library
                .submit(
                    principal,
                    &public_key_bytes,
                    &crate::library::Submission {
                        client_request_id: uuid::Uuid::new_v4().to_string(),
                        model: variant.selector(),
                        generation: cantor_proto::GenerationRequest {
                            caption: "held".into(),
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
                )
                .expect("submit");
        }

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"revoke","selector":"Phone"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        let locked = state.lock().expect("state");
        assert_eq!(
            locked.library.list(principal, 10).unwrap()[0].state,
            cantor_proto::JobState::Paused
        );
        drop(locked);
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::Revoked(key) if key == public_key
        ));
    }

    #[test]
    fn renaming_the_node_asks_for_a_node_info_push() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"rename-node","name":"studio"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        assert_eq!(state.lock().expect("state").config.name, "studio");
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::NodeInfoChanged
        ));
    }

    #[test]
    fn a_failed_config_write_rolls_back_state_and_emits_no_effect() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);
        let (config_path, original_name) = {
            let locked = state.lock().expect("state");
            (locked.config_path.clone(), locked.config.name.clone())
        };
        std::fs::remove_file(&config_path).expect("remove writable config");
        std::fs::create_dir(&config_path).expect("replace config with an unwritable target");

        let response = dispatch(
            &json!({"v":1,"id":"persist","t":"rename-node","name":"must-not-stick"}).to_string(),
            &state,
            &events,
        );

        let value = encode(&response);
        assert_eq!(value["t"], "error");
        assert_eq!(value["id"], "persist");
        assert_eq!(value["code"], "failed");
        assert_eq!(state.lock().expect("state").config.name, original_name);
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn an_unknown_selector_is_an_error_rather_than_a_guess() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);

        let response = dispatch(
            &json!({"v":1,"id":"7","t":"revoke","selector":"nothing"}).to_string(),
            &state,
            &events,
        );
        let value = encode(&response);
        assert_eq!(value["t"], "error");
        assert_eq!(value["id"], "7");
    }

    #[test]
    fn a_malformed_request_does_not_kill_the_connection() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);

        let value = encode(&dispatch("{not json", &state, &events));
        assert_eq!(value["t"], "error");
        assert_eq!(value["code"], "invalid-request");
    }
}

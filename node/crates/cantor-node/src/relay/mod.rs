mod carrier;
mod client;
mod connection;
mod effects;
mod node_info;
mod sessions;

use std::path::Path;

use anyhow::{Result, bail};
use cantor_proto::{NodeInfo, NodeMessage};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::application::RequestContext;
use crate::runtime::{NodeEvent, SharedState};
use crate::session::ClientSession;

use self::carrier::RELAY_VERSION;
use self::effects::execute_application_effects;
use self::node_info::static_node_info;

pub use self::client::run_forever;

fn lock(state: &SharedState) -> Result<std::sync::MutexGuard<'_, crate::runtime::NodeState>> {
    state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is poisoned"))
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
    let outcome = crate::application::handle_application(
        session,
        payload,
        RequestContext {
            config: &mut locked.config,
            config_path,
            pair_offer: &mut locked.pair_offer,
            node_public_key: public_key,
            node_info,
            library: &mut locked.library,
        },
    )?;
    let refresh_node_info = execute_application_effects(locked, outcome.effects, event_sender);
    Ok((outcome.response, refresh_node_info))
}

fn bail_relay_error<T>(v: u8, code: &str, msg: &str) -> Result<T> {
    if v != RELAY_VERSION {
        bail!("relay protocol version {v} is not supported");
    }
    bail!("relay error ({code}): {msg}")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU8, Ordering};

    use futures_util::FutureExt;
    use serde_json::{Value, json};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

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

    use super::carrier::parse_node_secure_carrier;
    use super::client::{RECONNECT_MAX_MS, reconnect_delay};
    use super::sessions::SessionRegistry;
    use super::{NodeEvent, dispatch_application, static_node_info};

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
            stages: Vec::new(),
            parameters: Vec::new(),
            lyrics: None,
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
            stages: variant.stages.clone(),
            parameters: variant.parameters.clone(),
            lyrics: variant.lyrics.clone(),
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
                        extensions: None,
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
        let mut sessions = SessionRegistry::default();
        sessions.insert_for_test(
            OWNER_SID,
            secure_authenticated(&state, OWNER_SID, "owner-key", [1; 32]),
        );
        sessions.insert_for_test(
            OTHER_SID,
            secure_authenticated(&state, OTHER_SID, "other-key", [2; 32]),
        );
        let principal_id = PrincipalId::from_client_public_key(&[1_u8; 32]);
        let frames = sessions
            .apply_control_event(
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
        let mut sessions = SessionRegistry::default();
        sessions.insert_for_test(
            OWNER_SID,
            secure_authenticated(&state, OWNER_SID, "owner-key", [1; 32]),
        );
        sessions.insert_for_test(
            OTHER_SID,
            secure_authenticated(&state, OTHER_SID, "other-key", [2; 32]),
        );
        let principal_id = PrincipalId::from_client_public_key(&[1_u8; 32]);
        let frames = sessions
            .apply_control_event(
                NodeEvent::LibraryChanged {
                    principal_id,
                    revision: 7,
                },
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
        let mut sessions = SessionRegistry::default();
        let node_ed25519 = [9_u8; 32];

        for frame in [
            r#"{"v":1,"t":"relay.somethingNew","detail":"from a newer relay"}"#,
            r#"{"v":2,"t":"tunnel","sid":"s","payload":{}}"#,
            r#"{"v":2,"t":"relay.detached","sid":"s"}"#,
            "not json at all",
            "",
        ] {
            let response = sessions
                .handle_text(frame, &state, &node_ed25519)
                .expect("unrecognised frames must not be errors");
            assert!(response.is_none(), "unexpected reply to {frame}");
        }
    }

    /// A relay-level error is about this connection specifically, so unlike an
    /// unknown frame it still ends it.
    #[test]
    fn a_relay_error_still_ends_the_connection() {
        let (state, _config_path, _guard) = fixture();

        let result = SessionRegistry::default().handle_text(
            r#"{"v":1,"t":"relay.error","code":"bad-claim","msg":"nope"}"#,
            &state,
            &[9_u8; 32],
        );

        assert!(result.is_err());
    }

    #[test]
    fn failed_handshake_entries_are_retained_and_an_invalid_sid_is_not_inserted() {
        let (state, _config_path, _guard) = fixture();
        let mut sessions = SessionRegistry::default();
        let invalid_handshake = json!({
            "v": 1,
            "t": "tunnel",
            "sid": OWNER_SID,
            "payload": {"v": 1, "t": "secure.init"}
        })
        .to_string();

        for _ in 0..2 {
            let response = sessions
                .handle_text(&invalid_handshake, &state, &[9_u8; 32])
                .expect("handshake failure is isolated")
                .expect("handshake error response")
                .0;
            let envelope: Value = serde_json::from_str(response.to_text().expect("text response"))
                .expect("tunnel response");
            assert_eq!(envelope["payload"]["code"], "handshake-failed");
        }
        assert_eq!(sessions.len_for_test(), 1);
        assert!(sessions.contains_for_test(OWNER_SID));
        assert!(sessions.can_open_for_test(OWNER_SID, 1));

        let invalid_sid = json!({
            "v": 1,
            "t": "tunnel",
            "sid": "not-a-uuid",
            "payload": {"v": 1, "t": "secure.init"}
        })
        .to_string();
        let response = sessions
            .handle_text(&invalid_sid, &state, &[9_u8; 32])
            .expect("invalid sid is isolated")
            .expect("unavailable response")
            .0;
        let envelope: Value = serde_json::from_str(response.to_text().expect("text response"))
            .expect("tunnel response");
        assert_eq!(envelope["payload"]["code"], "temporarily-unavailable");
        assert_eq!(sessions.len_for_test(), 1);
        assert!(!sessions.contains_for_test("not-a-uuid"));

        let detached = json!({"v": 1, "t": "relay.detached", "sid": OWNER_SID}).to_string();
        assert!(
            sessions
                .handle_text(&detached, &state, &[9_u8; 32])
                .expect("detach")
                .is_none()
        );
        assert_eq!(sessions.len_for_test(), 0);
    }

    /// Revoking someone who is connected right now has to cut them off, not wait
    /// for their next handshake. `rejected` is the code the app treats as final.
    #[test]
    fn revoking_drops_the_live_sessions_that_used_that_key() {
        let (state, _config_path, _guard) = fixture();
        let locked = state.lock().expect("state");
        let mut node_info = static_node_info(&locked.config, &locked.library);
        drop(locked);
        let mut sessions = SessionRegistry::default();
        sessions.insert_for_test(
            OWNER_SID,
            secure_authenticated(&state, OWNER_SID, "revoked-key", [1; 32]),
        );
        sessions.insert_for_test(
            OTHER_SID,
            secure_authenticated(&state, OTHER_SID, "other-key", [2; 32]),
        );

        let frames = sessions
            .apply_control_event(
                NodeEvent::Revoked("revoked-key".to_owned()),
                &state,
                &mut node_info,
            )
            .expect("revoke");

        assert_eq!(frames.len(), 1);
        assert_eq!(encrypted_sid(&frames[0]), OWNER_SID);
        assert_eq!(
            sessions
                .get_for_test(OWNER_SID)
                .expect("owner session")
                .authenticated_key(),
            None
        );
        // The device that was not revoked keeps its session.
        assert_eq!(
            sessions
                .get_for_test(OTHER_SID)
                .expect("other session")
                .authenticated_key(),
            Some("other-key")
        );
    }

    /// A connected app is told about a rename rather than showing the old name
    /// until it happens to reconnect.
    #[test]
    fn renaming_the_node_pushes_node_info_to_authenticated_sessions_only() {
        let (state, config_path, _guard) = fixture();
        let locked = state.lock().expect("state");
        let mut node_info = static_node_info(&locked.config, &locked.library);
        drop(locked);
        let mut sessions = SessionRegistry::default();
        sessions.insert_for_test(
            OWNER_SID,
            secure_authenticated(&state, OWNER_SID, "key", [1; 32]),
        );
        sessions.insert_for_test(OTHER_SID, ClientSession::default());
        state
            .lock()
            .expect("state")
            .config
            .rename_node(&config_path, "studio-node")
            .expect("rename");

        let frames = sessions
            .apply_control_event(NodeEvent::NodeInfoChanged, &state, &mut node_info)
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
        let mut sessions = SessionRegistry::default();
        sessions.insert_for_test("existing", ClientSession::default());

        assert!(sessions.can_open_for_test("existing", 1));
        assert!(!sessions.can_open_for_test("new", 1));
    }
}

use std::path::Path;

use anyhow::Result;
use cantor_proto::{NodeInfo, NodeMessage};
use serde_json::Value;

use crate::config::NodeConfig;
use crate::library::Library;
use crate::pairing::PairOffer;
use crate::secure::{SecureSession, TransportIdentity};

use super::auth::{AuthSession, AuthenticatedSession};
use super::transfers::ArtifactTransferSession;

#[derive(Default)]
pub struct ClientSession {
    secure: SecureSession,
    auth: AuthSession,
    transfers: ArtifactTransferSession,
}

impl ClientSession {
    pub fn secure_ready(&self) -> bool {
        self.secure.is_ready()
    }

    pub fn handle_secure_text(
        &mut self,
        payload: &Value,
        transport: &TransportIdentity,
        node_ed25519: &[u8; 32],
    ) -> Result<Value> {
        self.secure.handle_text(payload, transport, node_ed25519)
    }

    pub fn decrypt_secure(&mut self, ciphertext: &[u8]) -> Result<Option<Value>> {
        self.secure.decrypt_application(ciphertext)
    }

    pub fn encrypt_secure(&mut self, message: &NodeMessage) -> Result<Vec<Vec<u8>>> {
        self.secure.encrypt_application(message)
    }

    pub fn close_secure(&mut self) {
        self.secure.fail();
    }

    pub fn authenticated_key(&self) -> Option<&str> {
        self.auth.authenticated_key()
    }

    pub fn authenticated(&self) -> Option<&AuthenticatedSession> {
        self.auth.authenticated()
    }

    pub fn set_relay_session_id(&mut self, relay_session_id: &str) {
        self.auth.set_relay_session_id(relay_session_id);
    }

    /// Undoes authentication in place. The caller is responsible for telling the
    /// client why; this only makes sure nothing further is served on the session.
    pub fn deauthenticate(&mut self) {
        self.auth.deauthenticate();
        self.transfers.reset();
    }

    pub(super) fn handle_hello(
        &mut self,
        version: u8,
        id: String,
        public_key: String,
        pair_proof: Option<String>,
        petname: Option<String>,
        node_public_key: &str,
    ) -> Result<NodeMessage> {
        self.auth.handle_hello(
            version,
            id,
            public_key,
            pair_proof,
            petname,
            node_public_key,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_auth(
        &mut self,
        version: u8,
        id: String,
        signature: String,
        config: &mut NodeConfig,
        config_path: &Path,
        active_pair_offer: &mut Option<PairOffer>,
        node_public_key: &str,
        node_info: &NodeInfo,
    ) -> Result<NodeMessage> {
        let outcome = self.auth.handle_auth(
            version,
            id,
            signature,
            config,
            config_path,
            active_pair_offer,
            node_public_key,
            node_info,
        )?;
        if outcome.reset_transfer {
            self.transfers.reset();
        }
        Ok(outcome.response)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_artifact_open(
        &mut self,
        version: u8,
        id: String,
        song_id: String,
        profile: String,
        offset: u64,
        expected_sha256: Option<String>,
        library: &Library,
    ) -> NodeMessage {
        let principal_id = self.authenticated().map(|value| value.principal_id);
        self.transfers.handle_open(
            version,
            id,
            song_id,
            profile,
            offset,
            expected_sha256,
            principal_id,
            library,
        )
    }

    pub(super) fn handle_artifact_ack(
        &mut self,
        version: u8,
        id: String,
        transfer_id: String,
        next_offset: u64,
    ) -> NodeMessage {
        let principal_id = self.authenticated().map(|value| value.principal_id);
        self.transfers
            .handle_ack(version, id, transfer_id, next_offset, principal_id)
    }

    #[cfg(test)]
    pub fn authenticated_with_bytes_for_test(key: &str, bytes: [u8; 32]) -> Self {
        Self {
            secure: SecureSession::default(),
            auth: AuthSession::authenticated_with_bytes(key, bytes),
            transfers: ArtifactTransferSession::default(),
        }
    }

    #[cfg(test)]
    pub fn establish_secure_for_test(
        &mut self,
        transport: &TransportIdentity,
        node_ed25519: &[u8; 32],
    ) {
        self.secure =
            SecureSession::ready_for_test(transport, node_ed25519).expect("test secure session");
    }
}

impl ClientSession {
    #[allow(clippy::too_many_arguments)]
    pub fn handle(
        &mut self,
        payload: Value,
        config: &mut NodeConfig,
        config_path: &Path,
        active_pair_offer: &mut Option<PairOffer>,
        node_public_key: &str,
        node_info: &NodeInfo,
        library: &mut Library,
    ) -> Result<NodeMessage> {
        super::router::handle(
            self,
            payload,
            config,
            config_path,
            active_pair_offer,
            node_public_key,
            node_info,
            library,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use cantor_proto::{
        ErrorCode, ModelView, NodeFeatures, NodeInfo, NodeLimits, NodeLoad, NodeMessage,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use tempfile::tempdir;

    use super::ClientSession;
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::library::Library;
    use crate::pairing::{DEFAULT_PAIR_TTL, PairOffer};

    fn info() -> NodeInfo {
        NodeInfo {
            name: "test-node".to_owned(),
            device_type: "linux".to_owned(),
            engine_version: "ace-step-1.5-stub".to_owned(),
            models: vec![ModelView {
                selector: "acestep:1.5-fast".to_owned(),
                family: "acestep".to_owned(),
                engine: "acestep".to_owned(),
                stages: None,
                parameters: None,
                lyrics: None,
            }],
            limits: NodeLimits {
                max_concurrent_jobs: 0,
                max_queued_jobs_per_principal: 32,
                min_song_seconds: 15,
                max_song_seconds: 600,
                max_caption_bytes: 1_024,
                max_lyrics_bytes: 65_536,
                max_page_limit: 100,
            },
            load: NodeLoad {
                active_jobs: 0,
                queued_jobs: 0,
                accepting_jobs: false,
                unavailable_reason: Some("durable_jobs_not_enabled".to_owned()),
            },
            features: NodeFeatures {
                jobs_create: false,
                library_list: false,
                artifacts_transfer: false,
                secure_tunnel: false,
                job_controls: false,
            },
        }
    }

    fn config(path: &Path) -> (NodeConfig, NodePaths) {
        let paths = NodePaths::resolve(Some(path.join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        (config, paths)
    }

    fn delivery_fixture(root: &Path, key: [u8; 32]) -> (Library, String, String) {
        let library = Library::open(root.join("library")).unwrap();
        let (song_id, digest) = library.seed_delivery_fixture_for_test(key);
        (library, song_id, digest)
    }

    fn seed_dummy_transfer(session: &mut ClientSession, root: &Path, key: [u8; 32]) {
        session.transfers.seed_for_test(root, key);
    }

    #[test]
    fn hello_clears_auth_and_pending_before_version_but_preserves_transfer() {
        let temporary = tempdir().unwrap();
        let (mut config, paths) = config(temporary.path());
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let mut offer = None;
        let node_key = bs58::encode([8_u8; 32]).into_string();
        let client_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = bs58::encode(client_key.verifying_key().as_bytes()).into_string();
        let mut session = ClientSession::authenticated_with_bytes_for_test(
            &bs58::encode([1_u8; 32]).into_string(),
            [1_u8; 32],
        );
        seed_dummy_transfer(&mut session, temporary.path(), [1_u8; 32]);

        let unsupported = session
            .handle(
                json!({"t":"hello","v":1,"id":"old","pubkey":"not-checked"}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert!(matches!(
            unsupported,
            NodeMessage::Error {
                code: ErrorCode::UnsupportedVersion,
                ..
            }
        ));
        assert!(session.authenticated().is_none());
        assert!(session.transfers.is_active());

        assert!(matches!(
            session
                .handle(
                    json!({"t":"hello","v":2,"id":"pending","pubkey":public_key}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Challenge { .. }
        ));
        assert!(matches!(
            session
                .handle(
                    json!({"t":"hello","v":1,"id":"clear-pending","pubkey":"not-checked"}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Error {
                code: ErrorCode::UnsupportedVersion,
                ..
            }
        ));
        assert!(matches!(
            session
                .handle(
                    json!({"t":"auth","v":2,"id":"pending","sig":"bad"}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Error {
                code: ErrorCode::Unauthenticated,
                ..
            }
        ));
        assert!(session.transfers.is_active());
    }

    #[test]
    fn auth_version_preserves_but_mismatch_and_bad_signature_consume_the_challenge() {
        let temporary = tempdir().unwrap();
        let (mut config, paths) = config(temporary.path());
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let mut offer = None;
        let node_key = bs58::encode([8_u8; 32]).into_string();
        let public_key = bs58::encode(
            SigningKey::from_bytes(&[7_u8; 32])
                .verifying_key()
                .as_bytes(),
        )
        .into_string();
        let mut session = ClientSession::default();

        assert!(matches!(
            session
                .handle(
                    json!({"t":"hello","v":2,"id":"challenge","pubkey":public_key}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Challenge { .. }
        ));
        assert!(matches!(
            session
                .handle(
                    json!({"t":"auth","v":1,"id":"challenge","sig":"bad"}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Error {
                code: ErrorCode::UnsupportedVersion,
                ..
            }
        ));
        assert!(matches!(
            session
                .handle(
                    json!({"t":"auth","v":2,"id":"mismatch","sig":"bad"}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Error {
                code: ErrorCode::InvalidRequest,
                ..
            }
        ));
        assert!(matches!(
            session
                .handle(
                    json!({"t":"auth","v":2,"id":"challenge","sig":"bad"}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Error {
                code: ErrorCode::Unauthenticated,
                ..
            }
        ));

        assert!(matches!(
            session
                .handle(
                    json!({"t":"hello","v":2,"id":"bad-sig","pubkey":public_key}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Challenge { .. }
        ));
        assert!(matches!(
            session
                .handle(
                    json!({"t":"auth","v":2,"id":"bad-sig","sig":"bad"}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Error {
                code: ErrorCode::Rejected,
                ..
            }
        ));
        assert!(matches!(
            session
                .handle(
                    json!({"t":"auth","v":2,"id":"bad-sig","sig":"bad"}),
                    &mut config,
                    &paths.config,
                    &mut offer,
                    &node_key,
                    &info(),
                    &mut library,
                )
                .unwrap(),
            NodeMessage::Error {
                code: ErrorCode::Unauthenticated,
                ..
            }
        ));
    }

    #[test]
    fn application_errors_keep_correlation_and_check_version_before_authentication() {
        let temporary = tempdir().unwrap();
        let (mut config, paths) = config(temporary.path());
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let mut offer = None;
        let node_key = bs58::encode([8_u8; 32]).into_string();
        let mut session = ClientSession::default();

        let malformed = session
            .handle(
                json!({"t":"future.message","v":2,"id":"bad-shape"}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(malformed).unwrap(),
            json!({
                "t":"error", "v":2, "id":"bad-shape", "code":"invalid_request",
                "message":"The application message is not valid.", "retryable":false
            })
        );

        let old_version = session
            .handle(
                json!({"t":"status","v":1,"id":"old-version"}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(old_version).unwrap(),
            json!({
                "t":"error", "v":2, "id":"old-version", "code":"unsupported_version",
                "message":"This app and node use incompatible protocol versions.",
                "retryable":false,
                "details":{"kind":"supported_version","minimum":2,"maximum":2}
            })
        );

        let unauthenticated = session
            .handle(
                json!({"t":"status","v":2,"id":"needs-auth"}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(unauthenticated).unwrap(),
            json!({
                "t":"error", "v":2, "id":"needs-auth", "code":"unauthenticated",
                "message":"Authenticate before requesting status.", "retryable":false
            })
        );

        let extra_field = session
            .handle(
                json!({"t":"status","v":2,"id":"forward-compatible","future_hint":true}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(extra_field).unwrap(),
            json!({
                "t":"error", "v":2, "id":"forward-compatible", "code":"unauthenticated",
                "message":"Authenticate before requesting status.", "retryable":false
            })
        );
    }

    #[test]
    fn artifact_transfer_is_owner_scoped_resumable_and_acknowledged() {
        let temporary = tempdir().unwrap();
        let (mut config, paths) = config(temporary.path());
        let (mut library, song_id, digest) = delivery_fixture(temporary.path(), [1_u8; 32]);
        let mut offer = None;
        let node_key = bs58::encode([8_u8; 32]).into_string();
        let mut owner = ClientSession::authenticated_with_bytes_for_test(
            &bs58::encode([1_u8; 32]).into_string(),
            [1_u8; 32],
        );
        let opened = owner
            .handle(
                json!({"t":"artifact.open","v":2,"id":"open","song_id":song_id,
                       "profile":"opus-stereo-160k-v1","offset":4,
                       "expected_sha256":digest}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        let transfer_id = match opened {
            NodeMessage::ArtifactInfo {
                transfer_id,
                accepted_offset,
                artifact,
                ..
            } => {
                assert_eq!(accepted_offset, 4);
                assert_eq!(artifact.sha256, digest);
                transfer_id
            }
            other => panic!("unexpected open response: {other:?}"),
        };
        let chunk = owner
            .handle(
                json!({"t":"artifact.ack","v":2,"id":"ack","transfer_id":transfer_id,
                       "next_offset":4}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert!(matches!(
            chunk,
            NodeMessage::ArtifactChunk { offset: 4, ref data, .. }
                if base64::engine::general_purpose::STANDARD.decode(data).unwrap().len() == 96
        ));
        let completed = owner
            .handle(
                json!({"t":"artifact.ack","v":2,"id":"done","transfer_id":transfer_id,
                       "next_offset":100}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert!(matches!(
            completed,
            NodeMessage::ArtifactComplete {
                byte_length: 100,
                ..
            }
        ));

        let mut stranger = ClientSession::authenticated_with_bytes_for_test(
            &bs58::encode([3_u8; 32]).into_string(),
            [3_u8; 32],
        );
        let hidden = stranger
            .handle(
                json!({"t":"artifact.open","v":2,"id":"foreign","song_id":song_id,
                       "profile":"opus-stereo-160k-v1","offset":0}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert!(matches!(
            hidden,
            NodeMessage::Error {
                code: ErrorCode::ArtifactUnavailable,
                ..
            }
        ));
    }

    fn authenticate(token: Option<&str>) -> (NodeMessage, NodeConfig, Option<PairOffer>, bool) {
        authenticate_with_petname(token, None)
    }

    fn authenticate_with_petname(
        token: Option<&str>,
        petname: Option<&str>,
    ) -> (NodeMessage, NodeConfig, Option<PairOffer>, bool) {
        let temporary = tempdir().expect("temporary directory");
        let (mut config, paths) = config(temporary.path());
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = bs58::encode(signing_key.verifying_key().as_bytes()).into_string();
        let node_signing_key = SigningKey::from_bytes(&[8_u8; 32]);
        let node_public_key =
            bs58::encode(node_signing_key.verifying_key().as_bytes()).into_string();
        let pair_proof = token.map(|token| {
            use hmac::{Hmac, Mac};
            use sha2::Sha256;

            let token = URL_SAFE_NO_PAD.decode(token).expect("pair token");
            let mut mac = Hmac::<Sha256>::new_from_slice(&token).expect("HMAC key");
            mac.update(b"cantor-pair-proof-v1");
            mac.update(node_signing_key.verifying_key().as_bytes());
            mac.update(signing_key.verifying_key().as_bytes());
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        });
        let mut session = ClientSession::default();
        seed_dummy_transfer(&mut session, temporary.path(), [7_u8; 32]);
        let mut active_token =
            token.map(|token| PairOffer::new(token.to_owned(), DEFAULT_PAIR_TTL));
        let challenge = session
            .handle(
                json!({"t":"hello","v":2,"id":"1","pubkey":public_key,"pair_proof":pair_proof,"petname":petname}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
                &mut library,
            )
            .expect("hello");
        let nonce = match challenge {
            NodeMessage::Challenge { nonce, .. } => URL_SAFE_NO_PAD.decode(nonce).expect("nonce"),
            other => panic!("unexpected: {other:?}"),
        };
        let nonce = <[u8; 32]>::try_from(nonce.as_slice()).expect("32-byte nonce");
        let message = crate::signing::node_auth_message(
            &node_signing_key.verifying_key().to_bytes(),
            &signing_key.verifying_key().to_bytes(),
            &nonce,
        );
        let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(&message).to_bytes());
        let response = session
            .handle(
                json!({"t":"auth","v":2,"id":"1","sig":signature}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
                &mut library,
            )
            .expect("auth");
        (
            response,
            config,
            active_token,
            session.transfers.is_active(),
        )
    }

    #[test]
    fn pairing_token_enrolls_a_verified_key_once() {
        let token = URL_SAFE_NO_PAD.encode([6_u8; 32]);
        let (response, config, active_token, transfer_present) = authenticate(Some(&token));
        assert!(matches!(response, NodeMessage::Welcome { .. }));
        assert_eq!(config.pairings.len(), 1);
        assert!(active_token.is_none());
        assert!(!transfer_present);
    }

    #[test]
    fn a_petname_from_hello_is_recorded_on_the_pairing() {
        let token = URL_SAFE_NO_PAD.encode([6_u8; 32]);
        let (response, config, _, _) =
            authenticate_with_petname(Some(&token), Some("  Redmi Note 11  "));
        assert!(matches!(response, NodeMessage::Welcome { .. }));
        assert_eq!(config.pairings[0].petname.as_deref(), Some("Redmi Note 11"));
    }

    /// A device that could smuggle an escape sequence into the config file would
    /// own the terminal of whoever later runs `cantor pairings`.
    #[test]
    fn a_hostile_petname_is_dropped_without_failing_the_pairing() {
        let token = URL_SAFE_NO_PAD.encode([6_u8; 32]);
        let (response, config, _, _) =
            authenticate_with_petname(Some(&token), Some("pwned\u{1b}[2K\u{1b}[1A"));
        assert!(matches!(response, NodeMessage::Welcome { .. }));
        assert_eq!(config.pairings.len(), 1);
        assert_eq!(config.pairings[0].petname, None);
    }

    #[test]
    fn non_allowlisted_client_is_rejected() {
        let (response, config, _, transfer_present) = authenticate(None);
        assert!(matches!(
            response,
            NodeMessage::Error {
                code: ErrorCode::Rejected,
                ..
            }
        ));
        assert!(config.pairings.is_empty());
        assert!(transfer_present);
    }

    /// A bare-nonce signature is what the relay's room claim produces. Accepting
    /// one here would let a hostile node relay its room challenge through a
    /// paired client and replay the answer as that client's room claim.
    #[test]
    fn a_signature_over_the_bare_nonce_is_rejected() {
        let temporary = tempdir().expect("temporary directory");
        let (mut config, paths) = config(temporary.path());
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = bs58::encode(signing_key.verifying_key().as_bytes()).into_string();
        let node_public_key = bs58::encode(
            SigningKey::from_bytes(&[8_u8; 32])
                .verifying_key()
                .as_bytes(),
        )
        .into_string();
        config
            .pairings
            .push(crate::config::Pairing::new(public_key.clone(), None, None));

        let mut session = ClientSession::default();
        let mut active_token = None;
        let challenge = session
            .handle(
                json!({"t":"hello","v":2,"id":"1","pubkey":public_key}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
                &mut library,
            )
            .expect("hello");
        let nonce = match challenge {
            NodeMessage::Challenge { nonce, .. } => URL_SAFE_NO_PAD.decode(nonce).expect("nonce"),
            other => panic!("unexpected: {other:?}"),
        };
        let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(&nonce).to_bytes());

        let response = session
            .handle(
                json!({"t":"auth","v":2,"id":"1","sig":signature}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
                &mut library,
            )
            .expect("auth");
        assert!(matches!(
            response,
            NodeMessage::Error {
                code: ErrorCode::Rejected,
                ..
            }
        ));
    }

    #[test]
    fn job_controls_return_a_correlated_canonical_view_without_leaking_ownership() {
        let temporary = tempdir().expect("temporary directory");
        let (mut config, paths) = config(temporary.path());
        let mut library = Library::open(temporary.path().join("library")).expect("library");
        let mut owner = ClientSession::authenticated_with_bytes_for_test(
            &bs58::encode([1_u8; 32]).into_string(),
            [1_u8; 32],
        );
        let principal = owner.authenticated().unwrap().principal_id;
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
        let accepted = match library
            .submit(
                principal,
                &[1_u8; 32],
                &crate::library::Submission {
                    client_request_id: uuid::Uuid::new_v4().to_string(),
                    model: variant.selector(),
                    generation: cantor_proto::GenerationRequest {
                        caption: "control".into(),
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
            .unwrap()
        {
            crate::library::SubmitResult::Accepted(job) => job,
            other => panic!("unexpected submit: {other:?}"),
        };
        let mut offer = None;
        let node_key = bs58::encode([8_u8; 32]).into_string();
        let response = owner
            .handle(
                json!({
                    "t":"job.pause",
                    "v":2,
                    "id":"pause-1",
                    "job_id":accepted.id,
                    "expected_revision":accepted.revision
                }),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert!(matches!(
            response,
            NodeMessage::JobControlled { id, job, .. }
                if id == "pause-1" && job.state == cantor_proto::JobState::Paused
        ));

        let mut stranger = ClientSession::authenticated_with_bytes_for_test(
            &bs58::encode([3_u8; 32]).into_string(),
            [3_u8; 32],
        );
        let response = stranger
            .handle(
                json!({"t":"job.cancel","v":2,"id":"cancel-1","job_id":accepted.id}),
                &mut config,
                &paths.config,
                &mut offer,
                &node_key,
                &info(),
                &mut library,
            )
            .unwrap();
        assert!(matches!(
            response,
            NodeMessage::Error {
                id: Some(id),
                code: ErrorCode::NotFound,
                ..
            } if id == "cancel-1"
        ));
    }
}

use std::path::Path;

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cantor_proto::{ClientMessage, NodeInfo, NodeMessage, PROTOCOL_VERSION};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;

use crate::config::{NodeConfig, sanitize_petname};
use crate::pairing::PairOffer;

const CHALLENGE_BYTES: usize = 32;
const PUBLIC_KEY_BYTES: usize = 32;

#[derive(Debug, Default)]
pub struct ClientSession {
    pending: Option<PendingAuth>,
    /// The key this session authenticated with, so a revocation can find and
    /// cut off the sessions it applies to instead of waiting for a reconnect.
    authenticated_key: Option<String>,
}

impl ClientSession {
    pub fn authenticated_key(&self) -> Option<&str> {
        self.authenticated_key.as_deref()
    }

    /// Undoes authentication in place. The caller is responsible for telling the
    /// client why; this only makes sure nothing further is served on the session.
    pub fn deauthenticate(&mut self) {
        self.authenticated_key = None;
        self.pending = None;
    }

    #[cfg(test)]
    pub fn authenticated_for_test(key: &str) -> Self {
        Self {
            pending: None,
            authenticated_key: Some(key.to_owned()),
        }
    }
}

#[derive(Debug)]
struct PendingAuth {
    id: String,
    public_key: String,
    verifying_key: VerifyingKey,
    nonce: [u8; CHALLENGE_BYTES],
    pair_proof: Option<String>,
    petname: Option<String>,
}

impl ClientSession {
    pub fn handle(
        &mut self,
        payload: Value,
        config: &mut NodeConfig,
        config_path: &Path,
        active_pair_offer: &mut Option<PairOffer>,
        node_public_key: &str,
        node_info: &NodeInfo,
    ) -> Result<NodeMessage> {
        let fallback_id = payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let message: ClientMessage = match serde_json::from_value(payload) {
            Ok(message) => message,
            Err(_) => {
                return Ok(NodeMessage::error(
                    fallback_id,
                    "invalid-message",
                    "The application message is not valid.",
                ));
            }
        };

        match message {
            ClientMessage::Hello {
                v,
                id,
                pubkey,
                pair_proof,
                petname,
            } => {
                self.authenticated_key = None;
                self.pending = None;
                if v != PROTOCOL_VERSION {
                    return Ok(unsupported_version(id));
                }

                let key_bytes = match bs58::decode(&pubkey).into_vec() {
                    Ok(bytes) if bytes.len() == PUBLIC_KEY_BYTES => bytes,
                    _ => {
                        return Ok(NodeMessage::error(
                            id,
                            "invalid-key",
                            "The client public key is not valid Ed25519 base58.",
                        ));
                    }
                };
                let key_bytes: [u8; PUBLIC_KEY_BYTES] =
                    key_bytes.try_into().expect("length checked above");
                let verifying_key = match VerifyingKey::from_bytes(&key_bytes) {
                    Ok(key) => key,
                    Err(_) => {
                        return Ok(NodeMessage::error(
                            id,
                            "invalid-key",
                            "The client public key is not valid Ed25519 base58.",
                        ));
                    }
                };
                let mut nonce = [0_u8; CHALLENGE_BYTES];
                getrandom::fill(&mut nonce).context("failed to create client challenge")?;
                self.pending = Some(PendingAuth {
                    id: id.clone(),
                    public_key: pubkey,
                    verifying_key,
                    nonce,
                    pair_proof,
                    // A petname the node will not accept is dropped here rather
                    // than failing an otherwise valid pairing.
                    petname: petname.as_deref().and_then(sanitize_petname),
                });
                Ok(NodeMessage::Challenge {
                    v: PROTOCOL_VERSION,
                    id,
                    nonce: URL_SAFE_NO_PAD.encode(nonce),
                    node_pubkey: node_public_key.to_owned(),
                })
            }
            ClientMessage::Auth { v, id, sig } => {
                if v != PROTOCOL_VERSION {
                    return Ok(unsupported_version(id));
                }
                let Some(pending) = self.pending.take() else {
                    return Ok(NodeMessage::error(
                        id,
                        "handshake-required",
                        "Send hello before auth.",
                    ));
                };
                if pending.id != id {
                    return Ok(NodeMessage::error(
                        id,
                        "request-mismatch",
                        "The auth request does not match its challenge.",
                    ));
                }

                let node_key_bytes = match bs58::decode(node_public_key).into_vec() {
                    Ok(bytes) => <[u8; PUBLIC_KEY_BYTES]>::try_from(bytes.as_slice()).ok(),
                    Err(_) => None,
                };
                let Some(node_key_bytes) = node_key_bytes else {
                    return Ok(NodeMessage::error(
                        id,
                        "invalid-key",
                        "This node's own public key is not valid Ed25519 base58.",
                    ));
                };
                let expected = crate::signing::node_auth_message(
                    &node_key_bytes,
                    &pending.verifying_key.to_bytes(),
                    &pending.nonce,
                );

                let signature = URL_SAFE_NO_PAD
                    .decode(sig)
                    .ok()
                    .and_then(|bytes| Signature::from_slice(&bytes).ok());
                if signature.as_ref().is_none_or(|signature| {
                    pending.verifying_key.verify(&expected, signature).is_err()
                }) {
                    return Ok(NodeMessage::error(
                        id,
                        "bad-signature",
                        "The client challenge signature is invalid.",
                    ));
                }

                let already_allowed = config.is_authorized(&pending.public_key);
                // An expired offer is dropped here rather than merely ignored, so
                // a stale token cannot sit in memory for the life of the daemon.
                if active_pair_offer
                    .as_ref()
                    .is_some_and(PairOffer::is_expired)
                {
                    *active_pair_offer = None;
                }
                let may_enroll = active_pair_offer
                    .as_ref()
                    .zip(pending.pair_proof.as_ref())
                    .is_some_and(|(offer, supplied)| {
                        crate::pairing::verify_pair_proof(
                            &offer.token,
                            supplied,
                            node_public_key,
                            &pending.public_key,
                        )
                    });
                if !already_allowed && !may_enroll {
                    return Ok(NodeMessage::error(
                        id,
                        "rejected",
                        "This client key is not authorized.",
                    ));
                }

                if !already_allowed {
                    config.authorize_key(config_path, &pending.public_key, pending.petname)?;
                    *active_pair_offer = None;
                    println!("paired client {}", pending.public_key);
                }
                self.authenticated_key = Some(pending.public_key);
                Ok(NodeMessage::Welcome {
                    v: PROTOCOL_VERSION,
                    id,
                    node: node_info.clone(),
                })
            }
            ClientMessage::Status { v, id } => {
                if v != PROTOCOL_VERSION {
                    return Ok(unsupported_version(id));
                }
                if self.authenticated_key.is_none() {
                    return Ok(NodeMessage::error(
                        id,
                        "handshake-required",
                        "Authenticate before requesting status.",
                    ));
                }
                Ok(NodeMessage::Jobs {
                    v: PROTOCOL_VERSION,
                    id,
                    jobs: Vec::new(),
                })
            }
        }
    }
}

fn unsupported_version(id: String) -> NodeMessage {
    NodeMessage::error(
        id,
        "unsupported-version",
        format!("Only application protocol version {PROTOCOL_VERSION} is supported."),
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use cantor_proto::{NodeInfo, NodeLimits, NodeLoad, NodeMessage};
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use tempfile::tempdir;

    use super::ClientSession;
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::pairing::{DEFAULT_PAIR_TTL, PairOffer};

    fn info() -> NodeInfo {
        NodeInfo {
            name: "test-node".to_owned(),
            device_type: "linux".to_owned(),
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

    fn config(path: &Path) -> (NodeConfig, NodePaths) {
        let paths = NodePaths::resolve(Some(path.join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        (config, paths)
    }

    fn authenticate(token: Option<&str>) -> (NodeMessage, NodeConfig, Option<PairOffer>) {
        authenticate_with_petname(token, None)
    }

    fn authenticate_with_petname(
        token: Option<&str>,
        petname: Option<&str>,
    ) -> (NodeMessage, NodeConfig, Option<PairOffer>) {
        let temporary = tempdir().expect("temporary directory");
        let (mut config, paths) = config(temporary.path());
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
        let mut active_token =
            token.map(|token| PairOffer::new(token.to_owned(), DEFAULT_PAIR_TTL));
        let challenge = session
            .handle(
                json!({"t":"hello","v":1,"id":"1","pubkey":public_key,"pair_proof":pair_proof,"petname":petname}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
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
                json!({"t":"auth","v":1,"id":"1","sig":signature}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
            )
            .expect("auth");
        (response, config, active_token)
    }

    #[test]
    fn pairing_token_enrolls_a_verified_key_once() {
        let token = URL_SAFE_NO_PAD.encode([6_u8; 32]);
        let (response, config, active_token) = authenticate(Some(&token));
        assert!(matches!(response, NodeMessage::Welcome { .. }));
        assert_eq!(config.pairings.len(), 1);
        assert!(active_token.is_none());
    }

    #[test]
    fn a_petname_from_hello_is_recorded_on_the_pairing() {
        let token = URL_SAFE_NO_PAD.encode([6_u8; 32]);
        let (response, config, _) =
            authenticate_with_petname(Some(&token), Some("  Redmi Note 11  "));
        assert!(matches!(response, NodeMessage::Welcome { .. }));
        assert_eq!(config.pairings[0].petname.as_deref(), Some("Redmi Note 11"));
    }

    /// A device that could smuggle an escape sequence into the config file would
    /// own the terminal of whoever later runs `cantor pairings`.
    #[test]
    fn a_hostile_petname_is_dropped_without_failing_the_pairing() {
        let token = URL_SAFE_NO_PAD.encode([6_u8; 32]);
        let (response, config, _) =
            authenticate_with_petname(Some(&token), Some("pwned\u{1b}[2K\u{1b}[1A"));
        assert!(matches!(response, NodeMessage::Welcome { .. }));
        assert_eq!(config.pairings.len(), 1);
        assert_eq!(config.pairings[0].petname, None);
    }

    #[test]
    fn non_allowlisted_client_is_rejected() {
        let (response, config, _) = authenticate(None);
        assert!(matches!(response, NodeMessage::Error { code, .. } if code == "rejected"));
        assert!(config.pairings.is_empty());
    }

    /// A bare-nonce signature is what the relay's room claim produces. Accepting
    /// one here would let a hostile node relay its room challenge through a
    /// paired client and replay the answer as that client's room claim.
    #[test]
    fn a_signature_over_the_bare_nonce_is_rejected() {
        let temporary = tempdir().expect("temporary directory");
        let (mut config, paths) = config(temporary.path());
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = bs58::encode(signing_key.verifying_key().as_bytes()).into_string();
        let node_public_key =
            bs58::encode(SigningKey::from_bytes(&[8_u8; 32]).verifying_key().as_bytes())
                .into_string();
        config
            .pairings
            .push(crate::config::Pairing::new(public_key.clone(), None, None));

        let mut session = ClientSession::default();
        let mut active_token = None;
        let challenge = session
            .handle(
                json!({"t":"hello","v":1,"id":"1","pubkey":public_key}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
            )
            .expect("hello");
        let nonce = match challenge {
            NodeMessage::Challenge { nonce, .. } => URL_SAFE_NO_PAD.decode(nonce).expect("nonce"),
            other => panic!("unexpected: {other:?}"),
        };
        let signature = URL_SAFE_NO_PAD.encode(signing_key.sign(&nonce).to_bytes());

        let response = session
            .handle(
                json!({"t":"auth","v":1,"id":"1","sig":signature}),
                &mut config,
                &paths.config,
                &mut active_token,
                &node_public_key,
                &info(),
            )
            .expect("auth");
        assert!(matches!(response, NodeMessage::Error { code, .. } if code == "bad-signature"));
    }
}

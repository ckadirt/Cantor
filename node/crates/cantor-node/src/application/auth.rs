//! Authentication state and the hello/challenge/auth exchange.

use std::path::Path;

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cantor_proto::{ErrorCode, NodeInfo, NodeMessage, PROTOCOL_VERSION};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use crate::config::{NodeConfig, sanitize_petname};
use crate::pairing::PairOffer;
use crate::principal::PrincipalId;

use super::errors::unsupported_version;

const CHALLENGE_BYTES: usize = 32;
const PUBLIC_KEY_BYTES: usize = 32;

#[derive(Default)]
pub(super) struct AuthSession {
    relay_session_id: String,
    pending: Option<PendingAuth>,
    authenticated: Option<StoredAuthentication>,
}

/// Identity context constructed only after challenge verification succeeds.
/// Typed application handlers receive this rather than trusting owner data
/// supplied in request payloads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedSession {
    pub relay_session_id: String,
    pub principal_id: PrincipalId,
    pub client_public_key: [u8; 32],
}

pub(super) struct AuthOutcome {
    pub response: NodeMessage,
    pub reset_transfer: bool,
}

impl AuthOutcome {
    fn response(response: NodeMessage) -> Self {
        Self {
            response,
            reset_transfer: false,
        }
    }

    fn authenticated(response: NodeMessage) -> Self {
        Self {
            response,
            reset_transfer: true,
        }
    }
}

impl AuthSession {
    pub(super) fn authenticated_key(&self) -> Option<&str> {
        self.authenticated
            .as_ref()
            .map(|session| session.client_public_key_base58.as_str())
    }

    pub(super) fn authenticated(&self) -> Option<&AuthenticatedSession> {
        self.authenticated.as_ref().map(|stored| &stored.context)
    }

    pub(super) fn set_relay_session_id(&mut self, relay_session_id: &str) {
        self.relay_session_id = relay_session_id.to_owned();
    }

    pub(super) fn deauthenticate(&mut self) {
        self.authenticated = None;
        self.pending = None;
    }

    #[cfg(test)]
    pub(super) fn authenticated_with_bytes(key: &str, bytes: [u8; 32]) -> Self {
        Self {
            relay_session_id: String::new(),
            pending: None,
            authenticated: Some(StoredAuthentication::new(
                String::new(),
                key.to_owned(),
                bytes,
            )),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_hello(
        &mut self,
        version: u8,
        id: String,
        public_key: String,
        pair_proof: Option<String>,
        petname: Option<String>,
        node_public_key: &str,
    ) -> Result<NodeMessage> {
        self.authenticated = None;
        self.pending = None;
        if version != PROTOCOL_VERSION {
            return Ok(unsupported_version(id));
        }

        let key_bytes = match bs58::decode(&public_key).into_vec() {
            Ok(bytes) if bytes.len() == PUBLIC_KEY_BYTES => bytes,
            _ => {
                return Ok(NodeMessage::error(
                    Some(id),
                    ErrorCode::InvalidRequest,
                    "The client public key is not valid Ed25519 base58.",
                    false,
                ));
            }
        };
        let key_bytes: [u8; PUBLIC_KEY_BYTES] = key_bytes.try_into().expect("length checked above");
        let verifying_key = match VerifyingKey::from_bytes(&key_bytes) {
            Ok(key) => key,
            Err(_) => {
                return Ok(NodeMessage::error(
                    Some(id),
                    ErrorCode::InvalidRequest,
                    "The client public key is not valid Ed25519 base58.",
                    false,
                ));
            }
        };
        let mut nonce = [0_u8; CHALLENGE_BYTES];
        getrandom::fill(&mut nonce).context("failed to create client challenge")?;
        self.pending = Some(PendingAuth {
            id: id.clone(),
            public_key,
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
    ) -> Result<AuthOutcome> {
        if version != PROTOCOL_VERSION {
            return Ok(AuthOutcome::response(unsupported_version(id)));
        }
        let Some(pending) = self.pending.take() else {
            return Ok(AuthOutcome::response(NodeMessage::error(
                Some(id),
                ErrorCode::Unauthenticated,
                "Send hello before auth.",
                false,
            )));
        };
        if pending.id != id {
            return Ok(AuthOutcome::response(NodeMessage::error(
                Some(id),
                ErrorCode::InvalidRequest,
                "The auth request does not match its challenge.",
                false,
            )));
        }

        let node_key_bytes = match bs58::decode(node_public_key).into_vec() {
            Ok(bytes) => <[u8; PUBLIC_KEY_BYTES]>::try_from(bytes.as_slice()).ok(),
            Err(_) => None,
        };
        let Some(node_key_bytes) = node_key_bytes else {
            return Ok(AuthOutcome::response(NodeMessage::error(
                Some(id),
                ErrorCode::Internal,
                "This node's own public key is not valid Ed25519 base58.",
                false,
            )));
        };
        let expected = crate::signing::node_auth_message(
            &node_key_bytes,
            &pending.verifying_key.to_bytes(),
            &pending.nonce,
        );

        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .ok()
            .and_then(|bytes| Signature::from_slice(&bytes).ok());
        if signature
            .as_ref()
            .is_none_or(|signature| pending.verifying_key.verify(&expected, signature).is_err())
        {
            return Ok(AuthOutcome::response(NodeMessage::error(
                Some(id),
                ErrorCode::Rejected,
                "The client challenge signature is invalid.",
                false,
            )));
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
            return Ok(AuthOutcome::response(NodeMessage::error(
                Some(id),
                ErrorCode::Rejected,
                "This client key is not authorized.",
                false,
            )));
        }

        if !already_allowed {
            config.authorize_key(config_path, &pending.public_key, pending.petname)?;
            *active_pair_offer = None;
            println!("paired client {}", pending.public_key);
        }
        self.authenticated = Some(StoredAuthentication::new(
            self.relay_session_id.clone(),
            pending.public_key,
            pending.verifying_key.to_bytes(),
        ));
        Ok(AuthOutcome::authenticated(NodeMessage::Welcome {
            v: PROTOCOL_VERSION,
            id,
            node: node_info.clone(),
        }))
    }
}

#[derive(Clone, Debug)]
struct StoredAuthentication {
    context: AuthenticatedSession,
    client_public_key_base58: String,
}

impl StoredAuthentication {
    fn new(relay_session_id: String, encoded_key: String, key: [u8; 32]) -> Self {
        let principal_id = PrincipalId::from_client_public_key(&key);
        Self {
            context: AuthenticatedSession {
                relay_session_id,
                principal_id,
                client_public_key: key,
            },
            client_public_key_base58: encoded_key,
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

#[cfg(test)]
mod tests {
    use super::StoredAuthentication;

    #[test]
    fn principal_id_hashes_canonical_public_key_bytes() {
        let stored = StoredAuthentication::new(
            "relay-session".to_owned(),
            bs58::encode([1_u8; 32]).into_string(),
            [1_u8; 32],
        );
        assert_eq!(
            stored.context.principal_id.as_bytes(),
            &[
                0x72, 0xcd, 0x6e, 0x84, 0x22, 0xc4, 0x07, 0xfb, 0x6d, 0x09, 0x86, 0x90, 0xf1, 0x13,
                0x0b, 0x7d, 0xed, 0x7e, 0xc2, 0xf7, 0xf5, 0xe1, 0xd3, 0x0b, 0xd9, 0xd5, 0x21, 0xf0,
                0x15, 0x36, 0x37, 0x93,
            ]
        );
    }
}

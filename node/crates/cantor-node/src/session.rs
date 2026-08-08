use std::path::Path;

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cantor_proto::{
    ClientMessage, DEFAULT_PAGE_LIMIT, ErrorCode, ErrorDetails, MAX_CAPTION_BYTES, MAX_CFG,
    MAX_CLIENT_REQUEST_ID_BYTES, MAX_LYRICS_BYTES, MAX_MODEL_SELECTOR_BYTES, MAX_PAGE_LIMIT,
    MAX_SAFE_SEED, MAX_SONG_SECONDS, MAX_STEPS, MIN_CFG, MIN_SONG_SECONDS, MIN_STEPS, NodeInfo,
    NodeMessage, PROTOCOL_VERSION,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::{NodeConfig, sanitize_petname};
use crate::library::{Library, Submission, SubmitResult};
use crate::pairing::PairOffer;
use crate::songs::{ChangePageResult, MutationResult, PresenceMutation, SongPageResult};
use crate::store::Store;

const CHALLENGE_BYTES: usize = 32;
const PUBLIC_KEY_BYTES: usize = 32;

#[derive(Debug, Default)]
pub struct ClientSession {
    pending: Option<PendingAuth>,
    relay_session_id: String,
    authenticated: Option<StoredAuthentication>,
}

/// Identity context constructed only after challenge verification succeeds.
/// Typed application handlers receive this rather than trusting owner data
/// supplied in request payloads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedSession {
    pub relay_session_id: String,
    pub principal_id: [u8; 32],
    pub client_public_key: [u8; 32],
}

impl ClientSession {
    pub fn authenticated_key(&self) -> Option<&str> {
        self.authenticated
            .as_ref()
            .map(|session| session.client_public_key_base58.as_str())
    }

    pub fn authenticated(&self) -> Option<&AuthenticatedSession> {
        self.authenticated.as_ref().map(|stored| &stored.context)
    }

    pub fn set_relay_session_id(&mut self, relay_session_id: &str) {
        self.relay_session_id = relay_session_id.to_owned();
    }

    /// Undoes authentication in place. The caller is responsible for telling the
    /// client why; this only makes sure nothing further is served on the session.
    pub fn deauthenticate(&mut self) {
        self.authenticated = None;
        self.pending = None;
    }

    #[cfg(test)]
    pub fn authenticated_for_test(key: &str) -> Self {
        Self::authenticated_with_bytes_for_test(key, [1_u8; 32])
    }

    #[cfg(test)]
    pub fn authenticated_with_bytes_for_test(key: &str, bytes: [u8; 32]) -> Self {
        Self {
            pending: None,
            relay_session_id: String::new(),
            authenticated: Some(StoredAuthentication::new(
                String::new(),
                key.to_owned(),
                bytes,
            )),
        }
    }
}

#[derive(Clone, Debug)]
struct StoredAuthentication {
    context: AuthenticatedSession,
    client_public_key_base58: String,
}

impl StoredAuthentication {
    fn new(relay_session_id: String, encoded_key: String, key: [u8; 32]) -> Self {
        let principal_id: [u8; 32] = Sha256::digest(key).into();
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
        let fallback_id = payload.get("id").and_then(Value::as_str).map(str::to_owned);
        let message: ClientMessage = match serde_json::from_value(payload) {
            Ok(message) => message,
            Err(_) => {
                return Ok(NodeMessage::error(
                    fallback_id,
                    ErrorCode::InvalidRequest,
                    "The application message is not valid.",
                    false,
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
                self.authenticated = None;
                self.pending = None;
                if v != PROTOCOL_VERSION {
                    return Ok(unsupported_version(id));
                }

                let key_bytes = match bs58::decode(&pubkey).into_vec() {
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
                let key_bytes: [u8; PUBLIC_KEY_BYTES] =
                    key_bytes.try_into().expect("length checked above");
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
                        Some(id),
                        ErrorCode::Unauthenticated,
                        "Send hello before auth.",
                        false,
                    ));
                };
                if pending.id != id {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::InvalidRequest,
                        "The auth request does not match its challenge.",
                        false,
                    ));
                }

                let node_key_bytes = match bs58::decode(node_public_key).into_vec() {
                    Ok(bytes) => <[u8; PUBLIC_KEY_BYTES]>::try_from(bytes.as_slice()).ok(),
                    Err(_) => None,
                };
                let Some(node_key_bytes) = node_key_bytes else {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::Internal,
                        "This node's own public key is not valid Ed25519 base58.",
                        false,
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
                        Some(id),
                        ErrorCode::Rejected,
                        "The client challenge signature is invalid.",
                        false,
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
                        Some(id),
                        ErrorCode::Rejected,
                        "This client key is not authorized.",
                        false,
                    ));
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
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "status"));
                };
                Ok(NodeMessage::JobsPage {
                    v: PROTOCOL_VERSION,
                    id,
                    jobs: library.list(&context.principal_id, DEFAULT_PAGE_LIMIT)?,
                    next_cursor: None,
                })
            }
            ClientMessage::JobsList {
                v,
                id,
                states,
                cursor,
                limit,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "jobs"));
                };
                if cursor.is_some() {
                    return Ok(invalid_field(id, "cursor"));
                }
                let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT);
                if limit == 0 || limit > MAX_PAGE_LIMIT {
                    return Ok(invalid_field(id, "limit"));
                }
                let mut jobs = library.list(&context.principal_id, limit)?;
                if let Some(states) = states {
                    jobs.retain(|job| states.contains(&job.state));
                }
                Ok(NodeMessage::JobsPage {
                    v: PROTOCOL_VERSION,
                    id,
                    jobs,
                    next_cursor: None,
                })
            }
            ClientMessage::JobCreate {
                v,
                id,
                client_request_id,
                model,
                generation,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "jobs"));
                };
                if let Some(field) = invalid_submission(&client_request_id, &model, &generation) {
                    return Ok(invalid_field(id, field));
                }
                let variants = Store::new(config.model_root()).installed();
                let Some(variant) = variants.iter().find(|variant| variant.selector() == model)
                else {
                    return Ok(NodeMessage::Error {
                        v: PROTOCOL_VERSION,
                        id: Some(id),
                        code: ErrorCode::ModelNotInstalled,
                        message: "That model is not installed on this node.".into(),
                        retryable: false,
                        details: Some(ErrorDetails::Model { selector: model }),
                    });
                };
                let submission = Submission {
                    client_request_id,
                    model,
                    generation,
                };
                match library.submit(
                    &context.principal_id,
                    &context.client_public_key,
                    &submission,
                    variant,
                    config.jobs.max_queued_per_principal,
                    config.jobs.minimum_free_bytes,
                )? {
                    SubmitResult::Accepted(job) => Ok(NodeMessage::JobAccepted {
                        v: PROTOCOL_VERSION,
                        id,
                        job,
                    }),
                    SubmitResult::Conflict => Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::IdempotencyConflict,
                        "That submission ID was already used for different content.",
                        false,
                    )),
                    SubmitResult::QueueFull => Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::QueueFull,
                        "This client's durable queue is full.",
                        true,
                    )),
                    SubmitResult::InsufficientDisk => Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::InsufficientDisk,
                        "The node is below its configured free-space reserve.",
                        true,
                    )),
                }
            }
            ClientMessage::JobGet { v, id, job_id } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "jobs"));
                };
                match library.get(&context.principal_id, &job_id)? {
                    Some(job) => Ok(NodeMessage::JobDetail {
                        v: PROTOCOL_VERSION,
                        id,
                        job,
                    }),
                    None => Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::NotFound,
                        "That job was not found.",
                        false,
                    )),
                }
            }
            ClientMessage::LibraryList {
                v,
                id,
                limit,
                cursor,
                include_trashed,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "library"));
                };
                let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT);
                if limit == 0 || limit > MAX_PAGE_LIMIT {
                    return Ok(invalid_field(id, "limit"));
                }
                match library.list_songs(
                    &context.principal_id,
                    limit,
                    cursor.as_deref(),
                    include_trashed,
                )? {
                    SongPageResult::Page(page) => Ok(NodeMessage::LibraryPage {
                        v: PROTOCOL_VERSION,
                        id,
                        snapshot_revision: page.snapshot_revision,
                        songs: page.songs,
                        tombstones: Vec::new(),
                        next_cursor: page.next_cursor,
                    }),
                    SongPageResult::InvalidCursor => Ok(invalid_field(id, "cursor")),
                }
            }
            ClientMessage::LibrarySync {
                v,
                id,
                since_revision,
                limit,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "library"));
                };
                let limit = limit.unwrap_or(MAX_PAGE_LIMIT);
                if limit == 0 || limit > MAX_PAGE_LIMIT {
                    return Ok(invalid_field(id, "limit"));
                }
                match library.sync_songs(&context.principal_id, since_revision, limit)? {
                    ChangePageResult::Page(page) => Ok(NodeMessage::LibraryChanges {
                        v: PROTOCOL_VERSION,
                        id,
                        through_revision: page.through_revision,
                        changes: page.changes,
                        has_more: page.has_more,
                    }),
                    ChangePageResult::FullSyncRequired { minimum_revision } => {
                        Ok(NodeMessage::Error {
                            v: PROTOCOL_VERSION,
                            id: Some(id),
                            code: ErrorCode::FullSyncRequired,
                            message: "A fresh private-library snapshot is required.".into(),
                            retryable: true,
                            details: Some(ErrorDetails::FullSync { minimum_revision }),
                        })
                    }
                    ChangePageResult::InvalidRevision => Ok(invalid_field(id, "since_revision")),
                }
            }
            ClientMessage::SongGet { v, id, song_id } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "songs"));
                };
                match library.song_detail(&context.principal_id, &song_id)? {
                    Some(detail) => Ok(NodeMessage::SongDetail {
                        v: PROTOCOL_VERSION,
                        id,
                        detail,
                    }),
                    None => Ok(song_not_found(id)),
                }
            }
            ClientMessage::SongPatch {
                v,
                id,
                song_id,
                expected_revision,
                patch,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "songs"));
                };
                mutation_message(
                    id,
                    library.patch_song(
                        &context.principal_id,
                        &song_id,
                        expected_revision,
                        &patch,
                    )?,
                )
            }
            ClientMessage::SongTrash {
                v,
                id,
                song_id,
                expected_revision,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "songs"));
                };
                mutation_message(
                    id,
                    library.change_song_presence(
                        &context.principal_id,
                        &song_id,
                        expected_revision,
                        PresenceMutation::Trash,
                    )?,
                )
            }
            ClientMessage::SongRestore {
                v,
                id,
                song_id,
                expected_revision,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(context) = self.authenticated() else {
                    return Ok(unauthenticated(id, "songs"));
                };
                mutation_message(
                    id,
                    library.change_song_presence(
                        &context.principal_id,
                        &song_id,
                        expected_revision,
                        PresenceMutation::Restore,
                    )?,
                )
            }
        }
    }
}

fn mutation_message(id: String, result: MutationResult) -> Result<NodeMessage> {
    Ok(match result {
        MutationResult::Updated(song) => NodeMessage::SongUpdated {
            v: PROTOCOL_VERSION,
            id,
            song,
        },
        MutationResult::Conflict(current) => NodeMessage::Error {
            v: PROTOCOL_VERSION,
            id: Some(id),
            code: ErrorCode::RevisionConflict,
            message: "The song changed on another device.".into(),
            retryable: false,
            details: Some(ErrorDetails::RevisionConflict { current }),
        },
        MutationResult::NotFound => song_not_found(id),
        MutationResult::InvalidPatch => invalid_field(id, "patch"),
    })
}

fn song_not_found(id: String) -> NodeMessage {
    NodeMessage::error(
        Some(id),
        ErrorCode::NotFound,
        "That song was not found.",
        false,
    )
}

fn unauthenticated(id: String, resource: &str) -> NodeMessage {
    NodeMessage::error(
        Some(id),
        ErrorCode::Unauthenticated,
        format!("Authenticate before requesting {resource}."),
        false,
    )
}

fn invalid_field(id: String, field: &str) -> NodeMessage {
    NodeMessage::Error {
        v: PROTOCOL_VERSION,
        id: Some(id),
        code: ErrorCode::InvalidRequest,
        message: format!("The {field} field is invalid."),
        retryable: false,
        details: Some(ErrorDetails::InvalidField {
            field: field.to_owned(),
        }),
    }
}

fn invalid_submission(
    client_request_id: &str,
    model: &str,
    generation: &cantor_proto::GenerationRequest,
) -> Option<&'static str> {
    if client_request_id.len() > MAX_CLIENT_REQUEST_ID_BYTES
        || uuid::Uuid::parse_str(client_request_id).is_err()
    {
        return Some("client_request_id");
    }
    if model.is_empty() || model.len() > MAX_MODEL_SELECTOR_BYTES {
        return Some("model");
    }
    if generation.caption.trim().is_empty()
        || generation.caption.len() > MAX_CAPTION_BYTES as usize
        || generation.caption.chars().any(char::is_control)
    {
        return Some("caption");
    }
    if generation.lyrics.as_ref().is_some_and(|lyrics| {
        lyrics.len() > MAX_LYRICS_BYTES as usize
            || lyrics
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    }) {
        return Some("lyrics");
    }
    if generation
        .duration
        .is_some_and(|v| !(MIN_SONG_SECONDS..=MAX_SONG_SECONDS).contains(&v))
    {
        return Some("duration");
    }
    if generation
        .steps
        .is_some_and(|v| !(MIN_STEPS..=MAX_STEPS).contains(&v))
    {
        return Some("steps");
    }
    if generation
        .cfg
        .is_some_and(|v| !v.is_finite() || !(MIN_CFG..=MAX_CFG).contains(&v))
    {
        return Some("cfg");
    }
    if generation.seed.is_some_and(|seed| seed > MAX_SAFE_SEED) {
        return Some("seed");
    }
    None
}

fn unsupported_version(id: String) -> NodeMessage {
    NodeMessage::unsupported_version(Some(id))
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

    use super::{ClientSession, StoredAuthentication, invalid_submission};
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

    #[test]
    fn principal_id_hashes_canonical_public_key_bytes() {
        let stored = StoredAuthentication::new(
            "relay-session".to_owned(),
            bs58::encode([1_u8; 32]).into_string(),
            [1_u8; 32],
        );
        assert_eq!(
            stored.context.principal_id,
            [
                0x72, 0xcd, 0x6e, 0x84, 0x22, 0xc4, 0x07, 0xfb, 0x6d, 0x09, 0x86, 0x90, 0xf1, 0x13,
                0x0b, 0x7d, 0xed, 0x7e, 0xc2, 0xf7, 0xf5, 0xe1, 0xd3, 0x0b, 0xd9, 0xd5, 0x21, 0xf0,
                0x15, 0x36, 0x37, 0x93,
            ]
        );
    }

    #[test]
    fn seed_is_bounded_to_jsons_exact_integer_range() {
        let request_id = uuid::Uuid::new_v4().to_string();
        let request = cantor_proto::GenerationRequest {
            caption: "seed".into(),
            lyrics: None,
            duration: None,
            steps: None,
            cfg: None,
            seed: Some(cantor_proto::MAX_SAFE_SEED + 1),
        };
        assert_eq!(
            invalid_submission(&request_id, "acestep:test", &request),
            Some("seed")
        );
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
        assert!(matches!(
            response,
            NodeMessage::Error {
                code: ErrorCode::Rejected,
                ..
            }
        ));
        assert!(config.pairings.is_empty());
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
}

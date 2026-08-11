use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cantor_proto::{
    ARTIFACT_CHUNK_BYTES, ArtifactView, ClientMessage, DEFAULT_PAGE_LIMIT, ErrorCode, ErrorDetails,
    MAX_CAPTION_BYTES, MAX_CFG, MAX_CLIENT_REQUEST_ID_BYTES, MAX_LYRICS_BYTES,
    MAX_MODEL_SELECTOR_BYTES, MAX_PAGE_LIMIT, MAX_SAFE_SEED, MAX_SONG_SECONDS, MAX_STEPS, MIN_CFG,
    MIN_SONG_SECONDS, MIN_STEPS, NodeInfo, NodeMessage, PROTOCOL_VERSION,
};
use serde_json::Value;

use crate::config::NodeConfig;
use crate::library::{
    ChangePageResult, ControlResult, JobControl, Library, MutationResult, PresenceMutation,
    SongPageResult, Submission, SubmitResult,
};
use crate::pairing::PairOffer;
use crate::principal::PrincipalId;
use crate::secure::{SecureSession, TransportIdentity};
use crate::store::Store;

use super::auth::{AuthSession, AuthenticatedSession};
use super::errors::{invalid_field, song_not_found, unauthenticated, unsupported_version};

const TRANSFER_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct ClientSession {
    secure: SecureSession,
    auth: AuthSession,
    transfer: Option<ArtifactTransfer>,
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
        self.transfer = None;
    }

    #[cfg(test)]
    pub fn authenticated_with_bytes_for_test(key: &str, bytes: [u8; 32]) -> Self {
        Self {
            secure: SecureSession::default(),
            auth: AuthSession::authenticated_with_bytes(key, bytes),
            transfer: None,
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

#[derive(Debug)]
struct ArtifactTransfer {
    id: String,
    principal_id: PrincipalId,
    path: PathBuf,
    byte_length: u64,
    sha256: String,
    acknowledged: u64,
    sent_end: u64,
    expires_at: Instant,
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
            } => self
                .auth
                .handle_hello(v, id, pubkey, pair_proof, petname, node_public_key),
            ClientMessage::Auth { v, id, sig } => {
                let outcome = self.auth.handle_auth(
                    v,
                    id,
                    sig,
                    config,
                    config_path,
                    active_pair_offer,
                    node_public_key,
                    node_info,
                )?;
                if outcome.reset_transfer {
                    self.transfer = None;
                }
                Ok(outcome.response)
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
                    jobs: library.list(context.principal_id, DEFAULT_PAGE_LIMIT)?,
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
                let mut jobs = library.list(context.principal_id, limit)?;
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
                    context.principal_id,
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
                match library.get(context.principal_id, &job_id)? {
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
            ClientMessage::JobPause {
                v,
                id,
                job_id,
                expected_revision,
            } => control_job(
                self,
                library,
                v,
                id,
                job_id,
                expected_revision,
                JobControl::Pause,
            ),
            ClientMessage::JobResume {
                v,
                id,
                job_id,
                expected_revision,
            } => control_job(
                self,
                library,
                v,
                id,
                job_id,
                expected_revision,
                JobControl::Resume,
            ),
            ClientMessage::JobCancel {
                v,
                id,
                job_id,
                expected_revision,
            } => control_job(
                self,
                library,
                v,
                id,
                job_id,
                expected_revision,
                JobControl::Cancel,
            ),
            ClientMessage::JobRetry {
                v,
                id,
                job_id,
                expected_revision,
            } => control_job(
                self,
                library,
                v,
                id,
                job_id,
                expected_revision,
                JobControl::Retry,
            ),
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
                    context.principal_id,
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
                match library.sync_songs(context.principal_id, since_revision, limit)? {
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
                match library.song_detail(context.principal_id, &song_id)? {
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
                        context.principal_id,
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
                        context.principal_id,
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
                        context.principal_id,
                        &song_id,
                        expected_revision,
                        PresenceMutation::Restore,
                    )?,
                )
            }
            ClientMessage::ArtifactOpen {
                v,
                id,
                song_id,
                profile,
                offset,
                expected_sha256,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(principal_id) = self.authenticated().map(|value| value.principal_id)
                else {
                    return Ok(unauthenticated(id, "artifacts"));
                };
                if uuid::Uuid::parse_str(&song_id).is_err()
                    || profile.len() > 64
                    || offset > MAX_SAFE_SEED
                {
                    return Ok(invalid_field(id, "artifact"));
                }
                let artifact =
                    match library.verified_delivery_artifact(principal_id, &song_id, &profile) {
                        Ok(Some(artifact)) => artifact,
                        Ok(None) => {
                            return Ok(NodeMessage::error(
                                Some(id),
                                ErrorCode::ArtifactUnavailable,
                                "That private delivery artifact is not available.",
                                true,
                            ));
                        }
                        Err(error) => {
                            eprintln!("delivery verification failed for {song_id}: {error:#}");
                            return Ok(NodeMessage::error(
                                Some(id),
                                ErrorCode::ArtifactUnavailable,
                                "That private delivery artifact failed verification.",
                                true,
                            ));
                        }
                    };
                let (record, path) = artifact;
                if expected_sha256
                    .as_ref()
                    .is_some_and(|expected| expected != &record.sha256)
                {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::ArtifactChanged,
                        "The delivery artifact changed; discard the partial copy.",
                        false,
                    ));
                }
                if offset > record.byte_length {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::InvalidOffset,
                        "The requested resume offset is beyond the artifact.",
                        false,
                    ));
                }
                let transfer_id = uuid::Uuid::new_v4().to_string();
                self.transfer = Some(ArtifactTransfer {
                    id: transfer_id.clone(),
                    principal_id,
                    path,
                    byte_length: record.byte_length,
                    sha256: record.sha256.clone(),
                    acknowledged: offset,
                    sent_end: offset,
                    expires_at: Instant::now() + TRANSFER_TTL,
                });
                Ok(NodeMessage::ArtifactInfo {
                    v: PROTOCOL_VERSION,
                    id,
                    transfer_id,
                    song_id,
                    artifact: ArtifactView {
                        kind: record.kind,
                        profile: record.profile,
                        media_type: record.media_type,
                        byte_length: record.byte_length,
                        sha256: record.sha256,
                        sample_rate: record.sample_rate,
                        channels: record.channels,
                    },
                    accepted_offset: offset,
                    chunk_bytes: ARTIFACT_CHUNK_BYTES,
                    window_chunks: 1,
                })
            }
            ClientMessage::ArtifactAck {
                v,
                id,
                transfer_id,
                next_offset,
            } => {
                if v != PROTOCOL_VERSION {
                    return Ok(NodeMessage::unsupported_version(Some(id)));
                }
                let Some(principal_id) = self.authenticated().map(|value| value.principal_id)
                else {
                    return Ok(unauthenticated(id, "artifacts"));
                };
                let Some(mut transfer) = self.transfer.take() else {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::TransferExpired,
                        "Open the delivery artifact again to resume.",
                        true,
                    ));
                };
                if transfer.id != transfer_id
                    || transfer.principal_id != principal_id
                    || Instant::now() >= transfer.expires_at
                {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::TransferExpired,
                        "Open the delivery artifact again to resume.",
                        true,
                    ));
                }
                if next_offset == transfer.sent_end {
                    transfer.acknowledged = next_offset;
                } else if !(next_offset == transfer.acknowledged
                    && transfer.sent_end > transfer.acknowledged)
                {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::InvalidOffset,
                        "The durable artifact acknowledgement is out of order.",
                        false,
                    ));
                }
                if transfer.acknowledged == transfer.byte_length {
                    return Ok(NodeMessage::ArtifactComplete {
                        v: PROTOCOL_VERSION,
                        id,
                        transfer_id,
                        byte_length: transfer.byte_length,
                        sha256: transfer.sha256,
                    });
                }
                let offset = transfer.acknowledged;
                let length =
                    (transfer.byte_length - offset).min(u64::from(ARTIFACT_CHUNK_BYTES)) as usize;
                let mut bytes = vec![0_u8; length];
                let read = File::open(&transfer.path)
                    .and_then(|mut file| {
                        file.seek(SeekFrom::Start(offset))?;
                        file.read_exact(&mut bytes)
                    })
                    .is_ok();
                if !read {
                    return Ok(NodeMessage::error(
                        Some(id),
                        ErrorCode::ArtifactUnavailable,
                        "The delivery artifact became unavailable.",
                        true,
                    ));
                }
                transfer.sent_end = offset + length as u64;
                self.transfer = Some(transfer);
                Ok(NodeMessage::ArtifactChunk {
                    v: PROTOCOL_VERSION,
                    id,
                    transfer_id,
                    offset,
                    data: STANDARD.encode(bytes),
                })
            }
        }
    }
}

fn control_job(
    session: &ClientSession,
    library: &mut Library,
    version: u8,
    id: String,
    job_id: String,
    expected_revision: Option<u32>,
    control: JobControl,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = session.authenticated() else {
        return Ok(unauthenticated(id, "jobs"));
    };
    Ok(
        match library.control_job(context.principal_id, &job_id, expected_revision, control)? {
            ControlResult::Updated(job) => NodeMessage::JobControlled {
                v: PROTOCOL_VERSION,
                id,
                job,
            },
            ControlResult::Conflict(current) => NodeMessage::Error {
                v: PROTOCOL_VERSION,
                id: Some(id),
                code: ErrorCode::RevisionConflict,
                message: "The job changed before this control reached the node.".into(),
                retryable: false,
                details: Some(ErrorDetails::JobRevisionConflict { current }),
            },
            ControlResult::InvalidTransition(current) => NodeMessage::Error {
                v: PROTOCOL_VERSION,
                id: Some(id),
                code: ErrorCode::InvalidTransition,
                message: "That control is not valid in the job's current state.".into(),
                retryable: false,
                details: Some(ErrorDetails::JobState { current }),
            },
            ControlResult::NotFound => NodeMessage::error(
                Some(id),
                ErrorCode::NotFound,
                "That job was not found.",
                false,
            ),
        },
    )
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

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::{Duration, Instant};

    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use cantor_proto::{
        ErrorCode, ModelView, NodeFeatures, NodeInfo, NodeLimits, NodeLoad, NodeMessage,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use tempfile::tempdir;

    use super::{ArtifactTransfer, ClientSession, invalid_submission};
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

    fn delivery_fixture(root: &Path, key: [u8; 32]) -> (Library, String, String) {
        let library = Library::open(root.join("library")).unwrap();
        let (song_id, digest) = library.seed_delivery_fixture_for_test(key);
        (library, song_id, digest)
    }

    fn dummy_transfer(root: &Path, key: [u8; 32]) -> ArtifactTransfer {
        ArtifactTransfer {
            id: "transfer".into(),
            principal_id: crate::principal::PrincipalId::from_client_public_key(&key),
            path: root.join("delivery.opus"),
            byte_length: 100,
            sha256: "digest".into(),
            acknowledged: 0,
            sent_end: 0,
            expires_at: Instant::now() + Duration::from_secs(60),
        }
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
        session.transfer = Some(dummy_transfer(temporary.path(), [1_u8; 32]));

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
        assert!(session.transfer.is_some());

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
        assert!(session.transfer.is_some());
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
        let mut session = ClientSession {
            transfer: Some(dummy_transfer(temporary.path(), [7_u8; 32])),
            ..ClientSession::default()
        };
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
        (response, config, active_token, session.transfer.is_some())
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

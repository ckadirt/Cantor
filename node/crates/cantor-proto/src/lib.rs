//! Cantor application protocol v2.
//!
//! The relay carrier has its own version. These types describe only messages
//! inside a relay tunnel. Rust is the source of truth; TypeScript bindings are
//! generated with `ts-rs`, while untrusted input is validated at each edge.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u8 = 2;
pub const MIN_SUPPORTED_VERSION: u8 = 2;
pub const MAX_SUPPORTED_VERSION: u8 = 2;

pub const MAX_REQUEST_ID_BYTES: usize = 128;
pub const MAX_CLIENT_REQUEST_ID_BYTES: usize = 128;
pub const MAX_MODEL_SELECTOR_BYTES: usize = 128;
pub const MAX_CAPTION_BYTES: u32 = 1_024;
pub const MAX_LYRICS_BYTES: u32 = 65_536;
pub const MIN_SONG_SECONDS: u32 = 15;
pub const MAX_SONG_SECONDS: u32 = 600;
pub const MIN_STEPS: u32 = 1;
pub const MAX_STEPS: u32 = 200;
pub const MIN_CFG: f32 = 0.0;
pub const MAX_CFG: f32 = 30.0;
/// Largest integer every JSON/TypeScript client can round-trip exactly.
pub const MAX_SAFE_SEED: u64 = 9_007_199_254_740_991;
pub const DEFAULT_PAGE_LIMIT: u32 = 50;
pub const MAX_PAGE_LIMIT: u32 = 100;
pub const MAX_TITLE_BYTES: usize = 160;
pub const MAX_TAG_BYTES: usize = 64;
pub const MAX_TAGS: usize = 16;
pub const ARTIFACT_CHUNK_BYTES: u32 = 64 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ModelView {
    /// Stable value accepted by `job.create`, for example `acestep:1.5-fast`.
    pub selector: String,
    pub family: String,
    pub engine: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeLimits {
    pub max_concurrent_jobs: u32,
    pub max_queued_jobs_per_principal: u32,
    pub min_song_seconds: u32,
    pub max_song_seconds: u32,
    pub max_caption_bytes: u32,
    pub max_lyrics_bytes: u32,
    pub max_page_limit: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeLoad {
    pub active_jobs: u32,
    pub queued_jobs: u32,
    pub accepting_jobs: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeFeatures {
    pub jobs_create: bool,
    pub library_list: bool,
    pub artifacts_transfer: bool,
    pub secure_tunnel: bool,
    pub job_controls: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct NodeInfo {
    pub name: String,
    pub device_type: String,
    pub engine_version: String,
    pub models: Vec<ModelView>,
    pub limits: NodeLimits,
    pub load: NodeLoad,
    pub features: NodeFeatures,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Preparing,
    Running,
    PauseRequested,
    Paused,
    CancelRequested,
    Recovering,
    Finalizing,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum GenerationStage {
    Plan,
    Codes,
    Diffuse,
    Decode,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ProgressUnit {
    Tokens,
    Steps,
    Tiles,
    Stage,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct JobProgress {
    pub completed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total: Option<u32>,
    pub unit: ProgressUnit,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct JobError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct JobView {
    pub id: String,
    pub revision: u32,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stage: Option<GenerationStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub progress: Option<JobProgress>,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<JobError>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct GenerationRequest {
    pub caption: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lyrics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub steps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cfg: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | undefined")]
    pub seed: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ArtifactView {
    pub kind: String,
    #[serde(default = "default_artifact_profile")]
    pub profile: String,
    pub media_type: String,
    #[ts(type = "number")]
    pub byte_length: u64,
    pub sha256: String,
    pub sample_rate: u32,
    pub channels: u16,
}

fn default_artifact_profile() -> String {
    "pcm16-wav-v1".to_owned()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SongHeader {
    pub id: String,
    pub revision: u32,
    pub title: String,
    pub caption_summary: String,
    pub created_at: String,
    #[ts(type = "number")]
    pub duration_ms: u64,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | undefined")]
    pub seed: Option<u64>,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub trashed: bool,
    pub artifacts: Vec<ArtifactView>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SongDetail {
    pub song: SongHeader,
    pub generation: GenerationRequest,
    pub engine: String,
    pub component_digests: Vec<String>,
    pub attempts: u32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SongPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub favorite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum LibraryChangeKind {
    Upsert,
    Trash,
    Restore,
    Tombstone,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct LibraryChange {
    #[ts(type = "number")]
    pub revision: u64,
    pub song_id: String,
    pub kind: LibraryChangeKind,
    pub changed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub song: Option<SongHeader>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ErrorCode {
    UnsupportedVersion,
    Unauthenticated,
    Rejected,
    InvalidRequest,
    NotFound,
    ModelNotInstalled,
    ModelUnavailable,
    IdempotencyConflict,
    QueueFull,
    InsufficientDisk,
    TemporarilyUnavailable,
    FeatureUnavailable,
    RevisionConflict,
    FullSyncRequired,
    InvalidTransition,
    CheckpointUnavailable,
    ArtifactUnavailable,
    ArtifactChanged,
    InvalidOffset,
    TransferExpired,
    Internal,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, tag = "kind", rename_all = "snake_case")]
pub enum ErrorDetails {
    SupportedVersion {
        minimum: u8,
        maximum: u8,
    },
    InvalidField {
        field: String,
    },
    Model {
        selector: String,
    },
    Correlation {
        correlation_id: String,
    },
    RevisionConflict {
        current: SongHeader,
    },
    JobRevisionConflict {
        current: JobView,
    },
    JobState {
        current: JobView,
    },
    FullSync {
        #[ts(type = "number")]
        minimum_revision: u64,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "t")]
#[ts(export)]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    #[ts(rename = "hello")]
    Hello {
        v: u8,
        id: String,
        pubkey: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pair_proof: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        petname: Option<String>,
    },
    #[serde(rename = "auth")]
    #[ts(rename = "auth")]
    Auth { v: u8, id: String, sig: String },
    #[serde(rename = "status")]
    #[ts(rename = "status")]
    Status { v: u8, id: String },
    #[serde(rename = "job.create")]
    #[ts(rename = "job.create")]
    JobCreate {
        v: u8,
        id: String,
        client_request_id: String,
        model: String,
        generation: GenerationRequest,
    },
    #[serde(rename = "jobs.list")]
    #[ts(rename = "jobs.list")]
    JobsList {
        v: u8,
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        states: Option<Vec<JobState>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cursor: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        limit: Option<u32>,
    },
    #[serde(rename = "job.get")]
    #[ts(rename = "job.get")]
    JobGet { v: u8, id: String, job_id: String },
    #[serde(rename = "job.pause")]
    #[ts(rename = "job.pause")]
    JobPause {
        v: u8,
        id: String,
        job_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_revision: Option<u32>,
    },
    #[serde(rename = "job.resume")]
    #[ts(rename = "job.resume")]
    JobResume {
        v: u8,
        id: String,
        job_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_revision: Option<u32>,
    },
    #[serde(rename = "job.cancel")]
    #[ts(rename = "job.cancel")]
    JobCancel {
        v: u8,
        id: String,
        job_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_revision: Option<u32>,
    },
    #[serde(rename = "job.retry")]
    #[ts(rename = "job.retry")]
    JobRetry {
        v: u8,
        id: String,
        job_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_revision: Option<u32>,
    },
    #[serde(rename = "library.list")]
    #[ts(rename = "library.list")]
    LibraryList {
        v: u8,
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        limit: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cursor: Option<String>,
        #[serde(default)]
        include_trashed: bool,
    },
    #[serde(rename = "library.sync")]
    #[ts(rename = "library.sync")]
    LibrarySync {
        v: u8,
        id: String,
        #[ts(type = "number")]
        since_revision: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        limit: Option<u32>,
    },
    #[serde(rename = "song.get")]
    #[ts(rename = "song.get")]
    SongGet { v: u8, id: String, song_id: String },
    #[serde(rename = "song.patch")]
    #[ts(rename = "song.patch")]
    SongPatch {
        v: u8,
        id: String,
        song_id: String,
        expected_revision: u32,
        patch: SongPatch,
    },
    #[serde(rename = "song.trash")]
    #[ts(rename = "song.trash")]
    SongTrash {
        v: u8,
        id: String,
        song_id: String,
        expected_revision: u32,
    },
    #[serde(rename = "song.restore")]
    #[ts(rename = "song.restore")]
    SongRestore {
        v: u8,
        id: String,
        song_id: String,
        expected_revision: u32,
    },
    #[serde(rename = "artifact.open")]
    #[ts(rename = "artifact.open")]
    ArtifactOpen {
        v: u8,
        id: String,
        song_id: String,
        profile: String,
        #[ts(type = "number")]
        offset: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        expected_sha256: Option<String>,
    },
    #[serde(rename = "artifact.ack")]
    #[ts(rename = "artifact.ack")]
    ArtifactAck {
        v: u8,
        id: String,
        transfer_id: String,
        #[ts(type = "number")]
        next_offset: u64,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "t")]
#[ts(export)]
pub enum NodeMessage {
    #[serde(rename = "challenge")]
    #[ts(rename = "challenge")]
    Challenge {
        v: u8,
        id: String,
        nonce: String,
        node_pubkey: String,
    },
    #[serde(rename = "welcome")]
    #[ts(rename = "welcome")]
    Welcome { v: u8, id: String, node: NodeInfo },
    #[serde(rename = "job.accepted")]
    #[ts(rename = "job.accepted")]
    JobAccepted { v: u8, id: String, job: JobView },
    #[serde(rename = "jobs.page")]
    #[ts(rename = "jobs.page")]
    JobsPage {
        v: u8,
        id: String,
        jobs: Vec<JobView>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        next_cursor: Option<String>,
    },
    #[serde(rename = "job.detail")]
    #[ts(rename = "job.detail")]
    JobDetail { v: u8, id: String, job: JobView },
    #[serde(rename = "job.updated")]
    #[ts(rename = "job.updated")]
    JobUpdated { v: u8, job: JobView },
    #[serde(rename = "job.controlled")]
    #[ts(rename = "job.controlled")]
    JobControlled { v: u8, id: String, job: JobView },
    #[serde(rename = "library.page")]
    #[ts(rename = "library.page")]
    LibraryPage {
        v: u8,
        id: String,
        #[ts(type = "number")]
        snapshot_revision: u64,
        songs: Vec<SongHeader>,
        tombstones: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        next_cursor: Option<String>,
    },
    #[serde(rename = "library.changes")]
    #[ts(rename = "library.changes")]
    LibraryChanges {
        v: u8,
        id: String,
        #[ts(type = "number")]
        through_revision: u64,
        changes: Vec<LibraryChange>,
        has_more: bool,
    },
    #[serde(rename = "song.detail")]
    #[ts(rename = "song.detail")]
    SongDetail {
        v: u8,
        id: String,
        detail: SongDetail,
    },
    #[serde(rename = "song.updated")]
    #[ts(rename = "song.updated")]
    SongUpdated { v: u8, id: String, song: SongHeader },
    #[serde(rename = "artifact.info")]
    #[ts(rename = "artifact.info")]
    ArtifactInfo {
        v: u8,
        id: String,
        transfer_id: String,
        song_id: String,
        artifact: ArtifactView,
        #[ts(type = "number")]
        accepted_offset: u64,
        chunk_bytes: u32,
        window_chunks: u8,
    },
    #[serde(rename = "artifact.chunk")]
    #[ts(rename = "artifact.chunk")]
    ArtifactChunk {
        v: u8,
        id: String,
        transfer_id: String,
        #[ts(type = "number")]
        offset: u64,
        data: String,
    },
    #[serde(rename = "artifact.complete")]
    #[ts(rename = "artifact.complete")]
    ArtifactComplete {
        v: u8,
        id: String,
        transfer_id: String,
        #[ts(type = "number")]
        byte_length: u64,
        sha256: String,
    },
    #[serde(rename = "library.changed")]
    #[ts(rename = "library.changed")]
    LibraryChanged {
        v: u8,
        #[ts(type = "number")]
        revision: u64,
    },
    #[serde(rename = "error")]
    #[ts(rename = "error")]
    Error {
        v: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        code: ErrorCode,
        message: String,
        retryable: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        details: Option<ErrorDetails>,
    },
    /// Unsolicited capability update. It intentionally has no request ID.
    #[serde(rename = "node.info")]
    #[ts(rename = "node.info")]
    NodeInfoChanged { v: u8, node: NodeInfo },
}

impl NodeMessage {
    pub fn error(
        id: Option<String>,
        code: ErrorCode,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::Error {
            v: PROTOCOL_VERSION,
            id,
            code,
            message: message.into(),
            retryable,
            details: None,
        }
    }

    pub fn unsupported_version(id: Option<String>) -> Self {
        Self::Error {
            v: PROTOCOL_VERSION,
            id,
            code: ErrorCode::UnsupportedVersion,
            message: "This app and node use incompatible protocol versions.".to_owned(),
            retryable: false,
            details: Some(ErrorDetails::SupportedVersion {
                minimum: MIN_SUPPORTED_VERSION,
                maximum: MAX_SUPPORTED_VERSION,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_uses_the_flat_v2_wire_shape() {
        let message = ClientMessage::Hello {
            v: PROTOCOL_VERSION,
            id: "request-1".to_owned(),
            pubkey: "client-key".to_owned(),
            pair_proof: None,
            petname: None,
        };
        assert_eq!(
            serde_json::to_value(message).unwrap(),
            serde_json::json!({
                "t": "hello", "v": 2, "id": "request-1", "pubkey": "client-key"
            })
        );
    }

    #[test]
    fn required_enum_values_are_strict() {
        assert!(serde_json::from_str::<JobState>(r#""running""#).is_ok());
        assert!(serde_json::from_str::<JobState>(r#""future_state""#).is_err());
        assert!(serde_json::from_str::<JobProgress>(r#"{"completed":-1,"unit":"steps"}"#).is_err());
    }

    #[test]
    fn unsupported_version_is_safe_and_structured() {
        assert_eq!(
            serde_json::to_value(NodeMessage::unsupported_version(Some("r1".into()))).unwrap(),
            serde_json::json!({
                "t": "error", "v": 2, "id": "r1", "code": "unsupported_version",
                "message": "This app and node use incompatible protocol versions.", "retryable": false,
                "details": {"kind": "supported_version", "minimum": 2, "maximum": 2}
            })
        );
    }

    #[test]
    fn committed_valid_fixtures_deserialize_in_rust() {
        let client = [
            include_str!("../../../../protocol/fixtures/v2/hello.json"),
            include_str!("../../../../protocol/fixtures/v2/job-create.json"),
            include_str!("../../../../protocol/fixtures/v2/job-pause.json"),
            include_str!("../../../../protocol/fixtures/v2/library-list.json"),
        ];
        for fixture in client {
            serde_json::from_str::<ClientMessage>(fixture).expect("valid client fixture");
        }
        let node = [
            include_str!("../../../../protocol/fixtures/v2/node-info.json"),
            include_str!("../../../../protocol/fixtures/v2/jobs-page.json"),
            include_str!("../../../../protocol/fixtures/v2/library-page.json"),
            include_str!("../../../../protocol/fixtures/v2/error.json"),
            include_str!("../../../../protocol/fixtures/v2/forward/extra-optional-field.json"),
        ];
        for fixture in node {
            serde_json::from_str::<NodeMessage>(fixture).expect("valid node fixture");
        }
    }

    #[test]
    fn committed_malformed_fixtures_are_rejected_by_wire_types() {
        for fixture in [
            include_str!("../../../../protocol/fixtures/v2/malformed/invalid-state.json"),
            include_str!("../../../../protocol/fixtures/v2/malformed/negative-progress.json"),
        ] {
            assert!(serde_json::from_str::<NodeMessage>(fixture).is_err());
        }
    }
}

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
pub const DEFAULT_PAGE_LIMIT: u32 = 50;
pub const MAX_PAGE_LIMIT: u32 = 100;

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
    #[ts(optional)]
    pub seed: Option<u64>,
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
    Internal,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, tag = "kind", rename_all = "snake_case")]
pub enum ErrorDetails {
    SupportedVersion { minimum: u8, maximum: u8 },
    InvalidField { field: String },
    Model { selector: String },
    Correlation { correlation_id: String },
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
        ];
        for fixture in client {
            serde_json::from_str::<ClientMessage>(fixture).expect("valid client fixture");
        }
        let node = [
            include_str!("../../../../protocol/fixtures/v2/node-info.json"),
            include_str!("../../../../protocol/fixtures/v2/jobs-page.json"),
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

//! Cantor application protocol v2.
//!
//! The relay carrier has its own version. These types describe only messages
//! inside a relay tunnel. Rust is the source of truth; TypeScript bindings are
//! generated with `ts-rs`, while untrusted input is validated at each edge.

pub mod extensions;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

mod generated;
mod job_id;

pub use job_id::derive_job_id;

/// Application layer versions and the artifact chunk size come from the shared
/// transport manifest; every other bound below is application-local policy.
pub use generated::transport::{
    APPLICATION_PROTOCOL_MAX_SUPPORTED_VERSION as MAX_SUPPORTED_VERSION,
    APPLICATION_PROTOCOL_MIN_SUPPORTED_VERSION as MIN_SUPPORTED_VERSION,
    APPLICATION_PROTOCOL_VERSION as PROTOCOL_VERSION, ARTIFACT_CHUNK_BYTES, UPLOAD_CHUNK_BYTES,
};

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
/// The upper end of `AudioPrompt::closeness`: 0 is as close to the source as
/// the model goes, 1 as free.
pub const MAX_CLOSENESS: f32 = 1.0;
/// Longest a tune may be stretched to by tiling, and longest an extension.
pub const MAX_EXTEND_SECONDS: u32 = MAX_SONG_SECONDS;
pub const MAX_UPLOAD_ID_BYTES: usize = 64;
pub const MAX_MEDIA_TYPE_BYTES: usize = 64;

/// Bounds on the declared-parameter extension map.
///
/// A node advertises what its engine accepts; the app sends values back through
/// `GenerationRequest::extensions`. These bounds exist so an untrusted client
/// cannot make admission expensive.
pub const MAX_EXTENSIONS: usize = 32;
pub const MAX_EXTENSION_KEY_BYTES: usize = 64;
pub const MAX_EXTENSIONS_ENCODED_BYTES: usize = 4096;
pub const MAX_PARAMETER_LABEL_BYTES: usize = 120;
pub const MAX_PARAMETER_CHOICES: usize = 64;

/// A scalar an engine parameter can carry. Scalars only: an engine field is a
/// value, not a structure, and allowing nesting would make validation open.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum ParameterValue {
    Boolean(bool),
    Number(f64),
    Text(String),
}

/// One control an engine declares.
///
/// `key` is the field name the engine itself expects in its JSON input. The app
/// never translates a family or a selector into a field name -- that is the
/// whole point of declaring them.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ModelParameter {
    Integer {
        key: String,
        label: String,
        // i32, not i64: these cross JSON, where anything past 2^53 stops
        // round-tripping, and no engine control needs that range.
        default: i32,
        minimum: i32,
        maximum: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        step: Option<i32>,
    },
    Number {
        key: String,
        label: String,
        default: f64,
        minimum: f64,
        maximum: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        step: Option<f64>,
    },
    Boolean {
        key: String,
        label: String,
        default: bool,
    },
    Choice {
        key: String,
        label: String,
        default: String,
        /// Ordered; the app shows them in this order and does not sort.
        choices: Vec<String>,
    },
    Text {
        key: String,
        label: String,
        default: String,
        max_bytes: u32,
    },
}

impl ModelView {
    /// Declared stages, or an empty slice when the node declared none.
    pub fn declared_stages(&self) -> &[GenerationStage] {
        self.stages.as_deref().unwrap_or(&[])
    }

    /// Declared parameters, or an empty slice when the node declared none.
    pub fn declared_parameters(&self) -> &[ModelParameter] {
        self.parameters.as_deref().unwrap_or(&[])
    }
}

impl ModelParameter {
    pub fn key(&self) -> &str {
        match self {
            Self::Integer { key, .. }
            | Self::Number { key, .. }
            | Self::Boolean { key, .. }
            | Self::Choice { key, .. }
            | Self::Text { key, .. } => key,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct LyricsCapabilities {
    pub can_generate: bool,
    pub requires_lyrics: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub instrumental_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub writer_label: Option<String>,
}

/// What a model can do with audio it is given.
///
/// Named for what happens to the sound, not for an engine's task names, so
/// two families that cover a song in different ways both say `cover`. A model
/// declares these; nothing infers them from a family name.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum CapabilityKind {
    /// Re-render a source in a new style, keeping its tune and form.
    Cover,
    /// Add time before or after a source, keeping the source to the sample.
    Extend,
    /// Regenerate a region of a source, keeping the rest.
    Inpaint,
    /// Take a voice and sound from a reference recording.
    Timbre,
    /// Add one instrument over a backing track.
    AddTrack,
    /// Pull one stem out of a mix.
    Separate,
    /// Build a full arrangement around a single stem.
    Accompany,
}

impl CapabilityKind {
    /// The kind for a wire or catalog name, or `None` for one this build does
    /// not know, which callers drop rather than fail on.
    pub fn parse(name: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(name.to_owned())).ok()
    }
}

/// One audio capability a model declares, with its own limits and its own
/// stage arc: a cover skips planning, so it traces fewer stages than the
/// model's text-to-music path.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ModelCapability {
    pub kind: CapabilityKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stages: Option<Vec<GenerationStage>>,
    /// Longest source this capability takes, in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_source_seconds: Option<u32>,
    /// Longest result, source included, for `extend`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_total_seconds: Option<u32>,
}

/// A model's audio capabilities, read leniently.
///
/// A catalog or a newer node can name a kind this build has never heard of.
/// One unknown entry must not make every other declaration unreadable, so it
/// is dropped here rather than failing the view that carries it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Capabilities(pub Vec<ModelCapability>);

impl<'de> Deserialize<'de> for Capabilities {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Vec::<serde_json::Value>::deserialize(deserializer)?;
        Ok(Self(
            raw.into_iter()
                .filter_map(|value| serde_json::from_value::<ModelCapability>(value).ok())
                .collect(),
        ))
    }
}

impl Capabilities {
    pub fn get(&self, kind: CapabilityKind) -> Option<&ModelCapability> {
        self.0.iter().find(|capability| capability.kind == kind)
    }

    pub fn has(&self, kind: CapabilityKind) -> bool {
        self.get(kind).is_some()
    }
}

/// Capability kinds, read leniently for the same reason.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CapabilityKinds(pub Vec<CapabilityKind>);

impl<'de> Deserialize<'de> for CapabilityKinds {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Vec::<serde_json::Value>::deserialize(deserializer)?;
        Ok(Self(
            raw.into_iter()
                .filter_map(|value| serde_json::from_value::<CapabilityKind>(value).ok())
                .collect(),
        ))
    }
}

/// Where the sound an act starts from: a song in the library, a file the
/// phone sends, or a tune someone records.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ActSource {
    Song,
    Upload,
    Tune,
}

/// Which words an act's Words input may offer.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum WordsOffer {
    /// The source's own words (the app's song facts).
    Same,
    /// Words the person writes.
    Mine,
    /// No words: the model's instrumental marker.
    #[serde(rename = "none")]
    Nothing,
}

/// One thing an act asks of the person, by kind. Each kind fills known
/// `AudioPrompt` (or request) fields; a new kind is the one place a new act
/// needs code in the node and the app.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, tag = "kind", rename_all = "snake_case")]
pub enum ActInput {
    /// The caption. Optional with a default: an empty caption is the
    /// default, filled in by the node, so the recipe says what was sent.
    Prompt {
        required: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        default: Option<String>,
        /// An empty prompt is the source's own description: a made song's
        /// recipe caption (later, what the node hears in an upload). Takes
        /// precedence over `default`.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[ts(as = "Option<bool>", optional)]
        from_source: bool,
    },
    /// The lyrics, from the offers listed.
    Words { offers: Vec<WordsOffer> },
    /// Keep the source's voice (`AudioPrompt.keep_voice`); needs `timbre`.
    Voice,
    /// How far from the source (`AudioPrompt.closeness`), at these stops.
    Follow { stops: Vec<f32> },
    /// Time added (`extend_seconds`) in steps, and where (`extend_at`).
    AddedLength {
        step_seconds: u32,
        at: Vec<ExtendAt>,
    },
    /// A short source repeated to a whole song (`tile_to_seconds`).
    Tile,
}

/// Something a model can do with a sound, as the person meets it: "a
/// version", "longer". Declared in the catalog beside the capabilities, and
/// advertised only when the capability it `needs` is.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ActView {
    /// An open wire name (`version`, `longer`, `hum`, …): an app keeps its own
    /// words for the ids it knows and shows `label` for the rest.
    pub id: String,
    /// The catalog's own words for it.
    pub label: String,
    pub needs: CapabilityKind,
    pub sources: Vec<ActSource>,
    pub inputs: Vec<ActInput>,
}

impl ActView {
    /// The act's prompt input: whether it is required, its literal default,
    /// and whether an empty one is the source's own description.
    pub fn prompt(&self) -> Option<(bool, Option<&str>, bool)> {
        self.inputs.iter().find_map(|input| match input {
            ActInput::Prompt {
                required,
                default,
                from_source,
            } => Some((*required, default.as_deref(), *from_source)),
            _ => None,
        })
    }
}

/// A model's acts, read leniently: an act with an unknown capability or
/// input kind, or an id that is not a wire name, is dropped rather than
/// making the others unreadable. An act this build cannot fill is not one it
/// can offer.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Acts(pub Vec<ActView>);

impl<'de> Deserialize<'de> for Acts {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Vec::<serde_json::Value>::deserialize(deserializer)?;
        Ok(Self(
            raw.into_iter()
                .filter_map(|value| serde_json::from_value::<ActView>(value).ok())
                .filter(|act| is_wire_name(&act.id))
                .collect(),
        ))
    }
}

impl Acts {
    pub fn get(&self, id: &str) -> Option<&ActView> {
        self.0.iter().find(|act| act.id == id)
    }
}

/// `[a-z][a-z0-9_]{0,31}`: the shape of every open name on the wire.
pub fn is_wire_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 32
        && chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A model this node does not have but could install, with what it would add.
///
/// Drawn from the catalog the node caches and filtered by what its hardware and
/// backends can run, so the app can say which model would open a door rather
/// than only that it is shut.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct InstallableView {
    /// What to pass to `cantor pull`, for example `acestep:1.5-fast`.
    pub selector: String,
    pub family: String,
    #[serde(default)]
    #[ts(as = "Vec<CapabilityKind>")]
    pub capabilities: CapabilityKinds,
    #[ts(type = "number")]
    pub bytes: u64,
    #[serde(default)]
    pub licence: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct ModelView {
    /// Stable value accepted by `job.create`, for example `acestep:1.5-fast`.
    pub selector: String,
    pub family: String,
    pub engine: String,
    /// The stages this model actually runs, in order.
    ///
    /// `None` means the node has not declared them -- an older node, or a
    /// marker written before declarations existed. That is different from
    /// declaring none, and clients draw observed stages rather than guessing an
    /// arc when it is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stages: Option<Vec<GenerationStage>>,
    /// Controls this model accepts beyond caption, lyrics and duration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parameters: Option<Vec<ModelParameter>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lyrics: Option<LyricsCapabilities>,
    /// What this model can do with audio, where both its weights (the catalog)
    /// and the loaded engine build say so.
    ///
    /// `None` is an older node, which offers no audio acts. Unknown kinds are
    /// dropped rather than failing the whole view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, as = "Option<Vec<ModelCapability>>")]
    pub capabilities: Option<Capabilities>,
    /// What a person can do with a sound on this model: each act names the
    /// capability it needs and the inputs it asks for. `None` is an older
    /// node, read through the app's built-in acts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, as = "Option<Vec<ActView>>")]
    pub acts: Option<Acts>,
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
    /// Largest file `upload.open` accepts. Absent on a node without uploads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number | undefined")]
    pub max_upload_bytes: Option<u64>,
    /// Longest source an audio act takes, in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_source_seconds: Option<u32>,
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
    /// Additive: a client may predict a new job's id from its principal and
    /// client request id only when this is `true`.
    #[serde(default)]
    pub derived_job_ids: bool,
    /// Additive: a node that predates `job.forget` omits the key, and a client
    /// that reads `false` must not offer the act.
    #[serde(default)]
    pub job_forget: bool,
    /// Additive: `GenerationRequest::audio` is understood. A node that predates
    /// it would ignore the field and render text-to-music instead, so a client
    /// must not send it unless this is `true`.
    #[serde(default)]
    pub audio_sources: bool,
    /// Additive: `upload.open`, `upload.chunk` and `upload.commit`.
    #[serde(default)]
    pub uploads: bool,
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
    /// Models this node could install, from its cached catalog, filtered by
    /// what it can run. Absent when it has never reached the catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub installable: Option<Vec<InstallableView>>,
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
    /// An audio act's source turned into latents, before `diffuse`. Additive:
    /// an app that predates it draws it as working.
    Encode,
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

/// One stage of the plan a job runs (`JobView::plan`), and the unit its
/// progress is counted in while it runs.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct PlanStage {
    pub stage: GenerationStage,
    pub unit: ProgressUnit,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct JobView {
    pub id: String,
    /// The submitting client's id for this job (`job.create`'s
    /// `client_request_id`). Only ever sent to the principal that submitted it,
    /// which every JobView path already is. Lets a client match a job whose
    /// acceptance it never received.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_request_id: Option<String>,
    pub revision: u32,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stage: Option<GenerationStage>,
    /// The stages this job runs, in order, each with the unit its progress is
    /// counted in. Decided by the node from the request and the engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan: Option<Vec<PlanStage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub progress: Option<JobProgress>,
    pub model: String,
    /// The words that were asked for.
    ///
    /// Additive: a node that predates it omits the key, and a job cached by an
    /// older app has none. Without it a stopped job is unrecognisable from any
    /// device but the one that typed it, since the submission itself never
    /// leaves that phone. Bounded by `MAX_CAPTION_BYTES` at admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub caption: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<JobError>,
}

/// Where the sound an audio act starts from lives on the node.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, tag = "kind", rename_all = "snake_case")]
pub enum AudioSource {
    /// A song in this principal's library: its own recording, already here.
    Song { song_id: String },
    /// A committed upload: a tune, or a file from the phone.
    Upload { upload_id: String },
}

/// What is done to the source. User-level acts, mapped to engine tasks by the
/// node, so one wire serves every family that declares the capability.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AudioAct {
    /// Needs `cover`; `keep_voice` also needs `timbre`.
    Cover,
    /// Needs `extend`.
    Extend,
}

impl AudioAct {
    pub fn capability(self) -> CapabilityKind {
        match self {
            Self::Cover => CapabilityKind::Cover,
            Self::Extend => CapabilityKind::Extend,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ExtendAt {
    End,
    Start,
}

/// A generation that starts from a sound rather than only from words.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct AudioPrompt {
    pub source: AudioSource,
    pub act: AudioAct,
    /// The declared act this request makes (`ModelView.acts`), when the app
    /// knows acts. The node checks the model offers it and fills an empty
    /// caption from its prompt's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub act_id: Option<String>,
    /// Cover: how far from the source, 0 (close) to 1 (free). The node maps it
    /// to the engine's own controls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closeness: Option<f32>,
    /// Cover: keep the source's voice and sound as the timbre reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub keep_voice: Option<bool>,
    /// Extend: seconds to add.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extend_seconds: Option<u32>,
    /// Extend: where to add them. The end when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extend_at: Option<ExtendAt>,
    /// Cover: repeat the source to this many seconds first, so a short tune
    /// becomes a whole song that keeps coming back to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tile_to_seconds: Option<u32>,
    /// The source is a tune someone made (hummed, whistled, played), not a
    /// finished recording. A cover has to hold a bare melody much harder than
    /// a song to keep it, so the node maps `closeness` differently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tune: Option<bool>,
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
    /// Values for the parameters the selected model declared.
    ///
    /// Empty for an old client, and for a model that declares nothing. A field
    /// supplied here *and* through a legacy top-level field is rejected rather
    /// than resolved by precedence: silently picking one would run a generation
    /// the caller did not ask for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extensions: Option<BTreeMap<String, ParameterValue>>,
    /// Start from a sound. Send only to a node whose features say
    /// `audio_sources`: an older node ignores the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub audio: Option<Box<AudioPrompt>>,
    /// The song's name, when the app gives one (an audio act names its song
    /// after its source: "Variation of Terraza"). Absent: the node names it
    /// from the caption, as before. At most `MAX_TITLE_BYTES`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
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
    /// Where a song made from a sound came from. Absent for a song made from
    /// words alone, and from an older node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub derived_from: Option<SongOrigin>,
}

/// The sound a song was made from.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SongOrigin {
    pub act: AudioAct,
    /// The source song, when it was one; absent for an upload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub song_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct SongDetail {
    pub song: SongHeader,
    pub generation: GenerationRequest,
    /// The words the model wrote, when it was asked to write them
    /// (`generation.lyrics` absent). Absent for words someone gave it, and for
    /// songs made before a node recorded them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub written_lyrics: Option<String>,
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
    #[serde(rename = "job.forget")]
    #[ts(rename = "job.forget")]
    JobForget {
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
    /// Start or resume sending a file. Idempotent on `sha256`: a second open
    /// of the same bytes resumes the first upload from what arrived.
    #[serde(rename = "upload.open")]
    #[ts(rename = "upload.open")]
    UploadOpen {
        v: u8,
        id: String,
        sha256: String,
        #[ts(type = "number")]
        bytes: u64,
        media_type: String,
    },
    /// The next slice, at exactly the offset the node last acknowledged.
    #[serde(rename = "upload.chunk")]
    #[ts(rename = "upload.chunk")]
    UploadChunk {
        v: u8,
        id: String,
        upload_id: String,
        #[ts(type = "number")]
        offset: u64,
        /// Base64, at most `UPLOAD_CHUNK_BYTES` decoded.
        data: String,
    },
    #[serde(rename = "upload.commit")]
    #[ts(rename = "upload.commit")]
    UploadCommit {
        v: u8,
        id: String,
        upload_id: String,
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
    /// The reply carries the request id; the copy pushed to the owner's other
    /// sessions does not. A forgotten job has no view left to send.
    #[serde(rename = "job.forgotten")]
    #[ts(rename = "job.forgotten")]
    JobForgotten {
        v: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        id: Option<String>,
        job_id: String,
    },
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
        detail: Box<SongDetail>,
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
    /// Where to continue an upload from, and how large its slices are.
    #[serde(rename = "upload.ready")]
    #[ts(rename = "upload.ready")]
    UploadReady {
        v: u8,
        id: String,
        upload_id: String,
        #[ts(type = "number")]
        accepted_offset: u64,
        chunk_bytes: u32,
    },
    #[serde(rename = "upload.ack")]
    #[ts(rename = "upload.ack")]
    UploadAck {
        v: u8,
        id: String,
        upload_id: String,
        #[ts(type = "number")]
        next_offset: u64,
    },
    /// Every byte arrived, the hash matched, and the node could read it as
    /// audio of this length.
    #[serde(rename = "upload.committed")]
    #[ts(rename = "upload.committed")]
    UploadCommitted {
        v: u8,
        id: String,
        upload_id: String,
        sha256: String,
        #[ts(type = "number")]
        bytes: u64,
        seconds: f32,
    },
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
            include_str!("../../../../protocol/fixtures/v2/job-forget.json"),
            include_str!("../../../../protocol/fixtures/v2/library-list.json"),
            include_str!("../../../../protocol/fixtures/v2/job-create-audio.json"),
            include_str!("../../../../protocol/fixtures/v2/job-create-tune.json"),
            include_str!("../../../../protocol/fixtures/v2/upload-open.json"),
            include_str!("../../../../protocol/fixtures/v2/upload-chunk.json"),
            include_str!("../../../../protocol/fixtures/v2/upload-commit.json"),
        ];
        for fixture in client {
            serde_json::from_str::<ClientMessage>(fixture).expect("valid client fixture");
        }
        let node = [
            include_str!("../../../../protocol/fixtures/v2/node-info.json"),
            include_str!("../../../../protocol/fixtures/v2/node-info-lyrics.json"),
            include_str!("../../../../protocol/fixtures/v2/node-info-capabilities.json"),
            include_str!("../../../../protocol/fixtures/v2/upload-ready.json"),
            include_str!("../../../../protocol/fixtures/v2/upload-ack.json"),
            include_str!("../../../../protocol/fixtures/v2/upload-committed.json"),
            include_str!("../../../../protocol/fixtures/v2/jobs-page.json"),
            include_str!("../../../../protocol/fixtures/v2/jobs-page-plan.json"),
            include_str!("../../../../protocol/fixtures/v2/job-forgotten.json"),
            include_str!("../../../../protocol/fixtures/v2/library-page.json"),
            include_str!("../../../../protocol/fixtures/v2/error.json"),
            include_str!("../../../../protocol/fixtures/v2/forward/extra-optional-field.json"),
        ];
        for fixture in node {
            serde_json::from_str::<NodeMessage>(fixture).expect("valid node fixture");
        }
    }

    #[test]
    fn old_node_info_does_not_advertise_derived_job_ids() {
        let NodeMessage::NodeInfoChanged { node, .. } = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/v2/node-info.json"
        ))
        .expect("legacy node info fixture") else {
            panic!("node.info");
        };
        assert!(!node.features.derived_job_ids);
    }

    #[test]
    fn job_plan_fixture_carries_the_submission_and_arc_and_old_jobs_omit_them() {
        let NodeMessage::JobsPage { jobs, .. } = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/v2/jobs-page-plan.json"
        ))
        .expect("job plan fixture") else {
            panic!("jobs.page");
        };
        let job = &jobs[0];
        assert_eq!(
            job.client_request_id.as_deref(),
            Some("019c8f7e-5f2b-7a21-9ee0-8efb630bcb20")
        );
        assert_eq!(job.stage, Some(GenerationStage::Encode));
        assert_eq!(job.state, JobState::Running);
        assert_eq!(
            job.plan.as_deref(),
            Some(
                &[
                    PlanStage {
                        stage: GenerationStage::Encode,
                        unit: ProgressUnit::Tiles
                    },
                    PlanStage {
                        stage: GenerationStage::Diffuse,
                        unit: ProgressUnit::Steps
                    },
                    PlanStage {
                        stage: GenerationStage::Decode,
                        unit: ProgressUnit::Tiles
                    },
                ][..]
            )
        );
        let NodeMessage::JobsPage { jobs, .. } = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/v2/jobs-page.json"
        ))
        .expect("legacy jobs fixture") else {
            panic!("jobs.page");
        };
        for job in jobs {
            assert!(job.client_request_id.is_none() && job.plan.is_none());
            let json = serde_json::to_value(job).unwrap();
            assert!(json.get("client_request_id").is_none() && json.get("plan").is_none());
        }
    }

    #[test]
    fn unknown_capability_kinds_are_dropped_and_the_rest_kept() {
        let NodeMessage::NodeInfoChanged { node, .. } = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/v2/node-info-capabilities.json"
        ))
        .expect("node info") else {
            panic!("node.info");
        };
        let kinds: Vec<_> = node.models[0]
            .capabilities
            .as_ref()
            .expect("declared")
            .0
            .iter()
            .map(|c| c.kind)
            .collect();
        assert_eq!(
            kinds,
            [
                CapabilityKind::Cover,
                CapabilityKind::Extend,
                CapabilityKind::Timbre
            ]
        );
        assert!(node.features.audio_sources && node.features.uploads);
        let installable = node.installable.expect("installable");
        assert_eq!(installable[0].capabilities.0.len(), 3);
    }

    #[test]
    fn an_old_node_info_has_no_audio_and_says_so() {
        let NodeMessage::NodeInfoChanged { node, .. } = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/v2/node-info-lyrics.json"
        ))
        .expect("node info") else {
            panic!("node.info");
        };
        assert!(node.models[0].capabilities.is_none());
        assert!(!node.features.audio_sources && !node.features.uploads);
        assert!(node.installable.is_none());
    }

    #[test]
    fn an_unknown_audio_act_rejects_the_request_rather_than_running_another() {
        let mut raw: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/v2/job-create-audio.json"
        ))
        .expect("fixture");
        raw["generation"]["audio"]["act"] = serde_json::json!("teleport");
        assert!(serde_json::from_value::<ClientMessage>(raw).is_err());
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

    #[test]
    fn acts_use_the_tagged_wire_shape() {
        let act = ActView {
            id: "version".to_owned(),
            label: "A version".to_owned(),
            needs: CapabilityKind::Cover,
            sources: vec![ActSource::Song, ActSource::Upload],
            inputs: vec![
                ActInput::Voice,
                ActInput::Words {
                    offers: vec![WordsOffer::Same, WordsOffer::Nothing],
                },
                ActInput::Prompt {
                    from_source: false,
                    required: false,
                    default: Some("d".to_owned()),
                },
                ActInput::AddedLength {
                    step_seconds: 30,
                    at: vec![ExtendAt::End],
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&act).unwrap(),
            serde_json::json!({
                "id": "version", "label": "A version", "needs": "cover",
                "sources": ["song", "upload"],
                "inputs": [
                    {"kind": "voice"},
                    {"kind": "words", "offers": ["same", "none"]},
                    {"kind": "prompt", "required": false, "default": "d"},
                    {"kind": "added_length", "step_seconds": 30, "at": ["end"]}
                ]
            })
        );
    }

    #[test]
    fn an_act_this_build_cannot_fill_is_dropped_not_fatal() {
        let acts: Acts = serde_json::from_value(serde_json::json!([
            {"id": "version", "label": "A version", "needs": "cover",
             "sources": ["song"], "inputs": [{"kind": "voice"}]},
            // An input kind from a newer catalog.
            {"id": "redo", "label": "Redo a part", "needs": "cover",
             "sources": ["song"], "inputs": [{"kind": "region"}]},
            // A capability this build does not know.
            {"id": "stems", "label": "Stems", "needs": "demix",
             "sources": ["song"], "inputs": []},
            // Not a wire name.
            {"id": "Bad Id", "label": "x", "needs": "cover",
             "sources": ["song"], "inputs": []}
        ]))
        .unwrap();
        assert_eq!(
            acts.0.iter().map(|act| act.id.as_str()).collect::<Vec<_>>(),
            ["version"]
        );
    }
}

//! Authenticated status, durable job submission, lookup, and controls.

use anyhow::Result;
use cantor_proto::{
    DEFAULT_PAGE_LIMIT, ErrorCode, ErrorDetails, GenerationRequest, JobState, MAX_CAPTION_BYTES,
    MAX_CFG, MAX_CLIENT_REQUEST_ID_BYTES, MAX_LYRICS_BYTES, MAX_MODEL_SELECTOR_BYTES,
    MAX_PAGE_LIMIT, MAX_SAFE_SEED, MAX_SONG_SECONDS, MAX_STEPS, MIN_CFG, MIN_SONG_SECONDS,
    MIN_STEPS, NodeMessage, PROTOCOL_VERSION,
};

use crate::config::NodeConfig;
use crate::library::{ControlResult, ForgetResult, JobControl, Library, Submission, SubmitResult};
use crate::store::Store;

use super::admit_job;
use super::auth::AuthenticatedSession;
use super::errors::{invalid_field, unauthenticated, unsupported_version};

pub(super) fn status(
    version: u8,
    id: String,
    authentication: Option<&AuthenticatedSession>,
    library: &Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(unsupported_version(id));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "status"));
    };
    Ok(NodeMessage::JobsPage {
        v: PROTOCOL_VERSION,
        id,
        jobs: library.list(context.principal_id, DEFAULT_PAGE_LIMIT)?,
        next_cursor: None,
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn list(
    version: u8,
    id: String,
    states: Option<Vec<JobState>>,
    cursor: Option<String>,
    limit: Option<u32>,
    authentication: Option<&AuthenticatedSession>,
    library: &Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
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

#[allow(clippy::too_many_arguments)]
pub(super) fn create(
    version: u8,
    id: String,
    client_request_id: String,
    model: String,
    generation: GenerationRequest,
    authentication: Option<&AuthenticatedSession>,
    config: &NodeConfig,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "jobs"));
    };
    if let Some(field) = invalid_submission(&client_request_id, &model, &generation) {
        return Ok(invalid_field(id, field));
    }
    let variants = Store::new(config.model_root()).installed();
    let Some(variant) = variants.iter().find(|variant| variant.selector() == model) else {
        return Ok(NodeMessage::Error {
            v: PROTOCOL_VERSION,
            id: Some(id),
            code: ErrorCode::ModelNotInstalled,
            message: "That model is not installed on this node.".into(),
            retryable: false,
            details: Some(ErrorDetails::Model { selector: model }),
        });
    };
    // Against the variant that is actually installed, not the one the client
    // believed was installed.
    if variant
        .lyrics
        .as_ref()
        .is_some_and(|cap| cap.requires_lyrics)
        && generation
            .lyrics
            .as_deref()
            .is_none_or(|text| text.trim().is_empty())
    {
        return Ok(invalid_field(id, "lyrics"));
    }
    if let Some(field) = invalid_extensions(&generation, &variant.parameters) {
        return Ok(invalid_field(id, &field));
    }
    if let Some(field) = invalid_audio(
        &generation,
        variant,
        &config.model_root(),
        library,
        context.principal_id,
    ) {
        return Ok(invalid_field(id, field));
    }
    let submission = Submission {
        client_request_id,
        model,
        generation,
    };
    match admit_job(
        library,
        config,
        context.principal_id,
        &context.client_public_key,
        &submission,
        variant,
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
        SubmitResult::SourceUnavailable => Ok(invalid_field(id, "audio.source")),
    }
}

pub(super) fn get(
    version: u8,
    id: String,
    job_id: String,
    authentication: Option<&AuthenticatedSession>,
    library: &Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
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

#[allow(clippy::too_many_arguments)]
pub(super) fn control(
    version: u8,
    id: String,
    job_id: String,
    expected_revision: Option<u32>,
    control: JobControl,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
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

/// Delete a stopped job outright, on the node and therefore everywhere.
///
/// The node keeps no tombstone: a forgotten job is gone from `jobs.list`, so a
/// client that was offline for it simply never sees it again.
pub(super) fn forget(
    version: u8,
    id: String,
    job_id: String,
    expected_revision: Option<u32>,
    authentication: Option<&AuthenticatedSession>,
    library: &mut Library,
) -> Result<NodeMessage> {
    if version != PROTOCOL_VERSION {
        return Ok(NodeMessage::unsupported_version(Some(id)));
    }
    let Some(context) = authentication else {
        return Ok(unauthenticated(id, "jobs"));
    };
    Ok(
        match library.forget_job(context.principal_id, &job_id, expected_revision)? {
            ForgetResult::Forgotten => NodeMessage::JobForgotten {
                v: PROTOCOL_VERSION,
                id: Some(id),
                job_id,
            },
            ForgetResult::Conflict(current) => NodeMessage::Error {
                v: PROTOCOL_VERSION,
                id: Some(id),
                code: ErrorCode::RevisionConflict,
                message: "The job changed before this deletion reached the node.".into(),
                retryable: false,
                details: Some(ErrorDetails::JobRevisionConflict { current }),
            },
            ForgetResult::Refused(current) => NodeMessage::Error {
                v: PROTOCOL_VERSION,
                id: Some(id),
                code: ErrorCode::InvalidTransition,
                message: "Only a failed or cancelled job can be deleted.".into(),
                retryable: false,
                details: Some(ErrorDetails::JobState { current }),
            },
            ForgetResult::NotFound => NodeMessage::error(
                Some(id),
                ErrorCode::NotFound,
                "That job was not found.",
                false,
            ),
        },
    )
}

pub(super) fn invalid_submission(
    client_request_id: &str,
    model: &str,
    generation: &GenerationRequest,
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

/// Check an audio prompt against what this node advertises for the installed
/// model and against a source the principal really has. `None` when the
/// request has no prompt or the prompt is sound; otherwise the field to name.
pub(super) fn invalid_audio(
    generation: &GenerationRequest,
    variant: &crate::store::InstalledVariant,
    model_root: &std::path::Path,
    library: &Library,
    principal: crate::principal::PrincipalId,
) -> Option<&'static str> {
    use cantor_proto::{AudioAct, AudioSource, CapabilityKind, MAX_CLOSENESS, MAX_EXTEND_SECONDS};

    let prompt = generation.audio.as_ref()?;
    // A source decides an audio act's length; an explicit one would be ignored.
    if generation.duration.is_some() {
        return Some("duration");
    }
    match &prompt.source {
        AudioSource::Song { song_id } if uuid::Uuid::parse_str(song_id).is_err() => {
            return Some("audio.source");
        }
        AudioSource::Upload { upload_id }
            if upload_id.is_empty()
                || upload_id.len() > cantor_proto::MAX_UPLOAD_ID_BYTES
                || uuid::Uuid::parse_str(upload_id).is_err() =>
        {
            return Some("audio.source");
        }
        _ => {}
    }
    let catalog = crate::capabilities::cached_catalog(model_root);
    let advertised = crate::capabilities::advertised(
        crate::capabilities::declared(variant, catalog.as_ref()).as_ref(),
        crate::engine::loaded_capabilities(variant.engine()).as_ref(),
    );
    let Some(capability) = advertised
        .iter()
        .find(|c| c.kind == prompt.act.capability())
    else {
        return Some("audio.act");
    };
    let Ok(Some(seconds)) = library.audio_source_seconds(principal, &prompt.source) else {
        return Some("audio.source");
    };
    let source_limit = capability
        .max_source_seconds
        .unwrap_or(MAX_SONG_SECONDS)
        .min(MAX_SONG_SECONDS);
    if seconds <= 0.0 || seconds > f64::from(source_limit) {
        return Some("audio.source");
    }
    match prompt.act {
        AudioAct::Cover => {
            if prompt.extend_seconds.is_some() || prompt.extend_at.is_some() {
                return Some("audio.extend_seconds");
            }
            if prompt
                .closeness
                .is_some_and(|c| !c.is_finite() || !(0.0..=MAX_CLOSENESS).contains(&c))
            {
                return Some("audio.closeness");
            }
            if prompt.keep_voice == Some(true)
                && !advertised.iter().any(|c| c.kind == CapabilityKind::Timbre)
            {
                return Some("audio.keep_voice");
            }
            if prompt
                .tile_to_seconds
                .is_some_and(|t| !(MIN_SONG_SECONDS..=MAX_SONG_SECONDS).contains(&t))
            {
                return Some("audio.tile_to_seconds");
            }
        }
        AudioAct::Extend => {
            if prompt.closeness.is_some()
                || prompt.keep_voice.is_some()
                || prompt.tile_to_seconds.is_some()
            {
                return Some("audio.act");
            }
            let Some(added) = prompt.extend_seconds else {
                return Some("audio.extend_seconds");
            };
            let total_limit = capability
                .max_total_seconds
                .unwrap_or(MAX_SONG_SECONDS)
                .min(MAX_SONG_SECONDS);
            if added == 0
                || added > MAX_EXTEND_SECONDS
                || seconds + f64::from(added) > f64::from(total_limit)
            {
                return Some("audio.extend_seconds");
            }
        }
    }
    None
}

/// Check declared-parameter values against the model that is actually
/// installed, not against whatever the client believed was installed.
pub(super) fn invalid_extensions(
    generation: &GenerationRequest,
    declared: &[cantor_proto::ModelParameter],
) -> Option<String> {
    let extensions = generation.extensions.as_ref()?;
    let mut legacy = Vec::new();
    if generation.steps.is_some() {
        legacy.push("steps");
    }
    if generation.cfg.is_some() {
        legacy.push("cfg");
    }
    if generation.seed.is_some() {
        legacy.push("seed");
    }
    match cantor_proto::extensions::validate_extensions(extensions, declared, &legacy) {
        Ok(()) => None,
        Err(error) => Some(error.field().to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use cantor_proto::{ErrorCode, GenerationRequest, JobState, NodeMessage, PROTOCOL_VERSION};
    use tempfile::tempdir;

    use crate::catalog::{Component, Model, Needs, Variant};
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::library::{JobControl, Library};
    use crate::principal::PrincipalId;
    use crate::runtime::NodeEvent;
    use crate::store::{InstalledVariant, Store};

    use super::super::outcome::{ApplicationEffect, from_response};
    use super::{AuthenticatedSession, control, create, forget, invalid_submission};

    fn fixture(path: &Path) -> (NodeConfig, Library, AuthenticatedSession, String) {
        let paths = NodePaths::resolve(Some(path.join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (mut config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        config.jobs.minimum_free_bytes = 0;
        let installed = InstalledVariant {
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
            capabilities: None,
            audio: None,
        };
        let store = Store::new(config.model_root());
        store.prepare().expect("model store");
        store
            .mark_installed(
                &Model {
                    name: installed.model.clone(),
                    licence: installed.licence.clone(),
                    engine: Some(installed.engine.clone()),
                    variants: Vec::new(),
                },
                &Variant {
                    tag: installed.tag.clone(),
                    components: installed.components.clone(),
                    needs: Needs {
                        vram_bytes: installed.vram_bytes,
                        backends: Vec::new(),
                    },
                    stages: Vec::new(),
                    parameters: Vec::new(),
                    lyrics: None,
                    capabilities: None,
                    audio: None,
                },
            )
            .expect("installed marker");
        let key = [1_u8; 32];
        let authentication = AuthenticatedSession {
            relay_session_id: "session".into(),
            principal_id: PrincipalId::from_client_public_key(&key),
            client_public_key: key,
        };
        (
            config,
            Library::open(path.join("library")).expect("library"),
            authentication,
            installed.selector(),
        )
    }

    fn generation(caption: &str) -> GenerationRequest {
        GenerationRequest {
            caption: caption.into(),
            lyrics: None,
            audio: None,
            duration: Some(15),
            steps: Some(1),
            cfg: None,
            seed: Some(7),
            extensions: None,
        }
    }

    #[test]
    fn accepted_idempotent_and_conflicting_submissions_keep_effect_policy() {
        let temporary = tempdir().expect("temporary directory");
        let (mut config, mut library, authentication, model) = fixture(temporary.path());
        let request_id = uuid::Uuid::new_v4().to_string();

        let accepted = create(
            PROTOCOL_VERSION,
            "accepted".into(),
            request_id.clone(),
            model.clone(),
            generation("same"),
            Some(&authentication),
            &config,
            &mut library,
        )
        .expect("create");
        let accepted = from_response(accepted, Some(authentication.principal_id), None);
        assert!(matches!(
            accepted.effects.as_slice(),
            [
                ApplicationEffect::WakeJobWorker,
                ApplicationEffect::RefreshNodeInfo
            ]
        ));
        let accepted_id = match accepted.response {
            NodeMessage::JobAccepted { job, .. } => job.id,
            other => panic!("unexpected response: {other:?}"),
        };

        let idempotent = create(
            PROTOCOL_VERSION,
            "idempotent".into(),
            request_id.clone(),
            model.clone(),
            generation("same"),
            Some(&authentication),
            &config,
            &mut library,
        )
        .expect("idempotent create");
        let idempotent = from_response(idempotent, Some(authentication.principal_id), None);
        assert!(matches!(
            idempotent.effects.as_slice(),
            [
                ApplicationEffect::WakeJobWorker,
                ApplicationEffect::RefreshNodeInfo
            ]
        ));
        assert!(matches!(
            idempotent.response,
            NodeMessage::JobAccepted { job, .. } if job.id == accepted_id
        ));

        let conflict = create(
            PROTOCOL_VERSION,
            "conflict".into(),
            request_id,
            model.clone(),
            generation("changed"),
            Some(&authentication),
            &config,
            &mut library,
        )
        .expect("conflicting create");
        let conflict = from_response(conflict, Some(authentication.principal_id), None);
        assert!(conflict.effects.is_empty());
        assert!(matches!(
            conflict.response,
            NodeMessage::Error {
                code: ErrorCode::IdempotencyConflict,
                ..
            }
        ));

        config.jobs.max_queued_per_principal = 1;
        let queue_full = create(
            PROTOCOL_VERSION,
            "queue-full".into(),
            uuid::Uuid::new_v4().to_string(),
            model.clone(),
            generation("queued"),
            Some(&authentication),
            &config,
            &mut library,
        )
        .expect("queue policy");
        let queue_full = from_response(queue_full, Some(authentication.principal_id), None);
        assert!(queue_full.effects.is_empty());
        assert!(matches!(
            queue_full.response,
            NodeMessage::Error {
                code: ErrorCode::QueueFull,
                ..
            }
        ));

        config.jobs.max_queued_per_principal = 32;
        config.jobs.minimum_free_bytes = u64::MAX;
        let insufficient_disk = create(
            PROTOCOL_VERSION,
            "insufficient-disk".into(),
            uuid::Uuid::new_v4().to_string(),
            model,
            generation("disk"),
            Some(&authentication),
            &config,
            &mut library,
        )
        .expect("disk policy");
        let insufficient_disk =
            from_response(insufficient_disk, Some(authentication.principal_id), None);
        assert!(insufficient_disk.effects.is_empty());
        assert!(matches!(
            insufficient_disk.response,
            NodeMessage::Error {
                code: ErrorCode::InsufficientDisk,
                ..
            }
        ));
    }

    #[test]
    fn resumed_jobs_wake_before_publishing_and_conflicts_have_no_effects() {
        let temporary = tempdir().expect("temporary directory");
        let (config, mut library, authentication, model) = fixture(temporary.path());
        let accepted = create(
            PROTOCOL_VERSION,
            "accepted".into(),
            uuid::Uuid::new_v4().to_string(),
            model,
            generation("control"),
            Some(&authentication),
            &config,
            &mut library,
        )
        .expect("create");
        let accepted = match accepted {
            NodeMessage::JobAccepted { job, .. } => job,
            other => panic!("unexpected response: {other:?}"),
        };
        let paused = control(
            PROTOCOL_VERSION,
            "pause".into(),
            accepted.id.clone(),
            Some(accepted.revision),
            JobControl::Pause,
            Some(&authentication),
            &mut library,
        )
        .expect("pause");
        let paused = match paused {
            NodeMessage::JobControlled { job, .. } => job,
            other => panic!("unexpected pause: {other:?}"),
        };
        assert_eq!(paused.state, JobState::Paused);

        let resumed = control(
            PROTOCOL_VERSION,
            "resume".into(),
            paused.id.clone(),
            Some(paused.revision),
            JobControl::Resume,
            Some(&authentication),
            &mut library,
        )
        .expect("resume");
        let resumed = from_response(resumed, Some(authentication.principal_id), None);
        match resumed.effects.as_slice() {
            [
                ApplicationEffect::WakeJobWorker,
                ApplicationEffect::Publish(NodeEvent::JobUpdated { principal_id, job }),
                ApplicationEffect::RefreshNodeInfo,
            ] => {
                assert_eq!(*principal_id, authentication.principal_id);
                assert_eq!(job.state, JobState::Queued);
            }
            other => panic!("unexpected effects: {other:?}"),
        }

        let conflict = control(
            PROTOCOL_VERSION,
            "conflict".into(),
            paused.id,
            Some(paused.revision),
            JobControl::Pause,
            Some(&authentication),
            &mut library,
        )
        .expect("conflicting control");
        let conflict = from_response(conflict, Some(authentication.principal_id), None);
        assert!(conflict.effects.is_empty());
        assert!(matches!(
            conflict.response,
            NodeMessage::Error {
                code: ErrorCode::RevisionConflict,
                ..
            }
        ));
    }

    #[test]
    fn forgetting_a_cancelled_job_answers_the_caller_and_tells_its_other_sessions() {
        let temporary = tempdir().expect("temporary directory");
        let (config, mut library, authentication, model) = fixture(temporary.path());
        let accepted = create(
            PROTOCOL_VERSION,
            "accepted".into(),
            uuid::Uuid::new_v4().to_string(),
            model,
            generation("forget"),
            Some(&authentication),
            &config,
            &mut library,
        )
        .expect("create");
        let accepted = match accepted {
            NodeMessage::JobAccepted { job, .. } => job,
            other => panic!("unexpected response: {other:?}"),
        };

        // A queued job is still work someone asked for; cancel it first.
        let refused = forget(
            PROTOCOL_VERSION,
            "too-early".into(),
            accepted.id.clone(),
            None,
            Some(&authentication),
            &mut library,
        )
        .expect("early forget");
        let refused = from_response(refused, Some(authentication.principal_id), None);
        assert!(refused.effects.is_empty());
        assert!(matches!(
            refused.response,
            NodeMessage::Error {
                code: ErrorCode::InvalidTransition,
                ..
            }
        ));

        let cancelled = control(
            PROTOCOL_VERSION,
            "cancel".into(),
            accepted.id.clone(),
            Some(accepted.revision),
            JobControl::Cancel,
            Some(&authentication),
            &mut library,
        )
        .expect("cancel");
        let cancelled = match cancelled {
            NodeMessage::JobControlled { job, .. } => job,
            other => panic!("unexpected cancel: {other:?}"),
        };
        assert_eq!(cancelled.state, JobState::Cancelled);

        let forgotten = forget(
            PROTOCOL_VERSION,
            "forget".into(),
            cancelled.id.clone(),
            Some(cancelled.revision),
            Some(&authentication),
            &mut library,
        )
        .expect("forget");
        let forgotten = from_response(forgotten, Some(authentication.principal_id), None);
        match forgotten.effects.as_slice() {
            [
                ApplicationEffect::Publish(NodeEvent::JobForgotten {
                    principal_id,
                    job_id,
                }),
                ApplicationEffect::RefreshNodeInfo,
            ] => {
                assert_eq!(*principal_id, authentication.principal_id);
                assert_eq!(*job_id, cancelled.id);
            }
            other => panic!("unexpected effects: {other:?}"),
        }
        assert!(matches!(
            forgotten.response,
            NodeMessage::JobForgotten { id: Some(id), job_id, .. }
                if id == "forget" && job_id == cancelled.id
        ));

        let gone = forget(
            PROTOCOL_VERSION,
            "again".into(),
            cancelled.id,
            None,
            Some(&authentication),
            &mut library,
        )
        .expect("second forget");
        assert!(matches!(
            gone,
            NodeMessage::Error {
                code: ErrorCode::NotFound,
                ..
            }
        ));
    }

    #[test]
    fn an_unauthenticated_session_cannot_forget_anything() {
        let temporary = tempdir().expect("temporary directory");
        let (_, mut library, _, _) = fixture(temporary.path());
        assert!(matches!(
            forget(
                PROTOCOL_VERSION,
                "anonymous".into(),
                "job".into(),
                None,
                None,
                &mut library,
            )
            .expect("unauthenticated forget"),
            NodeMessage::Error {
                code: ErrorCode::Unauthenticated,
                ..
            }
        ));
    }

    #[test]
    fn seed_is_bounded_to_jsons_exact_integer_range() {
        let request_id = uuid::Uuid::new_v4().to_string();
        let request = GenerationRequest {
            caption: "seed".into(),
            lyrics: None,
            audio: None,
            duration: None,
            steps: None,
            cfg: None,
            seed: Some(cantor_proto::MAX_SAFE_SEED + 1),
            extensions: None,
        };
        assert_eq!(
            invalid_submission(&request_id, "acestep:test", &request),
            Some("seed")
        );
    }
}

#[cfg(test)]
mod audio_admission_tests {
    use cantor_proto::{
        AudioAct, AudioPrompt, AudioSource, Capabilities, CapabilityKind, GenerationRequest,
        ModelCapability,
    };
    use tempfile::tempdir;

    use super::invalid_audio;
    use crate::catalog::AudioBinding;
    use crate::library::{Library, UploadCommit, UploadOpen};
    use crate::principal::PrincipalId;
    use crate::store::InstalledVariant;

    const KEY: [u8; 32] = [3; 32];

    fn capability(kind: CapabilityKind) -> ModelCapability {
        ModelCapability {
            kind,
            stages: None,
            max_source_seconds: Some(120),
            max_total_seconds: Some(180),
        }
    }

    /// A model whose weights declare cover, extend and timbre, with a binding
    /// for each, run by an engine family of this test's own.
    fn variant(family: &str) -> InstalledVariant {
        InstalledVariant {
            model: family.into(),
            tag: "t".into(),
            licence: String::new(),
            components: Vec::new(),
            installed_at: String::new(),
            engine: family.into(),
            vram_bytes: 0,
            stages: Vec::new(),
            parameters: Vec::new(),
            lyrics: None,
            capabilities: Some(Capabilities(vec![
                capability(CapabilityKind::Cover),
                capability(CapabilityKind::Extend),
                capability(CapabilityKind::Timbre),
            ])),
            audio: Some(
                serde_json::from_value::<AudioBinding>(serde_json::json!({
                    "source_field": "src", "reference_field": "ref",
                    "cover": {"song": [{"closeness": 0.5, "fields": {}}]},
                    "extend": {"start_field": "a", "end_field": "b"}
                }))
                .expect("binding"),
            ),
        }
    }

    fn upload(library: &mut Library, seconds: f64) -> String {
        let principal = PrincipalId::from_client_public_key(&KEY);
        let bytes = format!("audio {seconds}").into_bytes();
        let sha = sha2::Digest::finalize(sha2::Digest::chain_update(
            <sha2::Sha256 as sha2::Digest>::new(),
            &bytes,
        ))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
        let UploadOpen::Ready { id, .. } = library
            .open_upload(principal, &KEY, &sha, bytes.len() as u64, "audio/wav")
            .expect("open")
        else {
            panic!("ready");
        };
        library
            .write_upload_chunk(principal, &id, 0, &bytes)
            .expect("chunk");
        assert!(matches!(
            library
                .commit_upload(principal, &id, |_| Ok(seconds))
                .expect("commit"),
            UploadCommit::Committed { .. }
        ));
        id
    }

    fn request(upload_id: &str, act: AudioAct) -> GenerationRequest {
        GenerationRequest {
            caption: "c".into(),
            lyrics: None,
            duration: None,
            steps: None,
            cfg: None,
            seed: None,
            extensions: None,
            audio: Some(Box::new(AudioPrompt {
                source: AudioSource::Upload {
                    upload_id: upload_id.into(),
                },
                act,
                closeness: None,
                keep_voice: None,
                extend_seconds: None,
                extend_at: None,
                tile_to_seconds: None,
                tune: None,
            })),
        }
    }

    fn check(
        family: &str,
        library: &Library,
        generation: &GenerationRequest,
    ) -> Option<&'static str> {
        invalid_audio(
            generation,
            &variant(family),
            std::path::Path::new("/nonexistent"),
            library,
            PrincipalId::from_client_public_key(&KEY),
        )
    }

    #[test]
    fn a_sound_prompt_passes_and_each_fault_names_its_field() {
        let family = "audio-admission-faults";
        crate::engine::declare_loaded_for_test(
            family,
            vec![
                CapabilityKind::Cover,
                CapabilityKind::Extend,
                CapabilityKind::Timbre,
            ],
        );
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let short = upload(&mut library, 30.0);
        let long = upload(&mut library, 150.0);

        let mut cover = request(&short, AudioAct::Cover);
        assert_eq!(check(family, &library, &cover), None);

        cover.duration = Some(60);
        assert_eq!(check(family, &library, &cover), Some("duration"));
        cover.duration = None;

        cover.audio.as_mut().unwrap().closeness = Some(1.5);
        assert_eq!(check(family, &library, &cover), Some("audio.closeness"));
        cover.audio.as_mut().unwrap().closeness = Some(0.0);
        cover.audio.as_mut().unwrap().keep_voice = Some(true);
        assert_eq!(check(family, &library, &cover), None);

        assert_eq!(
            check(family, &library, &request(&long, AudioAct::Cover)),
            Some("audio.source"),
            "longer than this capability takes"
        );
        assert_eq!(
            check(
                family,
                &library,
                &request(&uuid::Uuid::new_v4().to_string(), AudioAct::Cover)
            ),
            Some("audio.source"),
            "not an upload of this principal"
        );

        let mut longer = request(&short, AudioAct::Extend);
        assert_eq!(
            check(family, &library, &longer),
            Some("audio.extend_seconds")
        );
        longer.audio.as_mut().unwrap().extend_seconds = Some(60);
        assert_eq!(check(family, &library, &longer), None);
        longer.audio.as_mut().unwrap().extend_seconds = Some(200);
        assert_eq!(
            check(family, &library, &longer),
            Some("audio.extend_seconds"),
            "past the capability's total"
        );
        longer.audio.as_mut().unwrap().extend_seconds = Some(60);
        longer.audio.as_mut().unwrap().closeness = Some(0.5);
        assert_eq!(check(family, &library, &longer), Some("audio.act"));
    }

    #[test]
    fn nothing_is_admitted_that_the_engine_does_not_wire() {
        let family = "audio-admission-engine";
        crate::engine::declare_loaded_for_test(family, vec![CapabilityKind::Cover]);
        let directory = tempdir().expect("tempdir");
        let mut library = Library::open(directory.path()).expect("library");
        let id = upload(&mut library, 30.0);
        let mut keep = request(&id, AudioAct::Cover);
        keep.audio.as_mut().unwrap().keep_voice = Some(true);
        assert_eq!(check(family, &library, &keep), Some("audio.keep_voice"));
        let mut longer = request(&id, AudioAct::Extend);
        longer.audio.as_mut().unwrap().extend_seconds = Some(30);
        assert_eq!(check(family, &library, &longer), Some("audio.act"));
        assert_eq!(
            check(
                "audio-admission-never-loaded",
                &library,
                &request(&id, AudioAct::Cover)
            ),
            Some("audio.act"),
            "an engine not loaded yet advertises nothing"
        );
    }
}

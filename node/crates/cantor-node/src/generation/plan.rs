//! Resolve one accepted job into fully owned native generation inputs.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::LazyLock;

/// Shared empty map so the common path allocates nothing.
static EMPTY_EXTENSIONS: LazyLock<BTreeMap<String, cantor_proto::ParameterValue>> =
    LazyLock::new(BTreeMap::new);

use anyhow::Result;
use cantor_proto::ErrorCode;

use super::WorkerFailure;
use crate::accel;
use crate::audio::{acts, prepare};
use crate::backends::{BackendManifest, EngineStore, machine_arch};
use crate::engine::{LoadOptions, Stage};
use crate::generate::{Request, components_for, engine_fields};
use crate::library::WorkItem;
use crate::runtime::SharedState;
use crate::store::Store;

pub(crate) struct GenerationPlan {
    pub(super) attempts: Vec<(String, PathBuf)>,
    pub(super) components: Vec<(String, PathBuf)>,
    pub(super) options: LoadOptions,
    pub(super) request: Request,
    /// Where a fresh attempt enters, when not the engine's first stage. An
    /// audio act starts at `diffuse`: there is nothing to plan or code.
    pub(super) entry: Option<Stage>,
    /// For an extension: the source's samples and where they sit in the
    /// result, to be put back exactly after decoding.
    pub(super) restore: Option<SourceRestore>,
}

#[derive(Clone, Debug)]
pub(crate) struct SourceRestore {
    pub(super) source: PathBuf,
    pub(super) offset_seconds: f64,
}

pub(crate) async fn resolve(
    state: &SharedState,
    work: &WorkItem,
) -> std::result::Result<GenerationPlan, WorkerFailure> {
    let (model_root, backends_url, pinned, tuning) = state
        .lock()
        .map(|locked| {
            (
                locked.config.model_root(),
                locked.config.backends_url(),
                locked.config.backend.clone(),
                locked.config.engine.clone(),
            )
        })
        .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?;

    let store = Store::new(&model_root);
    let variant = store
        .installed()
        .into_iter()
        .find(|variant| variant.selector() == work.model)
        .ok_or_else(|| {
            WorkerFailure::permanent(
                ErrorCode::ModelUnavailable,
                "The exact accepted model is no longer installed.",
            )
        })?;
    if variant.engine() != work.engine {
        return Err(WorkerFailure::permanent(
            ErrorCode::ModelUnavailable,
            "The installed model provenance no longer matches this job.",
        ));
    }
    let installed_digests = variant
        .components
        .iter()
        .map(|component| component.digest().map(str::to_owned))
        .collect::<Result<Vec<_>>>()
        .map_err(WorkerFailure::from_internal)?;
    if installed_digests != work.component_digests {
        return Err(WorkerFailure::permanent(
            ErrorCode::ModelUnavailable,
            "The exact accepted model components are no longer installed.",
        ));
    }
    let components = components_for(&variant, &store.blob_dir()).map_err(|error| {
        WorkerFailure::with_source(
            ErrorCode::ModelUnavailable,
            false,
            "An accepted model component is unavailable.",
            error,
        )
    })?;

    let manifest = BackendManifest::fetch(&backends_url)
        .await
        .map_err(|error| {
            WorkerFailure::with_source(
                ErrorCode::TemporarilyUnavailable,
                true,
                "The node could not verify its installed engine backend.",
                error,
            )
        })?;
    let engine_store = EngineStore::new(&model_root);
    let wanted: Vec<String> = match pinned {
        Some(backend) => vec![backend],
        None => accel::candidates()
            .into_iter()
            .map(|candidate| candidate.backend)
            .collect(),
    };
    let mut attempts = Vec::<(String, PathBuf)>::new();
    for backend in wanted {
        if let Some(artifact) = manifest.find(variant.engine(), &backend, machine_arch())
            && engine_store
                .is_installed(artifact)
                .map_err(WorkerFailure::from_internal)?
        {
            // An upgraded node can have a complete engine archive from before
            // runtime management existed. Repair its dependencies before load.
            crate::cuda_runtime::ensure(
                &engine_store,
                &reqwest::Client::new(),
                artifact,
                |_, _| {},
            )
            .await
            .map_err(|error| {
                WorkerFailure::with_source(
                    ErrorCode::TemporarilyUnavailable,
                    true,
                    "The node could not prepare its engine runtime dependencies.",
                    error,
                )
            })?;
            attempts.push((
                backend,
                engine_store
                    .directory_for(artifact)
                    .map_err(WorkerFailure::from_internal)?,
            ));
        }
    }
    if attempts.is_empty() {
        return Err(WorkerFailure::permanent(
            ErrorCode::ModelUnavailable,
            "No installed engine backend can run this model.",
        ));
    }

    let options = LoadOptions {
        vram_budget_bytes: variant.vram_bytes,
        keep_loaded: i32::from(tuning.keep_loaded),
        vae_chunk: tuning.vae_chunk,
        vae_overlap: tuning.vae_overlap,
        n_threads: tuning.n_threads,
        disable_flash_attn: i32::from(tuning.disable_flash_attn),
        disable_batch_cfg: i32::from(tuning.disable_batch_cfg),
    };
    let mut extensions = cantor_proto::extensions::resolve_with_defaults(
        work.generation
            .extensions
            .as_ref()
            .unwrap_or(&EMPTY_EXTENSIONS),
        &variant.parameters,
    );
    // Legacy callers retain their explicitly supplied values; catalog defaults
    // must not emit duplicate JSON keys alongside these fields.
    if work.generation.steps.is_some() {
        extensions.remove("inference_steps");
    }
    if work.generation.cfg.is_some() {
        extensions.remove("guidance_scale");
    }
    if work.generation.seed.is_some() {
        extensions.remove("seed");
    }
    let audio = match work.generation.audio.as_ref() {
        Some(prompt) => Some(resolve_audio(state, work, &variant, prompt).await?),
        None => None,
    };
    let mut fields = engine_fields(extensions, &variant.parameters);
    if let Some((audio_fields, _, _)) = &audio {
        // The binding's fields win over declared parameters of the same name:
        // the act is what was asked for.
        fields.extend(audio_fields.clone());
    }
    let request = Request {
        caption: work.generation.caption.clone(),
        lyrics: work.generation.lyrics.clone(),
        // A source decides an audio act's length; an extension's region does.
        duration: if audio.is_some() {
            None
        } else {
            work.generation.duration.map(|value| value as f32)
        },
        steps: work.generation.steps,
        cfg: work.generation.cfg,
        seed: work.generation.seed,
        // Declared fields, defaults filled in, flattened alongside the core
        // ones. Validation already happened at admission against this exact
        // installed variant; this only resolves what was left unset, and
        // encodes each value in the shape its declaration gave it.
        extensions: fields,
    };

    let restore = audio.and_then(|(_, prepared, restore)| {
        restore.map(|offset_seconds| SourceRestore {
            source: prepared.path,
            offset_seconds,
        })
    });
    Ok(GenerationPlan {
        attempts,
        components,
        options,
        request,
        entry: work.generation.audio.as_ref().map(|_| Stage::Diffuse),
        restore,
    })
}

/// Resolve an audio prompt's source, prepare it beside the job, and map the act
/// to the engine's fields through the catalog's binding.
async fn resolve_audio(
    state: &SharedState,
    work: &WorkItem,
    variant: &crate::store::InstalledVariant,
    prompt: &cantor_proto::AudioPrompt,
) -> std::result::Result<
    (
        std::collections::BTreeMap<String, serde_json::Value>,
        prepare::PreparedSource,
        Option<f64>,
    ),
    WorkerFailure,
> {
    let (input, model_root) = {
        let locked = state
            .lock()
            .map_err(|_| WorkerFailure::internal("Node state is unavailable."))?;
        let input = match &prompt.source {
            cantor_proto::AudioSource::Song { song_id } => locked
                .library
                .verified_master_path(work.principal_id, song_id)
                .ok(),
            cantor_proto::AudioSource::Upload { upload_id } => locked
                .library
                .committed_upload(work.principal_id, upload_id)
                .map_err(WorkerFailure::from_internal)?
                .map(|upload| upload.path),
        };
        (input, locked.config.model_root())
    };
    let input = input.ok_or_else(|| {
        WorkerFailure::permanent(
            ErrorCode::NotFound,
            "The sound this song starts from is no longer on this node.",
        )
    })?;
    let catalog = crate::capabilities::cached_catalog(&model_root);
    let binding = crate::capabilities::declared(variant, catalog.as_ref())
        .and_then(|declared| declared.binding)
        .ok_or_else(|| {
            WorkerFailure::permanent(
                ErrorCode::ModelUnavailable,
                "This model's catalog entry no longer says how it takes audio.",
            )
        })?;
    let job_directory = work.job_directory().to_owned();
    let prompt_for_task = prompt.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        prepare::prepare(&input, &prompt_for_task, &job_directory)
    })
    .await
    .map_err(|error| {
        WorkerFailure::with_source(
            ErrorCode::Internal,
            true,
            "Source preparation stopped.",
            anyhow::anyhow!(error),
        )
    })?
    .map_err(|error| {
        WorkerFailure::with_source(
            ErrorCode::InvalidRequest,
            false,
            "The node could not read the sound this song starts from.",
            error,
        )
    })?;
    let fields = acts::engine_fields(&binding, prompt, &prepared.path, prepared.seconds).map_err(
        |error| {
            WorkerFailure::with_source(
                ErrorCode::ModelUnavailable,
                false,
                "This model cannot do what this song asks of it.",
                error,
            )
        },
    )?;
    let restore = acts::kept_source_seconds(prompt);
    Ok((fields, prepared, restore))
}

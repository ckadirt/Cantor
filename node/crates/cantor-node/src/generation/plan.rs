//! Resolve one accepted job into fully owned native generation inputs.

use std::path::PathBuf;

use anyhow::Result;
use cantor_proto::ErrorCode;

use super::WorkerFailure;
use crate::accel;
use crate::backends::{BackendManifest, EngineStore, machine_arch};
use crate::engine::LoadOptions;
use crate::generate::{Request, components_for};
use crate::library::WorkItem;
use crate::runtime::SharedState;
use crate::store::Store;

pub(crate) struct GenerationPlan {
    pub(super) attempts: Vec<(String, PathBuf)>,
    pub(super) components: Vec<(String, PathBuf)>,
    pub(super) options: LoadOptions,
    pub(super) request: Request,
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
    let request = Request {
        caption: work.generation.caption.clone(),
        lyrics: work.generation.lyrics.clone(),
        duration: work.generation.duration.map(|value| value as f32),
        steps: work.generation.steps,
        cfg: work.generation.cfg,
        seed: work.generation.seed,
    };

    Ok(GenerationPlan {
        attempts,
        components,
        options,
        request,
    })
}

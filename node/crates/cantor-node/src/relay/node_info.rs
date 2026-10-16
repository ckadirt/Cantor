//! Pure projection of durable node state into the application protocol.

use cantor_proto::{
    MAX_CAPTION_BYTES, MAX_LYRICS_BYTES, MAX_PAGE_LIMIT, MAX_SONG_SECONDS, MIN_SONG_SECONDS,
    ModelView, NodeFeatures, NodeInfo, NodeLimits, NodeLoad,
};

use crate::capabilities;
use crate::config::NodeConfig;
use crate::engine;
use crate::library::Library;
use crate::library::MAX_UPLOAD_BYTES;
use crate::store::Store;

pub(super) fn static_node_info(config: &NodeConfig, library: &Library) -> NodeInfo {
    let model_root = config.model_root();
    let catalog = capabilities::cached_catalog(&model_root);
    let installed = Store::new(&model_root).installed();
    let installable = catalog.as_ref().map(|catalog| {
        capabilities::installable(
            &installed,
            catalog,
            &capabilities::available_backends(config.backend.as_deref()),
        )
    });
    // What is actually on disk, so the app never offers a model this node
    // cannot load. Phase C's push is what keeps it current after a pull.
    let models = installed
        .into_iter()
        .map(|variant| {
            let declared = capabilities::declared(&variant, catalog.as_ref());
            // Declared by the weights and wired by the loaded engine build;
            // empty until both are known. See `capabilities`.
            let advertised = capabilities::advertised(
                declared.as_ref(),
                engine::loaded_capabilities(variant.engine()).as_ref(),
            );
            let acts = capabilities::advertised_acts(declared.as_ref(), &advertised);
            ModelView {
                capabilities: Some(cantor_proto::Capabilities(advertised)),
                acts: Some(acts),
                selector: variant.selector(),
                family: variant.model.clone(),
                engine: variant.engine().to_owned(),
                // Straight from the installed marker. The node converts nothing
                // here: an engine's internal stage bitmask was already turned into
                // an ordered list at install time.
                stages: variant.declared_stages(),
                parameters: variant.declared_parameters(),
                lyrics: variant.lyrics.clone(),
            }
        })
        .collect();
    let has_disk = library
        .available_bytes()
        .is_ok_and(|bytes| bytes >= config.jobs.minimum_free_bytes);
    NodeInfo {
        name: config.name.clone(),
        device_type: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        engine_version: "engine-abi-1".to_owned(),
        models,
        limits: NodeLimits {
            max_concurrent_jobs: 1,
            max_queued_jobs_per_principal: config.jobs.max_queued_per_principal,
            min_song_seconds: MIN_SONG_SECONDS,
            max_song_seconds: MAX_SONG_SECONDS,
            max_caption_bytes: MAX_CAPTION_BYTES,
            max_lyrics_bytes: MAX_LYRICS_BYTES,
            max_page_limit: MAX_PAGE_LIMIT,
            max_upload_bytes: Some(MAX_UPLOAD_BYTES),
            max_source_seconds: Some(MAX_SONG_SECONDS),
        },
        load: NodeLoad {
            active_jobs: library.active_count().unwrap_or(0),
            queued_jobs: library.queued_count().unwrap_or(0),
            accepting_jobs: has_disk,
            unavailable_reason: (!has_disk).then(|| "insufficient_disk".to_owned()),
        },
        features: NodeFeatures {
            jobs_create: true,
            library_list: true,
            artifacts_transfer: true,
            secure_tunnel: true,
            job_controls: true,
            derived_job_ids: true,
            job_forget: true,
            audio_sources: true,
            uploads: true,
        },
        installable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigSeed;
    use cantor_proto::{NodeMessage, PROTOCOL_VERSION};
    use tempfile::tempdir;

    #[test]
    fn node_info_json_advertises_derived_job_ids() {
        let temporary = tempdir().unwrap();
        let (mut config, _) =
            NodeConfig::load_or_create(&temporary.path().join("node.toml"), ConfigSeed::default())
                .unwrap();
        config.model_dir = Some(temporary.path().join("models").display().to_string());
        let library = Library::open(temporary.path().join("library")).unwrap();
        let message = NodeMessage::NodeInfoChanged {
            v: PROTOCOL_VERSION,
            node: static_node_info(&config, &library),
        };
        let json = serde_json::to_value(message).unwrap();
        assert_eq!(json["node"]["features"]["derived_job_ids"], true);
    }
}

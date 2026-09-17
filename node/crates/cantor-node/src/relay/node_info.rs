//! Pure projection of durable node state into the application protocol.

use cantor_proto::{
    MAX_CAPTION_BYTES, MAX_LYRICS_BYTES, MAX_PAGE_LIMIT, MAX_SONG_SECONDS, MIN_SONG_SECONDS,
    ModelView, NodeFeatures, NodeInfo, NodeLimits, NodeLoad,
};

use crate::config::NodeConfig;
use crate::library::Library;
use crate::store::Store;

pub(super) fn static_node_info(config: &NodeConfig, library: &Library) -> NodeInfo {
    // What is actually on disk, so the app never offers a model this node
    // cannot load. Phase C's push is what keeps it current after a pull.
    let models = Store::new(config.model_root())
        .installed()
        .into_iter()
        .map(|variant| ModelView {
            selector: variant.selector(),
            family: variant.model.clone(),
            engine: variant.engine().to_owned(),
            // Straight from the installed marker. The node converts nothing
            // here: an engine's internal stage bitmask was already turned into
            // an ordered list at install time.
            stages: variant.declared_stages(),
            parameters: variant.declared_parameters(),
            lyrics: variant.lyrics.clone(),
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
        },
    }
}

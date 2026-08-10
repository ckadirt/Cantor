//! Shared process state for the control adapter, relay, and workers.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::config::NodeConfig;
use crate::jobs::ActiveJobControl;
use crate::library::Library;
use crate::pairing::PairOffer;
use crate::secure::TransportIdentity;

/// Everything the control surface and the relay loop both touch.
pub struct NodeState {
    pub config: NodeConfig,
    pub config_path: PathBuf,
    pub node_public_key: String,
    pub transport_identity: Arc<TransportIdentity>,
    pub pair_offer: Option<PairOffer>,
    pub connected: bool,
    pub library: Library,
    /// Acceptance and model-readiness changes wake the single durable worker.
    pub job_notify: Arc<tokio::sync::Notify>,
    /// Completion and startup wake the single low-priority derivative worker.
    pub delivery_notify: Arc<tokio::sync::Notify>,
    pub active_job: Option<ActiveJobControl>,
    pub shutting_down: bool,
}

pub type SharedState = Arc<Mutex<NodeState>>;

pub fn shared(state: NodeState) -> SharedState {
    Arc::new(Mutex::new(state))
}

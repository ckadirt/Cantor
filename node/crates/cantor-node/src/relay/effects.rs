//! Execution of transport-independent application effects in node runtime state.

use tokio::sync::mpsc;

use crate::application::ApplicationEffect;
use crate::runtime::{NodeEvent, NodeState};

pub(super) fn execute_application_effects(
    state: &mut NodeState,
    effects: Vec<ApplicationEffect>,
    event_sender: &mpsc::Sender<NodeEvent>,
) -> bool {
    let mut refresh_node_info = false;
    for effect in effects {
        match effect {
            ApplicationEffect::WakeJobWorker => state.job_notify.notify_one(),
            ApplicationEffect::StopActiveJob { job_id, reason } => {
                if let Some(active) = state
                    .active_job
                    .as_ref()
                    .filter(|active| active.job_id == job_id)
                {
                    crate::jobs::request_stop(&active.signal, reason);
                }
            }
            ApplicationEffect::Publish(event) => {
                let _ = event_sender.try_send(event);
            }
            ApplicationEffect::RefreshNodeInfo => refresh_node_info = true,
        }
    }
    refresh_node_info
}

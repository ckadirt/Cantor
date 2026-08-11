//! Low-priority creation of bounded, phone-friendly audio derivatives.
//!
//! The canonical WAV is never replaced. A delivery artifact is encoded beside
//! it, fsynced, atomically renamed, and only then indexed and announced.

mod opus;
mod worker;

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::runtime::{NodeEvent, SharedState};

/// Runs the single low-priority delivery worker with the production Opus codec.
pub async fn run(state: SharedState, events: mpsc::Sender<NodeEvent>) {
    worker::run(state, events, Arc::new(opus::OpusDeliveryEncoder)).await;
}

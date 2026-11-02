//! Durable job scheduler compatibility facade.

pub mod operator;
mod scheduler;
mod stop;

pub use scheduler::run;
pub use stop::{StopReason, graceful_shutdown, request_stop};

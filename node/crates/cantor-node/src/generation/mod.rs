//! Generation planning and execution boundaries.

pub(crate) mod plan;
pub(crate) mod runner;

mod failure;
mod worker;

pub(crate) use failure::WorkerFailure;
pub(crate) use runner::{current_stage, settle_standing_stop};
pub(crate) use worker::{GenerationCommand, InferenceWorker};

pub(crate) fn start_worker() -> anyhow::Result<InferenceWorker> {
    InferenceWorker::start(runner::NativeGenerationDriver::default)
}

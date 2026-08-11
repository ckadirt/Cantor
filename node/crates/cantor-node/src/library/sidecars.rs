//! Accepted-request and durable job-status sidecars.

use std::fs::File;
use std::path::Path;

use anyhow::{Context, Result};
use cantor_proto::{GenerationRequest, JobView};
use serde::{Deserialize, Serialize};

use super::durable_fs::write_json_atomic;

#[derive(Serialize)]
pub(super) struct RequestSidecar<'a> {
    pub(super) schema: u8,
    pub(super) job_id: &'a str,
    pub(super) principal_id: &'a str,
    pub(super) client_request_id: &'a str,
    pub(super) accepted_at: &'a str,
    pub(super) model: AcceptedModel<'a>,
    pub(super) generation: &'a GenerationRequest,
}

#[derive(Serialize)]
pub(super) struct AcceptedModel<'a> {
    pub(super) selector: String,
    pub(super) engine: &'a str,
    pub(super) component_digests: Vec<&'a str>,
}

#[derive(Deserialize)]
pub(super) struct AcceptedRequestSidecar {
    pub(super) schema: u8,
    pub(super) job_id: String,
    pub(super) principal_id: String,
    pub(super) model: AcceptedModelOwned,
    pub(super) generation: GenerationRequest,
}

#[derive(Deserialize)]
pub(super) struct AcceptedModelOwned {
    pub(super) selector: String,
    pub(super) engine: String,
    pub(super) component_digests: Vec<String>,
}

pub(super) fn accepted_sidecar_for(
    root: &Path,
    principal: &str,
    id: &str,
) -> Result<AcceptedRequestSidecar> {
    let path = root
        .join("jobs")
        .join(principal)
        .join(id)
        .join("request.json");
    serde_json::from_reader(File::open(&path)?)
        .with_context(|| format!("failed to read {}", path.display()))
}

pub(super) fn write_status(artifact_directory: &Path, job: &JobView, attempt: u32) -> Result<()> {
    let job_directory = artifact_directory
        .parent()
        .context("artifact directory has no job parent")?;
    write_json_atomic(
        &job_directory.join("status.json"),
        &serde_json::json!({
            "schema": 2,
            "state": job.state,
            "stage": job.stage,
            "progress": job.progress,
            "revision": job.revision,
            "attempt": attempt,
            "updated_at": job.updated_at,
            "error": job.error,
        }),
    )
}

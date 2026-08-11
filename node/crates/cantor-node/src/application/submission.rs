//! Shared durable job admission after adapter-specific validation and model resolution.

use anyhow::Result;

use crate::config::NodeConfig;
use crate::library::{Library, Submission, SubmitResult};
use crate::principal::PrincipalId;
use crate::store::InstalledVariant;

pub(crate) fn admit_job(
    library: &mut Library,
    config: &NodeConfig,
    principal_id: PrincipalId,
    client_public_key: &[u8; 32],
    submission: &Submission,
    variant: &InstalledVariant,
) -> Result<SubmitResult> {
    library.submit(
        principal_id,
        client_public_key,
        submission,
        variant,
        config.jobs.max_queued_per_principal,
        config.jobs.minimum_free_bytes,
    )
}

//! Shared durable job admission after adapter-specific validation and model resolution.

use anyhow::{Result, bail};

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
    if let Some(field) = super::jobs::invalid_submission(
        &submission.client_request_id,
        &submission.model,
        &submission.generation,
    ) {
        bail!("invalid generation field: {field}");
    }
    if variant
        .lyrics
        .as_ref()
        .is_some_and(|cap| cap.requires_lyrics)
        && submission
            .generation
            .lyrics
            .as_deref()
            .is_none_or(|text| text.trim().is_empty())
    {
        bail!("this model requires lyrics; pass --lyrics or write words in the app");
    }
    if let Some(field) =
        super::jobs::invalid_extensions(&submission.generation, &variant.parameters)
    {
        bail!("invalid generation parameter: {field}");
    }
    library.submit(
        principal_id,
        client_public_key,
        submission,
        variant,
        config.jobs.max_queued_per_principal,
        config.jobs.minimum_free_bytes,
    )
}

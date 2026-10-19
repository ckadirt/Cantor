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
    if let Some(field) = super::jobs::invalid_audio(
        &submission.generation,
        variant,
        &config.model_root(),
        library,
        principal_id,
    ) {
        bail!("invalid audio prompt: {field}");
    }
    let plan = provisional_plan(submission, variant, &config.model_root());
    library.submit(
        principal_id,
        client_public_key,
        submission,
        variant,
        &plan,
        config.jobs.max_queued_per_principal,
        config.jobs.minimum_free_bytes,
    )
}

/// Admission chooses the arc; the library only persists it.
pub(super) fn provisional_plan(
    submission: &Submission,
    variant: &InstalledVariant,
    model_root: &std::path::Path,
) -> Vec<cantor_proto::PlanStage> {
    use cantor_proto::GenerationStage::{Codes, Decode, Diffuse, Plan};

    let stages = if let Some(audio) = &submission.generation.audio {
        let catalog = crate::capabilities::cached_catalog(model_root);
        crate::capabilities::advertised(
            crate::capabilities::declared(variant, catalog.as_ref()).as_ref(),
            crate::engine::loaded_capabilities(variant.engine()).as_ref(),
        )
        .into_iter()
        .find(|capability| capability.kind == audio.act.capability())
        .and_then(|capability| capability.stages)
        .map(|stages| {
            // A caption left to the source is heard after encoding.
            if submission.generation.caption.trim().is_empty() {
                stages
                    .into_iter()
                    .flat_map(|stage| match stage {
                        cantor_proto::GenerationStage::Encode => {
                            vec![stage, cantor_proto::GenerationStage::Listen]
                        }
                        other => vec![other],
                    })
                    .collect()
            } else {
                stages
            }
        })
        .unwrap_or_else(|| vec![Diffuse, Decode])
    } else {
        variant
            .declared_stages()
            .unwrap_or_else(|| vec![Plan, Codes, Diffuse, Decode])
    };
    crate::checkpoints::plan_stages(stages)
}

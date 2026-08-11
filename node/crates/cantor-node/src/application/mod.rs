//! Typed application responses and the process effects they request.

mod auth;
mod context;
mod errors;
mod jobs;
mod outcome;
mod router;
mod session;
mod songs;
mod submission;
mod transfers;

use anyhow::Result;
use cantor_proto::NodeMessage;
use serde_json::Value;

pub use auth::AuthenticatedSession;
pub use context::RequestContext;
pub use outcome::{ApplicationEffect, ApplicationOutcome};
pub use session::ClientSession;
pub(crate) use submission::admit_job;

pub(crate) fn handle_application(
    session: &mut ClientSession,
    payload: Value,
    context: RequestContext<'_>,
) -> Result<ApplicationOutcome> {
    let response = session.handle(
        payload,
        &mut *context.config,
        context.config_path,
        &mut *context.pair_offer,
        context.node_public_key,
        context.node_info,
        &mut *context.library,
    )?;
    let principal_id = session.authenticated().map(|context| context.principal_id);
    let committed_library_revision = if matches!(&response, NodeMessage::SongUpdated { .. }) {
        principal_id
            .map(|principal_id| context.library.library_revision(principal_id))
            .transpose()?
    } else {
        None
    };
    Ok(outcome::from_response(
        response,
        principal_id,
        committed_library_revision,
    ))
}

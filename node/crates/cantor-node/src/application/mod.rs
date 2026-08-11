//! Typed application responses and the process effects they request.

mod outcome;

use std::path::Path;

use anyhow::Result;
use cantor_proto::{NodeInfo, NodeMessage};
use serde_json::Value;

use crate::config::NodeConfig;
use crate::library::Library;
use crate::pairing::PairOffer;
use crate::session::ClientSession;

pub use outcome::{ApplicationEffect, ApplicationOutcome};

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_application(
    session: &mut ClientSession,
    payload: Value,
    config: &mut NodeConfig,
    config_path: &Path,
    active_pair_offer: &mut Option<PairOffer>,
    node_public_key: &str,
    node_info: &NodeInfo,
    library: &mut Library,
) -> Result<ApplicationOutcome> {
    let response = session.handle(
        payload,
        config,
        config_path,
        active_pair_offer,
        node_public_key,
        node_info,
        library,
    )?;
    let principal_id = session.authenticated().map(|context| context.principal_id);
    let committed_library_revision = if matches!(&response, NodeMessage::SongUpdated { .. }) {
        principal_id
            .map(|principal_id| library.library_revision(principal_id))
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

//! JSON application-message parsing, fallback correlation, and typed dispatch.

use std::path::Path;

use anyhow::Result;
use cantor_proto::{ClientMessage, ErrorCode, NodeInfo, NodeMessage};
use serde_json::Value;

use crate::config::NodeConfig;
use crate::library::{JobControl, Library};
use crate::pairing::PairOffer;

use super::jobs;
use super::session::ClientSession;
use super::songs;

#[allow(clippy::too_many_arguments)]
pub(super) fn handle(
    session: &mut ClientSession,
    payload: Value,
    config: &mut NodeConfig,
    config_path: &Path,
    active_pair_offer: &mut Option<PairOffer>,
    node_public_key: &str,
    node_info: &NodeInfo,
    library: &mut Library,
) -> Result<NodeMessage> {
    let fallback_id = payload.get("id").and_then(Value::as_str).map(str::to_owned);
    let message: ClientMessage = match serde_json::from_value(payload) {
        Ok(message) => message,
        Err(_) => {
            return Ok(NodeMessage::error(
                fallback_id,
                ErrorCode::InvalidRequest,
                "The application message is not valid.",
                false,
            ));
        }
    };

    match message {
        ClientMessage::Hello {
            v,
            id,
            pubkey,
            pair_proof,
            petname,
        } => session.handle_hello(v, id, pubkey, pair_proof, petname, node_public_key),
        ClientMessage::Auth { v, id, sig } => session.handle_auth(
            v,
            id,
            sig,
            config,
            config_path,
            active_pair_offer,
            node_public_key,
            node_info,
        ),
        ClientMessage::Status { v, id } => jobs::status(v, id, session.authenticated(), library),
        ClientMessage::JobsList {
            v,
            id,
            states,
            cursor,
            limit,
        } => jobs::list(
            v,
            id,
            states,
            cursor,
            limit,
            session.authenticated(),
            library,
        ),
        ClientMessage::JobCreate {
            v,
            id,
            client_request_id,
            model,
            generation,
        } => jobs::create(
            v,
            id,
            client_request_id,
            model,
            generation,
            session.authenticated(),
            config,
            library,
        ),
        ClientMessage::JobGet { v, id, job_id } => {
            jobs::get(v, id, job_id, session.authenticated(), library)
        }
        ClientMessage::JobPause {
            v,
            id,
            job_id,
            expected_revision,
        } => jobs::control(
            v,
            id,
            job_id,
            expected_revision,
            JobControl::Pause,
            session.authenticated(),
            library,
        ),
        ClientMessage::JobResume {
            v,
            id,
            job_id,
            expected_revision,
        } => jobs::control(
            v,
            id,
            job_id,
            expected_revision,
            JobControl::Resume,
            session.authenticated(),
            library,
        ),
        ClientMessage::JobCancel {
            v,
            id,
            job_id,
            expected_revision,
        } => jobs::control(
            v,
            id,
            job_id,
            expected_revision,
            JobControl::Cancel,
            session.authenticated(),
            library,
        ),
        ClientMessage::JobRetry {
            v,
            id,
            job_id,
            expected_revision,
        } => jobs::control(
            v,
            id,
            job_id,
            expected_revision,
            JobControl::Retry,
            session.authenticated(),
            library,
        ),
        ClientMessage::JobForget {
            v,
            id,
            job_id,
            expected_revision,
        } => jobs::forget(
            v,
            id,
            job_id,
            expected_revision,
            session.authenticated(),
            library,
        ),
        ClientMessage::LibraryList {
            v,
            id,
            limit,
            cursor,
            include_trashed,
        } => songs::list(
            v,
            id,
            limit,
            cursor,
            include_trashed,
            session.authenticated(),
            library,
        ),
        ClientMessage::LibrarySync {
            v,
            id,
            since_revision,
            limit,
        } => songs::sync(
            v,
            id,
            since_revision,
            limit,
            session.authenticated(),
            library,
        ),
        ClientMessage::SongGet { v, id, song_id } => {
            songs::get(v, id, song_id, session.authenticated(), library)
        }
        ClientMessage::SongPatch {
            v,
            id,
            song_id,
            expected_revision,
            patch,
        } => songs::patch(
            v,
            id,
            song_id,
            expected_revision,
            patch,
            session.authenticated(),
            library,
        ),
        ClientMessage::SongTrash {
            v,
            id,
            song_id,
            expected_revision,
        } => songs::trash(
            v,
            id,
            song_id,
            expected_revision,
            session.authenticated(),
            library,
        ),
        ClientMessage::SongRestore {
            v,
            id,
            song_id,
            expected_revision,
        } => songs::restore(
            v,
            id,
            song_id,
            expected_revision,
            session.authenticated(),
            library,
        ),
        ClientMessage::ArtifactOpen {
            v,
            id,
            song_id,
            profile,
            offset,
            expected_sha256,
        } => Ok(session.handle_artifact_open(
            v,
            id,
            song_id,
            profile,
            offset,
            expected_sha256,
            library,
        )),
        ClientMessage::ArtifactAck {
            v,
            id,
            transfer_id,
            next_offset,
        } => Ok(session.handle_artifact_ack(v, id, transfer_id, next_offset)),
    }
}

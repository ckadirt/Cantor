//! Synchronous local pairing and node-identity command workflows.

use std::time::Duration;

use anyhow::{Result, bail};
use tokio::sync::mpsc;

use super::super::wire::{CONTROL_VERSION, Response, reject_version};
use crate::pairing::{DEFAULT_PAIR_TTL, PairOffer, new_pair_token, pairing_uri};
use crate::principal::PrincipalId;
use crate::runtime::{NodeEvent, NodeState};

pub(in crate::control) fn status(state: &mut NodeState, v: u8, id: String) -> Result<Response> {
    reject_version(v, &id)?;
    if state.pair_offer.as_ref().is_some_and(PairOffer::is_expired) {
        state.pair_offer = None;
    }
    Ok(Response::Status {
        v: CONTROL_VERSION,
        id,
        name: state.config.name.clone(),
        pubkey: state.node_public_key.clone(),
        relay_url: state.config.relay_url.clone(),
        connected: state.connected,
        pairings: state.config.pairings.len(),
        pair_expires_in: state
            .pair_offer
            .as_ref()
            .map(|offer| offer.remaining().as_secs()),
    })
}

pub(in crate::control) fn pair(
    state: &mut NodeState,
    v: u8,
    id: String,
    expires_in: Option<u64>,
) -> Result<Response> {
    reject_version(v, &id)?;
    let ttl = expires_in.map_or(DEFAULT_PAIR_TTL, Duration::from_secs);
    let token = new_pair_token()?;
    let uri = pairing_uri(
        &state.config,
        &state.node_public_key,
        &token,
        state.transport_identity.descriptor(),
    )?;
    state.pair_offer = Some(PairOffer::new(token, ttl));
    Ok(Response::Pair {
        v: CONTROL_VERSION,
        id,
        uri: uri.to_string(),
        expires_in: ttl.as_secs(),
    })
}

pub(in crate::control) fn pairings(state: &mut NodeState, v: u8, id: String) -> Result<Response> {
    reject_version(v, &id)?;
    Ok(Response::Pairings {
        v: CONTROL_VERSION,
        id,
        pairings: state.config.pairings.clone(),
    })
}

pub(in crate::control) fn revoke(
    state: &mut NodeState,
    events: &mpsc::Sender<NodeEvent>,
    v: u8,
    id: String,
    selector: String,
) -> Result<Response> {
    reject_version(v, &id)?;
    let key = state.config.resolve_pairing(&selector)?;
    let principal_id = bs58::decode(&key)
        .into_vec()
        .ok()
        .and_then(|decoded| <[u8; 32]>::try_from(decoded).ok())
        .map(|key_bytes| PrincipalId::from_client_public_key(&key_bytes));
    let config_path = state.config_path.clone();
    if !state.config.revoke_key(&config_path, &key)? {
        bail!("no pairing matches {selector}");
    }
    if let Some(principal_id) = principal_id {
        state.library.hold_principal_jobs(principal_id)?;
        if let Some(active) = state
            .active_job
            .as_ref()
            .filter(|active| active.principal_id == principal_id)
        {
            crate::jobs::request_stop(&active.signal, crate::jobs::StopReason::Revoked);
        }
    }
    // Only after the file is written, so a failed write never disconnects
    // a device that is in fact still authorized.
    let _ = events.try_send(NodeEvent::Revoked(key));
    Ok(Response::Ok {
        v: CONTROL_VERSION,
        id,
    })
}

pub(in crate::control) fn rename(
    state: &mut NodeState,
    v: u8,
    id: String,
    selector: String,
    petname: String,
) -> Result<Response> {
    reject_version(v, &id)?;
    let key = state.config.resolve_pairing(&selector)?;
    let config_path = state.config_path.clone();
    state.config.rename_pairing(&config_path, &key, &petname)?;
    Ok(Response::Ok {
        v: CONTROL_VERSION,
        id,
    })
}

pub(in crate::control) fn rename_node(
    state: &mut NodeState,
    events: &mpsc::Sender<NodeEvent>,
    v: u8,
    id: String,
    name: String,
) -> Result<Response> {
    reject_version(v, &id)?;
    let config_path = state.config_path.clone();
    state.config.rename_node(&config_path, &name)?;
    // The node's name is part of NodeInfo, so connected apps have to hear
    // about it rather than showing the old one until they reconnect.
    let _ = events.try_send(NodeEvent::NodeInfoChanged);
    Ok(Response::Ok {
        v: CONTROL_VERSION,
        id,
    })
}

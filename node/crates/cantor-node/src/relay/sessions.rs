//! Relay client-session ownership and fanout.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use cantor_proto::{ErrorCode, NodeInfo, NodeMessage};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::carrier::{
    IncomingFrame, RELAY_VERSION, encode_node_secure_carrier, ensure_secure_sid,
    parse_node_secure_carrier, tunnel_text_frame,
};
use crate::runtime::{NodeEvent, SharedState};
use crate::session::ClientSession;

const MAX_CLIENT_SESSIONS: usize = 1_024;

#[derive(Default)]
pub(super) struct SessionRegistry {
    sessions: HashMap<String, ClientSession>,
}

impl SessionRegistry {
    fn can_open(&self, sid: &str, limit: usize) -> bool {
        self.sessions.contains_key(sid) || self.sessions.len() < limit
    }

    /// Returns the frame to send back, if any. `Ok(None)` means the frame needed
    /// no reply — including frames this node does not recognise, which are
    /// logged and skipped so a newer relay cannot take the node down.
    pub(super) fn handle_text(
        &mut self,
        text: &str,
        state: &SharedState,
        node_ed25519: &[u8; 32],
    ) -> Result<Option<(Message, bool)>> {
        let frame: IncomingFrame = match serde_json::from_str(text) {
            Ok(frame) => frame,
            Err(error) => {
                eprintln!("ignoring unparseable relay frame: {error}");
                return Ok(None);
            }
        };

        match frame {
            IncomingFrame::Tunnel { v, sid, payload } if v == RELAY_VERSION => {
                let response = if self.can_open(&sid, MAX_CLIENT_SESSIONS)
                    && ensure_secure_sid(&sid).is_ok()
                {
                    let transport = super::lock(state)?.transport_identity.clone();
                    let session = self.sessions.entry(sid.clone()).or_default();
                    session.set_relay_session_id(&sid);
                    match session.handle_secure_text(&payload, &transport, node_ed25519) {
                        Ok(response) => response,
                        Err(error) => {
                            eprintln!("secure handshake failed for one client: {error:#}");
                            session.close_secure();
                            secure_error_value("handshake-failed")
                        }
                    }
                } else {
                    secure_error_value("temporarily-unavailable")
                };
                Ok(Some((tunnel_text_frame(&sid, &response)?, false)))
            }
            IncomingFrame::Detached { v, sid } if v == RELAY_VERSION => {
                self.sessions.remove(&sid);
                Ok(None)
            }
            // A relay-level error is about this connection, so it still ends it.
            IncomingFrame::Error { v, code, msg } => super::bail_relay_error(v, &code, &msg)?,
            other => {
                eprintln!("ignoring unexpected relay frame: {other:?}");
                Ok(None)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_binary(
        &mut self,
        frame: &[u8],
        state: &SharedState,
        config_path: &Path,
        public_key: &str,
        node_info: &NodeInfo,
        event_sender: &mpsc::Sender<NodeEvent>,
    ) -> Result<Option<(Vec<Message>, bool)>> {
        let (sid, ciphertext) = match parse_node_secure_carrier(frame) {
            Ok(parsed) => parsed,
            Err(error) => {
                eprintln!("ignoring invalid secure relay carrier: {error:#}");
                return Ok(None);
            }
        };
        let Some(session) = self.sessions.get_mut(sid) else {
            return Ok(None);
        };
        if !session.secure_ready() {
            return Ok(None);
        }
        let payload = match session.decrypt_secure(ciphertext) {
            Ok(Some(payload)) => payload,
            Ok(None) => return Ok(None),
            Err(error) => {
                eprintln!("secure client frame failed authentication: {error:#}");
                return Ok(None);
            }
        };
        let (response, refresh_node_info) = super::dispatch_application(
            session,
            payload,
            state,
            config_path,
            public_key,
            node_info,
            event_sender,
        )?;
        Ok(Some((
            encrypted_frames(sid, session, &response)?,
            refresh_node_info,
        )))
    }

    /// Encrypts and queues each authenticated session's refresh before moving
    /// to the next session. This deliberately does not collect every frame
    /// first: command-triggered refreshes have always streamed this way.
    pub(super) async fn stream_authenticated_refresh(
        &mut self,
        payload: &NodeMessage,
        outbound: &mpsc::Sender<Message>,
    ) -> Result<()> {
        for (sid, session) in &mut self.sessions {
            if session.authenticated_key().is_some() {
                for frame in encrypted_frames(sid, session, payload)? {
                    if outbound.send(frame).await.is_err() {
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    /// Turns a control command into the complete frame batch that has to go out
    /// over the relay. Unlike command-triggered refreshes, event fanout is fully
    /// collected before the connection loop starts sending it.
    pub(super) fn apply_control_event(
        &mut self,
        event: NodeEvent,
        state: &SharedState,
        node_info: &mut NodeInfo,
    ) -> Result<Vec<Message>> {
        match event {
            NodeEvent::Revoked(key) => {
                let mut frames = Vec::new();
                let mut dropped = 0_usize;
                for (sid, session) in self.sessions.iter_mut() {
                    if session.authenticated_key() != Some(key.as_str()) {
                        continue;
                    }
                    // `rejected` is the one code the app treats as final, so the
                    // device stops retrying instead of spinning against a node that
                    // has already said no.
                    frames.extend(encrypted_frames(
                        sid,
                        session,
                        &NodeMessage::error(
                            None,
                            ErrorCode::Rejected,
                            "This client key is no longer authorized.",
                            false,
                        ),
                    )?);
                    session.deauthenticate();
                    session.close_secure();
                    dropped += 1;
                }
                println!("revoked {key}; dropped {dropped} live session(s)");
                Ok(frames)
            }
            NodeEvent::NodeInfoChanged => {
                let locked = super::lock(state)?;
                *node_info = super::static_node_info(&locked.config, &locked.library);
                let push = NodeMessage::NodeInfoChanged {
                    v: cantor_proto::PROTOCOL_VERSION,
                    node: node_info.clone(),
                };
                let mut frames = Vec::new();
                for (sid, session) in self.sessions.iter_mut() {
                    if session.authenticated_key().is_some() {
                        frames.extend(encrypted_frames(sid, session, &push)?);
                    }
                }
                Ok(frames)
            }
            NodeEvent::JobUpdated { principal_id, job } => {
                let locked = super::lock(state)?;
                let refreshed = super::static_node_info(&locked.config, &locked.library);
                drop(locked);
                let load_changed = node_info.load != refreshed.load;
                *node_info = refreshed;
                let private = NodeMessage::JobUpdated {
                    v: cantor_proto::PROTOCOL_VERSION,
                    job,
                };
                let mut frames = Vec::new();
                for (sid, session) in self.sessions.iter_mut() {
                    let Some(principal) = session
                        .authenticated()
                        .map(|authenticated| authenticated.principal_id)
                    else {
                        continue;
                    };
                    if principal == principal_id {
                        frames.extend(encrypted_frames(sid, session, &private)?);
                    }
                    if load_changed {
                        frames.extend(encrypted_frames(
                            sid,
                            session,
                            &NodeMessage::NodeInfoChanged {
                                v: cantor_proto::PROTOCOL_VERSION,
                                node: node_info.clone(),
                            },
                        )?);
                    }
                }
                Ok(frames)
            }
            NodeEvent::LibraryChanged {
                principal_id,
                revision,
            } => {
                let changed = NodeMessage::LibraryChanged {
                    v: cantor_proto::PROTOCOL_VERSION,
                    revision,
                };
                let mut frames = Vec::new();
                for (sid, session) in self.sessions.iter_mut() {
                    if session
                        .authenticated()
                        .is_some_and(|context| context.principal_id == principal_id)
                    {
                        frames.extend(encrypted_frames(sid, session, &changed)?);
                    }
                }
                Ok(frames)
            }
        }
    }

    #[cfg(test)]
    pub(super) fn insert_for_test(&mut self, sid: impl Into<String>, session: ClientSession) {
        self.sessions.insert(sid.into(), session);
    }

    #[cfg(test)]
    pub(super) fn get_for_test(&self, sid: &str) -> Option<&ClientSession> {
        self.sessions.get(sid)
    }

    #[cfg(test)]
    pub(super) fn contains_for_test(&self, sid: &str) -> bool {
        self.sessions.contains_key(sid)
    }

    #[cfg(test)]
    pub(super) fn len_for_test(&self) -> usize {
        self.sessions.len()
    }

    #[cfg(test)]
    pub(super) fn can_open_for_test(&self, sid: &str, limit: usize) -> bool {
        self.can_open(sid, limit)
    }
}

fn encrypted_frames(
    sid: &str,
    session: &mut ClientSession,
    payload: &NodeMessage,
) -> Result<Vec<Message>> {
    session
        .encrypt_secure(payload)?
        .into_iter()
        .map(|ciphertext| encode_node_secure_carrier(sid, &ciphertext))
        .collect()
}

fn secure_error_value(code: &str) -> Value {
    serde_json::json!({
        "v": 1,
        "t": "secure.error",
        "code": code,
        "message": "A secure channel is required.",
    })
}

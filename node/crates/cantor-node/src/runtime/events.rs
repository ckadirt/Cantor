//! Effects consumed by the relay loop on behalf of node subsystems.

use crate::principal::PrincipalId;

/// Work that only the relay loop can carry out, because only it holds the live
/// client sessions.
#[derive(Clone, Debug)]
pub enum NodeEvent {
    /// Cut off any session authenticated with this key, right now.
    Revoked(String),
    /// Capabilities changed; push `node.info` to everyone authenticated.
    NodeInfoChanged,
    /// Private durable state belongs only on sessions for this principal.
    JobUpdated {
        principal_id: PrincipalId,
        job: cantor_proto::JobView,
    },
    /// The job is gone. Sessions for this principal drop it; nobody else is
    /// told it ever existed.
    JobForgotten {
        principal_id: PrincipalId,
        job_id: String,
    },
    /// A private library revision is a sync hint, never a broadcast payload.
    LibraryChanged {
        principal_id: PrincipalId,
        revision: u64,
    },
}

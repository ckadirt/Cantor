//! Transport-independent result of handling one application request.

use cantor_proto::{JobState, NodeMessage};

use crate::jobs::StopReason;
use crate::principal::PrincipalId;
use crate::runtime::NodeEvent;

#[derive(Debug)]
pub struct ApplicationOutcome {
    pub response: NodeMessage,
    pub effects: Vec<ApplicationEffect>,
}

#[derive(Clone, Debug)]
pub enum ApplicationEffect {
    WakeJobWorker,
    StopActiveJob { job_id: String, reason: StopReason },
    Publish(NodeEvent),
    RefreshNodeInfo,
}

pub(super) fn from_response(
    response: NodeMessage,
    principal_id: Option<PrincipalId>,
    committed_library_revision: Option<u64>,
) -> ApplicationOutcome {
    let mut effects = Vec::new();
    match &response {
        NodeMessage::JobAccepted { .. } => {
            effects.push(ApplicationEffect::WakeJobWorker);
            effects.push(ApplicationEffect::RefreshNodeInfo);
        }
        NodeMessage::JobControlled { job, .. } => {
            if let Some(principal_id) = principal_id {
                match job.state {
                    JobState::PauseRequested => {
                        effects.push(ApplicationEffect::StopActiveJob {
                            job_id: job.id.clone(),
                            reason: StopReason::Pause,
                        });
                    }
                    JobState::CancelRequested => {
                        effects.push(ApplicationEffect::StopActiveJob {
                            job_id: job.id.clone(),
                            reason: StopReason::Cancel,
                        });
                    }
                    JobState::Queued => effects.push(ApplicationEffect::WakeJobWorker),
                    _ => {}
                }
                effects.push(ApplicationEffect::Publish(NodeEvent::JobUpdated {
                    principal_id,
                    job: job.clone(),
                }));
            }
            effects.push(ApplicationEffect::RefreshNodeInfo);
        }
        NodeMessage::JobForgotten { job_id, .. } => {
            if let Some(principal_id) = principal_id {
                effects.push(ApplicationEffect::Publish(NodeEvent::JobForgotten {
                    principal_id,
                    job_id: job_id.clone(),
                }));
            }
            effects.push(ApplicationEffect::RefreshNodeInfo);
        }
        NodeMessage::SongUpdated { .. } => {
            if let Some((principal_id, revision)) = principal_id.zip(committed_library_revision) {
                effects.push(ApplicationEffect::Publish(NodeEvent::LibraryChanged {
                    principal_id,
                    revision,
                }));
            }
        }
        _ => {}
    }
    ApplicationOutcome { response, effects }
}

#[cfg(test)]
mod tests {
    use cantor_proto::{JobState, JobView, NodeMessage, PROTOCOL_VERSION};

    use crate::jobs::StopReason;
    use crate::principal::PrincipalId;
    use crate::runtime::NodeEvent;

    use super::{ApplicationEffect, from_response};

    fn job(state: JobState) -> JobView {
        JobView {
            id: "job-id".into(),
            revision: 3,
            state,
            stage: None,
            progress: None,
            model: "model:variant".into(),
            caption: Some("a caption".into()),
            created_at: "created".into(),
            updated_at: "updated".into(),
            error: None,
        }
    }

    #[test]
    fn accepted_and_controlled_responses_declare_effects_in_execution_order() {
        let accepted = from_response(
            NodeMessage::JobAccepted {
                v: PROTOCOL_VERSION,
                id: "request".into(),
                job: job(JobState::Queued),
            },
            None,
            None,
        );
        assert!(matches!(
            accepted.effects.as_slice(),
            [
                ApplicationEffect::WakeJobWorker,
                ApplicationEffect::RefreshNodeInfo
            ]
        ));

        let principal_id = PrincipalId::from_client_public_key(&[7_u8; 32]);
        let controlled_job = job(JobState::PauseRequested);
        let controlled = from_response(
            NodeMessage::JobControlled {
                v: PROTOCOL_VERSION,
                id: "request".into(),
                job: controlled_job.clone(),
            },
            Some(principal_id),
            None,
        );
        match controlled.effects.as_slice() {
            [
                ApplicationEffect::StopActiveJob { job_id, reason },
                ApplicationEffect::Publish(NodeEvent::JobUpdated {
                    principal_id: event_principal,
                    job,
                }),
                ApplicationEffect::RefreshNodeInfo,
            ] => {
                assert_eq!(job_id, &controlled_job.id);
                assert_eq!(*reason, StopReason::Pause);
                assert_eq!(*event_principal, principal_id);
                assert_eq!(job, &controlled_job);
            }
            other => panic!("unexpected effects: {other:?}"),
        }
    }

    #[test]
    fn song_updates_declare_the_exact_committed_revision() {
        let principal_id = PrincipalId::from_client_public_key(&[7_u8; 32]);
        let outcome = from_response(
            NodeMessage::SongUpdated {
                v: PROTOCOL_VERSION,
                id: "request".into(),
                song: cantor_proto::SongHeader {
                    id: "song-id".into(),
                    revision: 2,
                    title: "title".into(),
                    caption_summary: "caption".into(),
                    created_at: "created".into(),
                    duration_ms: 10,
                    model: "model:variant".into(),
                    seed: Some(7),
                    favorite: true,
                    tags: Vec::new(),
                    trashed: false,
                    artifacts: Vec::new(),
                },
            },
            Some(principal_id),
            Some(42),
        );
        match outcome.effects.as_slice() {
            [
                ApplicationEffect::Publish(NodeEvent::LibraryChanged {
                    principal_id: event_principal,
                    revision,
                }),
            ] => {
                assert_eq!(*event_principal, principal_id);
                assert_eq!(*revision, 42);
            }
            other => panic!("unexpected effects: {other:?}"),
        }
    }
}

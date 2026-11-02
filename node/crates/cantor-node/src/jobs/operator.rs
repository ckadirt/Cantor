//! What the node's owner may do to the queue, whichever app a job came from.
//!
//! Decisions only: `control/commands/queue.rs` translates, the library
//! persists. An app reaches none of this. It sees the results as job updates.

use anyhow::{Context, Result, bail};
use cantor_proto::{JobState, JobView};
use serde::Serialize;

use super::{StopReason, request_stop};
use crate::config::NodeConfig;
use crate::library::{ControlResult, JobControl, QueuedJob};
use crate::principal::PrincipalId;
use crate::runtime::NodeState;

/// Jobs cancelled per hold of the state mutex. Each one commits and fsyncs, and
/// the relay and the worker wait on the same mutex, so a bulk cancel lets go
/// between chunks. Its events are published in the gaps, because the relay
/// needs this mutex to drain them.
pub const CANCEL_CHUNK: usize = 25;

/// Which jobs a command means. Either named, or filtered; never both.
#[derive(Clone, Debug, Default)]
pub struct Selection {
    /// Full ids or unambiguous prefixes.
    pub jobs: Vec<String>,
    pub all: bool,
    /// A pairing's petname or key, or `local` for this node's own jobs.
    pub from: Option<String>,
    /// A `model:tag` selector, or just the model.
    pub model: Option<String>,
}

impl Selection {
    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty() && !self.is_filter()
    }

    fn is_filter(&self) -> bool {
        self.all || self.from.is_some() || self.model.is_some()
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct QueueItem {
    #[serde(flatten)]
    pub job: JobView,
    /// A pairing's name, for a person to read.
    pub owner: String,
    /// 1 runs next. Only a queued job has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
    #[serde(skip)]
    pub principal_id: PrincipalId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    /// It had not started, or was paused. It is over.
    Cancelled,
    /// It was running, and stops at the next safe point.
    Stopping,
    /// Its song is being saved. It is past cancelling and will complete.
    Finishing,
    /// It ended before this reached it.
    Finished,
    /// It no longer exists.
    Gone,
}

#[derive(Debug)]
pub struct Cancellation {
    pub job_id: String,
    pub outcome: CancelOutcome,
    /// The change to tell the job's owner about, if anything changed.
    pub update: Option<(PrincipalId, JobView)>,
}

/// The queue in run order, with what a person needs to recognise each job.
pub fn queue(state: &NodeState) -> Result<Vec<QueueItem>> {
    let mut position = 0;
    Ok(state
        .library
        .operator_queue()?
        .into_iter()
        .map(|QueuedJob { principal_id, job }| {
            let position = (job.state == JobState::Queued).then(|| {
                position += 1;
                position
            });
            QueueItem {
                owner: owner_name(&state.config, principal_id),
                position,
                principal_id,
                job,
            }
        })
        .collect())
}

/// The jobs a selection means, in run order. Refuses a name that does not
/// point at exactly one job: acting on a guess is how the wrong song dies.
pub fn select(state: &NodeState, selection: &Selection) -> Result<Vec<QueueItem>> {
    if !selection.jobs.is_empty() && selection.is_filter() {
        bail!("name jobs or use a filter, not both");
    }
    let items = queue(state)?;
    if !selection.jobs.is_empty() {
        let mut chosen = Vec::new();
        for name in &selection.jobs {
            let found = find(&items, name)?;
            if !chosen.contains(&found) {
                chosen.push(found);
            }
        }
        return Ok(items
            .iter()
            .enumerate()
            .filter(|(index, _)| chosen.contains(index))
            .map(|(_, item)| item.clone())
            .collect());
    }
    let from = selection
        .from
        .as_deref()
        .map(|from| owner_named(&state.config, from))
        .transpose()?;
    Ok(items
        .into_iter()
        .filter(|item| from.is_none_or(|from| item.principal_id == from))
        .filter(|item| {
            selection
                .model
                .as_deref()
                .is_none_or(|model| model_matches(&item.job.model, model))
        })
        .collect())
}

/// Cancel these jobs, at most `CANCEL_CHUNK` at a time from the caller, which
/// publishes the updates once the mutex is released.
pub fn cancel(state: &mut NodeState, ids: &[String]) -> Result<Vec<Cancellation>> {
    ids.iter().map(|id| cancel_one(state, id)).collect()
}

fn cancel_one(state: &mut NodeState, id: &str) -> Result<Cancellation> {
    let gone = || Cancellation {
        job_id: id.to_owned(),
        outcome: CancelOutcome::Gone,
        update: None,
    };
    let Some(principal_id) = state.library.job_owner(id)? else {
        return Ok(gone());
    };
    let result = state
        .library
        .control_job(principal_id, id, None, JobControl::Cancel)?;
    let (outcome, update) = match result {
        ControlResult::NotFound => return Ok(gone()),
        ControlResult::Updated(job) => {
            if job.state == JobState::CancelRequested
                && let Some(active) = state
                    .active_job
                    .as_ref()
                    .filter(|active| active.job_id == id)
            {
                request_stop(&active.signal, StopReason::Cancel);
            }
            let outcome = if job.state == JobState::Cancelled {
                CancelOutcome::Cancelled
            } else {
                CancelOutcome::Stopping
            };
            (outcome, Some((principal_id, job)))
        }
        ControlResult::Conflict(job) | ControlResult::InvalidTransition(job) => {
            let outcome = if job.state == JobState::Finalizing {
                CancelOutcome::Finishing
            } else {
                CancelOutcome::Finished
            };
            (outcome, None)
        }
    };
    Ok(Cancellation {
        job_id: id.to_owned(),
        outcome,
        update,
    })
}

fn find(items: &[QueueItem], name: &str) -> Result<usize> {
    let name = name.to_ascii_lowercase();
    let mut matches = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.job.id.starts_with(&name));
    let Some((found, _)) = matches.next() else {
        bail!("no job in the queue starts with {name}");
    };
    if matches.next().is_some() {
        let ids = items
            .iter()
            .filter(|item| item.job.id.starts_with(&name))
            .map(|item| item.job.id.as_str())
            .collect::<Vec<_>>();
        bail!(
            "{name} could be {} jobs: {}. Use more of the id",
            ids.len(),
            ids.join(", ")
        );
    }
    Ok(found)
}

fn model_matches(job_model: &str, wanted: &str) -> bool {
    job_model == wanted
        || job_model
            .strip_prefix(wanted)
            .is_some_and(|rest| rest.starts_with(':'))
}

fn owner_named(config: &NodeConfig, name: &str) -> Result<PrincipalId> {
    if name == "local" {
        return Ok(PrincipalId::local_operator());
    }
    let key = config.resolve_pairing(name)?;
    PrincipalId::from_pairing_key(&key).with_context(|| format!("{name} has no usable key"))
}

fn owner_name(config: &NodeConfig, principal: PrincipalId) -> String {
    if principal == PrincipalId::local_operator() {
        return "this node".to_owned();
    }
    config
        .pairings
        .iter()
        .find(|pairing| PrincipalId::from_pairing_key(&pairing.key) == Some(principal))
        .map_or_else(
            // Revoked, or paired before this node kept records.
            || "unknown".to_owned(),
            |pairing| {
                pairing
                    .petname
                    .clone()
                    .unwrap_or_else(|| pairing.key.chars().take(8).collect())
            },
        )
}

#[cfg(test)]
mod tests {
    use super::model_matches;

    #[test]
    fn a_model_filter_means_the_model_or_one_exact_tag() {
        assert!(model_matches("acestep:1.5-fast", "acestep"));
        assert!(model_matches("acestep:1.5-fast", "acestep:1.5-fast"));
        assert!(!model_matches("acestep:1.5-fast", "acestep:1.5"));
        assert!(!model_matches("acestep:1.5-fast", "ace"));
    }
}

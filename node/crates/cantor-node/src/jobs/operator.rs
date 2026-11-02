//! What the node's owner may do to the queue, whichever app a job came from.
//!
//! Decisions only: `control/commands/queue.rs` translates, the library
//! persists. An app reaches none of this. It sees the results as job updates.

use anyhow::{Context, Result, bail};
use cantor_proto::{JobState, JobView};
use serde::Serialize;

use super::{StopReason, request_stop};
use crate::config::NodeConfig;
use crate::library::{ControlResult, ForgetResult, JobControl, QueuedJob};
use crate::principal::PrincipalId;
use crate::runtime::NodeState;

/// Jobs acted on per hold of the state mutex. Each one commits and fsyncs, and
/// the relay and the worker wait on the same mutex, so bulk work lets go
/// between chunks. Its events are published in the gaps, because the relay
/// needs this mutex to drain them.
pub const ACT_CHUNK: usize = 25;

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

/// What the owner can do to a job already on the node.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Act {
    Cancel,
    Hold,
    Release,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActOutcome {
    /// It had not started, or was paused. It is over.
    Cancelled,
    /// It stays pending until the owner releases it.
    Held,
    /// It is back in the queue, in the place it had.
    Released,
    /// It was running, and stops at the next safe point.
    Stopping,
    /// Its song is being saved. It is past stopping and will complete.
    Finishing,
    /// Nothing about it had to change, or could.
    Unchanged,
    /// It no longer exists.
    Gone,
}

#[derive(Debug)]
pub struct ActResult {
    pub job_id: String,
    pub outcome: ActOutcome,
    /// The change to tell the job's owner about, if anything changed.
    pub update: Option<(PrincipalId, JobView)>,
}

/// Where to put a job in the queue.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Placement {
    /// Runs next, and stays above new arrivals.
    Next,
    /// Runs last, and stays below new arrivals.
    Last,
    Before(String),
    After(String),
}

/// The priority changes that put `job` where `placement` says.
///
/// `priority` is the whole order: `claim_next` already sorts by it, a new job
/// arrives at 0, and a tie falls to age. So every gap made here is strict, or
/// age would quietly undo the move. Pure, so the order can be proved alone.
pub fn reorder(
    queue: &[(String, i64)],
    job: &str,
    placement: &Placement,
) -> Result<Vec<(String, i64)>> {
    if !queue.iter().any(|(id, _)| id == job) {
        bail!("only a waiting job can be moved");
    }
    let rest = queue.iter().filter(|(id, _)| id != job).collect::<Vec<_>>();
    let index_of = |target: &str| {
        if target == job {
            bail!("a job cannot be moved next to itself");
        }
        rest.iter()
            .position(|(id, _)| id == target)
            .with_context(|| format!("{target} is not waiting"))
    };
    let at = |index: usize, change: &mut Vec<(String, i64)>| {
        // Everything ahead keeps its order and clears the job by at least one.
        let below = rest[index].1;
        change.extend(
            rest[..index]
                .iter()
                .map(|(id, priority)| (id.clone(), priority + 2)),
        );
        change.push((job.to_owned(), below + 1));
    };
    let mut changes = Vec::new();
    match placement {
        Placement::Next => {
            let top = rest.first().map_or(0, |(_, priority)| priority + 1);
            changes.push((job.to_owned(), top));
        }
        Placement::Last => {
            let bottom = rest.last().map_or(0, |(_, priority)| priority - 1);
            changes.push((job.to_owned(), bottom));
        }
        Placement::Before(target) => at(index_of(target)?, &mut changes),
        Placement::After(target) => {
            let index = index_of(target)?;
            if index + 1 < rest.len() {
                at(index + 1, &mut changes);
            } else {
                changes.push((job.to_owned(), rest[index].1 - 1));
            }
        }
    }
    Ok(changes)
}

/// Put a named job somewhere in the queue.
pub fn place(state: &mut NodeState, job: &str, placement: &Placement) -> Result<QueueItem> {
    let items = queue(state)?;
    let moved = items[find(&items, job)?].job.id.clone();
    let resolve = |name: &str| Ok::<_, anyhow::Error>(items[find(&items, name)?].job.id.clone());
    let placement = match placement {
        Placement::Before(other) => Placement::Before(resolve(other)?),
        Placement::After(other) => Placement::After(resolve(other)?),
        other => other.clone(),
    };
    let order = state.library.queue_order()?;
    let changes = reorder(&order, &moved, &placement)?;
    state.library.set_queue_order(&changes)?;
    let items = queue(state)?;
    items
        .into_iter()
        .find(|item| item.job.id == moved)
        .context("the moved job disappeared")
}

/// Run this job now. The running job, if any, checkpoints and goes back in the
/// queue directly below it. Returns the job displaced, which may yet finish
/// first: a job saving its song is past stopping.
pub fn run_now(state: &mut NodeState, job: &str) -> Result<(QueueItem, Option<String>)> {
    let items = queue(state)?;
    let wanted = items[find(&items, job)?].job.id.clone();
    let order = state.library.queue_order()?;
    if !order.iter().any(|(id, _)| *id == wanted) {
        bail!("only a waiting job can run now");
    }
    let top = order
        .iter()
        .filter(|(id, _)| *id != wanted)
        .map(|(_, priority)| *priority)
        .max()
        .unwrap_or(0);
    let mut changes = vec![(wanted.clone(), top + 2)];
    let running = items
        .iter()
        .find(|item| matches!(item.job.state, JobState::Preparing | JobState::Running))
        .map(|item| item.job.id.clone());
    let displaced = running.filter(|id| {
        state
            .active_job
            .as_ref()
            .is_some_and(|active| active.job_id == *id)
    });
    if let Some(id) = &displaced {
        changes.push((id.clone(), top + 1));
    }
    state.library.set_queue_order(&changes)?;
    if let Some(active) = &state.active_job
        && displaced.is_some()
    {
        request_stop(&active.signal, StopReason::Yield);
    }
    let moved = queue(state)?
        .into_iter()
        .find(|item| item.job.id == wanted)
        .context("the job disappeared")?;
    Ok((moved, displaced))
}

/// Jobs `queue clear` would erase, optionally only one pairing's.
pub fn stopped(state: &NodeState, from: Option<&str>) -> Result<Vec<QueueItem>> {
    let from = from
        .map(|from| owner_named(&state.config, from))
        .transpose()?;
    Ok(state
        .library
        .stopped_jobs()?
        .into_iter()
        .filter(|job| from.is_none_or(|from| job.principal_id == from))
        .map(|QueuedJob { principal_id, job }| QueueItem {
            owner: owner_name(&state.config, principal_id),
            position: None,
            principal_id,
            job,
        })
        .collect())
}

/// Erase stopped jobs, returning who to tell. Refusals are skipped, not errors:
/// `forget_job` keeps its own rule that a published song is never erased.
pub fn forget(state: &mut NodeState, jobs: &[QueueItem]) -> Result<Vec<(PrincipalId, String)>> {
    let mut forgotten = Vec::new();
    for item in jobs {
        if matches!(
            state
                .library
                .forget_job(item.principal_id, &item.job.id, None)?,
            ForgetResult::Forgotten
        ) {
            forgotten.push((item.principal_id, item.job.id.clone()));
        }
    }
    Ok(forgotten)
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

/// Act on these jobs, at most `ACT_CHUNK` at a time from the caller, which
/// publishes the updates once the mutex is released.
pub fn act(state: &mut NodeState, act: Act, ids: &[String]) -> Result<Vec<ActResult>> {
    let results = ids
        .iter()
        .map(|id| act_on(state, act, id))
        .collect::<Result<Vec<_>>>()?;
    if results
        .iter()
        .any(|result| result.outcome == ActOutcome::Released)
    {
        state.job_notify.notify_one();
    }
    Ok(results)
}

fn act_on(state: &mut NodeState, act: Act, id: &str) -> Result<ActResult> {
    let gone = || ActResult {
        job_id: id.to_owned(),
        outcome: ActOutcome::Gone,
        update: None,
    };
    let Some(principal_id) = state.library.job_owner(id)? else {
        return Ok(gone());
    };
    let control = match act {
        Act::Cancel => JobControl::OwnerCancel,
        Act::Hold => JobControl::Hold,
        Act::Release => JobControl::Release,
    };
    let before = state.library.get(principal_id, id)?;
    let result = state.library.control_job(principal_id, id, None, control)?;
    let (outcome, update) = match result {
        ControlResult::NotFound => return Ok(gone()),
        ControlResult::Updated(job) => {
            let stop = match job.state {
                JobState::CancelRequested => Some(StopReason::Cancel),
                JobState::PauseRequested => Some(StopReason::Hold),
                _ => None,
            };
            if let Some(stop) = stop
                && let Some(active) = state
                    .active_job
                    .as_ref()
                    .filter(|active| active.job_id == id)
            {
                request_stop(&active.signal, stop);
            }
            let changed = before.is_none_or(|before| before.revision != job.revision);
            let outcome = match job.state {
                _ if !changed => ActOutcome::Unchanged,
                JobState::Cancelled => ActOutcome::Cancelled,
                JobState::Paused => ActOutcome::Held,
                JobState::Queued => ActOutcome::Released,
                _ => ActOutcome::Stopping,
            };
            (outcome, changed.then_some((principal_id, job)))
        }
        ControlResult::Conflict(job) | ControlResult::InvalidTransition(job) => {
            let outcome = if job.state == JobState::Finalizing {
                ActOutcome::Finishing
            } else {
                ActOutcome::Unchanged
            };
            (outcome, None)
        }
    };
    Ok(ActResult {
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
    use super::{Placement, model_matches, reorder};

    fn job(name: &str, priority: i64) -> (String, i64) {
        (name.to_owned(), priority)
    }

    /// Apply changes the way SQLite would read them back. Ties fall to age, and
    /// a job's age is its place in `ages`, oldest first.
    fn order(jobs: &[(String, i64)], changes: &[(String, i64)], ages: &[&str]) -> Vec<String> {
        let mut after = jobs.to_vec();
        for (id, priority) in changes {
            after.iter_mut().find(|job| &job.0 == id).unwrap().1 = *priority;
        }
        let age = |id: &str| ages.iter().position(|name| *name == id).unwrap();
        after.sort_by_key(|(id, priority)| (-priority, age(id)));
        after.into_iter().map(|(id, _)| id).collect()
    }

    const AGES: [&str; 5] = ["a", "b", "c", "d", "e"];

    fn flat() -> Vec<(String, i64)> {
        AGES.iter().map(|name| job(name, 0)).collect()
    }

    #[test]
    fn every_placement_lands_exactly_there_across_tied_priorities() {
        let cases = [
            ("e", Placement::Next, ["e", "a", "b", "c", "d"]),
            ("a", Placement::Last, ["b", "c", "d", "e", "a"]),
            (
                "e",
                Placement::Before("c".into()),
                ["a", "b", "e", "c", "d"],
            ),
            (
                "a",
                Placement::Before("d".into()),
                ["b", "c", "a", "d", "e"],
            ),
            ("a", Placement::After("c".into()), ["b", "c", "a", "d", "e"]),
            ("e", Placement::After("a".into()), ["a", "e", "b", "c", "d"]),
            ("b", Placement::After("e".into()), ["a", "c", "d", "e", "b"]),
            (
                "e",
                Placement::Before("a".into()),
                ["e", "a", "b", "c", "d"],
            ),
        ];
        for (moved, placement, expected) in cases {
            let changes = reorder(&flat(), moved, &placement).unwrap();
            assert_eq!(order(&flat(), &changes, &AGES), expected, "{placement:?}");
        }
    }

    #[test]
    fn moves_compose() {
        let mut jobs = flat();
        for (moved, placement) in [
            ("e", Placement::Next),
            ("a", Placement::Last),
            ("d", Placement::Before("b".into())),
            ("a", Placement::After("e".into())),
            ("c", Placement::Before("a".into())),
        ] {
            let changes = reorder(&jobs, moved, &placement).unwrap();
            let names = order(&jobs, &changes, &AGES);
            for (id, priority) in changes {
                jobs.iter_mut().find(|job| job.0 == id).unwrap().1 = priority;
            }
            jobs.sort_by_key(|(id, priority)| {
                (-priority, names.iter().position(|name| name == id).unwrap())
            });
            assert_eq!(
                jobs.iter().map(|job| job.0.clone()).collect::<Vec<_>>(),
                names
            );
        }
        let names = jobs.iter().map(|job| job.0.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["e", "c", "a", "d", "b"]);
    }

    #[test]
    fn a_job_placed_last_stays_below_what_arrives_later() {
        let jobs = [job("a", 0), job("b", 0)];
        let changes = reorder(&jobs, "a", &Placement::Last).unwrap();
        assert_eq!(changes, [job("a", -1)]);
        // An arrival is at 0: above -1, wherever age would have put it.
        assert!(changes[0].1 < 0);
    }

    #[test]
    fn a_job_placed_next_stays_above_what_arrives_later() {
        let changes = reorder(&flat(), "e", &Placement::Next).unwrap();
        assert_eq!(changes, [job("e", 1)]);
    }

    #[test]
    fn only_a_waiting_job_moves_and_never_next_to_itself() {
        assert!(reorder(&flat(), "z", &Placement::Next).is_err());
        assert!(reorder(&flat(), "a", &Placement::Before("a".into())).is_err());
        assert!(reorder(&flat(), "a", &Placement::After("z".into())).is_err());
    }

    #[test]
    fn a_model_filter_means_the_model_or_one_exact_tag() {
        assert!(model_matches("acestep:1.5-fast", "acestep"));
        assert!(model_matches("acestep:1.5-fast", "acestep:1.5-fast"));
        assert!(!model_matches("acestep:1.5-fast", "acestep:1.5"));
        assert!(!model_matches("acestep:1.5-fast", "ace"));
    }
}

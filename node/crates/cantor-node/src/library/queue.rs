//! The operator's view of the queue: the one place a job query crosses owners.
//!
//! Everything else in the library is scoped by `PrincipalId`. These queries
//! exist for the local control socket and must never be reachable from
//! `application/`: an app sees its own jobs and nobody else's. The exception is
//! `queue_positions`, which gives a client its own ids and bare counts.

use anyhow::Result;
use cantor_proto::{JobView, QueuePosition};
use rusqlite::{OptionalExtension, params};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::Library;
use super::rows::{JOB_VIEW_COLUMNS, job_from_row};
use crate::principal::PrincipalId;

#[derive(Clone, Debug)]
pub struct QueuedJob {
    pub principal_id: PrincipalId,
    pub job: JobView,
}

impl Library {
    /// Every job with work left, in the order it will run: what holds the
    /// worker, then the queue exactly as `claim_next` reads it, then paused
    /// jobs, which wait for someone to resume them.
    pub fn operator_queue(&self) -> Result<Vec<QueuedJob>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT principal_id,{JOB_VIEW_COLUMNS} FROM jobs
             WHERE state NOT IN ('completed','cancelled','failed')
             ORDER BY CASE state WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 0 END,
                      priority DESC,created_at ASC,rowid ASC"
        ))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, job_from_row(row, 1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(principal, job)| {
                Ok(QueuedJob {
                    principal_id: principal.parse()?,
                    job,
                })
            })
            .collect()
    }

    /// The waiting jobs and their priorities, in run order.
    pub fn queue_order(&self) -> Result<Vec<(String, i64)>> {
        let mut statement = self.connection.prepare(
            "SELECT id,priority FROM jobs WHERE state='queued'
             ORDER BY priority DESC,created_at ASC,rowid ASC",
        )?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    /// A principal's waiting jobs and how many jobs run before each. The rest
    /// of the queue leaves this function as a number and nothing else.
    pub fn queue_positions(&self, principal: PrincipalId) -> Result<Vec<QueuePosition>> {
        let active = self.active_count()?;
        let mut statement = self.connection.prepare(
            "SELECT id,principal_id FROM jobs WHERE state='queued'
             ORDER BY priority DESC,created_at ASC,rowid ASC",
        )?;
        let owner = principal.to_string();
        let order = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(order
            .into_iter()
            .zip(active..)
            .filter(|((_, job_owner), _)| *job_owner == owner)
            .map(|((job_id, _), ahead)| QueuePosition { job_id, ahead })
            .collect())
    }

    /// Reordering is not a change to a job: `JobView` carries no position, so
    /// this bumps no revision and tells no app. `claim_next` reads the result.
    pub fn set_queue_order(&mut self, changes: &[(String, i64)]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        for (id, priority) in changes {
            transaction.execute(
                "UPDATE jobs SET priority=?2 WHERE id=?1",
                params![id, priority],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Stopped jobs an owner may erase, with who they belong to.
    pub fn stopped_jobs(&self) -> Result<Vec<QueuedJob>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT principal_id,{JOB_VIEW_COLUMNS} FROM jobs
             WHERE state IN ('failed','cancelled') ORDER BY created_at ASC,rowid ASC"
        ))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, job_from_row(row, 1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(principal, job)| {
                Ok(QueuedJob {
                    principal_id: principal.parse()?,
                    job,
                })
            })
            .collect()
    }

    /// How long a job takes here, in seconds, from what has finished lately.
    /// `None` until there is enough to say anything honest.
    pub fn typical_job_seconds(&self) -> Result<Option<u64>> {
        let mut statement = self.connection.prepare(
            "SELECT created_at,updated_at FROM jobs WHERE state='completed'
             ORDER BY updated_at DESC LIMIT 30",
        )?;
        let mut finished = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .filter_map(|(created, ended)| Some((seconds(created)?, seconds(ended)?)))
            .collect::<Vec<_>>();
        finished.reverse();
        Ok(typical_duration(&finished))
    }

    /// Who a job belongs to, whoever that is.
    pub fn job_owner(&self, id: &str) -> Result<Option<PrincipalId>> {
        let owner: Option<String> = self
            .connection
            .query_row(
                "SELECT principal_id FROM jobs WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(owner.map(|owner| owner.parse()).transpose()?)
    }
}

fn seconds(rfc3339: &str) -> Option<i64> {
    OffsetDateTime::parse(rfc3339, &Rfc3339)
        .ok()
        .map(OffsetDateTime::unix_timestamp)
}

/// The median run of jobs given as `(created, finished)`, oldest first.
///
/// A job's start is not stored, so a duration is only known where the worker
/// went straight from one job to the next: the job was already waiting when the
/// one before it finished. Anything else would count idle time as work.
fn typical_duration(finished: &[(i64, i64)]) -> Option<u64> {
    const ENOUGH: usize = 3;
    let mut runs = finished
        .windows(2)
        .filter(|pair| pair[1].0 <= pair[0].1)
        .map(|pair| u64::try_from(pair[1].1 - pair[0].1).unwrap_or(0))
        .filter(|seconds| *seconds > 0)
        .collect::<Vec<_>>();
    if runs.len() < ENOUGH {
        return None;
    }
    runs.sort_unstable();
    Some(runs[runs.len() / 2])
}

#[cfg(test)]
mod tests {
    use super::typical_duration;

    #[test]
    fn a_duration_counts_only_jobs_that_were_already_waiting() {
        // Three back-to-back runs of 100, 100, 300; then an hour idle, which
        // must not count, because the last job arrived after it.
        let finished = [(0, 50), (10, 150), (20, 250), (30, 550), (4_000, 4_100)];
        assert_eq!(typical_duration(&finished), Some(100));
    }

    #[test]
    fn too_little_history_says_nothing() {
        assert_eq!(typical_duration(&[(0, 50), (10, 150), (20, 250)]), None);
    }
}

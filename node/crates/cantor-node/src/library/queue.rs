//! The operator's view of the queue: the one place a job query crosses owners.
//!
//! Everything else in the library is scoped by `PrincipalId`. These queries
//! exist for the local control socket and must never be reachable from
//! `application/`: an app sees its own jobs and nobody else's.

use anyhow::Result;
use cantor_proto::JobView;
use rusqlite::{OptionalExtension, params};

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

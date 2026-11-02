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

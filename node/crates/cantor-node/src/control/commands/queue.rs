//! `cantor queue`: the local operator's view of, and hand on, the queue.
//!
//! Both commands stream. A listing can outgrow the one-shot response limit, and
//! a bulk cancel outlasts the one-shot client timeout.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::super::wire::{CONTROL_VERSION, reject_version, write_value_line as write_line};
use crate::jobs::operator::{self, CANCEL_CHUNK, CancelOutcome, Placement, Selection};
use crate::runtime::{NodeEvent, SharedState};

/// How long a full event channel may hold up a bulk cancel. The relay drains it
/// only while connected; after this the rest go best-effort, since an app with
/// no session reads the truth when it next lists its jobs.
const EVENT_WAIT: Duration = Duration::from_secs(2);

fn version(request: &Value, id: &str) -> Result<()> {
    let v = request.get("v").and_then(Value::as_u64).unwrap_or_default();
    reject_version(u8::try_from(v).unwrap_or(u8::MAX), id)
}

fn text(request: &Value, key: &str) -> Option<String> {
    request.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn job_names(request: &Value) -> Vec<String> {
    request
        .get("jobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

pub(super) async fn run_list<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    version(request, id)?;
    let selection = Selection {
        jobs: job_names(request),
        all: request.get("all").and_then(Value::as_bool) == Some(true),
        from: text(request, "from"),
        model: text(request, "model"),
    };
    let items = {
        let locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        if selection.is_empty() {
            operator::queue(&locked)?
        } else {
            operator::select(&locked, &selection)?
        }
    };
    for item in &items {
        write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "queue-job", "job": item}),
        )
        .await?;
    }
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "count": items.len()}),
    )
    .await
}

pub(super) async fn run_cancel<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    version(request, id)?;
    let jobs = job_names(request);
    let mut tally = BTreeMap::<String, u32>::new();
    let mut stalled = false;
    for chunk in jobs.chunks(CANCEL_CHUNK) {
        let cancelled = {
            let mut locked = state
                .lock()
                .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
            operator::cancel(&mut locked, chunk)?
        };
        for cancellation in cancelled {
            let outcome = outcome_name(cancellation.outcome)?;
            write_line(
                writer,
                &json!({"v": CONTROL_VERSION, "id": id, "t": "queue-cancelled",
                        "job_id": cancellation.job_id, "outcome": outcome}),
            )
            .await?;
            *tally.entry(outcome).or_default() += 1;
            if let Some((principal_id, job)) = cancellation.update {
                publish(
                    events,
                    NodeEvent::JobUpdated { principal_id, job },
                    &mut stalled,
                )
                .await;
            }
        }
    }
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "outcomes": tally}),
    )
    .await
}

pub(super) async fn run_place<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    version(request, id)?;
    let job = text(request, "job").context("queue-place needs a job")?;
    let other = text(request, "other");
    let placement = match (text(request, "place").as_deref(), other) {
        (Some("next"), None) => Placement::Next,
        (Some("last"), None) => Placement::Last,
        (Some("before"), Some(other)) => Placement::Before(other),
        (Some("after"), Some(other)) => Placement::After(other),
        _ => bail!("queue-place needs next, last, or before or after another job"),
    };
    let item = {
        let mut locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        operator::place(&mut locked, &job, &placement)?
    };
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "job": item}),
    )
    .await
}

/// `queue clear`: with `count_only`, what it would erase; otherwise erase it,
/// in chunks, telling each job's owner it is gone.
pub(super) async fn run_clear<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    version(request, id)?;
    let from = text(request, "from");
    let stopped = {
        let locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        operator::stopped(&locked, from.as_deref())?
    };
    if request.get("count_only").and_then(Value::as_bool) == Some(true) {
        return write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "count": stopped.len()}),
        )
        .await;
    }
    let mut cleared = 0;
    let mut stalled = false;
    for chunk in stopped.chunks(CANCEL_CHUNK) {
        let forgotten = {
            let mut locked = state
                .lock()
                .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
            operator::forget(&mut locked, chunk)?
        };
        for (principal_id, job_id) in forgotten {
            cleared += 1;
            publish(
                events,
                NodeEvent::JobForgotten {
                    principal_id,
                    job_id,
                },
                &mut stalled,
            )
            .await;
        }
    }
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "count": cleared}),
    )
    .await
}

fn outcome_name(outcome: CancelOutcome) -> Result<String> {
    serde_json::to_value(outcome)?
        .as_str()
        .map(str::to_owned)
        .context("a cancel outcome is a string")
}

async fn publish(events: &mpsc::Sender<NodeEvent>, event: NodeEvent, stalled: &mut bool) {
    if *stalled {
        let _ = events.try_send(event);
    } else if events.send_timeout(event, EVENT_WAIT).await.is_err() {
        *stalled = true;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;

    use cantor_proto::{GenerationRequest, JobState};
    use serde_json::{Value, json};
    use tempfile::tempdir;
    use tokio::sync::mpsc;

    use super::super::generate::run_generate;
    use super::super::generate::tests::state as node_state;
    use super::{run_cancel, run_clear, run_list, run_place};
    use crate::application::admit_job;
    use crate::library::{JobControl, Submission, SubmitResult};
    use crate::principal::PrincipalId;
    use crate::runtime::{ActiveJobControl, NodeEvent, SharedState};
    use crate::store::Store;

    async fn local_job(state: &SharedState, caption: &str) {
        let mut sink = tokio::io::sink();
        run_generate(
            &json!({"caption": caption, "detach": true}),
            state,
            &mut sink,
            "request",
        )
        .await
        .expect("queued");
    }

    fn app_job(state: &SharedState, key: [u8; 32], caption: &str) -> String {
        let mut locked = state.lock().expect("state");
        let locked = &mut *locked;
        let variant = Store::new(locked.config.model_root()).installed().remove(0);
        let generation: GenerationRequest =
            serde_json::from_value(json!({"caption": caption})).expect("generation");
        let result = admit_job(
            &mut locked.library,
            &locked.config,
            PrincipalId::from_client_public_key(&key),
            &key,
            &Submission {
                client_request_id: uuid::Uuid::new_v4().to_string(),
                model: variant.selector(),
                generation,
            },
            &variant,
        )
        .expect("admission");
        match result {
            SubmitResult::Accepted(job) => job.id,
            other => panic!("not accepted: {other:?}"),
        }
    }

    async fn frames(request: Value, state: &SharedState) -> Vec<Value> {
        let mut output = Vec::new();
        run_list(&request, state, &mut output, "1")
            .await
            .expect("list");
        parse(&output)
    }

    fn parse(output: &[u8]) -> Vec<Value> {
        String::from_utf8_lossy(output)
            .lines()
            .map(|line| serde_json::from_str(line).expect("JSON frame"))
            .collect()
    }

    async fn frames_order(state: &SharedState) -> Vec<String> {
        captions(&frames(json!({"v": 1, "t": "queue"}), state).await)
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    fn captions(frames: &[Value]) -> Vec<&str> {
        frames
            .iter()
            .filter(|frame| frame["t"] == "queue-job")
            .map(|frame| frame["job"]["caption"].as_str().expect("caption"))
            .collect()
    }

    #[tokio::test]
    async fn the_listing_crosses_owners_in_run_order_and_says_whose() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        local_job(&state, "first").await;
        app_job(&state, [7; 32], "second");
        local_job(&state, "third").await;

        let frames = frames(json!({"v": 1, "t": "queue"}), &state).await;
        assert_eq!(captions(&frames), ["first", "second", "third"]);
        assert_eq!(frames[0]["job"]["owner"], "this node");
        assert_eq!(frames[0]["job"]["position"], 1);
        assert_eq!(frames[1]["job"]["owner"], "unknown");
        assert_eq!(frames[2]["job"]["position"], 3);
        assert_eq!(frames[3]["t"], "ok");
        assert_eq!(frames[3]["count"], 3);
    }

    #[tokio::test]
    async fn a_prefix_names_one_job_and_a_miss_or_a_guess_is_refused() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let id = app_job(&state, [7; 32], "only");
        let frames = frames(json!({"v": 1, "t": "queue", "jobs": [&id[..8]]}), &state).await;
        assert_eq!(captions(&frames), ["only"]);

        let mut output = Vec::new();
        let error = run_list(
            &json!({"v": 1, "t": "queue", "jobs": ["zz"]}),
            &state,
            &mut output,
            "1",
        )
        .await
        .expect_err("no such job");
        assert!(error.to_string().contains("no job in the queue"));

        let error = run_list(
            &json!({"v": 1, "t": "queue", "jobs": [&id[..8]], "all": true}),
            &state,
            &mut output,
            "1",
        )
        .await
        .expect_err("names and filters together");
        assert!(error.to_string().contains("not both"));
    }

    #[tokio::test]
    async fn cancel_ends_queued_work_and_stops_the_running_job() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let principal = PrincipalId::from_client_public_key(&key);
        let running = app_job(&state, key, "running");
        let waiting = app_job(&state, key, "waiting");
        let signal = {
            let mut locked = state.lock().expect("state");
            let (work, _) = locked.library.claim_next().expect("claim").expect("work");
            let signal = Arc::new(std::sync::atomic::AtomicU8::new(0));
            locked.active_job = Some(ActiveJobControl {
                job_id: work.id,
                principal_id: principal,
                signal: Arc::clone(&signal),
            });
            signal
        };

        let (events, mut received) = mpsc::channel(8);
        let mut output = Vec::new();
        run_cancel(
            &json!({"v": 1, "t": "queue-cancel", "jobs": [&running, &waiting, "gone"]}),
            &state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("cancel");

        let frames = parse(&output);
        assert_eq!(frames[0]["outcome"], "stopping");
        assert_eq!(frames[1]["outcome"], "cancelled");
        assert_eq!(frames[2]["outcome"], "gone");
        assert_eq!(frames[3]["outcomes"]["cancelled"], 1);
        assert_eq!(
            crate::jobs::StopReason::load(&signal),
            crate::jobs::StopReason::Cancel
        );
        for expected in [JobState::CancelRequested, JobState::Cancelled] {
            match received.try_recv().expect("owner told") {
                NodeEvent::JobUpdated { principal_id, job } => {
                    assert_eq!(principal_id, principal);
                    assert_eq!(job.state, expected);
                }
                other => panic!("unexpected event: {other:?}"),
            }
        }
    }

    async fn place(state: &SharedState, job: &str, place: &str, other: Option<&str>) {
        let mut output = Vec::new();
        run_place(
            &json!({"v": 1, "t": "queue-place", "job": job, "place": place, "other": other}),
            state,
            &mut output,
            "1",
        )
        .await
        .expect("place");
    }

    fn run_order(state: &SharedState) -> Vec<String> {
        let mut locked = state.lock().expect("state");
        let mut claimed = Vec::new();
        while let Some((work, _)) = locked.library.claim_next().expect("claim") {
            claimed.push(work.generation.caption.clone());
            locked
                .library
                .finish_cancelled(&work)
                .expect("worker lets go");
        }
        claimed
    }

    #[tokio::test]
    async fn the_worker_claims_what_the_operator_ordered_and_arrivals_respect_it() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let a = app_job(&state, key, "a");
        let b = app_job(&state, key, "b");
        let c = app_job(&state, key, "c");
        let d = app_job(&state, key, "d");
        place(&state, &d[..8], "next", None).await;
        place(&state, &a, "last", None).await;
        place(&state, &c, "before", Some(&b)).await;
        app_job(&state, key, "arrived later");

        assert_eq!(
            frames_order(&state).await,
            ["d", "c", "b", "arrived later", "a"]
        );
        assert_eq!(run_order(&state), ["d", "c", "b", "arrived later", "a"]);
    }

    #[tokio::test]
    async fn an_order_survives_a_pause_and_a_resume() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let principal = PrincipalId::from_client_public_key(&key);
        let a = app_job(&state, key, "a");
        let b = app_job(&state, key, "b");
        place(&state, &b, "next", None).await;
        {
            let mut locked = state.lock().expect("state");
            for control in [JobControl::Pause, JobControl::Resume] {
                locked
                    .library
                    .control_job(principal, &b, None, control)
                    .expect("control");
            }
        }
        let _ = a;
        assert_eq!(frames_order(&state).await, ["b", "a"]);
    }

    #[tokio::test]
    async fn clear_erases_stopped_jobs_and_tells_their_owners() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let stopped = app_job(&state, key, "stopped");
        let waiting = app_job(&state, key, "waiting");
        let (events, mut received) = mpsc::channel(8);
        let mut output = Vec::new();
        run_cancel(
            &json!({"v": 1, "t": "queue-cancel", "jobs": [&stopped]}),
            &state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("cancel");
        let _ = received.try_recv();

        let mut output = Vec::new();
        run_clear(
            &json!({"v": 1, "t": "queue-clear", "count_only": true}),
            &state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("count");
        assert_eq!(parse(&output)[0]["count"], 1);
        assert!(received.try_recv().is_err());

        let mut output = Vec::new();
        run_clear(
            &json!({"v": 1, "t": "queue-clear"}),
            &state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("clear");
        assert_eq!(parse(&output)[0]["count"], 1);
        match received.try_recv().expect("owner told") {
            NodeEvent::JobForgotten { job_id, .. } => assert_eq!(job_id, stopped),
            other => panic!("unexpected event: {other:?}"),
        }
        assert_eq!(frames_order(&state).await, ["waiting"]);
        let _ = waiting;
    }

    /// The relay needs the state mutex to handle each event. A bulk cancel that
    /// held it throughout would fill the channel and lose the overflow.
    #[tokio::test]
    async fn a_cancel_bigger_than_the_event_channel_loses_no_update() {
        const CHANNEL: usize = 8;
        const JOBS: usize = CHANNEL * 8;
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        state
            .lock()
            .expect("state")
            .config
            .jobs
            .max_queued_per_principal = 1_000;
        let ids = (0..JOBS)
            .map(|index| app_job(&state, [7; 32], &format!("song {index}")))
            .collect::<Vec<_>>();

        let (events, mut received) = mpsc::channel(CHANNEL);
        let relay_state = Arc::clone(&state);
        let relay = tokio::spawn(async move {
            let mut seen = HashSet::new();
            while let Some(event) = received.recv().await {
                drop(relay_state.lock().expect("state"));
                if let NodeEvent::JobUpdated { job, .. } = event {
                    seen.insert(job.id);
                }
            }
            seen
        });

        let mut output = Vec::new();
        run_cancel(
            &json!({"v": 1, "t": "queue-cancel", "jobs": ids}),
            &state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("cancel");
        drop(events);

        assert_eq!(relay.await.expect("relay").len(), JOBS);
        assert!(frames(json!({"v": 1, "t": "queue"}), &state).await[0]["t"] == "ok");
    }
}

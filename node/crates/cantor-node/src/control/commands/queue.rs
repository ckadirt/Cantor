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
use crate::jobs::operator::{self, ACT_CHUNK, Act, ActOutcome, Placement, Selection};
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
    let (items, paused, closed, job_seconds) = {
        let locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        let items = if selection.is_empty() {
            operator::queue(&locked)?
        } else {
            operator::select(&locked, &selection)?
        };
        (
            items,
            locked.config.jobs.paused,
            locked.config.jobs.closed,
            locked.library.typical_job_seconds()?,
        )
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
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "count": items.len(),
                "paused": paused, "closed": closed, "job_seconds": job_seconds}),
    )
    .await
}

pub(super) async fn run_act<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    version(request, id)?;
    let act = match text(request, "t").as_deref() {
        Some("queue-cancel") => Act::Cancel,
        Some("queue-hold") => Act::Hold,
        Some("queue-release") => Act::Release,
        other => bail!("unknown queue action {other:?}"),
    };
    let jobs = job_names(request);
    let mut tally = BTreeMap::<String, u32>::new();
    let mut stalled = false;
    for chunk in jobs.chunks(ACT_CHUNK) {
        let results = {
            let mut locked = state
                .lock()
                .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
            operator::act(&mut locked, act, chunk)?
        };
        for result in results {
            let outcome = outcome_name(result.outcome)?;
            write_line(
                writer,
                &json!({"v": CONTROL_VERSION, "id": id, "t": "queue-acted",
                        "job_id": result.job_id, "outcome": outcome}),
            )
            .await?;
            *tally.entry(outcome).or_default() += 1;
            if let Some((principal_id, job)) = result.update {
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
    events: &mpsc::Sender<NodeEvent>,
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
    nudge(events).await;
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "job": item}),
    )
    .await
}

pub(super) async fn run_now<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    version(request, id)?;
    let job = text(request, "job").context("queue-now needs a job")?;
    let (item, displaced) = {
        let mut locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        let moved = operator::run_now(&mut locked, &job)?;
        locked.job_notify.notify_one();
        moved
    };
    nudge(events).await;
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "job": item, "displaced": displaced}),
    )
    .await
}

/// `queue pause`, `resume`, `close`, `open`. The daemon owns `node.toml`.
pub(super) async fn run_gate<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    version(request, id)?;
    let (paused, closed) = match text(request, "gate").as_deref() {
        Some("pause") => (Some(true), None),
        Some("resume") => (Some(false), None),
        Some("close") => (None, Some(true)),
        Some("open") => (None, Some(false)),
        other => bail!("unknown queue gate {other:?}"),
    };
    let (paused, closed) = {
        let mut locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        let path = locked.config_path.clone();
        locked.config.set_queue_gates(&path, paused, closed)?;
        locked.job_notify.notify_one();
        (locked.config.jobs.paused, locked.config.jobs.closed)
    };
    nudge(events).await;
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "paused": paused, "closed": closed}),
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
    for chunk in stopped.chunks(ACT_CHUNK) {
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

fn outcome_name(outcome: ActOutcome) -> Result<String> {
    serde_json::to_value(outcome)?
        .as_str()
        .map(str::to_owned)
        .context("an outcome is a string")
}

/// A reorder changes no job's revision, so nothing else tells a waiting app.
/// `node.info` is what its queue positions refresh on.
async fn nudge(events: &mpsc::Sender<NodeEvent>) {
    let _ = events
        .send_timeout(NodeEvent::NodeInfoChanged, EVENT_WAIT)
        .await;
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
    use super::{run_act, run_clear, run_gate, run_list, run_now, run_place};
    use crate::application::admit_job;
    use crate::library::{ControlResult, JobControl, Submission, SubmitResult};
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
            &json!({"v": 1, "t": "queue", "jobs": ["zzzz"]}),
            &state,
            &mut output,
            "1",
        )
        .await
        .expect_err("no such job");
        assert!(error.to_string().contains("no job in the queue"));

        let error = run_list(
            &json!({"v": 1, "t": "queue", "jobs": [""]}),
            &state,
            &mut output,
            "1",
        )
        .await
        .expect_err("an empty name matches nothing, even with one job queued");
        assert!(error.to_string().contains("too short"));

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
        run_act(
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

    async fn act(state: &SharedState, t: &str, jobs: &[&str]) -> Vec<Value> {
        let (events, _received) = mpsc::channel(64);
        let mut output = Vec::new();
        run_act(
            &json!({"v": 1, "t": t, "jobs": jobs}),
            state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("act");
        parse(&output)
    }

    fn app_control(
        state: &SharedState,
        key: [u8; 32],
        id: &str,
        control: JobControl,
    ) -> ControlResult {
        state
            .lock()
            .expect("state")
            .library
            .control_job(PrincipalId::from_client_public_key(&key), id, None, control)
            .expect("control")
    }

    #[tokio::test]
    async fn a_hold_outranks_the_app_until_the_owner_releases_it() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let first = app_job(&state, key, "first");
        let held = app_job(&state, key, "held");
        place(&state, &held, "next", None).await;

        assert_eq!(
            act(&state, "queue-hold", &[&held]).await[0]["outcome"],
            "held"
        );
        assert_eq!(
            act(&state, "queue-hold", &[&held]).await[0]["outcome"],
            "unchanged"
        );
        assert!(matches!(
            app_control(&state, key, &held, JobControl::Resume),
            ControlResult::InvalidTransition(_)
        ));
        match app_control(&state, key, &held, JobControl::Pause) {
            ControlResult::Updated(job) => {
                assert_eq!(job.state, JobState::Paused);
                assert_eq!(job.by_node_owner, Some(true));
            }
            other => panic!("unexpected result: {other:?}"),
        }
        let listed = frames(json!({"v": 1, "t": "queue"}), &state).await;
        assert_eq!(listed[1]["job"]["by_node_owner"], true);

        assert_eq!(
            act(&state, "queue-release", &[&held]).await[0]["outcome"],
            "released"
        );
        // It comes back in the place it was given.
        assert_eq!(frames_order(&state).await, ["held", "first"]);
        let _ = first;
    }

    #[tokio::test]
    async fn a_hold_outlives_a_restart_and_a_revocation() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let held = app_job(&state, key, "held");
        act(&state, "queue-hold", &[&held]).await;
        let principal = PrincipalId::from_client_public_key(&key);
        state
            .lock()
            .expect("state")
            .library
            .hold_principal_jobs(principal)
            .expect("revocation");

        drop(state);
        let library = crate::library::Library::open(temporary.path().join("library"))
            .expect("the library reopens");
        let mut library = library;
        let job = library.get(principal, &held).unwrap().unwrap();
        assert_eq!(job.state, JobState::Paused);
        assert_eq!(job.by_node_owner, Some(true));
        assert!(library.claim_next().expect("claim").is_none());
        assert!(matches!(
            library
                .control_job(principal, &held, None, JobControl::Resume)
                .expect("control"),
            ControlResult::InvalidTransition(_)
        ));
    }

    #[tokio::test]
    async fn an_app_may_cancel_its_own_held_job() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let held = app_job(&state, key, "held");
        act(&state, "queue-hold", &[&held]).await;
        match app_control(&state, key, &held, JobControl::Cancel) {
            ControlResult::Updated(job) => {
                assert_eq!(job.state, JobState::Cancelled);
                assert_eq!(job.by_node_owner, None);
            }
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[tokio::test]
    async fn holding_a_running_job_stops_it_as_held_even_if_the_stop_says_pause() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let running = app_job(&state, key, "running");
        let (work, signal) = {
            let mut locked = state.lock().expect("state");
            let (work, _) = locked.library.claim_next().expect("claim").expect("work");
            let signal = Arc::new(std::sync::atomic::AtomicU8::new(0));
            locked.active_job = Some(ActiveJobControl {
                job_id: work.id.clone(),
                principal_id: work.principal_id,
                signal: Arc::clone(&signal),
            });
            (work, signal)
        };
        assert_eq!(
            act(&state, "queue-hold", &[&running]).await[0]["outcome"],
            "stopping"
        );
        assert_eq!(
            crate::jobs::StopReason::load(&signal),
            crate::jobs::StopReason::Hold
        );
        // The scheduler's gap: it read `pause_requested` and asked for a pause.
        let job = state
            .lock()
            .expect("state")
            .library
            .finish_paused(&work, None, cantor_proto::GenerationStage::Plan, "pause")
            .expect("paused")
            .expect("job");
        assert_eq!(job.by_node_owner, Some(true));
        assert!(matches!(
            app_control(&state, key, &running, JobControl::Resume),
            ControlResult::InvalidTransition(_)
        ));
    }

    #[tokio::test]
    async fn an_owner_cancel_says_so_and_an_app_cancel_does_not() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let owners = app_job(&state, key, "owners");
        let apps = app_job(&state, key, "apps");
        act(&state, "queue-cancel", &[&owners]).await;
        app_control(&state, key, &apps, JobControl::Cancel);
        let locked = state.lock().expect("state");
        let principal = PrincipalId::from_client_public_key(&key);
        let job = |id: &str| locked.library.get(principal, id).unwrap().unwrap();
        assert_eq!(job(&owners).by_node_owner, Some(true));
        assert_eq!(job(&apps).by_node_owner, None);
    }

    async fn gate(state: &SharedState, gate: &str) {
        let (events, _received) = mpsc::channel(4);
        let mut output = Vec::new();
        run_gate(
            &json!({"v": 1, "t": "queue-gate", "gate": gate}),
            state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("gate");
    }

    #[tokio::test]
    async fn pausing_stops_claims_durably_and_resuming_starts_them() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        app_job(&state, [7; 32], "waits");
        gate(&state, "pause").await;

        let path = state.lock().expect("state").config_path.clone();
        let saved = std::fs::read_to_string(&path).expect("config");
        assert!(saved.contains("paused = true"), "{saved}");

        let (events, mut received) = mpsc::channel(8);
        let worker = tokio::spawn(crate::jobs::run(state.clone(), events));
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert_eq!(frames_order(&state).await, ["waits"]);
        assert_eq!(
            frames(json!({"v": 1, "t": "queue"}), &state).await[0]["job"]["state"],
            "queued"
        );
        assert!(received.try_recv().is_err());

        gate(&state, "resume").await;
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
            .await
            .expect("the worker woke")
            .expect("event");
        assert!(matches!(event, NodeEvent::JobUpdated { .. }));
        worker.abort();
    }

    #[tokio::test]
    async fn a_closed_node_refuses_apps_but_not_its_owner_or_a_repeat() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let principal = PrincipalId::from_client_public_key(&key);
        const EARLIER: &str = "019c8f7e-5f2b-7a21-9ee0-8efb630bcb30";
        const LATER: &str = "019c8f7e-5f2b-7a21-9ee0-8efb630bcb31";
        let submission = |id: &str| Submission {
            client_request_id: id.to_owned(),
            model: "adapter:fast".to_owned(),
            generation: serde_json::from_value(json!({"caption": "song"})).expect("generation"),
        };
        let admit = |id: &str| {
            let mut locked = state.lock().expect("state");
            let locked = &mut *locked;
            let variant = Store::new(locked.config.model_root()).installed().remove(0);
            admit_job(
                &mut locked.library,
                &locked.config,
                principal,
                &key,
                &submission(id),
                &variant,
            )
            .expect("admission")
        };
        assert!(matches!(admit(EARLIER), SubmitResult::Accepted(_)));

        gate(&state, "close").await;
        assert!(matches!(admit(LATER), SubmitResult::Closed));
        assert!(matches!(admit(EARLIER), SubmitResult::Accepted(_)));
        local_job(&state, "the owner's own").await;
        {
            let locked = state.lock().expect("state");
            let info = crate::relay::static_node_info(&locked.config, &locked.library);
            assert!(!info.load.accepting_jobs);
            assert_eq!(info.load.unavailable_reason.as_deref(), Some("closed"));
        }

        gate(&state, "open").await;
        assert!(matches!(admit(LATER), SubmitResult::Accepted(_)));
    }

    #[tokio::test]
    async fn now_puts_the_job_first_and_the_running_one_straight_after_it() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let running = app_job(&state, key, "running");
        let other = app_job(&state, key, "other");
        let wanted = app_job(&state, key, "wanted");
        place(&state, &other, "next", None).await;
        let (work, signal) = {
            let mut locked = state.lock().expect("state");
            let (work, _) = locked.library.claim_next().expect("claim").expect("work");
            assert_eq!(work.id, other);
            let signal = Arc::new(std::sync::atomic::AtomicU8::new(0));
            locked.active_job = Some(ActiveJobControl {
                job_id: work.id.clone(),
                principal_id: work.principal_id,
                signal: Arc::clone(&signal),
            });
            (work, signal)
        };

        let (events, _received) = mpsc::channel(4);
        let mut output = Vec::new();
        run_now(
            &json!({"v": 1, "t": "queue-now", "job": &wanted}),
            &state,
            &events,
            &mut output,
            "1",
        )
        .await
        .expect("now");
        assert_eq!(parse(&output)[0]["displaced"], work.id);
        assert_eq!(
            crate::jobs::StopReason::load(&signal),
            crate::jobs::StopReason::Yield
        );

        // What the runner does when the signal lands.
        let job = state
            .lock()
            .expect("state")
            .library
            .finish_shutdown(&work, None, cantor_proto::GenerationStage::Diffuse, "yield")
            .expect("yield")
            .expect("job");
        assert_eq!(job.state, JobState::Queued);
        assert_eq!(job.stage, Some(cantor_proto::GenerationStage::Diffuse));

        assert_eq!(run_order(&state), ["wanted", "other", "running"]);
        let _ = running;
    }

    #[tokio::test]
    async fn a_client_learns_its_own_place_and_only_a_count_of_the_rest() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let (mine, theirs) = ([7; 32], [8; 32]);
        app_job(&state, theirs, "running");
        let first = app_job(&state, mine, "first");
        app_job(&state, theirs, "between");
        let second = app_job(&state, mine, "second");
        let mut locked = state.lock().expect("state");
        locked.library.claim_next().expect("claim").expect("work");
        let positions = locked
            .library
            .queue_positions(PrincipalId::from_client_public_key(&mine))
            .expect("positions");
        let found = positions
            .iter()
            .map(|place| (place.job_id.as_str(), place.ahead))
            .collect::<Vec<_>>();
        assert_eq!(found, [(first.as_str(), 1), (second.as_str(), 3)]);
    }

    /// A damaged job once stayed first in line and stopped the node for good.
    #[tokio::test]
    async fn a_damaged_job_fails_and_the_queue_moves_on() {
        let temporary = tempdir().expect("temporary directory");
        let state = node_state(temporary.path(), &[("adapter", "fast")]);
        let key = [7; 32];
        let damaged = app_job(&state, key, "damaged");
        let healthy = app_job(&state, key, "healthy");
        let mut locked = state.lock().expect("state");
        let principal = PrincipalId::from_client_public_key(&key);
        std::fs::write(
            locked
                .library
                .root()
                .join("jobs")
                .join(principal.to_string())
                .join(&damaged)
                .join("request.json"),
            "{}",
        )
        .expect("damage");

        let (work, _) = locked.library.claim_next().expect("claim").expect("work");
        assert_eq!(work.id, healthy);
        let set_aside = locked.library.take_set_aside();
        assert_eq!(set_aside.len(), 1);
        assert_eq!(set_aside[0].0, principal);
        assert_eq!(set_aside[0].1.id, damaged);
        assert_eq!(set_aside[0].1.state, JobState::Failed);
        assert!(locked.library.take_set_aside().is_empty());
    }

    async fn place(state: &SharedState, job: &str, place: &str, other: Option<&str>) {
        let (events, _received) = mpsc::channel(4);
        let mut output = Vec::new();
        run_place(
            &json!({"v": 1, "t": "queue-place", "job": job, "place": place, "other": other}),
            state,
            &events,
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
        run_act(
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
        run_act(
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

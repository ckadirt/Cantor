//! Local durable generation submission and progress streaming.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use super::super::wire::{CONTROL_VERSION, write_value_line as write_line};
use crate::principal::PrincipalId;
use crate::runtime::SharedState;
use crate::store::Store;

/// Submits under the reserved local-operator principal and follows the same
/// durable views the app receives. Inference belongs exclusively to `jobs`.
pub(super) async fn run_generate<W: tokio::io::AsyncWrite + Unpin>(
    request: &Value,
    state: &SharedState,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    let caption = request
        .get("caption")
        .and_then(Value::as_str)
        .context("generate needs a caption")?
        .to_owned();
    let selector = request
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let output = request
        .get("output")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let detach = request
        .get("detach")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let principal = PrincipalId::local_operator();
    let local_key = [0_u8; 32];

    let (job, notify) = {
        let mut locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        let installed = Store::new(locked.config.model_root()).installed();
        let variant = match &selector {
            Some(selector) => installed
                .iter()
                .find(|variant| &variant.selector() == selector)
                .with_context(|| {
                    format!("{selector} is not installed — run `cantor pull {selector}`")
                })?,
            None => installed
                .first()
                .context("no model is installed — run `cantor pull acestep:1.5-fast`")?,
        };
        let submission = crate::library::Submission {
            client_request_id: uuid::Uuid::new_v4().to_string(),
            model: variant.selector(),
            generation: cantor_proto::GenerationRequest {
                caption: caption.clone(),
                lyrics: None,
                duration: None,
                steps: None,
                cfg: None,
                seed: None,
                extensions: None,
            },
        };
        let result = {
            let state = &mut *locked;
            crate::application::admit_job(
                &mut state.library,
                &state.config,
                principal,
                &local_key,
                &submission,
                variant,
            )
        }?;
        let job = match result {
            crate::library::SubmitResult::Accepted(job) => job,
            crate::library::SubmitResult::QueueFull => bail!("the local durable queue is full"),
            crate::library::SubmitResult::InsufficientDisk => {
                bail!("the node is below its free-space reserve")
            }
            crate::library::SubmitResult::Conflict => {
                bail!("the generated local submission ID conflicted")
            }
        };
        (job, Arc::clone(&locked.job_notify))
    };
    notify.notify_one();
    write_line(
        writer,
        &json!({"v":CONTROL_VERSION,"id":id,"t":"generating",
                "job_id":job.id,"model":job.model,"caption":caption,
                "output":output.as_ref().map(|path| path.display().to_string())}),
    )
    .await?;
    if detach {
        return write_line(
            writer,
            &json!({"v":CONTROL_VERSION,"id":id,"t":"ok",
                    "msg":format!("queued job {}", job.id)}),
        )
        .await;
    }

    let mut revision = job.revision;
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let current = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?
            .library
            .get(principal, &job.id)?
            .context("the local job disappeared")?;
        if current.revision > revision {
            revision = current.revision;
            let done = current.progress.as_ref().map_or(0, |value| value.completed);
            let total = current
                .progress
                .as_ref()
                .and_then(|value| value.total)
                .unwrap_or(1);
            write_line(
                writer,
                &json!({"v":CONTROL_VERSION,"id":id,"t":"progress",
                        "role":current.stage.map(|stage| format!("{stage:?}").to_lowercase())
                            .unwrap_or_else(|| format!("{:?}", current.state).to_lowercase()),
                        "done":done,"total":total,"overall_done":done,
                        "overall_total":total,"revision":current.revision}),
            )
            .await?;
        }
        match current.state {
            cantor_proto::JobState::Completed => {
                let canonical = state
                    .lock()
                    .map_err(|_| anyhow::anyhow!("node state is poisoned"))?
                    .library
                    .verified_master_path(principal, &job.id)?;
                if let Some(destination) = output.as_ref() {
                    state
                        .lock()
                        .map_err(|_| anyhow::anyhow!("node state is poisoned"))?
                        .library
                        .export_master(principal, &job.id, destination)?;
                }
                return write_line(
                    writer,
                    &json!({"v":CONTROL_VERSION,"id":id,"t":"ok",
                            "msg":match output.as_ref() {
                                Some(path) => format!("completed {} (exported to {})", canonical.display(), path.display()),
                                None => format!("completed {}", canonical.display()),
                            }}),
                )
                .await;
            }
            cantor_proto::JobState::Failed => {
                bail!(
                    "job {} failed: {}",
                    job.id,
                    current
                        .error
                        .map_or_else(|| "unknown error".into(), |error| error.message)
                )
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use cantor_proto::{GenerationStage, JobState, ProgressUnit};
    use serde_json::{Value, json};
    use tempfile::tempdir;
    use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, Lines};

    use super::run_generate;
    use crate::catalog::{Model, Needs, Variant};
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::identity::NodeIdentity;
    use crate::principal::PrincipalId;
    use crate::runtime::{NodeState, SharedState, shared};
    use crate::secure::TransportIdentity;
    use crate::store::Store;

    fn state(path: &Path, installed: &[(&str, &str)]) -> SharedState {
        let paths = NodePaths::resolve(Some(path.join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (mut config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        config.model_dir = Some(path.join("models").display().to_string());
        config.jobs.max_queued_per_principal = 20;
        config.jobs.minimum_free_bytes = 0;

        let store = Store::new(config.model_root());
        store.prepare().expect("model store");
        for (model, tag) in installed {
            store
                .mark_installed(
                    &Model {
                        name: (*model).to_owned(),
                        licence: String::new(),
                        engine: Some((*model).to_owned()),
                        variants: Vec::new(),
                    },
                    &Variant {
                        tag: (*tag).to_owned(),
                        components: Vec::new(),
                        needs: Needs::default(),
                        stages: Vec::new(),
                        parameters: Vec::new(),
                    },
                )
                .expect("installed marker");
        }

        let library = crate::library::Library::open(path.join("library")).expect("library");
        let (identity, _) = NodeIdentity::load_or_create(&paths.key).expect("identity");
        let (transport_identity, _) =
            TransportIdentity::load_or_create(&paths.transport_key, &identity)
                .expect("transport identity");
        shared(NodeState {
            config,
            config_path: paths.config,
            node_public_key: bs58::encode([9_u8; 32]).into_string(),
            pair_offer: None,
            connected: true,
            library,
            job_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            delivery_notify: std::sync::Arc::new(tokio::sync::Notify::new()),
            active_job: None,
            shutting_down: false,
            transport_identity: std::sync::Arc::new(transport_identity),
        })
    }

    async fn next_frame(lines: &mut Lines<BufReader<DuplexStream>>) -> Value {
        let line = lines
            .next_line()
            .await
            .expect("read frame")
            .expect("frame before EOF");
        serde_json::from_str(&line).expect("JSON frame")
    }

    async fn generation_error(state: &SharedState, request: Value) -> String {
        let mut writer = tokio::io::sink();
        run_generate(&request, state, &mut writer, "request")
            .await
            .expect_err("generation must fail")
            .to_string()
    }

    #[tokio::test]
    async fn detached_generation_is_durable_and_notified_before_its_two_frames() {
        let temporary = tempdir().expect("temporary directory");
        let state = state(temporary.path(), &[("adapter", "fast")]);
        let notify = state.lock().expect("state").job_notify.clone();
        let task_state = state.clone();
        let (mut task_writer, reader) = tokio::io::duplex(8 * 1024);
        let task = tokio::spawn(async move {
            run_generate(
                &json!({"caption":"weight free","detach":true}),
                &task_state,
                &mut task_writer,
                "request",
            )
            .await
        });
        let mut lines = BufReader::new(reader).lines();

        let generating = next_frame(&mut lines).await;
        assert_eq!(generating["t"], "generating");
        assert_eq!(generating["model"], "adapter:fast");
        assert_eq!(generating["caption"], "weight free");
        let job_id = generating["job_id"].as_str().expect("job id");
        let principal = PrincipalId::local_operator();
        {
            let locked = state.lock().expect("state");
            let durable = locked
                .library
                .get(principal, job_id)
                .expect("durable query")
                .expect("accepted job");
            assert_eq!(durable.state, JobState::Queued);
            assert_eq!(durable.model, "adapter:fast");
            let directory = locked
                .library
                .root()
                .join("jobs")
                .join(principal.to_string())
                .join(job_id);
            assert!(directory.join("request.json").is_file());
            assert!(directory.join("status.json").is_file());
            assert!(directory.join("manifest.json").is_file());
        }
        tokio::time::timeout(Duration::from_millis(50), notify.notified())
            .await
            .expect("worker notification was stored before the frame");

        let ok = next_frame(&mut lines).await;
        assert_eq!(ok["t"], "ok");
        assert_eq!(ok["msg"], format!("queued job {job_id}"));
        task.await.expect("generation task").expect("generation");
    }

    #[tokio::test]
    async fn selector_default_and_admission_errors_keep_their_exact_text() {
        let empty = tempdir().expect("temporary directory");
        let empty_state = state(empty.path(), &[]);
        assert_eq!(
            generation_error(&empty_state, json!({"caption":"missing","detach":true})).await,
            "no model is installed — run `cantor pull acestep:1.5-fast`"
        );

        let temporary = tempdir().expect("temporary directory");
        let state = state(temporary.path(), &[("adapter", "fast")]);
        assert_eq!(
            generation_error(
                &state,
                json!({"caption":"missing","model":"adapter:other","detach":true}),
            )
            .await,
            "adapter:other is not installed — run `cantor pull adapter:other`"
        );

        state
            .lock()
            .expect("state")
            .config
            .jobs
            .max_queued_per_principal = 0;
        assert_eq!(
            generation_error(&state, json!({"caption":"full","detach":true})).await,
            "the local durable queue is full"
        );

        {
            let mut locked = state.lock().expect("state");
            locked.config.jobs.max_queued_per_principal = 20;
            locked.config.jobs.minimum_free_bytes = u64::MAX;
        }
        assert_eq!(
            generation_error(&state, json!({"caption":"disk","detach":true})).await,
            "the node is below its free-space reserve"
        );
    }

    #[tokio::test]
    async fn polling_emits_one_frame_for_a_new_revision_and_none_when_unchanged() {
        let temporary = tempdir().expect("temporary directory");
        let state = state(temporary.path(), &[("adapter", "fast")]);
        let task_state = state.clone();
        let (mut task_writer, reader) = tokio::io::duplex(8 * 1024);
        let task = tokio::spawn(async move {
            run_generate(
                &json!({"caption":"observe revisions"}),
                &task_state,
                &mut task_writer,
                "request",
            )
            .await
        });
        let mut lines = BufReader::new(reader).lines();

        let generating = next_frame(&mut lines).await;
        assert_eq!(generating["t"], "generating");
        let revision = {
            let mut locked = state.lock().expect("state");
            let (work, _) = locked
                .library
                .claim_next()
                .expect("claim")
                .expect("queued work");
            locked
                .library
                .record_progress(
                    &work,
                    GenerationStage::Codes,
                    3,
                    Some(10),
                    ProgressUnit::Tokens,
                )
                .expect("record progress")
                .expect("updated job")
                .revision
        };

        let progress = tokio::time::timeout(Duration::from_secs(1), next_frame(&mut lines))
            .await
            .expect("progress frame");
        assert_eq!(progress["t"], "progress");
        assert_eq!(progress["revision"], revision);
        assert_eq!(progress["role"], "codes");
        assert_eq!(progress["done"], 3);
        assert_eq!(progress["total"], 10);

        assert!(
            tokio::time::timeout(Duration::from_millis(350), lines.next_line())
                .await
                .is_err(),
            "an unchanged revision must not emit another frame"
        );
        task.abort();
        let _ = task.await;
    }
}

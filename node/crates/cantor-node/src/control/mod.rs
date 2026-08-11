//! The daemon's local control surface.
//!
//! The daemon owns `node.toml` and the in-memory allowlist, so a CLI that wrote
//! those files behind its back would be ignored until the next restart. Every
//! command that mutates state therefore goes through this socket and is applied
//! by the process that is actually serving clients.
//!
//! The wire format is line-delimited JSON using the same `{v, id, t, …}`
//! envelope as the app protocol, so the two stay legible side by side.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::accel;
use crate::backends::{BackendManifest, EngineStore, machine_arch};
use crate::catalog::Catalog;
use crate::engine;
use crate::pairing::{DEFAULT_PAIR_TTL, PairOffer, new_pair_token, pairing_uri};
use crate::principal::PrincipalId;
use crate::runtime::NodeEvent;
use crate::store::{Store, human_bytes};

mod client;
mod server;
mod socket;
mod wire;

pub use client::{CLIENT_TIMEOUT, request, request_streaming};
pub use server::serve;
#[cfg(test)]
use server::serve_connection;
#[cfg(test)]
use socket::{
    CONTROL_GROUP, MAX_SOCKET_PATH_BYTES, SOCKET_MODE_PRIVATE, SOCKET_MODE_SHARED, group_id,
    is_root,
};
pub use socket::{bind, client_socket_path, default_socket_path, running_as_root};
#[cfg(test)]
use wire::MAX_REQUEST_BYTES;
pub use wire::{CONTROL_VERSION, Response};
use wire::{Request, reject_version, write_value_line as write_line};

// Keep the original control-module entry points available while downstream
// callers migrate to runtime ownership.
#[allow(unused_imports)]
pub use crate::runtime::{NodeState, SharedState, shared};

/// Compatibility name for callers that still treat relay effects as control
/// events. New runtime-facing code should use [`NodeEvent`].
#[allow(dead_code)] // Deliberate migration shim; production code uses NodeEvent.
pub type ControlEvent = NodeEvent;

/// Everything a pull needs, copied out under the lock so the download itself
/// never holds it — a multi-gigabyte transfer must not block `cantor status`.
struct PullPlan {
    store_root: PathBuf,
    catalog_url: String,
    backends_url: String,
    backend: Option<String>,
}

fn pull_plan(state: &SharedState) -> Result<PullPlan> {
    let locked = state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
    Ok(PullPlan {
        store_root: locked.config.model_root(),
        catalog_url: locked.config.catalog_url(),
        backends_url: locked.config.backends_url(),
        backend: locked.config.backend.clone(),
    })
}

async fn stream_long_request<W: tokio::io::AsyncWrite + Unpin>(
    line: &str,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    kind: &str,
) -> Result<()> {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return write_line(
                writer,
                &json!({"v": CONTROL_VERSION, "id": "", "t": "error",
                        "code": "invalid-request", "msg": error.to_string()}),
            )
            .await;
        }
    };
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let outcome = match kind {
        "pull" => {
            let selector = request
                .get("selector")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            run_pull(&selector, state, events, writer, &id).await
        }
        "generate" => run_generate(&request, state, writer, &id).await,
        "backends" => {
            let install = request
                .get("install")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let use_backend = request
                .get("use")
                .and_then(Value::as_str)
                .map(str::to_owned);
            run_backends(state, writer, &id, install, use_backend).await
        }
        _ => run_catalog(state, writer, &id).await,
    };

    if let Err(error) = outcome {
        write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "error",
                    "code": "failed", "msg": format!("{error:#}")}),
        )
        .await?;
    }
    Ok(())
}

async fn run_catalog<W: tokio::io::AsyncWrite + Unpin>(
    state: &SharedState,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    let plan = pull_plan(state)?;
    let catalog = Catalog::fetch(&plan.catalog_url).await?;
    let store = Store::new(&plan.store_root);
    let installed: Vec<String> = store
        .installed()
        .into_iter()
        .map(|variant| variant.selector())
        .collect();
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "catalog",
                "models": catalog.models, "installed": installed,
                "available_bytes": store.available_bytes().unwrap_or(0)}),
    )
    .await
}

/// The distinct engines the installed models require. A backend is per
/// (engine, arch) — not per model — so pulling five acestep variants still
/// needs exactly one acestep engine.
fn required_engines(store: &Store) -> Vec<String> {
    let mut engines: Vec<String> = store
        .installed()
        .iter()
        .map(|variant| variant.engine().to_owned())
        .collect();
    engines.sort();
    engines.dedup();
    engines
}

/// Installs `backend` for every engine the installed models need, so switching
/// backends never leaves a model that cannot run. Returns what was installed.
async fn install_backend_for_engines(
    manifest: &BackendManifest,
    engine_store: &EngineStore,
    engines: &[String],
    backend: &str,
    arch: &str,
    client: &reqwest::Client,
    mut on_progress: impl FnMut(&str, u64, u64),
) -> Result<Vec<(String, PathBuf)>> {
    let mut installed = Vec::new();
    for engine in engines {
        let Some(artifact) = manifest.find(engine, backend, arch) else {
            bail!("no {backend} build of the {engine} engine is published for {arch}");
        };
        let label = engine.clone();
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<(u64, u64)>();
        let mut last = 0_u64;
        let fetch = engine_store.install(client, artifact, move |done, total| {
            let step = total / 50 + 1;
            if done >= last + step || done == total {
                last = done;
                let _ = progress_tx.send((done, total));
            }
        });
        tokio::pin!(fetch);
        let directory = loop {
            tokio::select! {
                Some((done, total)) = progress_rx.recv() => on_progress(&label, done, total),
                result = &mut fetch => break result?,
            }
        };
        installed.push((engine.clone(), directory));
    }
    Ok(installed)
}

/// Reports what this machine can run and, with `install`, fetches and selects a
/// backend for real. Selection is measured: each candidate is actually loaded,
/// and the first that works wins — a GPU that is present but broken falls
/// through to the next rather than being trusted.
async fn run_backends<W: tokio::io::AsyncWrite + Unpin>(
    state: &SharedState,
    writer: &mut W,
    id: &str,
    install: bool,
    use_backend: Option<String>,
) -> Result<()> {
    let (store_root, backends_url, pinned, config_path) = {
        let locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        (
            locked.config.model_root(),
            locked.config.backends_url(),
            locked.config.backend.clone(),
            locked.config_path.clone(),
        )
    };

    let detected = accel::candidates();
    let arch = machine_arch();
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "detected",
                "arch": arch, "pinned": pinned,
                "accelerators": detected.iter().map(|a| json!({
                    "backend": a.backend, "evidence": a.evidence, "device": a.device
                })).collect::<Vec<_>>()}),
    )
    .await?;

    let manifest = BackendManifest::fetch(&backends_url).await?;
    let store = EngineStore::new(&store_root);
    let model_store = Store::new(&store_root);

    // `--use` is the switch: fetch the requested backend for every engine the
    // installed models need, prove it loads, and only then persist the choice.
    // Persisting first would leave a node pinned to something unusable.
    if let Some(backend) = use_backend {
        let engines = required_engines(&model_store);
        if engines.is_empty() {
            bail!("no models are installed, so there is nothing to select a backend for");
        }
        let client = reqwest::Client::builder()
            .user_agent(concat!("cantor/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("failed to build an HTTP client")?;

        let mut progress = Vec::new();
        let installed = install_backend_for_engines(
            &manifest,
            &store,
            &engines,
            &backend,
            arch,
            &client,
            |engine, done, total| progress.push((engine.to_owned(), done, total)),
        )
        .await?;
        for (engine, done, total) in progress.iter().rev().take(1) {
            write_line(
                writer,
                &json!({"v": CONTROL_VERSION, "id": id, "t": "progress",
                        "role": engine, "done": done, "total": total,
                        "overall_done": done, "overall_total": total}),
            )
            .await?;
        }

        let attempts: Vec<(String, PathBuf)> = installed
            .iter()
            .map(|(_, directory)| (backend.clone(), directory.clone()))
            .collect();
        let selection = engine::select(&attempts)?;
        let engine_version = selection.engine.version.clone();
        drop(selection);

        {
            let mut locked = state
                .lock()
                .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
            locked
                .config
                .set_backend(&config_path, Some(backend.clone()))?;
        }

        write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "selected",
                    "backend": backend, "model": engines.join(", "),
                    "engine_version": engine_version, "abi": 1,
                    "directory": installed.first().map(|(_, d)| d.display().to_string())
                        .unwrap_or_default(),
                    "stages": ["plan", "codes", "diffuse", "decode"]}),
        )
        .await?;
        return write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "ok",
                    "msg": format!("switched to {backend} for {} engine(s); it is now the default",
                                   engines.len())}),
        )
        .await;
    }

    // Which engines this machine's installed models need. With nothing
    // installed, fall back to acestep so `cantor backends` still reports what
    // the machine could run.
    let engine_names = {
        let needed = required_engines(&Store::new(&store_root));
        if needed.is_empty() {
            vec!["acestep".to_owned()]
        } else {
            needed
        }
    };

    // A pinned backend narrows the list; otherwise try them in preference order.
    let wanted: Vec<String> = match &pinned {
        Some(backend) => vec![backend.clone()],
        None => detected.iter().map(|a| a.backend.clone()).collect(),
    };

    let mut available = Vec::new();
    for backend in &wanted {
        // A backend is usable only if EVERY needed engine publishes it, since a
        // model with no engine for the chosen backend could not run.
        let mut per_engine = Vec::new();
        let mut missing_engine = None;
        for engine_name in &engine_names {
            match manifest.find(engine_name, backend, arch) {
                Some(artifact) => per_engine.push(artifact),
                None => {
                    missing_engine = Some(engine_name.clone());
                    break;
                }
            }
        }
        match missing_engine {
            None => {
                for artifact in per_engine {
                    available.push((backend.clone(), artifact));
                }
            }
            Some(engine_name) => {
                write_line(
                    writer,
                    &json!({"v": CONTROL_VERSION, "id": id, "t": "note",
                            "msg": format!("no {backend} build of the {engine_name} engine for {arch}")}),
                )
                .await?;
            }
        }
    }
    if available.is_empty() {
        bail!("the manifest publishes no backend this machine can use ({arch})");
    }

    if !install {
        return write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "ok",
                    "msg": format!("{} candidate backend(s); run `cantor backends --install` to fetch and select",
                                   available.len())}),
        )
        .await;
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("cantor/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to build an HTTP client")?;

    let mut attempts = Vec::new();
    for (backend, artifact) in &available {
        let label = backend.clone();
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<(u64, u64)>();
        let mut last = 0_u64;
        let fetch = store.install(&client, artifact, move |done, total| {
            let step = total / 50 + 1;
            if done >= last + step || done == total {
                last = done;
                let _ = progress_tx.send((done, total));
            }
        });
        tokio::pin!(fetch);
        let directory = loop {
            tokio::select! {
                Some((done, total)) = progress_rx.recv() => {
                    write_line(writer, &json!({
                        "v": CONTROL_VERSION, "id": id, "t": "progress",
                        "role": label, "done": done, "total": total,
                        "overall_done": done, "overall_total": total
                    })).await?;
                }
                result = &mut fetch => break result?,
            }
        };
        attempts.push((backend.clone(), directory));
    }

    // The measured part: load each in turn, keep the first that works.
    let selection = engine::select(&attempts)?;
    for (backend, why) in &selection.rejected {
        write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "rejected",
                    "backend": backend, "reason": why}),
        )
        .await?;
    }

    let engine = &selection.engine;
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "selected",
                "backend": engine.backend, "model": engine.model,
                "engine_version": engine.version, "abi": engine.abi,
                "directory": engine.directory.display().to_string(),
                "stages": engine.supported_stages().iter()
                    .map(|s| s.as_str()).collect::<Vec<_>>()}),
    )
    .await?;

    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok",
                "msg": format!("selected {} ({})", engine.backend, engine.version)}),
    )
    .await
}

/// Submits under the reserved local-operator principal and follows the same
/// durable views the app receives. Inference belongs exclusively to `jobs`.
async fn run_generate<W: tokio::io::AsyncWrite + Unpin>(
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
            },
        };
        let max_queued = locked.config.jobs.max_queued_per_principal;
        let minimum_free = locked.config.jobs.minimum_free_bytes;
        let job = match locked.library.submit(
            principal,
            &local_key,
            &submission,
            variant,
            max_queued,
            minimum_free,
        )? {
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

async fn run_pull<W: tokio::io::AsyncWrite + Unpin>(
    selector: &str,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    let plan = pull_plan(state)?;
    let store = Store::new(&plan.store_root);
    store.prepare()?;

    let catalog = Catalog::fetch(&plan.catalog_url).await?;
    let (model, variant) = catalog.resolve(selector)?;

    let missing = store.missing(variant)?;
    let needed: u64 = missing.iter().map(|c| c.bytes).sum();
    let shared = variant.total_bytes() - needed;

    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "plan",
                "model": model.name, "tag": variant.tag, "licence": model.licence,
                "total_bytes": variant.total_bytes(), "needed_bytes": needed,
                "already_have_bytes": shared,
                "components": missing.iter().map(|c| json!({
                    "role": c.role, "bytes": c.bytes, "quant": c.quant
                })).collect::<Vec<_>>()}),
    )
    .await?;

    // Before the first byte, not as the disk fills.
    store.check_space_for(needed)?;

    if missing.is_empty() && store.is_installed(&model.name, &variant.tag) {
        return write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "msg": "already installed"}),
        )
        .await;
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("cantor/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to build an HTTP client")?;

    let mut completed: u64 = 0;
    for component in &missing {
        let role = component.role.clone();
        let mut last_report = 0_u64;
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<(u64, u64)>();
        let fetch = store.fetch(&client, component, move |done, total| {
            // Throttled to whole percent so a slow link does not drown the
            // socket in frames nobody can read.
            let step = total / 100 + 1;
            if done >= last_report + step || done == total {
                last_report = done;
                let _ = progress_tx.send((done, total));
            }
        });
        tokio::pin!(fetch);
        loop {
            tokio::select! {
                Some((done, total)) = progress_rx.recv() => {
                    write_line(writer, &json!({
                        "v": CONTROL_VERSION, "id": id, "t": "progress",
                        "role": role, "done": done, "total": total,
                        "overall_done": completed + done,
                        "overall_total": needed
                    })).await?;
                }
                result = &mut fetch => {
                    result?;
                    break;
                }
            }
        }
        completed += component.bytes;
    }

    // Only now does the variant count as installed.
    store.mark_installed(model, variant)?;
    let _ = events.try_send(NodeEvent::NodeInfoChanged);

    // A model with no engine cannot run, so pulling one fetches the backend it
    // needs. Best-effort: the weights are installed either way, and a failure
    // here is reported rather than losing a multi-gigabyte download.
    let engine_name = model.engine().to_owned();
    let engine_store = EngineStore::new(&plan.store_root);
    let arch = machine_arch();
    let wanted = plan
        .backend
        .clone()
        .or_else(|| accel::candidates().first().map(|a| a.backend.clone()));
    if let Some(backend) = wanted {
        match BackendManifest::fetch(&plan.backends_url).await {
            Ok(manifest) => match manifest.find(&engine_name, &backend, arch) {
                Some(artifact) if !engine_store.is_installed(artifact).unwrap_or(false) => {
                    write_line(
                        writer,
                        &json!({"v": CONTROL_VERSION, "id": id, "t": "note",
                                "msg": format!("fetching the {backend} engine for {engine_name}")}),
                    )
                    .await?;
                    let mut last = 0_u64;
                    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<(u64, u64)>();
                    let fetch = engine_store.install(&client, artifact, move |done, total| {
                        let step = total / 25 + 1;
                        if done >= last + step || done == total {
                            last = done;
                            let _ = progress_tx.send((done, total));
                        }
                    });
                    tokio::pin!(fetch);
                    loop {
                        tokio::select! {
                            Some((done, total)) = progress_rx.recv() => {
                                write_line(writer, &json!({
                                    "v": CONTROL_VERSION, "id": id, "t": "progress",
                                    "role": backend, "done": done, "total": total,
                                    "overall_done": done, "overall_total": total
                                })).await?;
                            }
                            result = &mut fetch => { result?; break; }
                        }
                    }
                }
                Some(_) => {}
                None => {
                    write_line(
                        writer,
                        &json!({"v": CONTROL_VERSION, "id": id, "t": "note",
                                "msg": format!("no {backend} engine published for {engine_name} on {arch}; run `cantor backends --use <other>`")}),
                    )
                    .await?;
                }
            },
            Err(error) => {
                write_line(
                    writer,
                    &json!({"v": CONTROL_VERSION, "id": id, "t": "note",
                            "msg": format!("could not check for an engine: {error:#}")}),
                )
                .await?;
            }
        }
    }

    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok",
                "msg": format!("installed {}:{} ({})", model.name, variant.tag,
                               human_bytes(variant.total_bytes()))}),
    )
    .await
}

fn dispatch(line: &str, state: &SharedState, events: &mpsc::Sender<NodeEvent>) -> Response {
    let fallback_id = serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();

    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return Response::error(fallback_id, "invalid-request", error.to_string());
        }
    };

    match handle(request, state, events) {
        Ok(response) => response,
        Err(error) => Response::error(fallback_id, "failed", format!("{error:#}")),
    }
}

fn handle(
    request: Request,
    state: &SharedState,
    events: &mpsc::Sender<NodeEvent>,
) -> Result<Response> {
    let mut state = state
        .lock()
        .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;

    match request {
        Request::Status { v, id } => {
            reject_version(v, &id)?;
            if state.pair_offer.as_ref().is_some_and(PairOffer::is_expired) {
                state.pair_offer = None;
            }
            Ok(Response::Status {
                v: CONTROL_VERSION,
                id,
                name: state.config.name.clone(),
                pubkey: state.node_public_key.clone(),
                relay_url: state.config.relay_url.clone(),
                connected: state.connected,
                pairings: state.config.pairings.len(),
                pair_expires_in: state
                    .pair_offer
                    .as_ref()
                    .map(|offer| offer.remaining().as_secs()),
            })
        }
        Request::Pair { v, id, expires_in } => {
            reject_version(v, &id)?;
            let ttl = expires_in.map_or(DEFAULT_PAIR_TTL, Duration::from_secs);
            let token = new_pair_token()?;
            let uri = pairing_uri(
                &state.config,
                &state.node_public_key,
                &token,
                state.transport_identity.descriptor(),
            )?;
            state.pair_offer = Some(PairOffer::new(token, ttl));
            Ok(Response::Pair {
                v: CONTROL_VERSION,
                id,
                uri: uri.to_string(),
                expires_in: ttl.as_secs(),
            })
        }
        Request::Pairings { v, id } => {
            reject_version(v, &id)?;
            Ok(Response::Pairings {
                v: CONTROL_VERSION,
                id,
                pairings: state.config.pairings.clone(),
            })
        }
        Request::Revoke { v, id, selector } => {
            reject_version(v, &id)?;
            let key = state.config.resolve_pairing(&selector)?;
            let principal_id = bs58::decode(&key)
                .into_vec()
                .ok()
                .and_then(|decoded| <[u8; 32]>::try_from(decoded).ok())
                .map(|key_bytes| PrincipalId::from_client_public_key(&key_bytes));
            let config_path = state.config_path.clone();
            if !state.config.revoke_key(&config_path, &key)? {
                bail!("no pairing matches {selector}");
            }
            if let Some(principal_id) = principal_id {
                state.library.hold_principal_jobs(principal_id)?;
                if let Some(active) = state
                    .active_job
                    .as_ref()
                    .filter(|active| active.principal_id == principal_id)
                {
                    crate::jobs::request_stop(&active.signal, crate::jobs::StopReason::Revoked);
                }
            }
            // Only after the file is written, so a failed write never disconnects
            // a device that is in fact still authorized.
            let _ = events.try_send(NodeEvent::Revoked(key));
            Ok(Response::Ok {
                v: CONTROL_VERSION,
                id,
            })
        }
        Request::Rename {
            v,
            id,
            selector,
            petname,
        } => {
            reject_version(v, &id)?;
            let key = state.config.resolve_pairing(&selector)?;
            let config_path = state.config_path.clone();
            state.config.rename_pairing(&config_path, &key, &petname)?;
            Ok(Response::Ok {
                v: CONTROL_VERSION,
                id,
            })
        }
        Request::List { v, id } => {
            reject_version(v, &id)?;
            let store = Store::new(state.config.model_root());
            Ok(Response::List {
                v: CONTROL_VERSION,
                id,
                installed: store.installed(),
                available_bytes: store.available_bytes().unwrap_or(0),
            })
        }
        Request::Remove { v, id, selector } => {
            reject_version(v, &id)?;
            let (model, tag) = selector
                .split_once(':')
                .context("expected a model and tag like `acestep:1.5-fast`")?;
            let store = Store::new(state.config.model_root());
            let reclaimed = store.remove(model, tag)?;
            let _ = events.try_send(NodeEvent::NodeInfoChanged);
            Ok(Response::Removed {
                v: CONTROL_VERSION,
                id,
                reclaimed_bytes: reclaimed,
            })
        }
        Request::RenameNode { v, id, name } => {
            reject_version(v, &id)?;
            let config_path = state.config_path.clone();
            state.config.rename_node(&config_path, &name)?;
            // The node's name is part of NodeInfo, so connected apps have to hear
            // about it rather than showing the old one until they reconnect.
            let _ = events.try_send(NodeEvent::NodeInfoChanged);
            Ok(Response::Ok {
                v: CONTROL_VERSION,
                id,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt, symlink};
    use std::path::PathBuf;

    use serde_json::json;
    use tempfile::tempdir;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};
    use tokio::sync::mpsc;

    use super::{
        CONTROL_GROUP, ControlEvent, MAX_REQUEST_BYTES, MAX_SOCKET_PATH_BYTES, Response,
        SOCKET_MODE_PRIVATE, SOCKET_MODE_SHARED, bind, dispatch, group_id, is_root, request,
        request_streaming, serve_connection,
    };
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};
    use crate::identity::NodeIdentity;
    use crate::principal::PrincipalId;
    use crate::runtime::{NodeState, SharedState, shared};
    use crate::secure::TransportIdentity;

    fn state() -> (SharedState, tempfile::TempDir) {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let library =
            crate::library::Library::open(temporary.path().join("library")).expect("library");
        let (identity, _) = NodeIdentity::load_or_create(&paths.key).expect("identity");
        let (transport_identity, _) =
            TransportIdentity::load_or_create(&paths.transport_key, &identity)
                .expect("transport identity");
        let state = shared(NodeState {
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
        });
        (state, temporary)
    }

    fn encode(response: &Response) -> serde_json::Value {
        serde_json::to_value(response).expect("serialize")
    }

    fn scripted_server(
        reply: &'static str,
    ) -> (tempfile::TempDir, PathBuf, tokio::task::JoinHandle<()>) {
        let temporary = tempdir().expect("temporary directory");
        let socket_path = temporary.path().join("control.sock");
        let listener = UnixListener::bind(&socket_path).expect("bind scripted server");
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept request");
            let mut stream = BufReader::new(stream);
            let mut request_line = String::new();
            stream
                .read_line(&mut request_line)
                .await
                .expect("read request");
            assert!(request_line.ends_with('\n'));
            let mut stream = stream.into_inner();
            if !reply.is_empty() {
                stream
                    .write_all(reply.as_bytes())
                    .await
                    .expect("write scripted response");
                stream.flush().await.expect("flush scripted response");
            }
        });
        (temporary, socket_path, task)
    }

    async fn next_frame(
        lines: &mut tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    ) -> serde_json::Value {
        let line = lines
            .next_line()
            .await
            .expect("read response")
            .expect("response line");
        serde_json::from_str(&line).expect("valid response JSON")
    }

    #[test]
    fn bind_refuses_to_replace_a_symlink() {
        let temporary = tempdir().expect("temporary directory");
        let socket_path = temporary.path().join("control.sock");
        symlink(temporary.path().join("elsewhere"), &socket_path).expect("create symlink");

        let error = bind(&socket_path).expect_err("symlink must be refused");

        assert!(
            error
                .to_string()
                .contains("refusing to replace symlinked control socket")
        );
        assert!(
            std::fs::symlink_metadata(&socket_path)
                .expect("symlink remains")
                .file_type()
                .is_symlink()
        );
    }

    #[tokio::test]
    async fn bind_replaces_a_stale_socket_and_sets_the_selected_mode() {
        let temporary = tempdir().expect("temporary directory");
        let socket_path = temporary.path().join("control.sock");
        let first = bind(&socket_path).expect("first bind");
        drop(first);
        assert!(
            std::fs::symlink_metadata(&socket_path)
                .expect("stale socket")
                .file_type()
                .is_socket()
        );

        let second = bind(&socket_path).expect("replace stale socket");
        let actual_mode = std::fs::metadata(&socket_path)
            .expect("socket metadata")
            .permissions()
            .mode()
            & 0o777;
        let expected_mode = if is_root() && group_id(CONTROL_GROUP).is_some() {
            SOCKET_MODE_SHARED
        } else {
            SOCKET_MODE_PRIVATE
        };

        assert_eq!(actual_mode, expected_mode);
        drop(second);
    }

    #[test]
    fn bind_rejects_a_path_at_the_kernel_bound() {
        let temporary = tempdir().expect("temporary directory");
        let prefix_bytes = temporary.path().as_os_str().as_bytes().len() + 1;
        let socket_path = temporary
            .path()
            .join("x".repeat(MAX_SOCKET_PATH_BYTES - prefix_bytes));
        assert_eq!(
            socket_path.as_os_str().as_bytes().len(),
            MAX_SOCKET_PATH_BYTES
        );

        let error = bind(&socket_path).expect_err("path at bound must be rejected");

        assert!(error.to_string().contains("the kernel limit is 107"));
        assert!(!socket_path.exists());
    }

    #[tokio::test]
    async fn one_connection_survives_malformed_and_long_request_errors() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);
        let (server, client) = UnixStream::pair().expect("socket pair");
        let server_task = tokio::spawn(serve_connection(server, state, events));
        let (reader, mut writer) = client.into_split();
        let mut lines = BufReader::new(reader).lines();
        let requests = [
            "{not json",
            r#"{"v":9,"id":"short-version","t":"status"}"#,
            r#"{"id":"missing-long-version","t":"generate"}"#,
            r#"{"v":9,"id":"wrong-long-version","t":"generate"}"#,
            r#"{"v":1,"id":"last","t":"status"}"#,
        ];
        for request in requests {
            writer
                .write_all(format!("{request}\n").as_bytes())
                .await
                .expect("write request");
        }
        writer.flush().await.expect("flush requests");

        let malformed = next_frame(&mut lines).await;
        assert_eq!(malformed["t"], "error");
        assert_eq!(malformed["code"], "invalid-request");

        let short_version = next_frame(&mut lines).await;
        assert_eq!(short_version["t"], "error");
        assert_eq!(short_version["code"], "failed");
        assert_eq!(short_version["id"], "short-version");
        assert!(
            short_version["msg"]
                .as_str()
                .expect("message")
                .contains("control protocol version 9 is not supported")
        );

        for id in ["missing-long-version", "wrong-long-version"] {
            let long_version = next_frame(&mut lines).await;
            assert_eq!(long_version["t"], "error");
            assert_eq!(long_version["code"], "failed");
            assert_eq!(long_version["id"], id);
            assert_eq!(long_version["msg"], "generate needs a caption");
        }

        let last = next_frame(&mut lines).await;
        assert_eq!(last["t"], "status");
        assert_eq!(last["id"], "last");

        writer.shutdown().await.expect("close request half");
        server_task
            .await
            .expect("server task")
            .expect("connection completes");
    }

    #[tokio::test]
    async fn request_budget_is_shared_by_the_whole_connection() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);
        let (server, client) = UnixStream::pair().expect("socket pair");
        let server_task = tokio::spawn(serve_connection(server, state, events));
        let (reader, mut writer) = client.into_split();
        let mut lines = BufReader::new(reader).lines();

        let sample = json!({
            "v": 1,
            "id": "first",
            "t": "status",
            "padding": "x",
        })
        .to_string();
        let target_line_bytes = MAX_REQUEST_BYTES as usize - 8 - 1;
        let padding_bytes = target_line_bytes - (sample.len() - 1);
        let first = json!({
            "v": 1,
            "id": "first",
            "t": "status",
            "padding": "x".repeat(padding_bytes),
        })
        .to_string();
        assert_eq!(first.len() + 1, MAX_REQUEST_BYTES as usize - 8);
        let second = json!({"v": 1, "id": "second", "t": "status"}).to_string();

        writer
            .write_all(format!("{first}\n{second}\n").as_bytes())
            .await
            .expect("write requests");
        writer.shutdown().await.expect("close request half");

        let first_response = next_frame(&mut lines).await;
        assert_eq!(first_response["t"], "status");
        assert_eq!(first_response["id"], "first");
        let truncated_response = next_frame(&mut lines).await;
        assert_eq!(truncated_response["t"], "error");
        assert_eq!(truncated_response["code"], "invalid-request");
        assert_ne!(truncated_response["id"], "second");

        server_task
            .await
            .expect("server task")
            .expect("connection completes at byte budget");
    }

    #[tokio::test]
    async fn one_shot_client_characterizes_blank_error_and_eof_responses() {
        let (_guard, path, server) = scripted_server("\n");
        let error = request(&path, &json!({"request": "blank"}))
            .await
            .expect_err("blank response must fail");
        assert!(error.to_string().contains("invalid response"));
        server.await.expect("blank server");

        let (_guard, path, server) = scripted_server(
            "{\"v\":1,\"id\":\"one\",\"t\":\"error\",\"code\":\"bad\",\"msg\":\"boom\"}\n",
        );
        let error = request(&path, &json!({"request": "error"}))
            .await
            .expect_err("error response must fail");
        assert_eq!(error.to_string(), "boom [bad]");
        server.await.expect("error server");

        let (_guard, path, server) = scripted_server("");
        let error = request(&path, &json!({"request": "eof"}))
            .await
            .expect_err("EOF must fail");
        assert_eq!(
            error.to_string(),
            "the node closed the control connection without answering"
        );
        server.await.expect("EOF server");
    }

    #[tokio::test]
    async fn streaming_client_preserves_callback_and_terminal_order() {
        let (_guard, path, server) = scripted_server(
            "{\"v\":1,\"id\":\"s\",\"t\":\"note\"}\n\
             {\"v\":1,\"id\":\"s\",\"t\":\"progress\"}\n\
             {\"v\":1,\"id\":\"s\",\"t\":\"ok\"}\n",
        );
        let mut callbacks = Vec::new();
        let terminal = request_streaming(&path, &json!({"request": "stream"}), |frame| {
            callbacks.push(frame["t"].as_str().expect("frame kind").to_owned());
        })
        .await
        .expect("stream completes");
        assert_eq!(callbacks, ["note", "progress"]);
        assert_eq!(terminal["t"], "ok");
        server.await.expect("stream server");

        let (_guard, path, server) =
            scripted_server("{\"v\":1,\"id\":\"c\",\"t\":\"catalog\",\"models\":[]}\n");
        let mut callbacks = Vec::new();
        let terminal = request_streaming(&path, &json!({"request": "catalog"}), |frame| {
            callbacks.push(frame.clone());
        })
        .await
        .expect("catalog completes");
        assert!(callbacks.is_empty());
        assert_eq!(terminal["t"], "catalog");
        server.await.expect("catalog server");

        let (_guard, path, server) = scripted_server("{\"v\":1,\"id\":\"e\",\"t\":\"note\"}\n");
        let mut callbacks = Vec::new();
        let error = request_streaming(&path, &json!({"request": "eof"}), |frame| {
            callbacks.push(frame["t"].as_str().expect("frame kind").to_owned());
        })
        .await
        .expect_err("EOF before terminal must fail");
        assert_eq!(callbacks, ["note"]);
        assert_eq!(
            error.to_string(),
            "the node closed the control connection without finishing"
        );
        server.await.expect("EOF server");
    }

    #[test]
    fn a_pair_request_creates_a_bounded_offer() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"pair","expires_in":60}).to_string(),
            &state,
            &events,
        );
        let value = encode(&response);
        assert_eq!(value["t"], "pair");
        assert_eq!(value["expires_in"], 60);
        assert!(
            value["uri"]
                .as_str()
                .expect("uri")
                .starts_with("cantor://pair?")
        );
        assert!(state.lock().expect("state").pair_offer.is_some());
    }

    /// Revoking has to disconnect a device that is currently connected, so the
    /// relay loop must be told; the config write alone is not enough.
    #[test]
    fn revoking_writes_the_config_and_signals_the_relay_loop() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);
        {
            let mut locked = state.lock().expect("state");
            let path = locked.config_path.clone();
            locked
                .config
                .authorize_key(&path, "device-key", Some("Phone".to_owned()))
                .expect("authorize");
        }

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"revoke","selector":"Phone"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        assert!(
            !state
                .lock()
                .expect("state")
                .config
                .is_authorized("device-key")
        );
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::Revoked(key) if key == "device-key"
        ));
    }

    #[test]
    fn revoking_a_real_principal_holds_its_queued_work() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);
        let public_key_bytes = [7_u8; 32];
        let public_key = bs58::encode(public_key_bytes).into_string();
        let principal = PrincipalId::from_client_public_key(&public_key_bytes);
        {
            let mut locked = state.lock().expect("state");
            let path = locked.config_path.clone();
            locked
                .config
                .authorize_key(&path, &public_key, Some("Phone".to_owned()))
                .expect("authorize");
            let variant = crate::store::InstalledVariant {
                model: "acestep".into(),
                tag: "1.5-fast".into(),
                licence: String::new(),
                components: vec![crate::catalog::Component {
                    role: "model".into(),
                    blob: format!("sha256:{}", "a".repeat(64)),
                    url: "u".into(),
                    bytes: 1,
                    quant: None,
                }],
                installed_at: String::new(),
                engine: "acestep".into(),
                vram_bytes: 0,
            };
            locked
                .library
                .submit(
                    principal,
                    &public_key_bytes,
                    &crate::library::Submission {
                        client_request_id: uuid::Uuid::new_v4().to_string(),
                        model: variant.selector(),
                        generation: cantor_proto::GenerationRequest {
                            caption: "held".into(),
                            lyrics: None,
                            duration: Some(15),
                            steps: Some(1),
                            cfg: None,
                            seed: Some(7),
                        },
                    },
                    &variant,
                    20,
                    0,
                )
                .expect("submit");
        }

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"revoke","selector":"Phone"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        let locked = state.lock().expect("state");
        assert_eq!(
            locked.library.list(principal, 10).unwrap()[0].state,
            cantor_proto::JobState::Paused
        );
        drop(locked);
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::Revoked(key) if key == public_key
        ));
    }

    #[test]
    fn renaming_the_node_asks_for_a_node_info_push() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"rename-node","name":"studio"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        assert_eq!(state.lock().expect("state").config.name, "studio");
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::NodeInfoChanged
        ));
    }

    #[test]
    fn a_failed_config_write_rolls_back_state_and_emits_no_effect() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::channel(8);
        let (config_path, original_name) = {
            let locked = state.lock().expect("state");
            (locked.config_path.clone(), locked.config.name.clone())
        };
        std::fs::remove_file(&config_path).expect("remove writable config");
        std::fs::create_dir(&config_path).expect("replace config with an unwritable target");

        let response = dispatch(
            &json!({"v":1,"id":"persist","t":"rename-node","name":"must-not-stick"}).to_string(),
            &state,
            &events,
        );

        let value = encode(&response);
        assert_eq!(value["t"], "error");
        assert_eq!(value["id"], "persist");
        assert_eq!(value["code"], "failed");
        assert_eq!(state.lock().expect("state").config.name, original_name);
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn an_unknown_selector_is_an_error_rather_than_a_guess() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);

        let response = dispatch(
            &json!({"v":1,"id":"7","t":"revoke","selector":"nothing"}).to_string(),
            &state,
            &events,
        );
        let value = encode(&response);
        assert_eq!(value["t"], "error");
        assert_eq!(value["id"], "7");
    }

    #[test]
    fn a_malformed_request_does_not_kill_the_connection() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::channel(8);

        let value = encode(&dispatch("{not json", &state, &events));
        assert_eq!(value["t"], "error");
        assert_eq!(value["code"], "invalid-request");
    }
}

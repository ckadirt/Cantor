//! Catalog listing and durable model installation workflows.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::json;
use tokio::sync::mpsc;

use super::super::wire::{
    CONTROL_VERSION, Response, reject_version, write_value_line as write_line,
};
use crate::accel;
use crate::backends::{BackendManifest, EngineStore, machine_arch};
use crate::catalog::Catalog;
use crate::runtime::{NodeEvent, NodeState, SharedState};
use crate::store::{Store, human_bytes};

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

pub(super) fn list(state: &mut NodeState, v: u8, id: String) -> Result<Response> {
    reject_version(v, &id)?;
    let store = Store::new(state.config.model_root());
    Ok(Response::List {
        v: CONTROL_VERSION,
        id,
        installed: store.installed(),
        available_bytes: store.available_bytes().unwrap_or(0),
    })
}

pub(super) fn remove(
    state: &mut NodeState,
    events: &mpsc::Sender<NodeEvent>,
    v: u8,
    id: String,
    selector: String,
) -> Result<Response> {
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

pub(super) async fn run_catalog<W: tokio::io::AsyncWrite + Unpin>(
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

pub(super) async fn run_pull<W: tokio::io::AsyncWrite + Unpin>(
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

    // Re-pulling refreshes capability declarations and backend builds even
    // when every content-addressed weight is already present.

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
                Some(artifact) => {
                    write_line(
                        writer,
                        &json!({"v": CONTROL_VERSION, "id": id, "t": "note",
                                "msg": format!("preparing the {backend} engine and runtime for {engine_name}")}),
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

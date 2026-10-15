//! Backend discovery, installation, probing, and selection workflow.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use serde_json::json;
use tokio::sync::mpsc;

use super::super::wire::{CONTROL_VERSION, write_value_line as write_line};
use crate::accel;
use crate::backends::{BackendManifest, EngineStore, SUPPORTED_ABI, machine_arch};
use crate::engine;
use crate::runtime::SharedState;
use crate::store::Store;

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
        let abi = manifest
            .engine(engine)
            .map_or(SUPPORTED_ABI, |found| found.abi);
        let fetch =
            engine_store.install_engine(client, engine, abi, artifact, move |done, total| {
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

/// The backends to keep current for `family`: those this node already has a
/// build of, or, with none, the first candidate the manifest publishes. Never
/// every backend in the manifest: a CUDA build is hundreds of megabytes.
fn backends_to_update(
    store: &EngineStore,
    manifest: &BackendManifest,
    family: &str,
    candidates: &[String],
    arch: &str,
) -> Vec<String> {
    let used: Vec<String> = candidates
        .iter()
        .filter(|backend| !store.builds(family, backend, arch).is_empty())
        .cloned()
        .collect();
    if !used.is_empty() {
        return used;
    }
    candidates
        .iter()
        .find(|backend| manifest.find(family, backend, arch).is_some())
        .cloned()
        .into_iter()
        .collect()
}

/// Fetch the build the manifest names for every engine the installed models
/// need, on the backends this node uses, and record it. Nothing is loaded:
/// a running node keeps its build until it restarts, because two builds of
/// one family must never share a process (`EngineStore::choose`).
pub(super) async fn run_update<W: tokio::io::AsyncWrite + Unpin>(
    state: &SharedState,
    writer: &mut W,
    id: &str,
) -> Result<()> {
    let (store_root, backends_url, pinned) = {
        let locked = state
            .lock()
            .map_err(|_| anyhow::anyhow!("node state is poisoned"))?;
        (
            locked.config.model_root(),
            locked.config.backends_url(),
            locked.config.backend.clone(),
        )
    };
    let families = required_engines(&Store::new(&store_root));
    if families.is_empty() {
        return write_line(
            writer,
            &json!({"v": CONTROL_VERSION, "id": id, "t": "ok",
                    "msg": "no models are installed, so no engine needs updating"}),
        )
        .await;
    }
    let manifest = BackendManifest::fetch(&backends_url).await?;
    let store = EngineStore::new(&store_root);
    store.record_manifest(&manifest);
    let arch = machine_arch();
    let candidates = crate::capabilities::available_backends(pinned.as_deref());
    let client = reqwest::Client::builder()
        .user_agent(concat!("cantor/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to build an HTTP client")?;

    let mut fetched = 0;
    let mut waiting = 0;
    for family in &families {
        let abi = manifest
            .engine(family)
            .map_or(SUPPORTED_ABI, |engine| engine.abi);
        for backend in backends_to_update(&store, &manifest, family, &candidates, arch) {
            let Some(artifact) = manifest.find(family, &backend, arch) else {
                continue;
            };
            let current = store.directory_for(artifact)?;
            if !store.is_installed(artifact)? {
                let label = format!("{family} {backend}");
                let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<(u64, u64)>();
                let mut last = 0_u64;
                let fetch =
                    store.install_engine(&client, family, abi, artifact, move |done, total| {
                        let step = total / 50 + 1;
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
                                "role": label, "done": done, "total": total,
                                "overall_done": done, "overall_total": total
                            })).await?;
                        }
                        result = &mut fetch => { result?; break; }
                    }
                }
                fetched += 1;
            }
            let loaded = engine::loaded_directory(family, &backend);
            let msg = match loaded {
                Some(loaded) if loaded != current => {
                    waiting += 1;
                    format!(
                        "{family} ({backend}): the current build is ready; it runs after a restart"
                    )
                }
                _ => format!("{family} ({backend}): current"),
            };
            write_line(
                writer,
                &json!({"v": CONTROL_VERSION, "id": id, "t": "note", "msg": msg}),
            )
            .await?;
        }
    }
    let msg = match (fetched, waiting) {
        (0, 0) => "engines are current".to_owned(),
        (_, 0) => format!("fetched {fetched} engine build(s)"),
        _ => format!(
            "fetched {fetched} engine build(s); restart the node to run them (cantor restart)"
        ),
    };
    write_line(
        writer,
        &json!({"v": CONTROL_VERSION, "id": id, "t": "ok", "msg": msg,
                "restart": waiting > 0}),
    )
    .await
}

/// Reports what this machine can run and, with `install`, fetches and selects a
/// backend for real. Selection is measured: each candidate is actually loaded,
/// and the first that works wins — a GPU that is present but broken falls
/// through to the next rather than being trusted.
pub(super) async fn run_backends<W: tokio::io::AsyncWrite + Unpin>(
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

        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();
        let fetch = install_backend_for_engines(
            &manifest,
            &store,
            &engines,
            &backend,
            arch,
            &client,
            |engine, done, total| {
                let _ = progress_tx.send((engine.to_owned(), done, total));
            },
        );
        tokio::pin!(fetch);
        let installed = loop {
            tokio::select! {
                Some((engine, done, total)) = progress_rx.recv() => {
                    write_line(writer, &json!({
                        "v": CONTROL_VERSION, "id": id, "t": "progress",
                        "role": engine, "done": done, "total": total,
                        "overall_done": done, "overall_total": total,
                    })).await?;
                }
                result = &mut fetch => break result?,
            }
        };

        let mut versions = Vec::new();
        for (family, directory) in &installed {
            let selection = engine::select(&[(backend.clone(), directory.clone())])
                .with_context(|| format!("{backend} is not usable for {family}"))?;
            if selection.engine.model != *family {
                bail!(
                    "{family} archive contains the {} engine",
                    selection.engine.model
                );
            }
            versions.push(format!("{family}: {}", selection.engine.version));
        }
        let engine_version = versions.join(", ");

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
                Some(artifact) => per_engine.push((engine_name.clone(), artifact)),
                None => {
                    missing_engine = Some(engine_name.clone());
                    break;
                }
            }
        }
        match missing_engine {
            None => {
                for (engine_name, artifact) in per_engine {
                    available.push((backend.clone(), engine_name, artifact));
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
    for (backend, engine_name, artifact) in &available {
        let label = backend.clone();
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel::<(u64, u64)>();
        let mut last = 0_u64;
        let abi = manifest
            .engine(engine_name)
            .map_or(SUPPORTED_ABI, |found| found.abi);
        let fetch =
            store.install_engine(&client, engine_name, abi, artifact, move |done, total| {
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

    // Validate every required family before advertising a backend as usable.
    let mut rejected = Vec::new();
    let mut chosen = None;
    for group in attempts.chunks(engine_names.len()) {
        let result = (|| -> Result<_> {
            let mut first = None;
            for ((backend, directory), family) in group.iter().zip(&engine_names) {
                let selection = engine::select(&[(backend.clone(), directory.clone())])
                    .with_context(|| format!("{backend} is not usable for {family}"))?;
                if selection.engine.model != *family {
                    bail!(
                        "{family} archive contains the {} engine",
                        selection.engine.model
                    );
                }
                first.get_or_insert(selection.engine);
            }
            first.context("no engine to validate")
        })();
        match result {
            Ok(engine) => {
                chosen = Some(engine);
                break;
            }
            Err(error) => rejected.push((group[0].0.clone(), format!("{error:#}"))),
        }
    }
    let engine = chosen.with_context(|| format!("no backend could be validated: {rejected:?}"))?;
    let selection = engine::Selection { engine, rejected };
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::backends_to_update;
    use crate::backends::{BackendArtifact, BackendManifest, EngineStore, machine_arch};

    fn artifact(backend: &str, fill: char) -> BackendArtifact {
        BackendArtifact {
            backend: backend.into(),
            arch: machine_arch().into(),
            os: std::env::consts::OS.into(),
            url: format!("https://e.test/{backend}.tar.gz"),
            sha256: fill.to_string().repeat(64),
            bytes: 10,
        }
    }

    #[test]
    fn update_keeps_the_backends_a_node_uses_and_nothing_else() {
        let temp = tempfile::tempdir().unwrap();
        let store = EngineStore::new(temp.path());
        let cuda = artifact("cuda12", 'a');
        let cpu = artifact("cpu", 'b');
        let manifest = BackendManifest::parse(
            &serde_json::json!({"schema": 1, "engines": [{
                "name": "acestep", "abi": 1, "backends": [&cuda, &cpu],
            }]})
            .to_string(),
        )
        .unwrap();
        let candidates = vec!["cuda12".to_owned(), "cpu".to_owned()];

        // Nothing installed: the first candidate the manifest publishes.
        assert_eq!(
            backends_to_update(&store, &manifest, "acestep", &candidates, machine_arch()),
            vec!["cuda12"]
        );

        // A node on CPU stays on CPU, and is not handed a CUDA build.
        let directory = store.directory_for(&cpu).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(".complete"), &cpu.sha256).unwrap();
        store.record("acestep", 1, &cpu).unwrap();
        assert_eq!(
            backends_to_update(&store, &manifest, "acestep", &candidates, machine_arch()),
            vec!["cpu"]
        );

        // A family the manifest does not publish asks for nothing.
        assert!(
            backends_to_update(&store, &manifest, "levo2", &candidates, machine_arch()).is_empty()
        );
    }
}

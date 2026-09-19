//! Private CUDA runtime dependencies, independent of the host's CUDA toolkit.
//!
//! These are NVIDIA's unmodified redistributable archives, pinned to the
//! checksums in redistrib_12.8.1.json. Licenses remain inside each extraction.
//! Both engine families share this digest-scoped cache. Never modify PATH,
//! LD_LIBRARY_PATH, /usr/local/cuda, or the installed driver.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use libloading::Library;

use crate::backends::{BackendArtifact, EngineStore};

fn artifacts(arch: &str) -> Result<Vec<BackendArtifact>> {
    let artifacts: Vec<BackendArtifact> =
        serde_json::from_str(include_str!("cuda12-runtime.json"))?;
    let artifacts: Vec<_> = artifacts
        .into_iter()
        .filter(|a| crate::backends::arch_matches(&a.arch, arch))
        .collect();
    if artifacts.len() != 2 {
        bail!("no managed CUDA 12 runtime for {arch}");
    }
    Ok(artifacts)
}

pub(crate) async fn ensure(
    store: &EngineStore,
    client: &reqwest::Client,
    engine: &BackendArtifact,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<()> {
    if engine.backend != "cuda12" || engine.os != "linux" {
        return Ok(());
    }
    let artifacts = artifacts(&engine.arch)?;
    let total: u64 = artifacts.iter().map(|a| a.bytes).sum();
    let mut complete = 0;
    for artifact in &artifacts {
        let downloading = !store.is_installed(artifact)?;
        if downloading {
            eprintln!(
                "runtime.install backend=cuda12 component={} bytes={} (private NVIDIA runtime)",
                artifact.backend, artifact.bytes
            );
        }
        let mut reported = 0;
        store
            .install_archive(client, artifact, |done, _| {
                let percent = done.saturating_mul(100) / artifact.bytes.max(1);
                if downloading && percent >= reported + 10 {
                    eprintln!(
                        "runtime.progress component={} percent={percent}",
                        artifact.backend
                    );
                    reported = percent;
                }
                on_progress(complete + done, total)
            })
            .await
            .with_context(|| {
                format!(
                    "could not install {}; retry cantor backends --install",
                    artifact.backend
                )
            })?;
        complete += artifact.bytes;
    }
    for path in library_paths(&store.directory_for(engine)?, &engine.arch)? {
        if !path.is_file() {
            bail!("CUDA runtime archive is incomplete: {}", path.display());
        }
    }
    Ok(())
}

fn library_paths(engine_directory: &Path, arch: &str) -> Result<Vec<PathBuf>> {
    let cache = engine_directory
        .parent()
        .context("engine has no cache directory")?;
    let artifacts = artifacts(arch)?;
    let find = |component: &str| -> Result<PathBuf> {
        let artifact = artifacts
            .iter()
            .find(|a| a.backend == component)
            .context("missing CUDA runtime component")?;
        Ok(cache.join(artifact.slug()?).join("lib"))
    };
    let cudart = find("cuda12-cuda_cudart")?;
    let cublas = find("cuda12-libcublas")?;
    // cuBLAS depends on cuBLASLt. Preload in dependency order using absolute
    // paths: dlopen resolves their SONAMEs without a process-wide env change.
    Ok(vec![
        cudart.join("libcudart.so.12"),
        cublas.join("libcublasLt.so.12"),
        cublas.join("libcublas.so.12"),
    ])
}

pub(crate) fn preload(engine_directory: &Path) -> Result<Vec<Library>> {
    library_paths(engine_directory, std::env::consts::ARCH)?
        .into_iter()
        .map(|path| {
            // SAFETY: the cache contains NVIDIA archives verified before extraction.
            unsafe { Library::new(&path) }.with_context(|| {
                format!(
                    "cannot load CUDA 12 runtime {}; run cantor backends --install",
                    path.display()
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in network smoke test: downloads about 940 MB of NVIDIA archives.
    #[tokio::test]
    #[ignore = "downloads NVIDIA CUDA runtime archives"]
    #[cfg(target_os = "linux")]
    async fn nvidia_archives_download_verify_extract_and_load() {
        let temp = tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target"))
            .unwrap();
        let store = EngineStore::new(temp.path());
        let engine = BackendArtifact {
            backend: "cuda12".into(),
            arch: std::env::consts::ARCH.into(),
            os: "linux".into(),
            url: "https://unused.test/engine".into(),
            sha256: "00".repeat(32),
            bytes: 0,
        };
        let client = reqwest::Client::new();
        ensure(&store, &client, &engine, |_, _| {}).await.unwrap();
        let libraries = preload(&store.directory_for(&engine).unwrap()).unwrap();
        assert_eq!(libraries.len(), 3);
        // A second preparation must reuse the verified extraction.
        ensure(&store, &client, &engine, |_, _| {}).await.unwrap();
    }

    #[test]
    fn runtime_is_pinned_and_shared_by_engine_families() {
        for arch in ["x86_64", "aarch64"] {
            for artifact in artifacts(arch).unwrap() {
                assert!(
                    artifact
                        .url
                        .starts_with("https://developer.download.nvidia.com/compute/cuda/redist/")
                );
                artifact.digest().unwrap();
            }
            let ace = library_paths(Path::new("/models/engines/cuda12-ace"), arch).unwrap();
            let mini = library_paths(Path::new("/models/engines/cuda12-mini"), arch).unwrap();
            assert_eq!(ace, mini);
            assert_eq!(ace.len(), 3);
            assert!(ace.iter().all(|p| p.starts_with("/models/engines")));
        }
        assert!(artifacts("unsupported").is_err());
    }
}

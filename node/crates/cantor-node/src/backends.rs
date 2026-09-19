//! The published backend manifest, and the store for downloaded engines.
//!
//! A backend is an *archive of shared libraries*, not a single file: the engine
//! library sits next to the ggml runtime it links against, plus ggml's own
//! per-microarchitecture CPU dispatch libraries. So unlike a model component,
//! it is fetched, verified, and then extracted into a directory the loader
//! points at.
//!
//! Same two rules as the catalog: the schema version is pinned, and an entry
//! this build cannot understand is skipped rather than failing the whole
//! manifest.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA_VERSION: u64 = 1;
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_BACKENDS_URL: &str = "https://cantor.ckadirt.xyz/backends/v1.json";
#[cfg(target_os = "macos")]
pub const DEFAULT_BACKENDS_URL: &str =
    "https://github.com/ckadirt/Cantor/releases/latest/download/backends-macos-v1.json";
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(20);
const ENGINES_DIRECTORY: &str = "engines";

/// The ABI this build of the node knows how to call. An engine advertising
/// anything else is refused rather than loaded — the whole point of the version
/// is that a mismatch is a segfault waiting to happen.
pub const SUPPORTED_ABI: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct BackendArtifact {
    pub backend: String,
    pub arch: String,
    #[serde(default = "linux_os")]
    pub os: String,
    pub url: String,
    /// Bare 64-hex, no `sha256:` prefix — this manifest's convention differs
    /// from the catalog's, so it is normalised on read rather than assumed.
    pub sha256: String,
    #[serde(default)]
    pub bytes: u64,
}

fn linux_os() -> String {
    "linux".to_owned()
}

impl BackendArtifact {
    pub fn digest(&self) -> Result<&str> {
        let hex = self.sha256.strip_prefix("sha256:").unwrap_or(&self.sha256);
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            bail!("{} has a malformed sha256", self.url);
        }
        Ok(hex)
    }

    /// Stable identity for the extracted directory: the digest, so two
    /// manifests naming the same bytes share one extraction.
    pub fn slug(&self) -> Result<String> {
        Ok(format!(
            "{}-{}-{}",
            self.backend,
            self.arch,
            &self.digest()?[..12]
        ))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Engine {
    pub name: String,
    pub abi: u32,
    pub backends: Vec<BackendArtifact>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct BackendManifest {
    pub schema: u64,
    pub engines: Vec<Engine>,
}

impl BackendManifest {
    pub fn parse(raw: &str) -> Result<Self> {
        let root: Value = serde_json::from_str(raw).context("the manifest is not valid JSON")?;
        let schema = root
            .get("schema")
            .and_then(Value::as_u64)
            .context("the backend manifest has no schema version")?;
        if schema != SCHEMA_VERSION {
            bail!(
                "backend manifest schema {schema} is not supported (this node speaks {SCHEMA_VERSION})"
            );
        }

        let mut engines = Vec::new();
        for entry in root
            .get("engines")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            match serde_json::from_value::<Engine>(entry.clone()) {
                Ok(mut engine) => {
                    engine.backends.retain(|artifact| match artifact.digest() {
                        Ok(_) => true,
                        Err(error) => {
                            eprintln!("skipping a backend of {}: {error}", engine.name);
                            false
                        }
                    });
                    if !engine.backends.is_empty() {
                        engines.push(engine);
                    }
                }
                Err(error) => eprintln!("skipping a manifest engine: {error}"),
            }
        }
        Ok(Self { schema, engines })
    }

    pub async fn fetch(url: &str) -> Result<Self> {
        let raw = reqwest::Client::builder()
            .user_agent(concat!("cantor/", env!("CARGO_PKG_VERSION")))
            .timeout(MANIFEST_TIMEOUT)
            .build()
            .context("failed to build an HTTP client")?
            .get(url)
            .send()
            .await
            .with_context(|| format!("failed to reach the backend manifest at {url}"))?
            .error_for_status()
            .context("the backend manifest request was refused")?
            .text()
            .await
            .context("failed to read the backend manifest")?;
        Self::parse(&raw)
    }

    pub fn engine(&self, name: &str) -> Option<&Engine> {
        self.engines.iter().find(|engine| engine.name == name)
    }

    /// The artifact for a given engine, backend and this machine's architecture.
    /// The manifest says `arm64` where Rust says `aarch64`, so both spellings
    /// are accepted rather than requiring the publisher to match Rust's.
    pub fn find(&self, engine: &str, backend: &str, arch: &str) -> Option<&BackendArtifact> {
        self.find_for_os(engine, backend, arch, std::env::consts::OS)
    }

    fn find_for_os(
        &self,
        engine: &str,
        backend: &str,
        arch: &str,
        os: &str,
    ) -> Option<&BackendArtifact> {
        self.engine(engine)?.backends.iter().find(|artifact| {
            artifact.backend == backend && artifact.os == os && arch_matches(&artifact.arch, arch)
        })
    }
}

pub fn arch_matches(manifest_arch: &str, machine_arch: &str) -> bool {
    normalise_arch(manifest_arch) == normalise_arch(machine_arch)
}

fn normalise_arch(arch: &str) -> &str {
    match arch {
        "arm64" | "aarch64" | "aarch64-apple-darwin" => "aarch64",
        "amd64" | "x86_64" | "x86_64-apple-darwin" => "x86_64",
        other => other,
    }
}

pub fn machine_arch() -> &'static str {
    std::env::consts::ARCH
}

/// Where downloaded engines are unpacked. Sibling of the model store rather
/// than inside it: models and engines have independent lifecycles.
pub struct EngineStore {
    root: PathBuf,
}

impl EngineStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn prepare(&self) -> Result<()> {
        let directory = self.root.join(ENGINES_DIRECTORY);
        fs::create_dir_all(&directory)
            .with_context(|| format!("failed to create {}", directory.display()))?;
        Ok(())
    }

    pub fn directory_for(&self, artifact: &BackendArtifact) -> Result<PathBuf> {
        Ok(self.root.join(ENGINES_DIRECTORY).join(artifact.slug()?))
    }

    pub fn is_installed(&self, artifact: &BackendArtifact) -> Result<bool> {
        Ok(self.directory_for(artifact)?.join(".complete").is_file())
    }

    /// Downloads, verifies, then extracts. The `.complete` marker is written
    /// last, so an extraction killed halfway is never mistaken for a usable
    /// engine and is simply redone.
    pub async fn install(
        &self,
        client: &reqwest::Client,
        artifact: &BackendArtifact,
        mut on_progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf> {
        crate::cuda_runtime::ensure(self, client, artifact, &mut on_progress).await?;
        self.install_archive(client, artifact, on_progress).await
    }

    /// Shared verified archive cache for engines and their runtime dependencies.
    pub(crate) async fn install_archive(
        &self,
        client: &reqwest::Client,
        artifact: &BackendArtifact,
        mut on_progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf> {
        // Control requests may overlap generation preparation. Never let two
        // downloads remove each other's staging directory.
        static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _guard = INSTALL_LOCK.lock().await;
        self.prepare()?;
        let target = self.directory_for(artifact)?;
        let _file_lock = crate::process_lock::acquire(&target.with_extension("install.lock"))?;
        if self.is_installed(artifact)? {
            on_progress(artifact.bytes, artifact.bytes);
            return Ok(target);
        }

        let digest = artifact.digest()?.to_owned();
        let archive = self
            .root
            .join(ENGINES_DIRECTORY)
            .join(format!(".{digest}.tar.gz"));

        // Backend archives are tens of megabytes, not gigabytes, so this is a
        // straight download rather than the resumable machinery models use.
        let response = client
            .get(&artifact.url)
            .timeout(Duration::from_secs(1800))
            .send()
            .await
            .with_context(|| format!("failed to download {}", artifact.url))?
            .error_for_status()
            .with_context(|| format!("the server refused {}", artifact.url))?;

        let total = response.content_length().unwrap_or(artifact.bytes);
        let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
        let mut file = tokio::fs::File::create(&archive)
            .await
            .with_context(|| format!("failed to create {}", archive.display()))?;
        let mut written = 0_u64;
        let mut stream = futures_util::StreamExt::boxed(response.bytes_stream());
        while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
            let chunk = chunk.context("the backend download was interrupted")?;
            sha2::Digest::update(&mut hasher, &chunk);
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
            written += chunk.len() as u64;
            on_progress(written, total);
        }
        tokio::io::AsyncWriteExt::flush(&mut file).await?;
        drop(file);

        let actual = hex(&sha2::Digest::finalize(hasher));
        if actual != digest {
            let _ = fs::remove_file(&archive);
            bail!(
                "{} failed verification (expected sha256:{digest}, got sha256:{actual})",
                artifact.url
            );
        }

        // Extract into a temporary sibling, then rename, so a partially
        // unpacked tree is never visible under the final name.
        let staging = self
            .root
            .join(ENGINES_DIRECTORY)
            .join(format!(".staging-{digest}"));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)
            .with_context(|| format!("failed to create {}", staging.display()))?;
        extract_archive(&archive, &staging)?;
        let _ = fs::remove_file(&archive);

        // The archive contains a single top-level directory; hoist its contents
        // so the loader does not have to guess the name.
        let unwrapped = single_child_directory(&staging)?.unwrap_or_else(|| staging.clone());
        let _ = fs::remove_dir_all(&target);
        fs::rename(&unwrapped, &target)
            .with_context(|| format!("failed to install the engine into {}", target.display()))?;
        let _ = fs::remove_dir_all(&staging);

        fs::write(target.join(".complete"), artifact.sha256.as_bytes())
            .with_context(|| format!("failed to finalise {}", target.display()))?;
        Ok(target)
    }
}

/// If `root` contains exactly one directory and nothing else, return it.
fn single_child_directory(root: &Path) -> Result<Option<PathBuf>> {
    let entries: Vec<_> = fs::read_dir(root)
        .with_context(|| format!("failed to read {}", root.display()))?
        .flatten()
        .collect();
    match entries.as_slice() {
        [only] if only.path().is_dir() => Ok(Some(only.path())),
        _ => Ok(None),
    }
}

/// Shells out to `tar`. Adding a Rust tar+gzip stack for one call would be more
/// dependency than it is worth, and `tar` is present on every target here.
///
/// `-p` and no `-h`: the archive's symlinks carry the versioned SONAMEs
/// (`libggml.so.0`) that the engine library is linked against. Dereferencing
/// them produces a tree that cannot be loaded.
fn extract_archive(archive: &Path, into: &Path) -> Result<()> {
    let status = std::process::Command::new("tar")
        .arg("-xpf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .status()
        .context("failed to run tar; is it installed?")?;
    if !status.success() {
        bail!("tar failed to extract {}", archive.display());
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{BackendManifest, SUPPORTED_ABI, arch_matches};

    const SAMPLE: &str = r#"{
      "schema": 1,
      "engines": [{
        "name": "acestep",
        "abi": 1,
        "backends": [
          {"backend":"cpu","arch":"x86_64","url":"https://e.test/cpu.tar.gz","sha256":"009408e6b660f2d217cf1765e16773ca8caeb3184602dff3d02c21f82620e34b","bytes":10},
          {"backend":"cpu","arch":"arm64","url":"https://e.test/arm.tar.gz","sha256":"c323bef56930074ec28dd1f4f87212507f4dcdc41e95af22535e19756974d071","bytes":20}
        ]
      }]
    }"#;

    async fn archive_server(
        body: Vec<u8>,
        extra_length: usize,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/runtime.tar.xz", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
                assert!(request.len() < 8192);
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len() + extra_length
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.write_all(&body).await.unwrap();
        });
        (url, task)
    }

    #[tokio::test]
    async fn runtime_archives_are_verified_atomic_and_reused_under_concurrency() {
        use super::{BackendArtifact, EngineStore};
        use std::{fs, process::Command};
        let temp = tempfile::tempdir().unwrap();
        let package = temp.path().join("package");
        fs::create_dir(&package).unwrap();
        fs::write(package.join("runtime.so"), "runtime fixture").unwrap();
        let archive = temp.path().join("fixture.tar.xz");
        assert!(
            Command::new("tar")
                .arg("-cJf")
                .arg(&archive)
                .arg("-C")
                .arg(temp.path())
                .arg("package")
                .status()
                .unwrap()
                .success()
        );
        let bytes = fs::read(archive).unwrap();
        let (url, server) = archive_server(bytes.clone(), 0).await;
        let artifact = BackendArtifact {
            backend: "runtime-test".into(),
            arch: "x86_64".into(),
            os: "linux".into(),
            url,
            sha256: super::hex(&<sha2::Sha256 as sha2::Digest>::digest(&bytes)),
            bytes: bytes.len() as u64,
        };
        let store = EngineStore::new(temp.path().join("models"));
        let client = reqwest::Client::new();
        let (one, two) = tokio::join!(
            store.install_archive(&client, &artifact, |_, _| {}),
            store.install_archive(&client, &artifact, |_, _| {}),
        );
        assert_eq!(one.unwrap(), two.unwrap());
        server.await.unwrap(); // Only one HTTP request, despite two installers.
        let installed = store.directory_for(&artifact).unwrap();
        assert_eq!(
            fs::read_to_string(installed.join("runtime.so")).unwrap(),
            "runtime fixture"
        );
        assert!(store.is_installed(&artifact).unwrap());

        let (url, server) = archive_server(bytes.clone(), 0).await;
        let bad = BackendArtifact {
            url,
            sha256: "00".repeat(32),
            ..artifact.clone()
        };
        assert!(
            store
                .install_archive(&client, &bad, |_, _| {})
                .await
                .unwrap_err()
                .to_string()
                .contains("failed verification")
        );
        assert!(!store.is_installed(&bad).unwrap());
        server.await.unwrap();

        let (url, server) = archive_server(bytes, 10).await;
        let interrupted = BackendArtifact { url, ..artifact };
        let empty_store = EngineStore::new(temp.path().join("interrupted"));
        assert!(
            empty_store
                .install_archive(&client, &interrupted, |_, _| {})
                .await
                .is_err()
        );
        assert!(!empty_store.is_installed(&interrupted).unwrap());
        server.await.unwrap();
    }

    #[test]
    fn a_manifest_resolves_an_artifact_for_this_machine() {
        let manifest = BackendManifest::parse(SAMPLE).expect("parse");
        let engine = manifest.engine("acestep").expect("engine");
        assert_eq!(engine.abi, SUPPORTED_ABI);

        let found = manifest
            .find_for_os("acestep", "cpu", "x86_64", "linux")
            .expect("x86_64");
        assert!(found.url.ends_with("cpu.tar.gz"));
        assert_eq!(found.digest().expect("digest").len(), 64);
    }

    #[test]
    fn linux_and_macos_artifacts_never_cross_match() {
        let linux = BackendManifest::parse(SAMPLE).unwrap();
        assert!(
            linux
                .find_for_os("acestep", "cpu", "aarch64", "macos")
                .is_none()
        );
        let raw = SAMPLE.replace(
            "\"arch\":\"arm64\"",
            "\"os\":\"macos\",\"arch\":\"aarch64-apple-darwin\"",
        );
        let mac = BackendManifest::parse(&raw).unwrap();
        assert!(
            mac.find_for_os("acestep", "cpu", "aarch64", "linux")
                .is_none()
        );
        assert!(
            mac.find_for_os("acestep", "cpu", "aarch64", "macos")
                .is_some()
        );
    }

    /// The manifest says `arm64` where Rust's `std::env::consts::ARCH` says
    /// `aarch64`. Matching literally would silently find no backend on ARM.
    #[test]
    fn arm64_and_aarch64_are_the_same_machine() {
        assert!(arch_matches("arm64", "aarch64"));
        assert!(arch_matches("aarch64", "arm64"));
        assert!(arch_matches("amd64", "x86_64"));
        assert!(!arch_matches("arm64", "x86_64"));

        let manifest = BackendManifest::parse(SAMPLE).expect("parse");
        assert!(
            manifest
                .find_for_os("acestep", "cpu", "aarch64", "linux")
                .is_some()
        );
    }

    #[test]
    fn a_malformed_digest_drops_only_that_backend() {
        let raw = SAMPLE.replace(
            r#""sha256":"c323bef56930074ec28dd1f4f87212507f4dcdc41e95af22535e19756974d071""#,
            r#""sha256":"nope""#,
        );
        let manifest = BackendManifest::parse(&raw).expect("parse");
        assert_eq!(
            manifest.engine("acestep").expect("engine").backends.len(),
            1
        );
        assert!(
            manifest
                .find_for_os("acestep", "cpu", "x86_64", "linux")
                .is_some()
        );
    }

    #[test]
    fn a_future_schema_is_refused() {
        let raw = SAMPLE.replace("\"schema\": 1", "\"schema\": 9");
        assert!(BackendManifest::parse(&raw).is_err());
    }

    #[test]
    fn the_extracted_directory_is_stable_and_digest_scoped() {
        let manifest = BackendManifest::parse(SAMPLE).expect("parse");
        let artifact = manifest
            .find_for_os("acestep", "cpu", "x86_64", "linux")
            .expect("artifact");
        let slug = artifact.slug().expect("slug");
        assert_eq!(slug, "cpu-x86_64-009408e6b660");
        // Same bytes must always land in the same place.
        assert_eq!(slug, artifact.slug().expect("slug again"));
    }
}

//! Content-addressed blob store for model components.
//!
//! A blob's identity is its SHA-256, so two variants that share a component
//! share the file on disk and download it once. Nothing is ever visible under
//! its final name until it has been verified, and a variant counts as installed
//! only once every one of its components has landed.

use std::fs;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::catalog::{Component, Model, Variant};

const BLOBS_DIRECTORY: &str = "blobs/sha256";
const PARTIALS_DIRECTORY: &str = "partial";
const VARIANTS_DIRECTORY: &str = "variants";
const DIRECTORY_MODE: u32 = 0o755;
/// Leave the filesystem some room rather than filling it exactly. A pull that
/// fills a VPS root partition takes sshd and journald down with it.
const FREE_SPACE_MARGIN: u64 = 256 * 1024 * 1024;

/// What was installed, written only after every component verified. Keeping the
/// component list here means `cantor list` and `cantor rm` work without the
/// catalog, which matters when the network is the thing that is broken.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InstalledVariant {
    pub model: String,
    pub tag: String,
    #[serde(default)]
    pub licence: String,
    pub components: Vec<Component>,
    #[serde(default)]
    pub installed_at: String,
    /// Copied from the catalog at install time so residency can be bounded
    /// without a network round trip. Absent on records written before this
    /// field existed, which reads as "no budget" — the engine's own default.
    #[serde(default)]
    pub vram_bytes: u64,
}

impl InstalledVariant {
    pub fn selector(&self) -> String {
        format!("{}:{}", self.model, self.tag)
    }
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn prepare(&self) -> Result<()> {
        for directory in [
            self.root.join(BLOBS_DIRECTORY),
            self.root.join(PARTIALS_DIRECTORY),
            self.root.join(VARIANTS_DIRECTORY),
        ] {
            fs::create_dir_all(&directory)
                .with_context(|| format!("failed to create {}", directory.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(DIRECTORY_MODE));
            }
        }
        Ok(())
    }

    pub fn blob_dir(&self) -> PathBuf {
        self.root.join(BLOBS_DIRECTORY)
    }

    pub fn blob_path(&self, digest: &str) -> PathBuf {
        self.root.join(BLOBS_DIRECTORY).join(digest)
    }

    fn partial_path(&self, digest: &str) -> PathBuf {
        self.root
            .join(PARTIALS_DIRECTORY)
            .join(format!("{digest}.part"))
    }

    fn marker_path(&self, model: &str, tag: &str) -> PathBuf {
        // `/` cannot appear in either, and this keeps the directory flat.
        self.root
            .join(VARIANTS_DIRECTORY)
            .join(format!("{model}__{tag}.json"))
    }

    pub fn has_blob(&self, digest: &str) -> bool {
        self.blob_path(digest).is_file()
    }

    /// Only the components that are not already on disk. This is what makes a
    /// second pull cheap and what makes shared blobs download once.
    pub fn missing<'a>(&self, variant: &'a Variant) -> Result<Vec<&'a Component>> {
        let mut missing = Vec::new();
        for component in &variant.components {
            if !self.has_blob(component.digest()?) {
                missing.push(component);
            }
        }
        Ok(missing)
    }

    pub fn installed(&self) -> Vec<InstalledVariant> {
        let directory = self.root.join(VARIANTS_DIRECTORY);
        let Ok(entries) = fs::read_dir(&directory) else {
            return Vec::new();
        };
        let mut installed: Vec<InstalledVariant> = entries
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| fs::read_to_string(entry.path()).ok())
            .filter_map(|raw| serde_json::from_str(&raw).ok())
            .collect();
        installed.sort_by_key(InstalledVariant::selector);
        installed
    }

    pub fn is_installed(&self, model: &str, tag: &str) -> bool {
        self.marker_path(model, tag).is_file()
    }

    pub fn mark_installed(&self, model: &Model, variant: &Variant) -> Result<()> {
        let record = InstalledVariant {
            model: model.name.clone(),
            tag: variant.tag.clone(),
            licence: model.licence.clone(),
            components: variant.components.clone(),
            installed_at: crate::config::now_rfc3339(),
            vram_bytes: variant.needs.vram_bytes,
        };
        let path = self.marker_path(&model.name, &variant.tag);
        let encoded =
            serde_json::to_string_pretty(&record).context("failed to encode the variant record")?;
        fs::write(&path, encoded).with_context(|| format!("failed to write {}", path.display()))?;
        Ok(())
    }

    /// Removes the variant, then any blob no other installed variant still
    /// needs. The marker goes first: a half-collected variant must never look
    /// installed.
    pub fn remove(&self, model: &str, tag: &str) -> Result<u64> {
        let path = self.marker_path(model, tag);
        if !path.is_file() {
            bail!("{model}:{tag} is not installed");
        }
        fs::remove_file(&path).with_context(|| format!("failed to remove {}", path.display()))?;
        self.collect_garbage()
    }

    /// Returns the bytes reclaimed.
    pub fn collect_garbage(&self) -> Result<u64> {
        let mut wanted = std::collections::HashSet::new();
        for variant in self.installed() {
            for component in &variant.components {
                if let Ok(digest) = component.digest() {
                    wanted.insert(digest.to_owned());
                }
            }
        }

        let mut reclaimed = 0;
        let blobs = self.root.join(BLOBS_DIRECTORY);
        let Ok(entries) = fs::read_dir(&blobs) else {
            return Ok(0);
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if wanted.contains(&name) {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if fs::remove_file(entry.path()).is_ok() {
                reclaimed += size;
            }
        }
        Ok(reclaimed)
    }

    /// Free space on the filesystem holding the store, minus a safety margin.
    pub fn available_bytes(&self) -> Result<u64> {
        available_bytes(&self.root)
    }

    /// Checked before the first byte is requested, not as it runs out.
    pub fn check_space_for(&self, needed: u64) -> Result<()> {
        let available = self.available_bytes()?;
        let required = needed.saturating_add(FREE_SPACE_MARGIN);
        if available < required {
            bail!(
                "not enough free space on {}: need {} (plus a {} margin), have {}",
                self.root.display(),
                human_bytes(needed),
                human_bytes(FREE_SPACE_MARGIN),
                human_bytes(available)
            );
        }
        Ok(())
    }

    /// Downloads one component, resuming a previous attempt when possible.
    ///
    /// The partial file is the resume state: its length is how many bytes are
    /// already known-good, so an interrupted transfer continues with a `Range`
    /// request instead of starting over. Nothing lands in `blobs/` until the
    /// digest matches, so a truncated or corrupted download can never be
    /// mistaken for an installed component.
    pub async fn fetch(
        &self,
        client: &reqwest::Client,
        component: &Component,
        mut on_progress: impl FnMut(u64, u64),
    ) -> Result<()> {
        let digest = component.digest()?;
        if self.has_blob(digest) {
            on_progress(component.bytes, component.bytes);
            return Ok(());
        }

        let partial = self.partial_path(digest);
        let mut resume_from = fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
        // A partial longer than the component means the catalog changed under
        // us; the bytes on disk are not the bytes we want.
        if resume_from > component.bytes {
            let _ = fs::remove_file(&partial);
            resume_from = 0;
        }

        let mut hasher = Sha256::new();
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&partial)
            .await
            .with_context(|| format!("failed to open {}", partial.display()))?;

        // The hash has to cover the resumed prefix too, so it is replayed from
        // disk rather than recomputed by downloading it again.
        if resume_from > 0 {
            let mut existing = tokio::fs::File::open(&partial)
                .await
                .with_context(|| format!("failed to reread {}", partial.display()))?;
            let mut buffer = vec![0_u8; 1024 * 1024];
            let mut replayed = 0_u64;
            loop {
                let read = tokio::io::AsyncReadExt::read(&mut existing, &mut buffer).await?;
                if read == 0 || replayed >= resume_from {
                    break;
                }
                let take = read.min((resume_from - replayed) as usize);
                hasher.update(&buffer[..take]);
                replayed += take as u64;
            }
            file.seek(SeekFrom::Start(resume_from)).await?;
        }

        on_progress(resume_from, component.bytes);

        let mut request = client.get(&component.url);
        if resume_from > 0 {
            request = request.header("range", format!("bytes={resume_from}-"));
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("failed to download {}", component.url))?
            .error_for_status()
            .with_context(|| format!("the server refused {}", component.url))?;

        // If a resume was asked for and the server sent the whole file anyway,
        // the prefix on disk is not what follows — start clean rather than
        // splicing two different byte streams together.
        if resume_from > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            drop(file);
            let _ = fs::remove_file(&partial);
            bail!(
                "{} does not support resuming; re-run to download it from the start",
                component.url
            );
        }

        let mut written = resume_from;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("the download was interrupted")?;
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            written += chunk.len() as u64;
            on_progress(written, component.bytes);
        }
        file.flush().await?;
        file.sync_all().await?;
        drop(file);

        let actual = hex(&hasher.finalize());
        if actual != digest {
            // Keeping a partial that hashes wrong would poison every later
            // resume, so it goes.
            let _ = fs::remove_file(&partial);
            bail!(
                "{} failed verification (expected sha256:{digest}, got sha256:{actual})",
                component.url
            );
        }
        if written != component.bytes {
            let _ = fs::remove_file(&partial);
            bail!(
                "{} is {written} bytes but the catalog says {}",
                component.url,
                component.bytes
            );
        }

        // Verified, so it can take its final name. Rename is atomic, which is
        // what makes "present in blobs/" mean "complete and correct".
        fs::rename(&partial, self.blob_path(digest)).with_context(|| {
            format!("failed to install the verified blob for {}", component.role)
        })?;
        Ok(())
    }
}

/// `statvfs` is the only way to ask the filesystem this, and there is no safe
/// wrapper in std.
fn available_bytes(path: &Path) -> Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes())
        .with_context(|| format!("{} is not a valid C path", path.display()))?;
    // SAFETY: `stats` is fully initialised by a successful statvfs, and
    // `c_path` is a valid NUL-terminated string that outlives the call.
    let stats = unsafe {
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) != 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("failed to check free space on {}", path.display()));
        }
        stats.assume_init()
    };
    // Unprivileged callers get bavail, not bfree: the reserved blocks are not
    // ours to spend.
    Ok(stats.f_bavail * stats.f_frsize)
}

pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{Store, human_bytes};
    use crate::catalog::{Component, Model, Variant};

    fn component(role: &str, digest: &str, bytes: u64) -> Component {
        Component {
            role: role.to_owned(),
            blob: format!("sha256:{digest}"),
            url: format!("https://example.test/{role}"),
            bytes,
            quant: None,
        }
    }

    const A: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const B: &str = "bb11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";

    fn variant(tag: &str, digests: &[&str]) -> Variant {
        Variant {
            tag: tag.to_owned(),
            components: digests
                .iter()
                .enumerate()
                .map(|(i, d)| component(&format!("role{i}"), d, 10))
                .collect(),
            needs: Default::default(),
        }
    }

    fn model() -> Model {
        Model {
            name: "acestep".to_owned(),
            licence: "Apache-2.0".to_owned(),
            variants: Vec::new(),
        }
    }

    #[test]
    fn only_missing_components_are_reported() {
        let temporary = tempdir().expect("temp");
        let store = Store::new(temporary.path());
        store.prepare().expect("prepare");
        let variant = variant("1.5-fast", &[A, B]);

        assert_eq!(store.missing(&variant).expect("missing").len(), 2);
        std::fs::write(store.blob_path(A), b"x").expect("write blob");
        let missing = store.missing(&variant).expect("missing");
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].blob, format!("sha256:{B}"));
    }

    /// Removing one variant must not delete a blob another still needs — that
    /// is the whole point of sharing them.
    #[test]
    fn garbage_collection_keeps_blobs_another_variant_still_needs() {
        let temporary = tempdir().expect("temp");
        let store = Store::new(temporary.path());
        store.prepare().expect("prepare");
        std::fs::write(store.blob_path(A), b"shared").expect("write");
        std::fs::write(store.blob_path(B), b"only-fast").expect("write");

        store
            .mark_installed(&model(), &variant("1.5-fast", &[A, B]))
            .expect("mark fast");
        store
            .mark_installed(&model(), &variant("1.5-balanced", &[A]))
            .expect("mark balanced");
        assert_eq!(store.installed().len(), 2);

        store.remove("acestep", "1.5-fast").expect("remove");

        assert!(store.has_blob(A), "shared blob must survive");
        assert!(!store.has_blob(B), "unreferenced blob must be collected");
        assert_eq!(store.installed().len(), 1);
    }

    #[test]
    fn removing_something_not_installed_is_an_error() {
        let temporary = tempdir().expect("temp");
        let store = Store::new(temporary.path());
        store.prepare().expect("prepare");
        assert!(store.remove("acestep", "nope").is_err());
    }

    #[test]
    fn free_space_is_checked_against_a_margin() {
        let temporary = tempdir().expect("temp");
        let store = Store::new(temporary.path());
        store.prepare().expect("prepare");

        store.check_space_for(1024).expect("a kilobyte should fit");
        let error = store
            .check_space_for(u64::MAX / 2)
            .expect_err("an absurd pull must be refused before it starts");
        assert!(error.to_string().contains("not enough free space"));
    }

    #[test]
    fn byte_sizes_read_the_way_a_person_would_write_them() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(337_420_928), "321.8 MB");
        assert_eq!(human_bytes(3_030_000_000), "2.8 GB");
    }
}

//! Library-owned durable filesystem primitives.

use std::fs::{self, File};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Serialize;

const DIRECTORY_MODE: u32 = 0o700;
pub(super) const FILE_MODE: u32 = 0o600;

pub(super) fn prepare_real_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("failed to create {}", path.display()))?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("library path must be a real directory: {}", path.display());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(DIRECTORY_MODE))?;
    Ok(())
}

pub(super) fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("sidecar path has no parent")?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".sidecar.")
        .tempfile_in(parent)?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(FILE_MODE))?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), value)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

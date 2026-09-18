//! Kernel-owned lifetime locks. Files stay in place; unlinking a lock is unsafe.
use anyhow::{Context, Result, bail};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub fn acquire(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| format!("cannot open lock {}", path.display()))?;
    // SAFETY: file owns a valid descriptor; flock has no pointer arguments.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!(
            "another node or lifecycle operation owns {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        );
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    #[test]
    fn excludes_duplicates_and_recovers_when_owner_exits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock");
        let lock = super::acquire(&path).unwrap();
        assert!(super::acquire(&path).is_err());
        drop(lock);
        assert!(super::acquire(&path).is_ok());
    }
}

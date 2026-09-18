//! Local control socket path resolution and secure binding.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use tokio::net::UnixListener;

const SOCKET_DIRECTORY_MODE: u32 = 0o750;
/// Group-writable so an operator in the `cantor` group can drive the daemon.
/// World-writable would let any local user pair their own phone or revoke yours.
pub(super) const SOCKET_MODE_SHARED: u32 = 0o660;
/// A user install's socket lives under a runtime directory only that user can
/// reach, so it needs no group at all.
pub(super) const SOCKET_MODE_PRIVATE: u32 = 0o600;
pub(super) const CONTROL_GROUP: &str = "cantor";
/// `sockaddr_un.sun_path` is 108 bytes on Linux, including the terminator.
#[cfg(not(target_os = "macos"))]
pub(super) const MAX_SOCKET_PATH_BYTES: usize = 107;
#[cfg(target_os = "macos")]
pub(super) const MAX_SOCKET_PATH_BYTES: usize = 103;

const SYSTEM_SOCKET_PATH: &str = "/run/cantor/control.sock";

fn user_socket_path() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(|dir| PathBuf::from(dir).join("cantor").join("control.sock"))
        .or_else(|| {
            crate::config::NodePaths::resolve(None)
                .ok()
                .map(|paths| paths.directory.join("control.sock"))
        })
}

/// Where a daemon started by *this* process should listen: system installs run
/// as root and use `/run/cantor`, user installs use their runtime directory.
pub fn default_socket_path() -> Result<PathBuf> {
    if is_root() {
        return Ok(PathBuf::from(SYSTEM_SOCKET_PATH));
    }
    user_socket_path().context(
        "XDG_RUNTIME_DIR is not set, so the control socket path is unknown; pass --control-socket",
    )
}

/// Where a *client* should look. This cannot be decided from the caller's own
/// privileges: an operator in the `cantor` group is deliberately not root, and
/// the daemon they need to reach is the system one. So probe for a socket that
/// actually exists, preferring a user install when both are present.
pub fn client_socket_path() -> Result<PathBuf> {
    let user = user_socket_path();
    if let Some(path) = user.as_ref()
        && path.exists()
    {
        return Ok(path.clone());
    }
    if let Ok(paths) = crate::config::NodePaths::resolve(None) {
        let fallback = paths.directory.join("control.sock");
        if fallback.exists() {
            return Ok(fallback);
        }
    }
    let system = PathBuf::from(SYSTEM_SOCKET_PATH);
    if system.exists() {
        return Ok(system);
    }

    // The socket cannot be stat'ed without search permission on its directory,
    // so "not found" and "not allowed" look identical from here. If the
    // directory is there, the far likelier story is an operator who was added to
    // the group but has not logged out since — exactly what the installer warns
    // about — and telling them the node is not running sends them the wrong way.
    if let Some(directory) = system.parent()
        && directory.exists()
    {
        bail!(
            "cannot reach {SYSTEM_SOCKET_PATH}. If the node is running, you are probably not in \
             the {CONTROL_GROUP} group yet — membership only applies to new logins, so log out \
             and back in, or use sudo."
        );
    }

    match user {
        Some(path) => bail!(
            "no running node found (looked in {} and {}). Start it with `cantor start`.",
            path.display(),
            SYSTEM_SOCKET_PATH
        ),
        None => bail!(
            "no running node found (looked in {SYSTEM_SOCKET_PATH}). Start it with `cantor start`."
        ),
    }
}

pub fn running_as_root() -> bool {
    is_root()
}

pub(super) fn is_root() -> bool {
    // SAFETY: geteuid has no arguments and is available on supported Unix hosts.
    unsafe { libc::geteuid() == 0 }
}

/// Resolves a group name to a gid by reading `/etc/group`. Enough for the local
/// groups an installer creates; directory-backed groups are out of scope.
pub(super) fn group_id(name: &str) -> Option<u32> {
    let contents = fs::read_to_string("/etc/group").ok()?;
    contents.lines().find_map(|line| {
        let mut fields = line.split(':');
        let group = fields.next()?;
        let _password = fields.next()?;
        let gid = fields.next()?;
        (group == name).then(|| gid.parse().ok())?
    })
}

/// Serialize bind/rebind across configurations before inspecting a stale socket.
pub fn acquire_socket_lock(socket_path: &Path) -> Result<fs::File> {
    let parent = socket_path
        .parent()
        .context("control socket has no parent")?;
    if !parent.exists() {
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(SOCKET_DIRECTORY_MODE))?;
        if is_root()
            && let Some(gid) = group_id(CONTROL_GROUP)
        {
            std::os::unix::fs::chown(parent, None, Some(gid))?;
        }
    }
    crate::process_lock::acquire(&socket_path.with_extension("lock"))
}

/// Binds the control socket with a restrictive parent directory first, so the
/// socket is never reachable during the window between bind and chmod.
pub fn bind(socket_path: &Path) -> Result<UnixListener> {
    // The kernel's limit, not ours, and the raw error ("path must be shorter
    // than SUN_LEN") gives no hint about which path or what the bound is.
    if socket_path.as_os_str().len() >= MAX_SOCKET_PATH_BYTES {
        bail!(
            "control socket path is {} bytes; the kernel limit is {}: {}",
            socket_path.as_os_str().len(),
            MAX_SOCKET_PATH_BYTES,
            socket_path.display()
        );
    }
    let parent = socket_path
        .parent()
        .context("control socket path has no parent directory")?;
    // Only a directory this call creates gets its permissions set. Tightening a
    // pre-existing one would mean chmod'ing /tmp for `--control-socket
    // /tmp/x.sock`, which is not ours to do.
    let created_parent = !parent.exists();
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    if created_parent {
        fs::set_permissions(parent, fs::Permissions::from_mode(SOCKET_DIRECTORY_MODE))
            .with_context(|| format!("failed to restrict {}", parent.display()))?;
    }

    match fs::symlink_metadata(socket_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                bail!(
                    "refusing to replace symlinked control socket {}",
                    socket_path.display()
                );
            }
            if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
                bail!("a node is already listening at {}", socket_path.display());
            }
            if !std::os::unix::fs::FileTypeExt::is_socket(&metadata.file_type()) {
                bail!("refusing to remove non-socket {}", socket_path.display());
            }
            // A socket left behind by a killed daemon would otherwise make bind fail.
            fs::remove_file(socket_path).with_context(|| {
                format!("failed to remove stale socket {}", socket_path.display())
            })?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect {}", socket_path.display()));
        }
    }

    let listener = UnixListener::bind(socket_path)
        .with_context(|| format!("failed to bind control socket {}", socket_path.display()))?;

    let group = group_id(CONTROL_GROUP);
    let mode = if is_root() && group.is_some() {
        SOCKET_MODE_SHARED
    } else {
        SOCKET_MODE_PRIVATE
    };
    fs::set_permissions(socket_path, fs::Permissions::from_mode(mode))
        .with_context(|| format!("failed to restrict {}", socket_path.display()))?;
    if is_root()
        && let Some(gid) = group
    {
        if created_parent {
            std::os::unix::fs::chown(parent, None, Some(gid))
                .with_context(|| format!("failed to set the group on {}", parent.display()))?;
        }
        std::os::unix::fs::chown(socket_path, None, Some(gid))
            .with_context(|| format!("failed to set the group on {}", socket_path.display()))?;
    } else if is_root() {
        eprintln!(
            "warning: group {CONTROL_GROUP} does not exist, so {} is owner-only",
            socket_path.display()
        );
    }

    Ok(listener)
}

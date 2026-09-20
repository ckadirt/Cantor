//! Host supervisor integration with an unprivileged detached-process fallback.
use crate::{config::NodePaths, control, process_lock};
use anyhow::{Context, Result, bail};
use serde_json::json;
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const UNIT: &str = "cantor.service";
const LABEL: &str = "xyz.ckadirt.cantor";

/// What Linux appends to `/proc/self/exe` once the running binary's inode has
/// been unlinked.
const DELETED_MARKER: &[u8] = b" (deleted)";

/// Drops the marker Linux appends to a deleted binary's path, if it is there.
fn without_deleted_marker(path: &Path) -> Option<PathBuf> {
    path.as_os_str()
        .as_bytes()
        .strip_suffix(DELETED_MARKER)
        .map(|bytes| PathBuf::from(OsString::from_vec(bytes.to_vec())))
}

/// The binary to run the daemon from.
///
/// `cantor upgrade` renames the new release over the running one, so by the
/// time it restarts the node, this process is executing an unlinked inode and
/// `current_exe` reports `/path/to/cantor (deleted)` -- a path that cannot be
/// spawned. Stripping the marker names exactly what should run: the upgrade
/// just put the new binary there, and restarting onto it is the point of the
/// whole operation.
fn node_binary() -> Result<PathBuf> {
    binary_from_exe_path(
        std::env::current_exe().context("could not determine the running binary path")?,
    )
}

fn binary_from_exe_path(exe: PathBuf) -> Result<PathBuf> {
    if exe.exists() {
        return Ok(exe);
    }
    if let Some(replaced) = without_deleted_marker(&exe)
        && replaced.exists()
    {
        return Ok(replaced);
    }
    bail!(
        "the cantor binary is no longer at {}; reinstall it and run cantor start",
        without_deleted_marker(&exe).unwrap_or(exe).display()
    )
}

fn user_unit() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|p| p.join("systemd/user").join(UNIT))
}
pub fn system_unit_exists() -> bool {
    Path::new("/etc/systemd/system/cantor.service").exists()
}
pub fn use_user_scope() -> bool {
    (!control::running_as_root()
        && dirs::config_dir().is_some_and(|p| p.join("cantor/installation.toml").exists()))
        || user_unit().is_some_and(|p| p.exists())
        || (!system_unit_exists() && !control::running_as_root())
}
fn systemd_available() -> bool {
    if !cfg!(target_os = "linux")
        || !(if use_user_scope() {
            user_unit().is_some_and(|p| p.exists())
        } else {
            system_unit_exists()
        })
    {
        return false;
    }
    Command::new("systemctl")
        .arg(if use_user_scope() {
            "--user"
        } else {
            "--system"
        })
        .args(["show", "--property=Version"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}
fn launch_agent() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let p = dirs::home_dir()?
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"));
    p.exists().then_some(p)
}
fn launch_domain() -> String {
    // SAFETY: geteuid has no arguments.
    format!("gui/{}", unsafe { libc::geteuid() })
}
fn launchd_available() -> bool {
    launch_agent().is_some()
        && Command::new("launchctl")
            .args(["print", &launch_domain()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
}
fn systemctl(action: &str) -> Result<()> {
    let status = Command::new("systemctl")
        .arg(if use_user_scope() {
            "--user"
        } else {
            "--system"
        })
        .args([action, UNIT])
        .status()
        .context("failed to run systemctl")?;
    if !status.success() {
        bail!("systemctl {action} {UNIT} failed");
    }
    Ok(())
}
fn launchctl(action: &str) -> Result<()> {
    let domain = launch_domain();
    let target = format!("{domain}/{LABEL}");
    let loaded = Command::new("launchctl")
        .args(["print", &target])
        .output()?
        .status
        .success();
    if matches!(action, "stop" | "restart")
        && loaded
        && !Command::new("launchctl")
            .args(["bootout", &target])
            .status()?
            .success()
    {
        bail!("launchctl bootout failed");
    }
    if matches!(action, "start" | "restart") && (!loaded || action == "restart") {
        let path = launch_agent().context("launch agent is missing")?;
        if !Command::new("launchctl")
            .args(["bootstrap", &domain])
            .arg(path)
            .status()?
            .success()
        {
            bail!("launchctl bootstrap failed");
        }
    }
    Ok(())
}
async fn ready(socket: &Path) -> bool {
    tokio::time::timeout(
        Duration::from_secs(1),
        control::request(socket, &json!({"v":1,"id":"lifecycle","t":"status"})),
    )
    .await
    .is_ok_and(|r| r.is_ok_and(|v| v.get("t").and_then(|v| v.as_str()) == Some("status")))
}
fn paths(config: Option<PathBuf>, socket: Option<PathBuf>) -> Result<(NodePaths, PathBuf)> {
    let custom = config.is_some();
    let paths = NodePaths::resolve(config)?;
    let socket = match socket {
        Some(p) => p,
        None if custom => paths.directory.join("control.sock"),
        None if !control::running_as_root() => paths.directory.join("control.sock"),
        None => control::default_socket_path()?,
    };
    Ok((paths, socket))
}
async fn stop(socket: &Path) -> Result<()> {
    if !ready(socket).await {
        if std::os::unix::net::UnixStream::connect(socket).is_ok() {
            bail!("node socket is reachable but not responding; inspect cantor logs");
        }
        println!("node is not running");
        return Ok(());
    }
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        control::request(socket, &json!({"v":1,"id":"lifecycle","t":"daemon-stop"})),
    )
    .await??;
    if response.get("t").and_then(|v| v.as_str()) != Some("ok") {
        bail!("node cannot be stopped through this control socket: {response}");
    }
    for _ in 0..300 {
        if !socket.exists() {
            println!("node stopped");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("node is still shutting down; no process was forcibly killed")
}
pub async fn run_action(
    action: &str,
    config: Option<PathBuf>,
    socket: Option<PathBuf>,
) -> Result<()> {
    let managed = config.is_none() && socket.is_none();
    if managed && systemd_available() {
        systemctl(action)?;
        if action == "stop" {
            return Ok(());
        }
        return wait_ready(
            &control::client_socket_path().or_else(|_| control::default_socket_path())?,
        )
        .await;
    }
    if managed && launchd_available() {
        launchctl(action)?;
        if action == "stop" {
            return Ok(());
        }
        return wait_ready(&NodePaths::resolve(None)?.directory.join("control.sock")).await;
    }
    let (paths, socket) = paths(config, socket)?;
    paths.prepare_directory()?;
    let _operation = process_lock::acquire(&paths.directory.join("lifecycle.lock"))?;
    if matches!(action, "stop" | "restart") {
        stop(&socket).await?;
    }
    if action == "stop" {
        return Ok(());
    }
    if ready(&socket).await {
        println!("node already running");
        return Ok(());
    }
    let log_path = paths.directory.join("node.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&log_path)?;
    let mut command = Command::new(node_binary()?);
    command
        .arg("run")
        .arg("--config-dir")
        .arg(&paths.directory)
        .arg("--control-socket")
        .arg(&socket)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: setsid is async-signal-safe; no allocation or locks after fork.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().context("failed to start background node")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            bail!("node exited ({status}); see {}", log_path.display());
        }
        if ready(&socket).await {
            println!("node started; logs: {}", log_path.display());
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!(
        "node did not become ready; it may still be starting. See {}",
        log_path.display()
    )
}
async fn wait_ready(socket: &Path) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        if ready(socket).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("service did not become ready; run cantor logs")
}
pub async fn restart_after_upgrade() {
    if control::client_socket_path().is_err() {
        println!("Node is not running; use cantor start when ready.");
        return;
    }
    if let Err(error) = run_action("restart", None, None).await {
        println!("Could not restart node: {error:#}. Run: cantor restart");
    }
}
pub fn logs(lines: &str, follow: bool, config: Option<PathBuf>) -> Result<()> {
    let count: usize = lines
        .parse()
        .context("--lines must be a nonnegative integer")?;
    let mut command;
    if config.is_none() && systemd_available() {
        command = Command::new("journalctl");
        if use_user_scope() {
            command.arg("--user");
        }
        command.args(["-u", UNIT, "-n", &count.to_string()]);
        if follow {
            command.arg("-f");
        }
    } else {
        let path = NodePaths::resolve(config)?.directory.join("node.log");
        if !path.exists() {
            bail!("no log yet at {}; start the node first", path.display());
        }
        command = Command::new("tail");
        command.args(["-n", &count.to_string()]);
        if follow {
            command.arg("-f");
        }
        command.arg(path);
    }
    if !command.status()?.success() {
        bail!("log reader failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{binary_from_exe_path, without_deleted_marker};

    #[test]
    fn a_live_binary_path_is_used_as_it_is() {
        let directory = tempfile::tempdir().expect("temp dir");
        let binary = directory.path().join("cantor");
        fs::write(&binary, b"#!/bin/sh\n").expect("write binary");
        assert_eq!(
            binary_from_exe_path(binary.clone()).expect("a path"),
            binary
        );
    }

    /// The upgrade case: this process runs an unlinked inode, and the new
    /// release is already sitting at the unmarked path.
    #[test]
    fn an_upgraded_binary_is_found_without_the_deleted_marker() {
        let directory = tempfile::tempdir().expect("temp dir");
        let binary = directory.path().join("cantor");
        fs::write(&binary, b"the new release").expect("write binary");
        let reported = PathBuf::from(format!("{} (deleted)", binary.display()));

        assert_eq!(binary_from_exe_path(reported).expect("a path"), binary);
    }

    #[test]
    fn a_binary_that_is_really_gone_says_so_without_the_marker() {
        let directory = tempfile::tempdir().expect("temp dir");
        let missing = directory.path().join("cantor");
        let reported = PathBuf::from(format!("{} (deleted)", missing.display()));

        let error = binary_from_exe_path(reported).expect_err("no binary");
        let message = format!("{error:#}");
        assert!(
            message.contains(&missing.display().to_string()),
            "{message}"
        );
        assert!(!message.contains("(deleted)"), "{message}");
    }

    #[test]
    fn only_a_trailing_marker_is_stripped() {
        assert_eq!(
            without_deleted_marker(&PathBuf::from("/opt/cantor (deleted)")),
            Some(PathBuf::from("/opt/cantor"))
        );
        assert_eq!(without_deleted_marker(&PathBuf::from("/opt/cantor")), None);
        assert_eq!(
            without_deleted_marker(&PathBuf::from("/opt/a (deleted)/cantor")),
            None,
            "a directory that merely contains the words is not a marker"
        );
    }
}

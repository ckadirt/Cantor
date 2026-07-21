//! Thin wrappers over the service manager.
//!
//! systemd already owns the lifecycle; reimplementing any of it here would only
//! give an operator a second, disagreeing answer.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, Result, bail};

/// The unit both install paths write.
pub const UNIT: &str = "cantor.service";

/// Which systemd scope actually holds the unit. This cannot be read off the
/// caller's own privileges: an operator in the `cantor` group is deliberately
/// not root, and the unit they need is the system one. Prefer a user unit when
/// one exists, mirroring how the control socket is resolved.
pub fn use_user_scope() -> bool {
    let user_unit = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .map(|config| config.join("systemd").join("user").join(UNIT));
    if user_unit.is_some_and(|path| path.exists()) {
        return true;
    }
    !system_unit_exists() && !crate::control::running_as_root()
}

pub fn system_unit_exists() -> bool {
    PathBuf::from("/etc/systemd/system").join(UNIT).exists()
}

pub fn installed() -> bool {
    system_unit_exists() || use_user_scope()
}

fn systemctl(action: &str) -> Result<std::process::ExitStatus> {
    let mut command = Command::new("systemctl");
    if use_user_scope() {
        command.arg("--user");
    }
    command.args([action, UNIT]);
    command
        .status()
        .context("failed to run systemctl; is systemd available here?")
}

pub fn run_action(action: &str) -> Result<()> {
    if !systemctl(action)?.success() {
        bail!("systemctl {action} {UNIT} failed");
    }
    Ok(())
}

/// Best-effort: an upgrade that swapped the binary correctly should not report
/// failure because the restart needs privileges the caller does not have. The
/// caller is told what to run instead.
pub fn restart_after_upgrade() {
    if !installed() {
        println!("No service is installed here; restart the node yourself to pick this up.");
        return;
    }
    match systemctl("restart") {
        Ok(status) if status.success() => println!("restarted {UNIT}"),
        _ => {
            let scope = if use_user_scope() { "--user " } else { "" };
            println!("Could not restart the service. Run: systemctl {scope}restart {UNIT}");
        }
    }
}

pub fn logs(lines: &str, follow: bool) -> Result<()> {
    let mut command = Command::new("journalctl");
    if use_user_scope() {
        command.arg("--user");
    }
    command.args(["-u", UNIT, "-n", lines]);
    if follow {
        command.arg("-f");
    }
    let status = command
        .status()
        .context("failed to run journalctl; is systemd available here?")?;
    if !status.success() {
        bail!("journalctl -u {UNIT} failed");
    }
    Ok(())
}

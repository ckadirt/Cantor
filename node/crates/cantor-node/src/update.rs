//! Self-update against GitHub Releases.
//!
//! The version check hits GitHub rather than any infrastructure of ours. That
//! is deliberate: it means running a node reports nothing to us, so there is no
//! install count, no address list, and nothing to subpoena. The cost is a
//! dependency on a third party for update discovery, which is the cheaper side
//! of the trade.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const REPOSITORY: &str = "ckadirt/Cantor";
const RELEASES_API: &str = "https://api.github.com/repos/ckadirt/Cantor/releases/latest";
const BINARY_MODE: u32 = 0o755;
/// GitHub rejects API requests without one.
const USER_AGENT: &str = concat!("cantor/", env!("CARGO_PKG_VERSION"));
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// One check a day is plenty for a notice, and it keeps this off GitHub's
/// unauthenticated rate limit even on a busy machine.
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// The notice must never be what makes a command feel slow, so the refresh gets
/// a hard ceiling and gives up silently.
const NOTICE_TIMEOUT: Duration = Duration::from_secs(2);
const UPGRADE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
struct LatestRelease {
    tag_name: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct CheckCache {
    checked_at: u64,
    latest: String,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

fn cache_path() -> Option<PathBuf> {
    dirs::cache_dir().map(|dir| dir.join("cantor").join("update-check.json"))
}

/// `1.2.3` → `(1, 2, 3)`. Anything unparseable sorts as zero, so a malformed
/// tag can never claim to be newer than what is installed.
fn parse_version(value: &str) -> (u64, u64, u64) {
    let trimmed = value.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.').map(|part| {
        part.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    });
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    parse_version(candidate) > parse_version(current)
}

/// The release asset for the architecture this binary was built for. Must match
/// the names `node/install.sh` downloads and `release.yml` uploads.
fn asset_name() -> Result<String> {
    let target = match std::env::consts::ARCH {
        "x86_64" => "x86_64-unknown-linux-gnu",
        "aarch64" => "aarch64-unknown-linux-gnu",
        other => bail!("no release assets are published for {other}"),
    };
    Ok(format!("cantor-{target}"))
}

fn client(timeout: Duration) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .build()
        .context("failed to build an HTTP client")
}

async fn latest_version(timeout: Duration) -> Result<String> {
    let response = client(timeout)?
        .get(RELEASES_API)
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .context("failed to reach the GitHub releases API")?;

    // GitHub answers 404 both for a repository with no releases at all and for
    // one nobody may see. Either way "no releases published" is the useful
    // sentence; "404 Not Found" sends people looking for a typo.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("{REPOSITORY} has no published releases yet");
    }

    let release: LatestRelease = response
        .error_for_status()
        .context("the GitHub releases API refused the request")?
        .json()
        .await
        .context("the GitHub releases API sent an unexpected response")?;
    Ok(release.tag_name.trim_start_matches('v').to_owned())
}

/// Prints at most one line, from cache, and refreshes that cache at most once a
/// day. Every failure is silent: an update notice is never worth an error on an
/// unrelated command.
pub async fn print_notice_if_stale() {
    let Some(path) = cache_path() else {
        return;
    };
    let mut cache: CheckCache = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    if now_seconds().saturating_sub(cache.checked_at) >= CHECK_INTERVAL.as_secs()
        && let Ok(latest) = latest_version(NOTICE_TIMEOUT).await
    {
        cache = CheckCache {
            checked_at: now_seconds(),
            latest,
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(encoded) = serde_json::to_string(&cache) {
            let _ = fs::write(&path, encoded);
        }
    }

    if !cache.latest.is_empty() && is_newer(&cache.latest, CURRENT_VERSION) {
        eprintln!(
            "\nA newer Cantor is available ({} → {}). Run `cantor upgrade`.",
            CURRENT_VERSION, cache.latest
        );
    }
}

pub async fn upgrade(check_only: bool) -> Result<()> {
    let latest = latest_version(NOTICE_TIMEOUT * 5).await?;
    if !is_newer(&latest, CURRENT_VERSION) {
        println!("cantor {CURRENT_VERSION} is already the newest release.");
        return Ok(());
    }
    println!("cantor {CURRENT_VERSION} → {latest}");
    if check_only {
        return Ok(());
    }

    let target = std::env::current_exe().context("could not determine the running binary path")?;
    let target = fs::canonicalize(&target).unwrap_or(target);
    let directory = target
        .parent()
        .context("the running binary has no parent directory")?;

    // Replacing the binary is a rename within its directory, so what matters is
    // write permission there, not on the file. Checking up front turns a
    // half-finished download into an immediate, actionable error.
    if !directory_is_writable(directory) {
        bail!(
            "{} is not writable. Re-run as root: sudo cantor upgrade",
            directory.display()
        );
    }

    let asset = asset_name()?;
    let base = format!("https://github.com/{REPOSITORY}/releases/download/v{latest}");
    let http = client(UPGRADE_TIMEOUT)?;

    println!("downloading {asset}…");
    let binary = http
        .get(format!("{base}/{asset}"))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .with_context(|| format!("failed to download {asset}"))?
        .bytes()
        .await
        .context("failed to read the downloaded binary")?;

    let expected = http
        .get(format!("{base}/{asset}.sha256"))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .with_context(|| format!("failed to download {asset}.sha256"))?
        .text()
        .await
        .context("failed to read the published checksum")?;
    let expected = expected
        .split_whitespace()
        .next()
        .context("the published checksum is empty")?
        .to_ascii_lowercase();

    // Verified before anything is written into place: a swapped binary that
    // turns out to be wrong is not something an operator can undo remotely.
    let actual = hex(&Sha256::digest(&binary));
    if actual != expected {
        bail!(
            "the downloaded binary failed SHA-256 verification (expected {expected}, got {actual})"
        );
    }

    let mut staged = tempfile::Builder::new()
        .prefix(".cantor-upgrade.")
        .tempfile_in(directory)
        .with_context(|| format!("failed to stage the new binary in {}", directory.display()))?;
    staged
        .write_all(&binary)
        .context("failed to write the new binary")?;
    staged
        .as_file()
        .sync_all()
        .context("failed to flush the new binary")?;
    staged
        .as_file()
        .set_permissions(fs::Permissions::from_mode(BINARY_MODE))
        .context("failed to make the new binary executable")?;
    // Rename is atomic, and the running process keeps its own inode, so this is
    // safe to do to the binary currently executing this code.
    staged
        .persist(&target)
        .map_err(|error| error.error)
        .with_context(|| format!("failed to replace {}", target.display()))?;

    println!("installed cantor {latest} at {}", target.display());
    Ok(())
}

fn directory_is_writable(directory: &Path) -> bool {
    tempfile::Builder::new()
        .prefix(".cantor-write-test.")
        .tempfile_in(directory)
        .is_ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{asset_name, is_newer, parse_version};

    #[test]
    fn versions_compare_by_component_not_lexically() {
        assert!(is_newer("0.0.10", "0.0.9"));
        assert!(is_newer("0.1.0", "0.0.99"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.0.1", "0.0.1"));
        assert!(!is_newer("0.0.1", "0.0.2"));
    }

    #[test]
    fn a_leading_v_and_prerelease_suffix_are_tolerated() {
        assert_eq!(parse_version("v1.2.3"), (1, 2, 3));
        assert_eq!(parse_version("1.2.3-rc1"), (1, 2, 3));
        assert_eq!(parse_version("1.2"), (1, 2, 0));
    }

    /// A tag that cannot be parsed must never look newer than what is running,
    /// or a malformed release would nag every node into a pointless upgrade.
    #[test]
    fn an_unparseable_tag_never_looks_newer() {
        assert!(!is_newer("not-a-version", "0.0.1"));
        assert!(!is_newer("", "0.0.1"));
    }

    #[test]
    fn the_asset_name_matches_what_the_installer_downloads() {
        let name = asset_name().expect("supported architecture");
        assert!(name.starts_with("cantor-"));
        assert!(name.ends_with("-unknown-linux-gnu"));
    }
}

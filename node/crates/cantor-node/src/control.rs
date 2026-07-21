//! The daemon's local control surface.
//!
//! The daemon owns `node.toml` and the in-memory allowlist, so a CLI that wrote
//! those files behind its back would be ignored until the next restart. Every
//! command that mutates state therefore goes through this socket and is applied
//! by the process that is actually serving clients.
//!
//! The wire format is line-delimited JSON using the same `{v, id, t, …}`
//! envelope as the app protocol, so the two stay legible side by side.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use crate::config::{NodeConfig, Pairing};
use crate::pairing::{DEFAULT_PAIR_TTL, PairOffer, new_pair_token, pairing_uri};

pub const CONTROL_VERSION: u8 = 1;
const SOCKET_DIRECTORY_MODE: u32 = 0o750;
/// Group-writable so an operator in the `cantor` group can drive the daemon.
/// World-writable would let any local user pair their own phone or revoke yours.
const SOCKET_MODE_SHARED: u32 = 0o660;
/// A user install's socket lives under a runtime directory only that user can
/// reach, so it needs no group at all.
const SOCKET_MODE_PRIVATE: u32 = 0o600;
const CONTROL_GROUP: &str = "cantor";
/// A control request is local and answered from memory; anything slower than
/// this is a stuck daemon, and the CLI should say so rather than hang.
pub const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
/// `sockaddr_un.sun_path` is 108 bytes on Linux, including the terminator.
const MAX_SOCKET_PATH_BYTES: usize = 107;

/// Everything the control surface and the relay loop both touch.
pub struct NodeState {
    pub config: NodeConfig,
    pub config_path: PathBuf,
    pub node_public_key: String,
    pub pair_offer: Option<PairOffer>,
    pub connected: bool,
}

pub type SharedState = Arc<Mutex<NodeState>>;

/// Work that only the relay loop can carry out, because only it holds the live
/// client sessions.
#[derive(Clone, Debug)]
pub enum ControlEvent {
    /// Cut off any session authenticated with this key, right now.
    Revoked(String),
    /// Capabilities changed; push `node.info` to everyone authenticated.
    NodeInfoChanged,
}

pub fn shared(state: NodeState) -> SharedState {
    Arc::new(Mutex::new(state))
}

const SYSTEM_SOCKET_PATH: &str = "/run/cantor/control.sock";

fn user_socket_path() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(|dir| PathBuf::from(dir).join("cantor").join("control.sock"))
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

fn is_root() -> bool {
    // Avoids a libc dependency for the one bit of identity that is needed.
    fs::metadata("/proc/self")
        .ok()
        .map(|metadata| {
            use std::os::unix::fs::MetadataExt;
            metadata.uid() == 0
        })
        .unwrap_or(false)
}

/// Resolves a group name to a gid by reading `/etc/group`. Enough for the local
/// groups an installer creates; directory-backed groups are out of scope.
fn group_id(name: &str) -> Option<u32> {
    let contents = fs::read_to_string("/etc/group").ok()?;
    contents.lines().find_map(|line| {
        let mut fields = line.split(':');
        let group = fields.next()?;
        let _password = fields.next()?;
        let gid = fields.next()?;
        (group == name).then(|| gid.parse().ok())?
    })
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
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create {}", parent.display()))?;
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

pub async fn serve(
    listener: UnixListener,
    state: SharedState,
    events: mpsc::UnboundedSender<ControlEvent>,
) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(error) => {
                eprintln!("control socket accept failed: {error}");
                continue;
            }
        };
        let state = Arc::clone(&state);
        let events = events.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_connection(stream, state, events).await {
                eprintln!("control connection ended: {error:#}");
            }
        });
    }
}

async fn serve_connection(
    stream: UnixStream,
    state: SharedState,
    events: mpsc::UnboundedSender<ControlEvent>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader.take(MAX_REQUEST_BYTES)).lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = dispatch(&line, &state, &events);
        let mut encoded = serde_json::to_string(&response).context("failed to encode response")?;
        encoded.push('\n');
        writer.write_all(encoded.as_bytes()).await?;
        writer.flush().await?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
enum Request {
    #[serde(rename = "status")]
    Status { v: u8, id: String },
    #[serde(rename = "pair")]
    Pair {
        v: u8,
        id: String,
        #[serde(default)]
        expires_in: Option<u64>,
    },
    #[serde(rename = "pairings")]
    Pairings { v: u8, id: String },
    #[serde(rename = "revoke")]
    Revoke { v: u8, id: String, selector: String },
    #[serde(rename = "rename")]
    Rename {
        v: u8,
        id: String,
        selector: String,
        petname: String,
    },
    #[serde(rename = "rename-node")]
    RenameNode { v: u8, id: String, name: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "t")]
pub enum Response {
    #[serde(rename = "status")]
    Status {
        v: u8,
        id: String,
        name: String,
        pubkey: String,
        relay_url: String,
        connected: bool,
        pairings: usize,
        pair_expires_in: Option<u64>,
    },
    #[serde(rename = "pair")]
    Pair {
        v: u8,
        id: String,
        uri: String,
        expires_in: u64,
    },
    #[serde(rename = "pairings")]
    Pairings {
        v: u8,
        id: String,
        pairings: Vec<Pairing>,
    },
    #[serde(rename = "ok")]
    Ok { v: u8, id: String },
    #[serde(rename = "error")]
    Error {
        v: u8,
        id: String,
        code: String,
        msg: String,
    },
}

impl Response {
    fn error(id: impl Into<String>, code: &str, msg: impl Into<String>) -> Self {
        Self::Error {
            v: CONTROL_VERSION,
            id: id.into(),
            code: code.to_owned(),
            msg: msg.into(),
        }
    }
}

fn dispatch(line: &str, state: &SharedState, events: &mpsc::UnboundedSender<ControlEvent>) -> Response {
    let fallback_id = serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();

    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return Response::error(fallback_id, "invalid-request", error.to_string());
        }
    };

    match handle(request, state, events) {
        Ok(response) => response,
        Err(error) => Response::error(fallback_id, "failed", format!("{error:#}")),
    }
}

fn handle(
    request: Request,
    state: &SharedState,
    events: &mpsc::UnboundedSender<ControlEvent>,
) -> Result<Response> {
    let mut state = state.lock().map_err(|_| anyhow::anyhow!("node state is poisoned"))?;

    match request {
        Request::Status { v, id } => {
            reject_version(v, &id)?;
            if state.pair_offer.as_ref().is_some_and(PairOffer::is_expired) {
                state.pair_offer = None;
            }
            Ok(Response::Status {
                v: CONTROL_VERSION,
                id,
                name: state.config.name.clone(),
                pubkey: state.node_public_key.clone(),
                relay_url: state.config.relay_url.clone(),
                connected: state.connected,
                pairings: state.config.pairings.len(),
                pair_expires_in: state
                    .pair_offer
                    .as_ref()
                    .map(|offer| offer.remaining().as_secs()),
            })
        }
        Request::Pair { v, id, expires_in } => {
            reject_version(v, &id)?;
            let ttl = expires_in.map_or(DEFAULT_PAIR_TTL, Duration::from_secs);
            let token = new_pair_token()?;
            let uri = pairing_uri(&state.config, &state.node_public_key, &token)?;
            state.pair_offer = Some(PairOffer::new(token, ttl));
            Ok(Response::Pair {
                v: CONTROL_VERSION,
                id,
                uri: uri.to_string(),
                expires_in: ttl.as_secs(),
            })
        }
        Request::Pairings { v, id } => {
            reject_version(v, &id)?;
            Ok(Response::Pairings {
                v: CONTROL_VERSION,
                id,
                pairings: state.config.pairings.clone(),
            })
        }
        Request::Revoke { v, id, selector } => {
            reject_version(v, &id)?;
            let key = state.config.resolve_pairing(&selector)?;
            let config_path = state.config_path.clone();
            if !state.config.revoke_key(&config_path, &key)? {
                bail!("no pairing matches {selector}");
            }
            // Only after the file is written, so a failed write never disconnects
            // a device that is in fact still authorized.
            let _ = events.send(ControlEvent::Revoked(key));
            Ok(Response::Ok {
                v: CONTROL_VERSION,
                id,
            })
        }
        Request::Rename {
            v,
            id,
            selector,
            petname,
        } => {
            reject_version(v, &id)?;
            let key = state.config.resolve_pairing(&selector)?;
            let config_path = state.config_path.clone();
            state.config.rename_pairing(&config_path, &key, &petname)?;
            Ok(Response::Ok {
                v: CONTROL_VERSION,
                id,
            })
        }
        Request::RenameNode { v, id, name } => {
            reject_version(v, &id)?;
            let config_path = state.config_path.clone();
            state.config.rename_node(&config_path, &name)?;
            // The node's name is part of NodeInfo, so connected apps have to hear
            // about it rather than showing the old one until they reconnect.
            let _ = events.send(ControlEvent::NodeInfoChanged);
            Ok(Response::Ok {
                v: CONTROL_VERSION,
                id,
            })
        }
    }
}

fn reject_version(v: u8, id: &str) -> Result<()> {
    if v != CONTROL_VERSION {
        bail!("control protocol version {v} is not supported (id {id})");
    }
    Ok(())
}

/// Client half: one request, one response, used by the CLI subcommands.
pub async fn request(socket_path: &Path, request: &Value) -> Result<Value> {
    let stream = UnixStream::connect(socket_path).await.with_context(|| {
        format!(
            "could not reach the node at {}. Is it running?",
            socket_path.display()
        )
    })?;
    let (reader, mut writer) = stream.into_split();

    let mut encoded = serde_json::to_string(request).context("failed to encode request")?;
    encoded.push('\n');
    writer.write_all(encoded.as_bytes()).await?;
    writer.flush().await?;

    let mut lines = BufReader::new(reader.take(MAX_REQUEST_BYTES)).lines();
    let line = lines
        .next_line()
        .await?
        .context("the node closed the control connection without answering")?;
    let response: Value = serde_json::from_str(&line).context("the node sent an invalid response")?;

    if response.get("t").and_then(Value::as_str) == Some("error") {
        let code = response
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("error");
        let msg = response
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("the node reported an error");
        bail!("{msg} [{code}]");
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;
    use tokio::sync::mpsc;

    use super::{ControlEvent, NodeState, Response, dispatch, shared};
    use crate::config::{ConfigSeed, NodeConfig, NodePaths};

    fn state() -> (super::SharedState, tempfile::TempDir) {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("directory");
        let (config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");
        let state = shared(NodeState {
            config,
            config_path: paths.config,
            node_public_key: bs58::encode([9_u8; 32]).into_string(),
            pair_offer: None,
            connected: true,
        });
        (state, temporary)
    }

    fn encode(response: &Response) -> serde_json::Value {
        serde_json::to_value(response).expect("serialize")
    }

    #[test]
    fn a_pair_request_creates_a_bounded_offer() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::unbounded_channel();

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"pair","expires_in":60}).to_string(),
            &state,
            &events,
        );
        let value = encode(&response);
        assert_eq!(value["t"], "pair");
        assert_eq!(value["expires_in"], 60);
        assert!(
            value["uri"]
                .as_str()
                .expect("uri")
                .starts_with("cantor://pair?")
        );
        assert!(state.lock().expect("state").pair_offer.is_some());
    }

    /// Revoking has to disconnect a device that is currently connected, so the
    /// relay loop must be told; the config write alone is not enough.
    #[test]
    fn revoking_writes_the_config_and_signals_the_relay_loop() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::unbounded_channel();
        {
            let mut locked = state.lock().expect("state");
            let path = locked.config_path.clone();
            locked
                .config
                .authorize_key(&path, "device-key", Some("Phone".to_owned()))
                .expect("authorize");
        }

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"revoke","selector":"Phone"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        assert!(!state.lock().expect("state").config.is_authorized("device-key"));
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::Revoked(key) if key == "device-key"
        ));
    }

    #[test]
    fn renaming_the_node_asks_for_a_node_info_push() {
        let (state, _guard) = state();
        let (events, mut received) = mpsc::unbounded_channel();

        let response = dispatch(
            &json!({"v":1,"id":"1","t":"rename-node","name":"studio"}).to_string(),
            &state,
            &events,
        );

        assert_eq!(encode(&response)["t"], "ok");
        assert_eq!(state.lock().expect("state").config.name, "studio");
        assert!(matches!(
            received.try_recv().expect("event"),
            ControlEvent::NodeInfoChanged
        ));
    }

    #[test]
    fn an_unknown_selector_is_an_error_rather_than_a_guess() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::unbounded_channel();

        let response = dispatch(
            &json!({"v":1,"id":"7","t":"revoke","selector":"nothing"}).to_string(),
            &state,
            &events,
        );
        let value = encode(&response);
        assert_eq!(value["t"], "error");
        assert_eq!(value["id"], "7");
    }

    #[test]
    fn a_malformed_request_does_not_kill_the_connection() {
        let (state, _guard) = state();
        let (events, _rx) = mpsc::unbounded_channel();

        let value = encode(&dispatch("{not json", &state, &events));
        assert_eq!(value["t"], "error");
        assert_eq!(value["code"], "invalid-request");
    }
}

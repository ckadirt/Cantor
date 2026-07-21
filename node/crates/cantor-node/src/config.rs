use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use url::Url;

const CONFIG_DIRECTORY_MODE: u32 = 0o700;
const CONFIG_FILE_MODE: u32 = 0o600;
const DEFAULT_RELAY_URL: &str = "ws://localhost:8787";
const MAX_NODE_NAME_BYTES: usize = 64;
pub const MAX_PETNAME_BYTES: usize = 64;

#[derive(Debug)]
pub struct NodePaths {
    pub directory: PathBuf,
    pub config: PathBuf,
    pub key: PathBuf,
}

impl NodePaths {
    pub fn resolve(override_directory: Option<PathBuf>) -> Result<Self> {
        let directory = match override_directory {
            Some(directory) => directory,
            None => dirs::config_dir()
                .context("could not determine the platform config directory")?
                .join("cantor"),
        };

        Ok(Self {
            config: directory.join("node.toml"),
            key: directory.join("node.key"),
            directory,
        })
    }

    pub fn prepare_directory(&self) -> Result<()> {
        fs::create_dir_all(&self.directory).with_context(|| {
            format!(
                "failed to create config directory {}",
                self.directory.display()
            )
        })?;
        let metadata = fs::symlink_metadata(&self.directory).with_context(|| {
            format!(
                "failed to inspect config directory {}",
                self.directory.display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!(
                "config directory must be a real directory, not a symlink: {}",
                self.directory.display()
            );
        }
        fs::set_permissions(
            &self.directory,
            fs::Permissions::from_mode(CONFIG_DIRECTORY_MODE),
        )
        .with_context(|| {
            format!(
                "failed to restrict config directory {}",
                self.directory.display()
            )
        })?;
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct ConfigSeed {
    pub name: Option<String>,
    pub relay_url: Option<String>,
}

impl ConfigSeed {
    fn has_overrides(&self) -> bool {
        self.name.is_some() || self.relay_url.is_some()
    }
}

/// One paired client. `petname` and `paired_at` are optional so that records
/// folded up from the legacy `allowed_keys` array stay representable.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Pairing {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub petname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_at: Option<String>,
}

impl Pairing {
    pub fn new(key: String, petname: Option<String>, paired_at: Option<String>) -> Self {
        Self {
            key,
            petname,
            paired_at,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(from = "RawNodeConfig")]
pub struct NodeConfig {
    pub name: String,
    pub relay_url: String,
    /// Where pulled model blobs live. The installer writes it; Phase E is what
    /// starts reading it. Carried here so rewriting the file never drops it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_dir: Option<String>,
    #[serde(default)]
    pub pairings: Vec<Pairing>,
}

/// Read-side shape only. Nodes installed before pairings became records still
/// carry a flat `allowed_keys` array; it is folded into records on load and
/// never written back.
#[derive(Deserialize)]
struct RawNodeConfig {
    name: String,
    relay_url: String,
    #[serde(default)]
    model_dir: Option<String>,
    #[serde(default)]
    pairings: Vec<Pairing>,
    #[serde(default)]
    allowed_keys: Vec<String>,
}

impl From<RawNodeConfig> for NodeConfig {
    fn from(raw: RawNodeConfig) -> Self {
        let mut pairings = raw.pairings;
        for key in raw.allowed_keys {
            if !pairings.iter().any(|pairing| pairing.key == key) {
                pairings.push(Pairing::new(key, None, None));
            }
        }
        Self {
            name: raw.name,
            relay_url: raw.relay_url,
            model_dir: raw.model_dir,
            pairings,
        }
    }
}

impl NodeConfig {
    pub fn load_or_create(path: &Path, seed: ConfigSeed) -> Result<(Self, bool)> {
        if path.exists() {
            if seed.has_overrides() {
                bail!(
                    "--name and --relay-url are first-run options; edit {} instead",
                    path.display()
                );
            }
            return Ok((Self::load(path)?, false));
        }

        let had_overrides = seed.has_overrides();
        let config = Self {
            name: seed.name.unwrap_or_else(default_node_name),
            relay_url: seed
                .relay_url
                .unwrap_or_else(|| DEFAULT_RELAY_URL.to_owned()),
            model_dir: None,
            pairings: Vec::new(),
        };
        config.validate()?;

        let serialized =
            toml::to_string_pretty(&config).context("failed to serialize node config")?;
        match create_private_file(path) {
            Ok(mut file) => {
                file.write_all(serialized.as_bytes())
                    .with_context(|| format!("failed to write node config {}", path.display()))?;
                file.sync_all()
                    .with_context(|| format!("failed to sync node config {}", path.display()))?;
                Ok((config, true))
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if had_overrides {
                    bail!(
                        "node config was created concurrently; edit {} to apply first-run options",
                        path.display()
                    );
                }
                Ok((Self::load(path)?, false))
            }
            Err(error) => Err(error)
                .with_context(|| format!("failed to create node config {}", path.display())),
        }
    }

    pub fn room_url(&self, public_key: &str) -> Result<Url> {
        let mut url = Url::parse(&self.relay_url).context("relay_url is not a valid URL")?;
        let base_path = url.path().trim_end_matches('/');
        let room_path = format!("{base_path}/v1/room/{public_key}");
        url.set_path(&room_path);
        url.set_query(Some("role=node"));
        url.set_fragment(None);
        Ok(url)
    }

    pub fn is_authorized(&self, public_key: &str) -> bool {
        self.pairings.iter().any(|pairing| pairing.key == public_key)
    }

    pub fn authorize_key(
        &mut self,
        path: &Path,
        public_key: &str,
        petname: Option<String>,
    ) -> Result<bool> {
        if self.is_authorized(public_key) {
            return Ok(false);
        }

        self.pairings.push(Pairing::new(
            public_key.to_owned(),
            petname,
            Some(now_rfc3339()),
        ));
        if let Err(error) = self.save_atomically(path) {
            self.pairings.pop();
            return Err(error);
        }
        Ok(true)
    }

    fn save_atomically(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let parent = path
            .parent()
            .context("node config path has no parent directory")?;
        let serialized = toml::to_string_pretty(self).context("failed to serialize node config")?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".node.toml.")
            .tempfile_in(parent)
            .with_context(|| {
                format!("failed to create temporary config in {}", parent.display())
            })?;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(CONFIG_FILE_MODE))
            .context("failed to restrict temporary node config")?;
        temporary
            .write_all(serialized.as_bytes())
            .context("failed to write temporary node config")?;
        temporary
            .as_file()
            .sync_all()
            .context("failed to sync temporary node config")?;
        temporary
            .persist(path)
            .map_err(|error| error.error)
            .with_context(|| format!("failed to replace node config {}", path.display()))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .with_context(|| format!("failed to sync config directory {}", parent.display()))?;
        Ok(())
    }

    fn load(path: &Path) -> Result<Self> {
        reject_symlink(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(CONFIG_FILE_MODE))
            .with_context(|| format!("failed to restrict node config {}", path.display()))?;
        let source = fs::read_to_string(path)
            .with_context(|| format!("failed to read node config {}", path.display()))?;
        let config: Self = toml::from_str(&source)
            .with_context(|| format!("failed to parse node config {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || self.name.len() > MAX_NODE_NAME_BYTES
            || self.name.chars().any(char::is_control)
        {
            bail!("node name must be 1-{MAX_NODE_NAME_BYTES} bytes with no control characters");
        }

        let relay_url = Url::parse(&self.relay_url).context("relay_url is not a valid URL")?;
        if !matches!(relay_url.scheme(), "ws" | "wss") || relay_url.host().is_none() {
            bail!("relay_url must be an absolute ws:// or wss:// URL");
        }
        if relay_url.query().is_some() || relay_url.fragment().is_some() {
            bail!("relay_url must not contain a query string or fragment");
        }

        // A petname reaching this point unsanitised would be written to disk and
        // later printed to a terminal; refuse rather than persist it.
        for pairing in &self.pairings {
            if pairing
                .petname
                .as_deref()
                .is_some_and(|petname| sanitize_petname(petname).is_none())
            {
                bail!("pairing petnames must be 1-{MAX_PETNAME_BYTES} bytes with no control characters");
            }
        }
        Ok(())
    }
}

/// Petnames are attacker-supplied, persisted, and later printed to a terminal.
/// Rejecting control characters is what stops a paired device from injecting
/// ANSI escape sequences into `cantor pairings` output.
pub fn sanitize_petname(petname: &str) -> Option<String> {
    let trimmed = petname.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_PETNAME_BYTES
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    Some(trimmed.to_owned())
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
        .format(&Rfc3339)
        .unwrap_or_default()
}

fn default_node_name() -> String {
    let hostname = hostname::get().unwrap_or_default();
    let name = hostname.to_string_lossy();
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "cantor-node".to_owned()
    } else {
        trimmed.chars().take(MAX_NODE_NAME_BYTES).collect()
    }
}

fn create_private_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(CONFIG_FILE_MODE)
        .open(path)
}

pub fn reject_symlink(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect {}", path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("refusing to use symlink at {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::tempdir;

    use super::{ConfigSeed, NodeConfig, NodePaths};

    #[test]
    fn first_run_creates_owner_only_config_and_reloads_it() {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("prepare directory");

        let seed = ConfigSeed {
            name: Some("cesar-desktop".to_owned()),
            relay_url: Some("ws://localhost:8787".to_owned()),
        };
        let (created, was_created) =
            NodeConfig::load_or_create(&paths.config, seed).expect("create config");

        assert!(was_created);
        assert_eq!(created.name, "cesar-desktop");
        assert!(created.pairings.is_empty());
        let mode = std::fs::metadata(&paths.config)
            .expect("config metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);

        let (loaded, was_created) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default())
                .expect("reload config");
        assert!(!was_created);
        assert_eq!(loaded.name, created.name);
        assert_eq!(loaded.relay_url, created.relay_url);

        let override_error = NodeConfig::load_or_create(
            &paths.config,
            ConfigSeed {
                name: Some("different-name".to_owned()),
                relay_url: None,
            },
        )
        .expect_err("existing config must reject first-run overrides");
        assert!(override_error.to_string().contains("first-run options"));
    }

    #[test]
    fn room_url_preserves_a_configured_base_path() {
        let config = NodeConfig {
            name: "node".to_owned(),
            relay_url: "wss://example.test/cantor/".to_owned(),
            model_dir: None,
            pairings: Vec::new(),
        };

        assert_eq!(
            config.room_url("public-key").expect("room URL").as_str(),
            "wss://example.test/cantor/v1/room/public-key?role=node"
        );
    }

    #[test]
    fn authorizing_a_key_is_atomic_and_idempotent() {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("prepare directory");
        let (mut config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("config");

        assert!(
            config
                .authorize_key(&paths.config, "client-key", Some("Redmi Note 11".to_owned()))
                .expect("authorize")
        );
        assert!(
            !config
                .authorize_key(&paths.config, "client-key", Some("second try".to_owned()))
                .expect("idempotent")
        );

        let (reloaded, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("reload");
        assert_eq!(reloaded.pairings.len(), 1);
        assert_eq!(reloaded.pairings[0].key, "client-key");
        assert_eq!(reloaded.pairings[0].petname.as_deref(), Some("Redmi Note 11"));
        assert!(
            reloaded.pairings[0]
                .paired_at
                .as_deref()
                .is_some_and(|stamp| stamp.ends_with('Z') && stamp.contains('T'))
        );
    }

    /// Nodes installed before pairings became records must keep working, and
    /// must be rewritten in the new form the first time anything is written.
    #[test]
    fn a_legacy_allowed_keys_config_loads_and_is_rewritten_as_records() {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("prepare directory");
        std::fs::write(
            &paths.config,
            "name = \"legacy\"\nrelay_url = \"ws://localhost:8787\"\nallowed_keys = [\"old-key\"]\n",
        )
        .expect("write legacy config");

        let (mut config, was_created) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("load legacy");
        assert!(!was_created);
        assert!(config.is_authorized("old-key"));
        assert_eq!(config.pairings[0].petname, None);
        assert_eq!(config.pairings[0].paired_at, None);

        config
            .authorize_key(&paths.config, "new-key", Some("Phone".to_owned()))
            .expect("authorize");

        let rewritten = std::fs::read_to_string(&paths.config).expect("read config");
        assert!(rewritten.contains("[[pairings]]"));
        assert!(!rewritten.contains("allowed_keys"));

        let (reloaded, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("reload");
        assert!(reloaded.is_authorized("old-key"));
        assert!(reloaded.is_authorized("new-key"));
    }

    /// The installer writes `model_dir` and nothing reads it until Phase E, so
    /// a pairing rewrite in between must not quietly drop it.
    #[test]
    fn a_model_dir_written_by_the_installer_survives_a_pairing() {
        let temporary = tempdir().expect("temporary directory");
        let paths = NodePaths::resolve(Some(temporary.path().join("cantor"))).expect("paths");
        paths.prepare_directory().expect("prepare directory");
        std::fs::write(
            &paths.config,
            "name = \"n\"\nrelay_url = \"ws://localhost:8787\"\nmodel_dir = \"/var/lib/cantor/models\"\npairings = []\n",
        )
        .expect("write config");

        let (mut config, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("load");
        assert_eq!(config.model_dir.as_deref(), Some("/var/lib/cantor/models"));
        config
            .authorize_key(&paths.config, "key", None)
            .expect("authorize");

        let (reloaded, _) =
            NodeConfig::load_or_create(&paths.config, ConfigSeed::default()).expect("reload");
        assert_eq!(reloaded.model_dir.as_deref(), Some("/var/lib/cantor/models"));
    }

    #[test]
    fn petnames_with_control_characters_or_excess_length_are_refused() {
        assert_eq!(
            super::sanitize_petname("  Redmi Note 11  ").as_deref(),
            Some("Redmi Note 11")
        );
        assert_eq!(super::sanitize_petname("   "), None);
        assert_eq!(super::sanitize_petname("evil\u{1b}[2Kname"), None);
        assert_eq!(super::sanitize_petname("wrapped\nname"), None);
        assert_eq!(super::sanitize_petname(&"x".repeat(65)), None);
        assert_eq!(
            super::sanitize_petname(&"x".repeat(64)).as_deref(),
            Some("x".repeat(64).as_str())
        );
    }
}

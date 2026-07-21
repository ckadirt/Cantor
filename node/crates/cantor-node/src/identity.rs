use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

use anyhow::{Context, Result, bail};
use ed25519_dalek::{Signature, Signer, SigningKey};
use zeroize::Zeroizing;

use crate::config::reject_symlink;

const ED25519_SECRET_BYTES: usize = 32;
const KEY_FILE_MODE: u32 = 0o600;

pub struct NodeIdentity {
    signing_key: SigningKey,
}

impl NodeIdentity {
    pub fn load_or_create(path: &Path) -> Result<(Self, bool)> {
        if path.exists() {
            return Ok((Self::load(path)?, false));
        }

        let mut secret = Zeroizing::new([0_u8; ED25519_SECRET_BYTES]);
        getrandom::fill(&mut secret[..]).context("failed to obtain operating-system randomness")?;

        match create_key_file(path) {
            Ok(mut file) => {
                file.write_all(&secret[..])
                    .with_context(|| format!("failed to write node key {}", path.display()))?;
                file.sync_all()
                    .with_context(|| format!("failed to sync node key {}", path.display()))?;
                let signing_key = SigningKey::from_bytes(&secret);
                Ok((Self { signing_key }, true))
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Ok((Self::load(path)?, false))
            }
            Err(error) => {
                Err(error).with_context(|| format!("failed to create node key {}", path.display()))
            }
        }
    }

    pub fn public_key_base58(&self) -> String {
        bs58::encode(self.signing_key.verifying_key().as_bytes()).into_string()
    }

    pub fn public_key_bytes(&self) -> [u8; ED25519_SECRET_BYTES] {
        self.signing_key.verifying_key().to_bytes()
    }

    pub fn sign(&self, message: &[u8]) -> Signature {
        self.signing_key.sign(message)
    }

    fn load(path: &Path) -> Result<Self> {
        reject_symlink(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(KEY_FILE_MODE))
            .with_context(|| format!("failed to restrict node key {}", path.display()))?;

        let bytes = Zeroizing::new(
            fs::read(path)
                .with_context(|| format!("failed to read node key {}", path.display()))?,
        );
        if bytes.len() != ED25519_SECRET_BYTES {
            bail!(
                "node key {} must contain exactly {ED25519_SECRET_BYTES} bytes",
                path.display()
            );
        }

        let mut secret = Zeroizing::new([0_u8; ED25519_SECRET_BYTES]);
        secret.copy_from_slice(&bytes);
        let signing_key = SigningKey::from_bytes(&secret);
        Ok(Self { signing_key })
    }
}

fn create_key_file(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(KEY_FILE_MODE)
        .open(path)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::tempdir;

    use super::NodeIdentity;

    #[test]
    fn first_run_creates_owner_only_stable_identity() {
        let temporary = tempdir().expect("temporary directory");
        let path = temporary.path().join("node.key");

        let (created, was_created) = NodeIdentity::load_or_create(&path).expect("create key");
        assert!(was_created);
        let public_key = created.public_key_base58();

        let metadata = std::fs::metadata(&path).expect("key metadata");
        assert_eq!(metadata.len(), 32);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);

        let (loaded, was_created) = NodeIdentity::load_or_create(&path).expect("reload key");
        assert!(!was_created);
        assert_eq!(loaded.public_key_base58(), public_key);
    }
}

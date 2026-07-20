mod config;
mod identity;
mod pairing;
mod relay;
mod session;

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use rustls::crypto::CryptoProvider;

use crate::config::{ConfigSeed, NodeConfig, NodePaths};
use crate::identity::NodeIdentity;

const USAGE: &str = "Usage:\n  cantor-node run  [--config-dir PATH] [--name NAME] [--relay-url URL]\n  cantor-node pair [--config-dir PATH] [--name NAME] [--relay-url URL]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Command {
    Run,
    Pair,
}

#[derive(Debug)]
struct Cli {
    command: Command,
    config_dir: Option<PathBuf>,
    name: Option<String>,
    relay_url: Option<String>,
}

impl Cli {
    fn parse() -> Result<Self> {
        let mut args = env::args_os().skip(1);
        let command = match args.next().as_deref() {
            Some(value) if value == OsStr::new("run") => Command::Run,
            Some(value) if value == OsStr::new("pair") => Command::Pair,
            Some(value) if value == OsStr::new("--help") => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            _ => bail!("{USAGE}"),
        };

        let mut cli = Self {
            command,
            config_dir: None,
            name: None,
            relay_url: None,
        };
        while let Some(option) = args.next() {
            match option.to_str() {
                Some("--config-dir") => {
                    cli.config_dir = Some(PathBuf::from(next_value(&mut args, "--config-dir")?));
                }
                Some("--name") => cli.name = Some(next_utf8_value(&mut args, "--name")?),
                Some("--relay-url") => {
                    cli.relay_url = Some(next_utf8_value(&mut args, "--relay-url")?);
                }
                Some("--help") => {
                    println!("{USAGE}");
                    std::process::exit(0);
                }
                Some(other) => bail!("unknown option {other}\n{USAGE}"),
                None => bail!("option names must be valid UTF-8\n{USAGE}"),
            }
        }
        Ok(cli)
    }
}

fn next_value(args: &mut impl Iterator<Item = OsString>, option: &str) -> Result<OsString> {
    args.next()
        .with_context(|| format!("{option} requires a value\n{USAGE}"))
}

fn next_utf8_value(args: &mut impl Iterator<Item = OsString>, option: &str) -> Result<String> {
    next_value(args, option)?
        .into_string()
        .map_err(|_| anyhow::anyhow!("{option} requires a UTF-8 value\n{USAGE}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    install_tls_crypto_provider()?;
    let cli = Cli::parse()?;
    let paths = NodePaths::resolve(cli.config_dir)?;
    paths.prepare_directory()?;
    let seed = ConfigSeed {
        name: cli.name,
        relay_url: cli.relay_url,
    };
    let (config, config_created) = NodeConfig::load_or_create(&paths.config, seed)?;
    let (identity, identity_created) = NodeIdentity::load_or_create(&paths.key)?;

    if config_created {
        println!("created node config at {}", paths.config.display());
    }
    if identity_created {
        println!("created node identity at {}", paths.key.display());
    }

    let pair_token = if cli.command == Command::Pair {
        let token = pairing::new_pair_token()?;
        let uri = pairing::pairing_uri(&config, &identity.public_key_base58(), &token)?;
        pairing::print_pairing_code(&uri)?;
        Some(token)
    } else {
        None
    };

    relay::run_forever(config, &paths.config, &identity, pair_token).await
}

fn install_tls_crypto_provider() -> Result<()> {
    if CryptoProvider::get_default().is_none() {
        rustls::crypto::ring::default_provider()
            .install_default()
            .map_err(|_| anyhow::anyhow!("failed to install the Rustls Ring crypto provider"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rustls::crypto::CryptoProvider;

    use super::install_tls_crypto_provider;

    #[test]
    fn installs_tls_crypto_provider() {
        install_tls_crypto_provider().expect("install TLS provider");
        assert!(CryptoProvider::get_default().is_some());
    }
}

mod config;
mod identity;
mod relay;

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};

use crate::config::{ConfigSeed, NodeConfig, NodePaths};
use crate::identity::NodeIdentity;

const USAGE: &str = "Usage: cantor-node run [--config-dir PATH] [--name NAME] [--relay-url URL]";

#[derive(Debug)]
struct Cli {
    config_dir: Option<PathBuf>,
    name: Option<String>,
    relay_url: Option<String>,
}

impl Cli {
    fn parse() -> Result<Self> {
        let mut args = env::args_os().skip(1);
        let command = args.next();
        if command.as_deref() == Some(std::ffi::OsStr::new("--help")) {
            println!("{USAGE}");
            std::process::exit(0);
        }
        if command.as_deref() != Some(std::ffi::OsStr::new("run")) {
            bail!("{USAGE}");
        }

        let mut cli = Self {
            config_dir: None,
            name: None,
            relay_url: None,
        };

        while let Some(option) = args.next() {
            match option.to_str() {
                Some("--config-dir") => {
                    cli.config_dir = Some(PathBuf::from(next_value(&mut args, "--config-dir")?));
                }
                Some("--name") => {
                    cli.name = Some(next_utf8_value(&mut args, "--name")?);
                }
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

    relay::claim_room(&config, &identity).await
}

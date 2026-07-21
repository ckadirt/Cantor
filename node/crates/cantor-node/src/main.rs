mod catalog;
mod config;
mod control;
mod identity;
mod pairing;
mod relay;
mod service;
mod session;
mod signing;
mod store;
mod update;

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use rustls::crypto::CryptoProvider;
use serde_json::{Value, json};

use crate::config::{ConfigSeed, NodeConfig, NodePaths};
use crate::control::{ControlEvent, NodeState};
use crate::identity::NodeIdentity;

const USAGE: &str = "\
Usage:
  cantor run       [--config-dir PATH] [--name NAME] [--relay-url URL]
  cantor status
  cantor pair      [--expires-in SECONDS]
  cantor pairings
  cantor revoke    <key-or-petname>
  cantor rename    <key-or-petname> <new-name>
  cantor rename    --node <new-name>
  cantor start | stop | restart
  cantor logs      [--follow] [--lines N]
  cantor pull      <model:tag>
  cantor list      [--all]
  cantor rm        <model:tag>
  cantor upgrade   [--check]

Options common to every command:
  --control-socket PATH   where the running node listens (default: per install)
  -V, --version           print the version
  -h, --help              show this message";

const DEFAULT_LOG_LINES: &str = "50";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Command_ {
    Run,
    Status,
    Pair,
    Pairings,
    Revoke,
    Rename,
    Start,
    Stop,
    Restart,
    Logs,
    Upgrade,
    Pull,
    List,
    Remove,
}

#[derive(Debug)]
struct Cli {
    command: Command_,
    config_dir: Option<PathBuf>,
    control_socket: Option<PathBuf>,
    name: Option<String>,
    relay_url: Option<String>,
    expires_in: Option<u64>,
    follow: bool,
    lines: String,
    rename_node: bool,
    check_only: bool,
    all: bool,
    positional: Vec<String>,
}

impl Cli {
    fn parse() -> Result<Self> {
        let mut args = env::args_os().skip(1);
        let command = match args.next().as_deref() {
            Some(value) if value == OsStr::new("run") => Command_::Run,
            Some(value) if value == OsStr::new("status") => Command_::Status,
            Some(value) if value == OsStr::new("pair") => Command_::Pair,
            Some(value) if value == OsStr::new("pairings") => Command_::Pairings,
            Some(value) if value == OsStr::new("revoke") => Command_::Revoke,
            Some(value) if value == OsStr::new("rename") => Command_::Rename,
            Some(value) if value == OsStr::new("start") => Command_::Start,
            Some(value) if value == OsStr::new("stop") => Command_::Stop,
            Some(value) if value == OsStr::new("restart") => Command_::Restart,
            Some(value) if value == OsStr::new("logs") => Command_::Logs,
            Some(value) if value == OsStr::new("upgrade") => Command_::Upgrade,
            Some(value) if value == OsStr::new("pull") => Command_::Pull,
            Some(value) if value == OsStr::new("list") => Command_::List,
            Some(value) if value == OsStr::new("rm") => Command_::Remove,
            Some(value) if value == OsStr::new("--version") || value == OsStr::new("-V") => {
                println!("cantor {}", update::CURRENT_VERSION);
                std::process::exit(0);
            }
            Some(value) if value == OsStr::new("--help") || value == OsStr::new("-h") => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            _ => bail!("{USAGE}"),
        };

        let mut cli = Self {
            command,
            config_dir: None,
            control_socket: None,
            name: None,
            relay_url: None,
            expires_in: None,
            follow: false,
            lines: DEFAULT_LOG_LINES.to_owned(),
            rename_node: false,
            check_only: false,
            all: false,
            positional: Vec::new(),
        };
        while let Some(option) = args.next() {
            match option.to_str() {
                Some("--config-dir") => {
                    cli.config_dir = Some(PathBuf::from(next_value(&mut args, "--config-dir")?));
                }
                Some("--control-socket") => {
                    cli.control_socket =
                        Some(PathBuf::from(next_value(&mut args, "--control-socket")?));
                }
                Some("--name") => cli.name = Some(next_utf8_value(&mut args, "--name")?),
                Some("--relay-url") => {
                    cli.relay_url = Some(next_utf8_value(&mut args, "--relay-url")?);
                }
                Some("--expires-in") => {
                    let value = next_utf8_value(&mut args, "--expires-in")?;
                    cli.expires_in =
                        Some(value.parse().with_context(|| {
                            format!("--expires-in must be a number, got {value}")
                        })?);
                }
                Some("--lines") => cli.lines = next_utf8_value(&mut args, "--lines")?,
                Some("--follow") | Some("-f") => cli.follow = true,
                Some("--node") => cli.rename_node = true,
                Some("--check") => cli.check_only = true,
                Some("--all") => cli.all = true,
                Some("--version") | Some("-V") => {
                    println!("cantor {}", update::CURRENT_VERSION);
                    std::process::exit(0);
                }
                Some("--help") | Some("-h") => {
                    println!("{USAGE}");
                    std::process::exit(0);
                }
                Some(other) if other.starts_with('-') => bail!("unknown option {other}\n{USAGE}"),
                Some(other) => cli.positional.push(other.to_owned()),
                None => bail!("arguments must be valid UTF-8\n{USAGE}"),
            }
        }
        Ok(cli)
    }

    /// Where `run` should bind.
    fn listen_path(&self) -> Result<PathBuf> {
        match &self.control_socket {
            Some(path) => Ok(path.clone()),
            None => control::default_socket_path(),
        }
    }

    /// Where a control command should connect.
    fn connect_path(&self) -> Result<PathBuf> {
        match &self.control_socket {
            Some(path) => Ok(path.clone()),
            None => control::client_socket_path(),
        }
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

    // `run` is the daemon and never nags; the notice belongs on the commands a
    // person types.
    match cli.command {
        Command_::Run => run(cli).await,
        Command_::Upgrade => update::upgrade(cli.check_only).await,
        // A pull, and `list --all`, report as they go rather than answering once.
        Command_::Pull => streaming_command(cli).await,
        Command_::List if cli.all => streaming_command(cli).await,
        Command_::Start | Command_::Stop | Command_::Restart | Command_::Logs => {
            let result = lifecycle(&cli);
            update::print_notice_if_stale().await;
            result
        }
        _ => {
            let result = talk_to_daemon(cli).await;
            update::print_notice_if_stale().await;
            result
        }
    }
}

async fn run(cli: Cli) -> Result<()> {
    let socket_path = cli.listen_path()?;
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

    let listener = control::bind(&socket_path)?;
    println!("control socket at {}", socket_path.display());

    let state = control::shared(NodeState {
        config,
        config_path: paths.config.clone(),
        node_public_key: identity.public_key_base58(),
        pair_offer: None,
        connected: false,
    });
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel::<ControlEvent>();
    tokio::spawn(control::serve(listener, state.clone(), events_tx));

    let result = relay::run_forever(state, &identity, &mut events_rx).await;
    // The socket is not reusable once this process is gone, and a stale one
    // makes the next start look like a permissions problem.
    let _ = std::fs::remove_file(&socket_path);
    result
}

async fn talk_to_daemon(cli: Cli) -> Result<()> {
    let socket_path = cli.connect_path()?;
    let id = "1";

    let request = match cli.command {
        Command_::Status => json!({"v": 1, "id": id, "t": "status"}),
        Command_::Pair => {
            let mut request = json!({"v": 1, "id": id, "t": "pair"});
            if let Some(expires_in) = cli.expires_in {
                request["expires_in"] = json!(expires_in);
            }
            request
        }
        Command_::Pairings => json!({"v": 1, "id": id, "t": "pairings"}),
        Command_::List => json!({"v": 1, "id": id, "t": "list"}),
        Command_::Remove => {
            let selector = cli
                .positional
                .first()
                .context("rm needs a model and tag, like `cantor rm acestep:1.5-fast`")?;
            json!({"v": 1, "id": id, "t": "rm", "selector": selector})
        }
        Command_::Revoke => {
            let selector = cli
                .positional
                .first()
                .context("revoke needs a key or petname\n{USAGE}")?;
            json!({"v": 1, "id": id, "t": "revoke", "selector": selector})
        }
        Command_::Rename if cli.rename_node => {
            let name = cli
                .positional
                .first()
                .context("rename --node needs a new name")?;
            json!({"v": 1, "id": id, "t": "rename-node", "name": name})
        }
        Command_::Rename => {
            let (selector, petname) = match cli.positional.as_slice() {
                [selector, petname] => (selector, petname),
                _ => bail!("rename needs a key or petname and a new name\n{USAGE}"),
            };
            json!({"v": 1, "id": id, "t": "rename", "selector": selector, "petname": petname})
        }
        other => bail!("{other:?} is not a control command"),
    };

    let response = tokio::time::timeout(
        control::CLIENT_TIMEOUT,
        control::request(&socket_path, &request),
    )
    .await
    .context("the node did not answer in time")??;

    print_response(cli.command, &response)
}

/// `pull` and `list --all` read many frames from the socket before a terminal
/// one, so they cannot use the one-shot request path.
async fn streaming_command(cli: Cli) -> Result<()> {
    let socket_path = cli.connect_path()?;
    let id = "1";
    let request = match cli.command {
        Command_::Pull => {
            let selector = cli
                .positional
                .first()
                .context("pull needs a model and tag, like `cantor pull acestep:1.5-fast`")?;
            json!({"v": 1, "id": id, "t": "pull", "selector": selector})
        }
        _ => json!({"v": 1, "id": id, "t": "catalog"}),
    };

    let mut planned = false;
    let response = control::request_streaming(&socket_path, &request, |frame| {
        match frame.get("t").and_then(Value::as_str) {
            Some("plan") => {
                planned = true;
                print_pull_plan(frame);
            }
            Some("progress") => print_progress(frame),
            _ => {}
        }
    })
    .await?;

    if planned {
        // The progress line is rewritten in place, so it needs terminating.
        eprintln!();
    }
    match response.get("t").and_then(Value::as_str) {
        Some("catalog") => print_catalog(&response),
        _ => {
            println!(
                "{}",
                response
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("done")
            );
            Ok(())
        }
    }
}

fn print_pull_plan(frame: &Value) {
    let total = frame
        .get("total_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let needed = frame
        .get("needed_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let have = frame
        .get("already_have_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    println!(
        "{}:{}",
        string_field(frame, "model"),
        string_field(frame, "tag")
    );
    // Shown before the first byte: someone should know what they are agreeing
    // to generate with, especially where it is non-commercial.
    let licence = string_field(frame, "licence");
    if !licence.is_empty() {
        println!("  licence   {licence}");
    }
    println!("  size      {}", store::human_bytes(total));
    if have > 0 {
        println!(
            "  to fetch  {} ({} already shared with another variant)",
            store::human_bytes(needed),
            store::human_bytes(have)
        );
    } else {
        println!("  to fetch  {}", store::human_bytes(needed));
    }
    if let Some(components) = frame.get("components").and_then(Value::as_array) {
        for component in components {
            let quant = component
                .get("quant")
                .and_then(Value::as_str)
                .map(|q| format!(" {q}"))
                .unwrap_or_default();
            println!(
                "            {}{quant} · {}",
                string_field(component, "role"),
                store::human_bytes(component.get("bytes").and_then(Value::as_u64).unwrap_or(0))
            );
        }
    }
    println!();
}

fn print_progress(frame: &Value) {
    let done = frame
        .get("overall_done")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total = frame
        .get("overall_total")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1);
    let percent = (done * 100 / total).min(100);
    eprint!(
        "\r  {percent:>3}%  {} / {}  ({})   ",
        store::human_bytes(done),
        store::human_bytes(total),
        string_field(frame, "role")
    );
}

fn print_catalog(response: &Value) -> Result<()> {
    let installed: Vec<&str> = response
        .get("installed")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let available = response
        .get("available_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let models = response
        .get("models")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if models.is_empty() {
        println!("The catalog is empty.");
        return Ok(());
    }
    for model in models {
        let name = string_field(model, "name");
        let licence = string_field(model, "licence");
        println!("{name}  ({licence})");
        for variant in model
            .get("variants")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let tag = string_field(variant, "tag");
            let selector = format!("{name}:{tag}");
            let bytes: u64 = variant
                .get("components")
                .and_then(Value::as_array)
                .map(|components| {
                    components
                        .iter()
                        .filter_map(|c| c.get("bytes").and_then(Value::as_u64))
                        .sum()
                })
                .unwrap_or(0);
            let mark = if installed.contains(&selector.as_str()) {
                "installed"
            } else if bytes > available {
                "will not fit"
            } else {
                ""
            };
            println!("  {tag:<16} {:>10}  {mark}", store::human_bytes(bytes));
        }
    }
    println!("\n{} free on this node.", store::human_bytes(available));
    Ok(())
}

fn print_response(command: Command_, response: &Value) -> Result<()> {
    match command {
        Command_::Status => {
            println!("name       {}", string_field(response, "name"));
            println!("key        {}", string_field(response, "pubkey"));
            println!("relay      {}", string_field(response, "relay_url"));
            println!(
                "relay link {}",
                if response.get("connected").and_then(Value::as_bool) == Some(true) {
                    "connected"
                } else {
                    "disconnected"
                }
            );
            println!(
                "pairings   {}",
                response
                    .get("pairings")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
            );
            if let Some(expires_in) = response.get("pair_expires_in").and_then(Value::as_u64) {
                println!("pairing    open, expires in {expires_in}s");
            }
        }
        Command_::Pair => {
            let uri = string_field(response, "uri");
            let url = url::Url::parse(&uri).context("the node sent an invalid pairing URI")?;
            pairing::print_pairing_code(&url)?;
            // The daemon holds the offer, so this command returns immediately;
            // there is nothing here to keep running while the phone scans.
            println!(
                "This code expires in {}s. The node is already waiting — run `cantor pairings` once the phone is done.",
                response
                    .get("expires_in")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
            );
        }
        Command_::Pairings => {
            let pairings = response
                .get("pairings")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if pairings.is_empty() {
                println!("No paired devices. Run `cantor pair` to add one.");
                return Ok(());
            }
            for pairing in pairings {
                // Petnames are attacker-supplied; they were sanitised on the way
                // in, so what reaches a terminal here has no control characters.
                let petname = pairing
                    .get("petname")
                    .and_then(Value::as_str)
                    .unwrap_or("(unnamed)");
                let paired_at = pairing
                    .get("paired_at")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                println!(
                    "{petname}\n  key    {}\n  paired {paired_at}",
                    string_field(pairing, "key")
                );
            }
        }
        Command_::List => {
            let installed = response
                .get("installed")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if installed.is_empty() {
                println!("No models installed. Run `cantor list --all` to see the catalog.");
                return Ok(());
            }
            for variant in installed {
                let bytes: u64 = variant
                    .get("components")
                    .and_then(Value::as_array)
                    .map(|components| {
                        components
                            .iter()
                            .filter_map(|c| c.get("bytes").and_then(Value::as_u64))
                            .sum()
                    })
                    .unwrap_or(0);
                println!(
                    "{}:{:<16} {:>10}  {}",
                    string_field(variant, "model"),
                    string_field(variant, "tag"),
                    store::human_bytes(bytes),
                    string_field(variant, "licence")
                );
            }
            println!(
                "\n{} free on this node.",
                store::human_bytes(
                    response
                        .get("available_bytes")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                )
            );
        }
        Command_::Remove => {
            println!(
                "removed; reclaimed {}",
                store::human_bytes(
                    response
                        .get("reclaimed_bytes")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                )
            );
        }
        _ => println!("ok"),
    }
    Ok(())
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `start`, `stop`, `restart` and `logs` are thin wrappers over systemd.
fn lifecycle(cli: &Cli) -> Result<()> {
    match cli.command {
        Command_::Logs => service::logs(&cli.lines, cli.follow),
        Command_::Start => service::run_action("start"),
        Command_::Stop => service::run_action("stop"),
        Command_::Restart => service::run_action("restart"),
        other => bail!("{other:?} is not a lifecycle command"),
    }
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

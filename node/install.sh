#!/bin/sh

set -eu

# Published command:
#   sh -c "$(curl -fsSL https://cantor.ckadirt.xyz/install.sh)"
# Not `curl … | sh`: piping hands the script's stdin to curl's output, so every
# prompt below would read EOF and silently take its default.

cantor_fail() {
  printf 'cantor installer: %s\n' "$*" >&2
  exit 1
}

cantor_warn() {
  printf 'cantor installer: %s\n' "$*" >&2
}

cantor_require() {
  command -v "$1" >/dev/null 2>&1 || cantor_fail "required command not found: $1"
}

cantor_reject_control() {
  [ -n "$2" ] || cantor_fail "$1 must not be empty"
  case "$2" in
    *'
'*) cantor_fail "$1 must not contain control characters" ;;
  esac
  if printf '%s' "$2" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    cantor_fail "$1 must not contain control characters"
  fi
}

cantor_toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cantor_systemd_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
}

# Prompts are skipped whole when stdin is not a terminal, so piped and CI
# installs take defaults instead of hanging on a read that can never answer.
cantor_prompt() {
  cantor_prompt_result=$2
  if [ "$cantor_interactive" != '1' ]; then
    return 0
  fi
  printf '%s [%s]: ' "$1" "$2" >&2
  if ! IFS= read -r cantor_prompt_reply; then
    cantor_prompt_reply=''
  fi
  if [ -n "$cantor_prompt_reply" ]; then
    cantor_prompt_result=$cantor_prompt_reply
  fi
}

cantor_confirm() {
  if [ "$cantor_interactive" != '1' ]; then
    return 1
  fi
  printf '%s [y/N]: ' "$1" >&2
  if ! IFS= read -r cantor_confirm_reply; then
    return 1
  fi
  case "$cantor_confirm_reply" in
    y | Y | yes | YES | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

[ "$(uname -s)" = 'Linux' ] || cantor_fail 'only Linux is supported'
cantor_require grep
cantor_require install
cantor_require sed
cantor_require uname
cantor_require hostname
cantor_require id

if [ -t 0 ] && [ -t 2 ]; then
  cantor_interactive=1
else
  cantor_interactive=0
fi

if [ "$(id -u)" = '0' ]; then
  cantor_privileged=1
else
  cantor_privileged=0
fi

# systemd's own documented marker. Docker and WSL1 have neither, and writing a
# unit into a system that will never read it is worse than saying so.
if [ -d /run/systemd/system ]; then
  cantor_has_systemd=1
else
  cantor_has_systemd=0
fi

cantor_config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
cantor_data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}

# /usr/local/bin is on everyone's PATH, including root's, so prefer it whenever
# it can actually be written. Falling back to ~/.local/bin is the unprivileged
# case, and that one needs a PATH check afterwards.
cantor_default_install_dir() {
  if [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    printf '/usr/local/bin'
  elif [ ! -d /usr/local/bin ] && [ -d /usr/local ] && [ -w /usr/local ]; then
    printf '/usr/local/bin'
  else
    printf '%s/.local/bin' "$HOME"
  fi
}

cantor_install_dir=${CANTOR_INSTALL_DIR:-"$(cantor_default_install_dir)"}

if [ "$cantor_privileged" = '1' ]; then
  cantor_config_dir=${CANTOR_CONFIG_DIR:-/etc/cantor}
  cantor_default_model_dir=/var/lib/cantor/models
  cantor_service_path=${CANTOR_SERVICE_PATH:-/etc/systemd/system/cantor.service}
  cantor_systemctl_scope='--system'
  cantor_service_dir=$(dirname "$cantor_service_path")
else
  cantor_config_dir=${CANTOR_CONFIG_DIR:-"$cantor_config_home/cantor"}
  cantor_default_model_dir="$cantor_data_home/cantor/models"
  cantor_systemd_user_dir=${CANTOR_SYSTEMD_USER_DIR:-"$cantor_config_home/systemd/user"}
  cantor_service_path=${CANTOR_SERVICE_PATH:-"$cantor_systemd_user_dir/cantor.service"}
  cantor_systemctl_scope='--user'
  cantor_service_dir=$(dirname "$cantor_service_path")
fi

cantor_relay_url=${CANTOR_RELAY_URL:-wss://cantor.ckadirt.xyz}
cantor_node_name=${CANTOR_NODE_NAME:-$(hostname)}
cantor_model_dir=${CANTOR_MODEL_DIR:-"$cantor_default_model_dir"}

# Each prompt is skipped when its variable was supplied, so a CANTOR_* override
# always wins and a scripted install never becomes interactive.
if [ -z "${CANTOR_NODE_NAME:-}" ]; then
  cantor_prompt 'Node name' "$cantor_node_name"
  cantor_node_name=$cantor_prompt_result
fi
if [ -z "${CANTOR_RELAY_URL:-}" ]; then
  cantor_prompt 'Relay URL' "$cantor_relay_url"
  cantor_relay_url=$cantor_prompt_result
fi
if [ -z "${CANTOR_MODEL_DIR:-}" ]; then
  cantor_prompt 'Model directory' "$cantor_model_dir"
  cantor_model_dir=$cantor_prompt_result
fi

cantor_reject_control CANTOR_NODE_NAME "$cantor_node_name"
cantor_reject_control CANTOR_INSTALL_DIR "$cantor_install_dir"
cantor_reject_control CANTOR_CONFIG_DIR "$cantor_config_dir"
cantor_reject_control CANTOR_MODEL_DIR "$cantor_model_dir"
cantor_reject_control CANTOR_SERVICE_PATH "$cantor_service_path"
cantor_reject_control CANTOR_RELAY_URL "$cantor_relay_url"
case "$cantor_relay_url" in
  ws://* | wss://*) ;;
  *) cantor_fail 'CANTOR_RELAY_URL must start with ws:// or wss://' ;;
esac
case "$cantor_relay_url" in
  *'?'* | *'#'*) cantor_fail 'CANTOR_RELAY_URL must not contain a query or fragment' ;;
esac
if printf '%s' "$cantor_relay_url" | LC_ALL=C grep -q '[[:space:]]'; then
  cantor_fail 'CANTOR_RELAY_URL must not contain whitespace or control characters'
fi
case "$cantor_config_dir" in
  /*) ;;
  *) cantor_fail 'CANTOR_CONFIG_DIR must be an absolute path' ;;
esac
case "$cantor_model_dir" in
  /*) ;;
  *) cantor_fail 'CANTOR_MODEL_DIR must be an absolute path' ;;
esac

cantor_binary_path="$cantor_install_dir/cantor"
cantor_config_path="$cantor_config_dir/node.toml"
cantor_temp_dir=''

cantor_cleanup() {
  if [ -n "$cantor_temp_dir" ]; then
    rm -f -- "$cantor_temp_dir/cantor" "$cantor_temp_dir/cantor.sha256"
    rmdir -- "$cantor_temp_dir" 2>/dev/null || true
  fi
}
trap cantor_cleanup EXIT HUP INT TERM

umask 077
install -d -m 0755 "$cantor_install_dir"
install -d -m 0700 "$cantor_config_dir"
install -d -m 0700 "$cantor_model_dir"

cantor_source_binary=${CANTOR_NODE_BINARY:-}
if [ -n "$cantor_source_binary" ]; then
  [ -f "$cantor_source_binary" ] || cantor_fail "binary not found: $cantor_source_binary"
  install -m 0755 "$cantor_source_binary" "$cantor_binary_path"
else
  cantor_require curl
  cantor_require awk
  cantor_require mktemp
  cantor_require sha256sum
  case "$(uname -m)" in
    x86_64 | amd64) cantor_asset='cantor-x86_64-unknown-linux-gnu' ;;
    aarch64 | arm64) cantor_asset='cantor-aarch64-unknown-linux-gnu' ;;
    *) cantor_fail "unsupported architecture: $(uname -m)" ;;
  esac
  cantor_node_url=${CANTOR_NODE_URL:-"https://github.com/ckadirt/Cantor/releases/latest/download/$cantor_asset"}
  cantor_reject_control CANTOR_NODE_URL "$cantor_node_url"
  case "$cantor_node_url" in
    https://*) ;;
    *) cantor_fail 'CANTOR_NODE_URL must use https://' ;;
  esac
  if printf '%s' "$cantor_node_url" | LC_ALL=C grep -q '[[:space:]]'; then
    cantor_fail 'CANTOR_NODE_URL must not contain whitespace'
  fi

  cantor_temp_dir=$(mktemp -d)
  curl --fail --location --silent --show-error --retry 3 \
    --proto '=https' --proto-redir '=https' --tlsv1.2 \
    "$cantor_node_url" -o "$cantor_temp_dir/cantor"

  cantor_expected_sha256=${CANTOR_NODE_SHA256:-}
  if [ -z "$cantor_expected_sha256" ]; then
    curl --fail --location --silent --show-error --retry 3 \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      "$cantor_node_url.sha256" -o "$cantor_temp_dir/cantor.sha256"
    cantor_expected_sha256=$(awk 'NR == 1 { print $1 }' "$cantor_temp_dir/cantor.sha256")
  fi
  printf '%s\n' "$cantor_expected_sha256" | grep -Eq '^[0-9A-Fa-f]{64}$' || \
    cantor_fail 'the binary checksum is not a 64-character SHA-256 value'
  cantor_actual_sha256=$(sha256sum "$cantor_temp_dir/cantor" | awk '{ print $1 }')
  [ "$cantor_actual_sha256" = "$cantor_expected_sha256" ] || \
    cantor_fail 'the downloaded binary failed SHA-256 verification'
  install -m 0755 "$cantor_temp_dir/cantor" "$cantor_binary_path"
fi

if [ -L "$cantor_config_path" ]; then
  cantor_fail "refusing to use symlinked config: $cantor_config_path"
fi
if [ -e "$cantor_config_path" ] && [ ! -f "$cantor_config_path" ]; then
  cantor_fail "config path is not a regular file: $cantor_config_path"
fi
if [ ! -e "$cantor_config_path" ]; then
  cantor_escaped_name=$(cantor_toml_escape "$cantor_node_name")
  cantor_escaped_relay=$(cantor_toml_escape "$cantor_relay_url")
  cantor_escaped_model_dir=$(cantor_toml_escape "$cantor_model_dir")
  {
    printf 'name = "%s"\n' "$cantor_escaped_name"
    printf 'relay_url = "%s"\n' "$cantor_escaped_relay"
    printf 'model_dir = "%s"\n' "$cantor_escaped_model_dir"
    printf 'pairings = []\n'
  } > "$cantor_config_path"
  chmod 0600 "$cantor_config_path"
  cantor_config_result='created'
else
  chmod 0600 "$cantor_config_path"
  cantor_config_result='preserved existing'
fi

cantor_service_result='skipped'
if [ "$cantor_has_systemd" = '1' ]; then
  install -d -m 0755 "$cantor_service_dir"
  if [ -L "$cantor_service_path" ]; then
    cantor_fail "refusing to replace symlinked service: $cantor_service_path"
  fi
  if [ -e "$cantor_service_path" ] && ! grep -q '^# Managed by Cantor install.sh$' "$cantor_service_path"; then
    cantor_fail "refusing to replace unmanaged service: $cantor_service_path"
  fi
  cantor_escaped_binary=$(cantor_systemd_escape "$cantor_binary_path")
  cantor_escaped_config_dir=$(cantor_systemd_escape "$cantor_config_dir")
  cantor_escaped_service_model_dir=$(cantor_systemd_escape "$cantor_model_dir")
  {
    printf '%s\n' '# Managed by Cantor install.sh'
    printf '%s\n' '[Unit]'
    printf '%s\n' 'Description=Cantor generation node'
    printf '%s\n' 'Wants=network-online.target'
    printf '%s\n' 'After=network-online.target'
    printf '\n%s\n' '[Service]'
    printf 'ExecStart="%s" run --config-dir "%s"\n' "$cantor_escaped_binary" "$cantor_escaped_config_dir"
    printf '%s\n' 'Restart=always'
    printf '%s\n' 'RestartSec=5s'
    printf '%s\n' 'UMask=0077'
    printf '%s\n' 'NoNewPrivileges=true'
    printf '%s\n' 'PrivateTmp=true'
    printf '%s\n' 'ProtectSystem=strict'
    printf '%s\n' 'ProtectHome=read-only'
    printf 'ReadWritePaths="%s" "%s"\n' "$cantor_escaped_config_dir" "$cantor_escaped_service_model_dir"
    printf '%s\n' 'RestrictSUIDSGID=true'
    printf '%s\n' 'LockPersonality=true'
    printf '\n%s\n' '[Install]'
    if [ "$cantor_privileged" = '1' ]; then
      printf '%s\n' 'WantedBy=multi-user.target'
    else
      printf '%s\n' 'WantedBy=default.target'
    fi
  } > "$cantor_service_path"
  chmod 0644 "$cantor_service_path"
  cantor_service_result='installed'

  if [ "${CANTOR_SKIP_SYSTEMD_RELOAD:-0}" != '1' ] && command -v systemctl >/dev/null 2>&1; then
    if ! systemctl "$cantor_systemctl_scope" daemon-reload; then
      cantor_warn 'systemd did not accept daemon-reload; run it yourself before enabling the service'
    fi
  fi

  # A --user service dies with the last session of the user that started it, so
  # ssh in, install, pair, log out would silently stop the node. Lingering is
  # what keeps an unprivileged install running after logout.
  if [ "$cantor_privileged" != '1' ] && [ "${CANTOR_SKIP_LINGER:-0}" != '1' ]; then
    if command -v loginctl >/dev/null 2>&1; then
      if loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then
        cantor_linger='enabled'
      else
        cantor_linger='unavailable'
      fi
    else
      cantor_linger='unavailable'
    fi
  fi
fi

printf '\n'
printf 'Installed cantor at %s\n' "$cantor_binary_path"
printf '%s config at %s\n' "$cantor_config_result" "$cantor_config_path"
printf 'Model directory %s\n' "$cantor_model_dir"

if [ "$cantor_has_systemd" = '1' ]; then
  printf 'Installed %s service at %s\n' \
    "$(if [ "$cantor_privileged" = '1' ]; then printf 'system'; else printf 'user'; fi)" \
    "$cantor_service_path"
  if [ "$cantor_privileged" != '1' ] && [ "${cantor_linger:-}" = 'unavailable' ]; then
    printf '\n%s\n' 'warning: could not enable lingering, so this service will stop when you log out.'
    printf '%s\n' "Ask an administrator to run: loginctl enable-linger $(id -un)"
  fi
else
  printf '\n%s\n' 'warning: systemd is not running here (/run/systemd/system is absent).'
  printf '%s\n' 'No service was installed. Docker and WSL1 behave this way; you will have to'
  printf '%s\n' 'keep the node running yourself.'
fi

# Debian only adds ~/.local/bin from ~/.profile, at login, and only when the
# directory already existed — so it is reliably absent in the shell that just
# ran this. Root's profile usually never adds it at all.
case ":$PATH:" in
  *":$cantor_install_dir:"*) ;;
  *)
    printf '\n%s\n' "warning: $cantor_install_dir is not on your PATH."
    printf '%s\n' 'Add it with:'
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.profile\n' "$cantor_install_dir"
    printf '%s\n' 'and either log out and back in, or run that export in this shell.'
    ;;
esac

printf '\n'
if [ "$cantor_has_systemd" != '1' ]; then
  cantor_enable_command="$cantor_binary_path run --config-dir $cantor_config_dir"
elif [ "$cantor_privileged" = '1' ]; then
  cantor_enable_command="systemctl enable --now cantor.service"
else
  cantor_enable_command="systemctl --user enable --now cantor.service"
fi

# The pair command always carries --config-dir: a system install keeps its
# config in /etc/cantor, while a bare `cantor pair` would default to the running
# user's own config directory and pair into a file the service never reads.
cantor_pair_command="$cantor_binary_path pair --config-dir $cantor_config_dir"

if cantor_confirm 'Pair a phone with this node now?'; then
  printf '\n%s\n\n' 'Starting pairing. Press Ctrl-C once Cantor shows the node as READY.'
  $cantor_pair_command || true
  printf '\n%s\n' 'Pairing finished. Start the node with:'
  printf '  %s\n' "$cantor_enable_command"
else
  printf '%s\n' 'Pair this node before starting it:'
  printf '  %s\n' "$cantor_pair_command"
  printf '%s\n' 'After Cantor reaches READY, stop the foreground pair process and run:'
  printf '  %s\n' "$cantor_enable_command"
fi

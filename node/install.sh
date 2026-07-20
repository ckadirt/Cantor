#!/bin/sh

set -eu

cantor_fail() {
  printf 'cantor-node installer: %s\n' "$*" >&2
  exit 1
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

cantor_relay_url=${CANTOR_RELAY_URL:-wss://cantor.ckadirt.xyz}
cantor_node_name=${CANTOR_NODE_NAME:-$(hostname)}
cantor_install_dir=${CANTOR_INSTALL_DIR:-"$HOME/.local/bin"}
cantor_config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
cantor_config_dir=${CANTOR_CONFIG_DIR:-"$cantor_config_home/cantor"}
cantor_systemd_user_dir=${CANTOR_SYSTEMD_USER_DIR:-"$cantor_config_home/systemd/user"}
cantor_service_path="$cantor_systemd_user_dir/cantor-node.service"
cantor_binary_path="$cantor_install_dir/cantor-node"
cantor_config_path="$cantor_config_dir/node.toml"
cantor_temp_dir=''

cantor_cleanup() {
  if [ -n "$cantor_temp_dir" ]; then
    rm -f -- "$cantor_temp_dir/cantor-node" "$cantor_temp_dir/cantor-node.sha256"
    rmdir -- "$cantor_temp_dir" 2>/dev/null || true
  fi
}
trap cantor_cleanup EXIT HUP INT TERM

[ "$(uname -s)" = 'Linux' ] || cantor_fail 'only Linux is supported'
cantor_require grep
cantor_reject_control CANTOR_NODE_NAME "$cantor_node_name"
cantor_reject_control CANTOR_INSTALL_DIR "$cantor_install_dir"
cantor_reject_control CANTOR_CONFIG_DIR "$cantor_config_dir"
cantor_reject_control CANTOR_SYSTEMD_USER_DIR "$cantor_systemd_user_dir"
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

cantor_require install
cantor_require sed
cantor_require uname
cantor_require hostname

umask 077
install -d -m 0755 "$cantor_install_dir"
install -d -m 0700 "$cantor_config_dir"
install -d -m 0755 "$cantor_systemd_user_dir"

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
    x86_64 | amd64) cantor_asset='cantor-node-x86_64-unknown-linux-gnu' ;;
    aarch64 | arm64) cantor_asset='cantor-node-aarch64-unknown-linux-gnu' ;;
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
    "$cantor_node_url" -o "$cantor_temp_dir/cantor-node"

  cantor_expected_sha256=${CANTOR_NODE_SHA256:-}
  if [ -z "$cantor_expected_sha256" ]; then
    curl --fail --location --silent --show-error --retry 3 \
      --proto '=https' --proto-redir '=https' --tlsv1.2 \
      "$cantor_node_url.sha256" -o "$cantor_temp_dir/cantor-node.sha256"
    cantor_expected_sha256=$(awk 'NR == 1 { print $1 }' "$cantor_temp_dir/cantor-node.sha256")
  fi
  printf '%s\n' "$cantor_expected_sha256" | grep -Eq '^[0-9A-Fa-f]{64}$' || \
    cantor_fail 'the binary checksum is not a 64-character SHA-256 value'
  cantor_actual_sha256=$(sha256sum "$cantor_temp_dir/cantor-node" | awk '{ print $1 }')
  [ "$cantor_actual_sha256" = "$cantor_expected_sha256" ] || \
    cantor_fail 'the downloaded binary failed SHA-256 verification'
  install -m 0755 "$cantor_temp_dir/cantor-node" "$cantor_binary_path"
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
  {
    printf 'name = "%s"\n' "$cantor_escaped_name"
    printf 'relay_url = "%s"\n' "$cantor_escaped_relay"
    printf 'allowed_keys = []\n'
  } > "$cantor_config_path"
  chmod 0600 "$cantor_config_path"
  cantor_config_result='created'
else
  chmod 0600 "$cantor_config_path"
  cantor_config_result='preserved existing'
fi

if [ -L "$cantor_service_path" ]; then
  cantor_fail "refusing to replace symlinked service: $cantor_service_path"
fi
if [ -e "$cantor_service_path" ] && ! grep -q '^# Managed by Cantor install.sh$' "$cantor_service_path"; then
  cantor_fail "refusing to replace unmanaged service: $cantor_service_path"
fi
cantor_escaped_binary=$(cantor_systemd_escape "$cantor_binary_path")
cantor_escaped_config_dir=$(cantor_systemd_escape "$cantor_config_dir")
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
  printf 'ReadWritePaths="%s"\n' "$cantor_escaped_config_dir"
  printf '%s\n' 'RestrictSUIDSGID=true'
  printf '%s\n' 'LockPersonality=true'
  printf '\n%s\n' '[Install]'
  printf '%s\n' 'WantedBy=default.target'
} > "$cantor_service_path"
chmod 0644 "$cantor_service_path"

if [ "${CANTOR_SKIP_SYSTEMD_RELOAD:-0}" != '1' ] && command -v systemctl >/dev/null 2>&1; then
  if ! systemctl --user daemon-reload; then
    printf '%s\n' 'warning: systemd user manager is unavailable; run daemon-reload after login' >&2
  fi
fi

printf 'Installed cantor-node at %s\n' "$cantor_binary_path"
printf '%s config at %s\n' "$cantor_config_result" "$cantor_config_path"
printf 'Installed user service at %s\n\n' "$cantor_service_path"
printf '%s\n' 'Pair this node before enabling the service:'
printf '  %s pair --config-dir %s\n' "$cantor_binary_path" "$cantor_config_dir"
printf '%s\n' 'After Cantor reaches READY, stop the foreground pair process and run:'
printf '%s\n' '  systemctl --user enable --now cantor-node.service'

#!/bin/sh

set -eu

# Published command: curl -fsSL https://cantor.ckadirt.xyz/install.sh | sh
# Read prompts from the controlling terminal, independently of script input.

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

cantor_group_exists() {
  if command -v getent >/dev/null 2>&1; then
    getent group "$1" >/dev/null 2>&1
  else
    LC_ALL=C grep -q "^$1:" /etc/group 2>/dev/null
  fi
}

cantor_toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cantor_systemd_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
}

# Prompts use fd 3, opened from the controlling terminal when one is available.
cantor_prompt() {
  cantor_prompt_result=$2
  if [ "$cantor_interactive" != '1' ]; then
    return 0
  fi
  printf '%s [%s]: ' "$1" "$2" >&2
  if ! IFS= read -r cantor_prompt_reply <&3; then
    cantor_prompt_reply=''
  fi
  if [ -n "$cantor_prompt_reply" ]; then
    cantor_prompt_result=$cantor_prompt_reply
  fi
}

# Recommended setup steps are opt-out rather than opt-in, but only at a real
# terminal. Non-interactive installs still perform no service starts, pairing,
# or multi-gigabyte downloads unless an operator runs those commands later.
cantor_confirm_recommended() {
  if [ "$cantor_interactive" != '1' ]; then
    return 1
  fi
  printf '%s [Y/n]: ' "$1" >&2
  if ! IFS= read -r cantor_confirm_reply <&3; then
    return 1
  fi
  case "$cantor_confirm_reply" in
    '' | y | Y | yes | YES | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

cantor_pause() {
  if [ "$cantor_interactive" != '1' ]; then
    return 0
  fi
  printf '%s' "$1" >&2
  IFS= read -r cantor_pause_reply <&3 || true
}

cantor_os=$(uname -s)
case "$cantor_os" in Linux | Darwin) ;; *) cantor_fail 'only Linux and macOS are supported' ;; esac
cantor_require grep
cantor_require install
cantor_require sed
cantor_require uname
cantor_require hostname
cantor_require id

cantor_interactive=0
if [ "${CANTOR_NON_INTERACTIVE:-0}" != '1' ] && [ -t 2 ]; then
  if ( : </dev/tty ) 2>/dev/null; then
    exec 3</dev/tty
    cantor_interactive=1
  elif [ -t 0 ]; then
    exec 3<&0
    cantor_interactive=1
  fi
fi

if [ "$(id -u)" = '0' ]; then
  cantor_privileged=1
else
  cantor_privileged=0
fi

if [ "$cantor_os" = Darwin ]; then
  [ "$cantor_privileged" = '0' ] || cantor_fail 'install on macOS as your normal user, without sudo'
  cantor_config_home="$HOME/Library/Application Support"
  cantor_data_home="$cantor_config_home"
else
  cantor_config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
  cantor_data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
fi

# Normal installs are always user-owned, even when /usr/local/bin is writable.
cantor_default_install_dir() {
  if [ "$cantor_privileged" != 1 ]; then
    printf '%s/.local/bin' "$HOME"
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
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
  cantor_default_library_dir=/var/lib/cantor/library
  cantor_service_path=${CANTOR_SERVICE_PATH:-/etc/systemd/system/cantor.service}
  cantor_systemctl_scope='--system'
  cantor_service_dir=$(dirname "$cantor_service_path")
else
  cantor_config_dir=${CANTOR_CONFIG_DIR:-"$cantor_config_home/cantor"}
  cantor_default_model_dir="$cantor_data_home/cantor/models"
  cantor_default_library_dir="$cantor_data_home/cantor/library"
  cantor_systemd_user_dir=${CANTOR_SYSTEMD_USER_DIR:-"$cantor_config_home/systemd/user"}
  cantor_service_path=${CANTOR_SERVICE_PATH:-"$cantor_systemd_user_dir/cantor.service"}
  cantor_systemctl_scope='--user'
  cantor_service_dir=$(dirname "$cantor_service_path")
fi

# A host systemd marker does not imply a reachable user manager (for example
# in hosted studios or containers). Probe the manager we would actually use.
# `show` succeeds even when the manager is degraded, unlike is-system-running.
cantor_has_systemd=0
if [ "$cantor_os" = Linux ] && command -v systemctl >/dev/null 2>&1 &&
  systemctl "$cantor_systemctl_scope" show --property=Version >/dev/null 2>&1; then
  cantor_has_systemd=1
fi

cantor_relay_url=${CANTOR_RELAY_URL:-wss://cantor.ckadirt.xyz}
cantor_node_name=${CANTOR_NODE_NAME:-$(hostname)}
cantor_model_dir=${CANTOR_MODEL_DIR:-"$cantor_default_model_dir"}
cantor_library_dir=${CANTOR_LIBRARY_DIR:-"$cantor_default_library_dir"}

# Must match CONTROL_GROUP in crates/cantor-node/src/control.rs.
CANTOR_GROUP_NAME=${CANTOR_GROUP_NAME:-cantor}
# Under sudo the operator is the invoking user, not root; a direct root login
# has no one to enrol, and adding root to the group would be pointless.
cantor_operator=${CANTOR_OPERATOR:-${SUDO_USER:-}}
if [ "$cantor_operator" = 'root' ]; then
  cantor_operator=''
fi

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
if [ -z "${CANTOR_LIBRARY_DIR:-}" ]; then
  cantor_prompt 'Library directory' "$cantor_library_dir"
  cantor_library_dir=$cantor_prompt_result
fi

cantor_reject_control CANTOR_NODE_NAME "$cantor_node_name"
cantor_reject_control CANTOR_INSTALL_DIR "$cantor_install_dir"
cantor_reject_control CANTOR_CONFIG_DIR "$cantor_config_dir"
cantor_reject_control CANTOR_MODEL_DIR "$cantor_model_dir"
cantor_reject_control CANTOR_LIBRARY_DIR "$cantor_library_dir"
cantor_reject_control CANTOR_SERVICE_PATH "$cantor_service_path"
cantor_reject_control CANTOR_RELAY_URL "$cantor_relay_url"
cantor_reject_control CANTOR_GROUP_NAME "$CANTOR_GROUP_NAME"
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
case "$cantor_library_dir" in
  /*) ;;
  *) cantor_fail 'CANTOR_LIBRARY_DIR must be an absolute path' ;;
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
install -d -m 0700 "$cantor_library_dir"

cantor_source_binary=${CANTOR_NODE_BINARY:-}
if [ -n "$cantor_source_binary" ]; then
  [ -f "$cantor_source_binary" ] || cantor_fail "binary not found: $cantor_source_binary"
  install -m 0755 "$cantor_source_binary" "$cantor_binary_path.new.$$"
  mv -f "$cantor_binary_path.new.$$" "$cantor_binary_path"
else
  cantor_require curl
  cantor_require awk
  cantor_require mktemp
  if command -v sha256sum >/dev/null 2>&1; then
    cantor_checksum=sha256sum
  else
    cantor_require shasum
    cantor_checksum="shasum -a 256"
  fi
  case "$cantor_os:$(uname -m)" in
    Linux:x86_64 | Linux:amd64) cantor_asset='cantor-x86_64-unknown-linux-gnu' ;;
    Linux:aarch64 | Linux:arm64) cantor_asset='cantor-aarch64-unknown-linux-gnu' ;;
    Darwin:arm64) cantor_asset='cantor-aarch64-apple-darwin' ;;
    Darwin:x86_64) cantor_asset='cantor-x86_64-apple-darwin' ;;
    *) cantor_fail "unsupported architecture: $(uname -m)" ;;
  esac
  cantor_node_url=${CANTOR_NODE_URL:-"https://github.com/ckadirt/Cantor/releases/download/${CANTOR_VERSION:-v0.1.6}/$cantor_asset"}
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
  cantor_actual_sha256=$($cantor_checksum "$cantor_temp_dir/cantor" | awk '{ print $1 }')
  [ "$cantor_actual_sha256" = "$cantor_expected_sha256" ] || \
    cantor_fail 'the downloaded binary failed SHA-256 verification'
  install -m 0755 "$cantor_temp_dir/cantor" "$cantor_binary_path.new.$$"
  mv -f "$cantor_binary_path.new.$$" "$cantor_binary_path"
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
  cantor_escaped_library_dir=$(cantor_toml_escape "$cantor_library_dir")
  {
    printf 'name = "%s"\n' "$cantor_escaped_name"
    printf 'relay_url = "%s"\n' "$cantor_escaped_relay"
    printf 'model_dir = "%s"\n' "$cantor_escaped_model_dir"
    printf 'library_dir = "%s"\n' "$cantor_escaped_library_dir"
    printf 'pairings = []\n'
    printf '\n[jobs]\n'
    printf 'max_queued_per_principal = 20\n'
    printf 'minimum_free_bytes = 2147483648\n'
  } > "$cantor_config_path"
  chmod 0600 "$cantor_config_path"
  cantor_config_result='created'
else
  chmod 0600 "$cantor_config_path"
  cantor_config_result='preserved existing'
fi

# The control socket is root:cantor 0660, so an operator needs to be in the
# group. Group membership is only picked up at login, which is worth saying out
# loud rather than letting the first `cantor status` fail with EACCES.
cantor_group_result='skipped'
if [ "$cantor_privileged" = '1' ]; then
  if command -v groupadd >/dev/null 2>&1; then
    if cantor_group_exists "$CANTOR_GROUP_NAME"; then
      cantor_group_result='existed'
    elif groupadd --system "$CANTOR_GROUP_NAME" >/dev/null 2>&1; then
      cantor_group_result='created'
    else
      cantor_group_result='unavailable'
    fi
    if [ "$cantor_group_result" != 'unavailable' ] && [ -n "$cantor_operator" ]; then
      if command -v usermod >/dev/null 2>&1 &&
        usermod -aG "$CANTOR_GROUP_NAME" "$cantor_operator" >/dev/null 2>&1; then
        cantor_group_added=$cantor_operator
      fi
    fi
  else
    cantor_group_result='unavailable'
  fi
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
  cantor_escaped_service_library_dir=$(cantor_systemd_escape "$cantor_library_dir")
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
    printf 'ReadWritePaths="%s" "%s" "%s"\n' "$cantor_escaped_config_dir" "$cantor_escaped_service_model_dir" "$cantor_escaped_service_library_dir"
    printf '%s\n' 'RestrictSUIDSGID=true'
    printf '%s\n' 'LockPersonality=true'
    # systemd creates and tears down the control socket's directory, so a
    # killed daemon never leaves an unreachable one behind. It owns that
    # directory as the unit's User:Group, so without Group= it would be
    # root:root 0750 and no group member could traverse it to reach the socket.
    if [ "$cantor_privileged" = '1' ]; then
      printf '%s\n' 'RuntimeDirectory=cantor'
      printf '%s\n' 'RuntimeDirectoryMode=0750'
      case "$cantor_group_result" in
        created | existed) printf 'Group=%s\n' "$CANTOR_GROUP_NAME" ;;
      esac
    fi
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

# Remember custom/root configuration without changing the existing config layout.
cantor_registration_dir="$cantor_config_home/cantor"
install -d -m 0700 "$cantor_registration_dir"
[ ! -L "$cantor_registration_dir/installation.toml" ] || cantor_fail 'symlinked installation record'
printf 'directory = "%s"\n' "$(cantor_toml_escape "$cantor_config_dir")" > "$cantor_registration_dir/installation.toml"
chmod 0600 "$cantor_registration_dir/installation.toml"

cantor_launch_agent=''
if [ "$cantor_os" = Darwin ]; then
  cantor_launch_dir="$HOME/Library/LaunchAgents"
  cantor_launch_agent="$cantor_launch_dir/xyz.ckadirt.cantor.plist"
  install -d -m 0755 "$cantor_launch_dir"
  if [ -L "$cantor_launch_agent" ] || { [ -e "$cantor_launch_agent" ] && ! grep -q 'Managed by Cantor install.sh' "$cantor_launch_agent"; }; then
    cantor_fail "refusing to replace unmanaged launch agent: $cantor_launch_agent"
  fi
  cantor_xml_escape() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
  cat > "$cantor_launch_agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!-- Managed by Cantor install.sh -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>xyz.ckadirt.cantor</string>
<key>ProgramArguments</key><array>
<string>$(cantor_xml_escape "$cantor_binary_path")</string><string>run</string>
<string>--config-dir</string><string>$(cantor_xml_escape "$cantor_config_dir")</string>
<string>--control-socket</string><string>$(cantor_xml_escape "$cantor_config_dir/control.sock")</string>
</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>$(cantor_xml_escape "$cantor_config_dir/node.log")</string>
<key>StandardErrorPath</key><string>$(cantor_xml_escape "$cantor_config_dir/node.log")</string>
</dict></plist>
PLIST
  chmod 0644 "$cantor_launch_agent"
fi

printf '\n'
printf 'Installed cantor at %s\n' "$cantor_binary_path"
printf '%s config at %s\n' "$cantor_config_result" "$cantor_config_path"
printf 'Model directory %s\n' "$cantor_model_dir"
printf 'Library directory %s\n' "$cantor_library_dir"

if [ "$cantor_has_systemd" = '1' ]; then
  printf 'Installed %s service at %s\n' \
    "$(if [ "$cantor_privileged" = '1' ]; then printf 'system'; else printf 'user'; fi)" \
    "$cantor_service_path"
  if [ "$cantor_privileged" != '1' ] && [ "${cantor_linger:-}" = 'unavailable' ]; then
    printf '\n%s\n' 'warning: could not enable lingering, so this service will stop when you log out.'
    printf '%s\n' "Ask an administrator to run: loginctl enable-linger $(id -un)"
  fi
elif [ -n "$cantor_launch_agent" ]; then
  printf 'Installed macOS launch agent at %s\n' "$cantor_launch_agent"
else
  printf '\n%s\n' 'Background mode: detached process (no automatic restart after reboot or crash).'
  printf '%s\n' 'Use cantor start, stop, restart and logs to manage the node.'

fi

if [ "$cantor_privileged" = '1' ]; then
  case "$cantor_group_result" in
    created | existed)
      printf 'Control group %s (%s)\n' "$CANTOR_GROUP_NAME" "$cantor_group_result"
      if [ -n "${cantor_group_added:-}" ]; then
        printf '\n%s\n' "Added $cantor_group_added to the $CANTOR_GROUP_NAME group."
        printf '%s\n' 'Group membership only applies to new logins: log out and back in'
        printf '%s\n' 'before running cantor status, pair, pairings or revoke.'
      fi
      ;;
    unavailable)
      printf '\n%s\n' "warning: could not create the $CANTOR_GROUP_NAME group."
      printf '%s\n' 'The control socket will be root-only, so control commands need sudo.'
      ;;
  esac
fi

cantor_shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
# Configure future shells; a child installer cannot change its parent's PATH.
case ":$PATH:" in
  *":$cantor_install_dir:"*) ;;
  *)
    cantor_path_line="export PATH=$(cantor_shell_quote "$cantor_install_dir"):\"\$PATH\""
    for cantor_profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      if ! grep -Fqx "$cantor_path_line" "$cantor_profile" 2>/dev/null; then
        printf '\n# Cantor\n%s\n' "$cantor_path_line" >> "$cantor_profile"
      fi
    done
    printf '\n%s\n' 'PATH configured for future shells. In this shell, run:'
    printf '  %s\n' "$cantor_path_line"
    ;;
esac

printf '\n'

# Pairing, catalog and pull are daemon operations over the control socket, so
# the service has to be running first. These commands reach whichever node is
# actually running and do not need --config-dir.
cantor_cli_command=$(cantor_shell_quote "$cantor_binary_path")
cantor_pair_command="$cantor_cli_command pair"
cantor_started=0
cantor_phone_ready=0
cantor_model_ready=0
if cantor_confirm_recommended 'Start the node now? Recommended for pairing and model setup.'; then
  if [ "$cantor_has_systemd" = '1' ]; then
    systemctl "$cantor_systemctl_scope" enable cantor.service || cantor_warn 'could not enable startup at login/boot'
  fi
  if "$cantor_binary_path" start 3<&-; then
    # The socket appears a moment after the unit does; pairing right away would
    # otherwise race it and look like the daemon is missing.
    cantor_waited=0
    while [ "$cantor_waited" -lt 10 ]; do
      if "$cantor_binary_path" status >/dev/null 2>&1; then
        cantor_started=1
        break
      fi
      sleep 1
      cantor_waited=$((cantor_waited + 1))
    done
    if [ "$cantor_started" != '1' ]; then
      cantor_warn 'the service started but its control socket did not become ready'
    fi
  else
    cantor_warn 'could not start the node; run cantor logs to inspect the failure'
  fi
fi

if [ "$cantor_started" = '1' ]; then
  if cantor_confirm_recommended 'Pair a phone with this node now? Strongly recommended.'; then
    printf '\n'
    if "$cantor_binary_path" pair; then
      cantor_pause 'Scan that code in Cantor. Press Enter after the phone reports it is connected: '
      printf '\n%s\n' 'Paired devices:'
      if "$cantor_binary_path" pairings; then
        cantor_pairing_count=$("$cantor_binary_path" status 2>/dev/null |
          sed -n 's/^pairings[[:space:]]*//p')
        case "$cantor_pairing_count" in
          '' | 0) cantor_warn 'no phone is paired yet; run `cantor pair` to try again' ;;
          *) cantor_phone_ready=1 ;;
        esac
      else
        cantor_warn 'could not check paired devices'
      fi
    else
      cantor_warn 'pairing could not be started; run `cantor pair` later'
    fi
  fi

  printf '\n%s\n' 'A generation node needs at least one model variant and its matching backend.'
  printf '%s\n' '`cantor list --all` shows every available variant, its licence and size,'
  printf '%s\n\n' 'whether it fits, and how much free space this node has.'
  if "$cantor_binary_path" list --all; then
    if cantor_confirm_recommended 'Download a model variant and matching backend now? Strongly recommended.'; then
      cantor_prompt 'Model variant to download' 'acestep:1.5-fast'
      cantor_setup_model=$cantor_prompt_result
      cantor_reject_control 'model selector' "$cantor_setup_model"
      printf '\n%s\n' "Downloading $cantor_setup_model. This can take a while and resumes if interrupted."
      if "$cantor_binary_path" pull "$cantor_setup_model"; then
        cantor_model_ready=1
      else
        cantor_warn "could not install $cantor_setup_model; run cantor pull $cantor_setup_model later"
      fi
    fi
  else
    cantor_warn 'could not load the model catalog; run `cantor list --all` later'
  fi
else
  printf '%s\n' 'Finish setup with:'
  printf '  %s start\n' "$cantor_cli_command"
  printf '  %s\n' "$cantor_pair_command"
fi

if [ "$cantor_phone_ready" = '1' ] && [ "$cantor_model_ready" = '1' ]; then
  printf '\n%s\n' 'Recommended setup complete: a phone is paired and a model plus backend are ready.'
fi

printf '\n%s\n' 'Useful model and backend commands for later:'
printf '  %s list --all             # available variants, licences, sizes and fit\n' "$cantor_cli_command"
printf '  %s pull <model:tag>       # download a variant and its matching backend\n' "$cantor_cli_command"
printf '  %s list                   # variants already installed\n' "$cantor_cli_command"
printf '  %s backends               # detected and selected compute backends\n' "$cantor_cli_command"
printf '  %s backends --install     # try and install the best backend for this machine\n' "$cantor_cli_command"
printf '  %s pair                   # open another phone-pairing code\n' "$cantor_cli_command"
printf '  %s pairings               # confirm which phones are paired\n' "$cantor_cli_command"

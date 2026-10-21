---
title: Files and settings
description: Where the node keeps things, and what node.toml holds.
eyebrow: The node · Reference
---

## Where things live

| | Linux | Linux, installed as root | macOS |
| --- | --- | --- | --- |
| Config, keys, log | `~/.config/cantor` | `/etc/cantor` | `~/Library/Application Support/cantor` |
| Models and library | `~/.local/share/cantor` | `/var/lib/cantor` | `~/Library/Application Support/cantor` |
| The `cantor` command | `~/.local/bin` | `/usr/local/bin` | `~/.local/bin` |

On Linux, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` move these, as you would expect.

In the config directory:

- **`node.toml`**: the node's settings and its pairings.
- **`node.key`**: the node's identity. Keep it private and never share it; a
  node with a new key is a new node, and no phone is paired with it.
- **`noise.key`**: the key that encrypts traffic with phones.
- **`node.log`**: the log, when the node runs detached.

## node.toml

The node writes this file itself. Stop the node before editing it by hand, or
[restart](/docs/node/restart/) it after.

```toml
name = "studio"
relay_url = "wss://relay.cantorfm.com"

# Optional: pin a backend instead of measuring one.
# backend = "cpu"

[engine]
keep_loaded = false   # keep a model loaded between songs
vae_chunk = 256       # lower uses less memory at the slowest step
n_threads = 0         # 0 lets the engine choose

[jobs]
max_queued_per_principal = 20
minimum_free_bytes = 2147483648   # 2 GB the node always leaves free
```

**`[engine]`** fields left out, or set to zero, use the engine's own default.
`vae_chunk` is the one worth knowing on a small machine: the last step of a song
uses the most memory, and 256 keeps a 7 GB machine from swapping.

**`[jobs]`**: how many songs each phone may have waiting, and how much space the
node keeps free. Below that it refuses new songs rather than fill the disk.

## The installer

```sh
curl -fsSL https://cantorfm.com/install.sh | sh
```

Run it as your normal user. It asks for a node name, the relay, and where models
and the library go, then offers to start the node, pair a phone and pull a
model. Running it again keeps your existing `node.toml`.

`CANTOR_NON_INTERACTIVE=1` skips every question and starts nothing.
`CANTOR_RELAY_URL` sets the relay without asking.

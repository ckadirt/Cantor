---
title: cantor logs
description: What the node has been saying.
eyebrow: The node · Running
---

## Usage

```sh
cantor logs                  # the last 50 lines
cantor logs --lines 200      # more of them
cantor logs --follow         # keep printing as it goes; Ctrl-C to stop
```

`-f` is short for `--follow`.

## Where it reads from

On Linux with systemd, the node's journal (`journalctl`). Everywhere else, the
`node.log` file beside the node's config.

## What to look for

Each line is an event and its fields:

```txt
relay.ok — room claimed as studio
engine.rejected backend=cuda12 reason=…
checkpoint.rejected job=8f3c… reason=…
```

`relay.ok` means phones can reach the node. A `job=` field is the id of a song
being made, which is also the id of the song it becomes.

## When it goes wrong

**No log yet.** The node has never run from this config. Start it with
[`cantor start`](/docs/node/start/).

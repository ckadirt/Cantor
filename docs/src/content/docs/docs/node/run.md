---
title: cantor run
description: The node itself, in the foreground.
eyebrow: The node · Running
---

## Usage

```sh
cantor run [--config-dir PATH] [--name NAME] [--relay-url URL]
```

You rarely need this: [`cantor start`](/docs/node/start/) runs the same thing in
the background and keeps it running. `run` is for watching the node in a
terminal, or for running a second, separate node.

## What it does

It opens the node's config and library, listens for the other commands on its
local socket, and connects to the relay. It keeps running until it is stopped
(Ctrl-C, or [`cantor stop`](/docs/node/stop/)). Its log goes to the terminal.

The first run creates the node: `node.toml`, its identity key, and its
transport key. It prints where each one went.

## The options

**`--config-dir PATH`** uses another config directory, which means another node
with its own identity, its own pairings and its own library. Pass the same
directory to every command meant for it.

**`--name NAME`** and **`--relay-url URL`** only apply when the node is first
created. After that, change them in `node.toml` (or, for the name, with
[`cantor rename --node`](/docs/node/rename/)).

:::caution[One identity per directory]
Pointing `--config-dir` at a different directory makes a new node, with a new
key, that none of your phones are paired with. Pass the exact directory.
:::

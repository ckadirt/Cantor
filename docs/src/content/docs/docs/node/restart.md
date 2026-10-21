---
title: cantor restart
description: Stop the node, then start it again.
eyebrow: The node · Running
---

## Usage

```sh
cantor restart
```

## What it does

[`cantor stop`](/docs/node/stop/), then [`cantor start`](/docs/node/start/),
under one lock, so two restarts at once cannot trip over each other.

You need it after changing `node.toml` by hand, after
[`cantor backends --update`](/docs/node/backends/) (new engine builds load at
the next start), and to free a model kept loaded between songs.
[`cantor upgrade`](/docs/node/upgrade/) restarts the node for you.

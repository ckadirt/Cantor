---
title: cantor stop
description: Stop the background node, cleanly.
eyebrow: The node · Running
---

## Usage

```sh
cantor stop
```

## What it does

It asks the running node to shut down and waits for it. Nothing is killed: the
node finishes writing what it is writing first. A song being made stops at its
last finished stage and carries on from there when the node starts again.

While it is stopped, your phone shows the node as offline. Songs already on the
phone still play.

On macOS, stopping unloads the launch agent for this session only; it starts
again at your next login.

## When it goes wrong

**It is still shutting down.** The node is finishing a write. Wait and run
`cantor stop` again; nothing has been forced.

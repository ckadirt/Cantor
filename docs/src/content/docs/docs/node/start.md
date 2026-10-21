---
title: cantor start
description: Bring the background node up.
eyebrow: The node · Running
---

## Usage

```sh
cantor start
```

## What it does

It starts the node in the background and waits, up to fifteen seconds, until it
answers. Who looks after it depends on the machine:

- **Linux** with systemd: a service (a user service for a normal install,
  lingering where the system allows it, so it runs without you logged in).
- **macOS**: a launch agent, which starts at login and restarts after a crash.
- **Anywhere else**, or over SSH with neither: a detached process, with its log
  in `node.log` beside the config.

A detached node does not come back by itself after a reboot. Run `cantor start`
again, or add it to whatever your system runs at startup.

## What it prints

A managed node prints nothing when it comes up. A detached one says where it
logs:

```txt
node started; logs: /home/you/.config/cantor/node.log
```

If it is already up: `node already running`.

## When it goes wrong

**It exits straight away.** The message names the log; read it with
[`cantor logs`](/docs/node/logs/).

**It did not become ready.** It may still be starting, for example while it
opens a large library. Wait a moment and run [`cantor status`](/docs/node/status/).

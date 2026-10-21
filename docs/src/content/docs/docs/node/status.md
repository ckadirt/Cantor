---
title: cantor status
description: What the node is, and whether it can be reached.
eyebrow: The node · Running
---

## Usage

```sh
cantor status
```

## What it prints

```txt
name       studio
key        8JY4wq6V2sN…
relay      wss://relay.cantorfm.com
relay link connected
pairings   2
```

- **name** is what your phone shows for this node. Change it with
  [`cantor rename --node`](/docs/node/rename/).
- **key** is the node's public key. Its mark in the app, the station, is drawn
  from it.
- **relay link** is `connected` when phones can reach the node right now.
- **pairings** is how many phones it trusts; [`cantor pairings`](/docs/node/pairings/)
  lists them.

While a pairing code is open, one more line says how long it has left:

```txt
pairing    open, expires in 212s
```

## When it goes wrong

**It cannot reach the node.** The background node is not running. Start it with
[`cantor start`](/docs/node/start/), or see why it stopped with
[`cantor logs`](/docs/node/logs/).

**The relay link says disconnected.** The node keeps retrying on its own, with
growing pauses. If it stays disconnected, check the machine's connection and
the `relay` line, then `cantor restart`.

A newer release, when there is one, is mentioned under the output; see
[`cantor upgrade`](/docs/node/upgrade/).

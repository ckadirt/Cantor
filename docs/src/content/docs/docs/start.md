---
title: Quick start
description: From nothing to your first song, in three steps.
eyebrow: Start here
---

You need a computer that stays on while it works (Linux or macOS), and an
Android phone.

## Install a node

Run this as your normal user, not with `sudo`:

```sh
curl -fsSL https://cantorfm.com/install.sh | sh
```

The installer puts `cantor` in `~/.local/bin`, then offers, one question at a
time, to start the node, pair a phone, and download a model with the engine
that suits your hardware. Say yes to all three and you can skip to the last
step. If the shell does not find `cantor` afterwards, run the `export PATH=…`
line it printed.

## Pull a model

```sh
cantor pull
```

With no argument it opens a chooser. `acestep:1.5-fast` is a good first model:
about 3.3 GB, and quick on a CPU. See [`cantor pull`](/docs/node/pull/) for the
whole catalog.

## Pair your phone

```sh
cantor pair
```

It prints a code in the terminal. In the app, open **Engines**, choose to pair a
backend, and scan it. The code works once; run `cantor pair` again for another
phone.

:::note[It stays on]
The node keeps running after you close the terminal, and starts again with your
computer where the system allows it. `cantor status` says what it is doing.
:::

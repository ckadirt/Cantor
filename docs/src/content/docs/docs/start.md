---
title: Quick start
description: From nothing to your first song, in three steps.
eyebrow: Start here
---

You need a computer that stays on while it works (Linux or macOS), and an
Android phone (Android 7 or later).

## Install the app

[Download the APK](https://github.com/ckadirt/Cantor/releases/download/app-v0.1.0/cantor-0.1.0-arm64.apk)
on your phone and open it. Android asks once to allow installs from your
browser; allow it, install, and you can turn the permission off again.

The app is not on Google Play yet. Each release is signed with the same key, so
later versions install over this one and keep your songs.

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

With no argument it opens a chooser. `acestep:1.5-quality` is the one we
recommend: about 8.1 GB, and the best songs ACE-Step makes. On a smaller disk or
a CPU-only machine, `acestep:1.5-fast` is about 3.3 GB and quicker. See
[`cantor pull`](/docs/node/pull/) for the whole catalog.

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

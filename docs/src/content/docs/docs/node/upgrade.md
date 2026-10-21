---
title: cantor upgrade
description: Move to the newest release.
eyebrow: The node · Keeping current
---

## Usage

```sh
cantor upgrade                  # download, install, update engines, restart
cantor upgrade --check          # only say whether there is a newer one
cantor upgrade --no-engines     # leave the engines as they are
```

## What it does

It asks GitHub for the newest release, downloads the binary for your machine,
and checks it against its published SHA-256 before anything is replaced. Then
it swaps the binary in one step, fetches the newest engine builds, and restarts
the node so the new version is the one running.

The check goes to GitHub, not to us: running a node reports nothing to Cantor.

## What it prints

```txt
$ cantor upgrade
cantor 0.2.7 → 0.2.8
downloading cantor-x86_64-unknown-linux-gnu…
installed cantor 0.2.8 at /home/you/.local/bin/cantor
updating engines…
```

Other commands mention a newer release under their output, at most once a day.

## When it goes wrong

**The directory is not writable.** The binary was installed somewhere you cannot
write. Run `sudo cantor upgrade`.

**The checksum does not match.** Nothing was replaced. Try again; if it keeps
failing, the download is being tampered with or cut short.

**The engines were not updated.** The upgrade still went through; the node keeps
the engine build it has. Try [`cantor backends --update`](/docs/node/backends/)
later.

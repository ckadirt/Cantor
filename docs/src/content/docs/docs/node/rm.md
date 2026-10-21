---
title: cantor rm
description: Remove a model and reclaim its space.
eyebrow: The node · Models
---

## Usage

```sh
cantor rm acestep:1.5-fast
```

## What it does

It removes the model, then deletes every file that no installed model still
uses. Files shared with another model you keep stay where they are.

Your songs are not touched: they live in the library, not with the model. You
cannot make new songs with a model you removed until you
[pull](/docs/node/pull/) it again. Phones hear about the change at once.

## What it prints

```txt
removed; reclaimed 1.7 GB
```

## When it goes wrong

**It is not installed.** Check the exact name with
[`cantor list`](/docs/node/list/).

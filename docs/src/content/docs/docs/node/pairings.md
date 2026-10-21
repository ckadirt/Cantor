---
title: cantor pairings
description: The phones this node trusts.
eyebrow: The node · Phones
---

## Usage

```sh
cantor pairings
```

## What it prints

Each phone, by the name it gave itself (or the one you gave it), with its key
and when it paired:

```txt
Pixel of Ana
  key    5Hq2…
  paired 2026-10-12T18:04:11Z
studio tablet
  key    9wZt…
  paired 2026-10-14T09:30:52Z
```

With none: `No paired devices. Run `cantor pair` to add one.`

Either the name or the key picks a phone for [`cantor revoke`](/docs/node/revoke/)
and [`cantor rename`](/docs/node/rename/). Names come from the phones, so two
can be the same; then use the key.

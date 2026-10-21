---
title: cantor revoke
description: Stop trusting a phone.
eyebrow: The node · Phones
---

## Usage

```sh
cantor revoke "Pixel of Ana"     # by its name
cantor revoke 5Hq2…              # or by its key
```

## What it does

It removes the phone from the node's pairings and disconnects it at once. A song
that phone is making stops, and the ones it has waiting are held. The phone can
no longer reach this node; to use it again, pair it again with
[`cantor pair`](/docs/node/pair/).

The phone's songs stay in the node's library.

## When it goes wrong

**No pairing matches.** Check the name with
[`cantor pairings`](/docs/node/pairings/).

**The name matches more than one phone.** Use the key instead.

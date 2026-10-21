---
title: cantor rename
description: Name a phone, or the node.
eyebrow: The node · Phones
---

## Usage

```sh
cantor rename "Pixel of Ana" "Ana"     # a phone, by its name or key
cantor rename --node studio            # this node
```

## A phone

A phone pairs under the name it gives itself. `rename` changes the name the node
keeps for it, which is what [`cantor pairings`](/docs/node/pairings/) shows and
what `revoke` and `rename` accept.

## The node

`--node` renames this node. Paired phones show the new name straight away, with
the same mark: the station is drawn from the node's key, not its name.

## When it goes wrong

**The name matches more than one phone.** Use the key instead.

// The published install command serves `public/install.sh`. It is a symlink to
// the one installer the repository actually uses, so this check exists to make
// sure nobody replaces it with a copy that can then drift.
import {readFile, realpath, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const asset = join(here, '..', 'public', 'install.sh');
const expected = join(here, '..', '..', 'node', 'install.sh');

const stats = await lstat(asset);
if (!stats.isSymbolicLink()) {
  throw new Error('relay/public/install.sh must be a symlink to node/install.sh');
}

const [assetTarget, installer] = await Promise.all([realpath(asset), realpath(expected)]);
if (assetTarget !== installer) {
  throw new Error(
    `relay/public/install.sh resolves to ${relative(process.cwd(), assetTarget)}, expected node/install.sh`,
  );
}

const script = await readFile(asset, 'utf8');
if (!script.startsWith('#!/bin/sh')) {
  throw new Error('the served installer does not start with a shebang');
}

console.log('assets ok: public/install.sh -> node/install.sh');

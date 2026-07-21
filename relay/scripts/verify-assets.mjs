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

// The catalog is what every node reads to find models; a malformed one takes
// `cantor pull` down for everybody at once.
const catalogPath = join(here, '..', 'public', 'catalog', 'v1.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (catalog.schema !== 1) {
  throw new Error(`catalog schema must be 1, found ${catalog.schema}`);
}
if (!Array.isArray(catalog.models)) {
  throw new Error('catalog.models must be an array');
}
for (const model of catalog.models) {
  for (const variant of model.variants ?? []) {
    for (const component of variant.components ?? []) {
      if (!/^sha256:[0-9a-f]{64}$/.test(component.blob ?? '')) {
        throw new Error(
          `${model.name}:${variant.tag} component ${component.role} has a malformed blob digest`,
        );
      }
    }
  }
}

console.log('assets ok: public/install.sh -> node/install.sh');
console.log(`catalog ok: schema ${catalog.schema}, ${catalog.models.length} model(s)`);

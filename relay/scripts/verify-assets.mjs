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

// Shared components must carry the SAME digest in every variant. That
// identity is what makes them download once; a drifted digest silently costs
// every node a redundant multi-gigabyte fetch, and nothing else would catch it.
const sharedDigest = new Map();
for (const model of catalog.models) {
  for (const variant of model.variants ?? []) {
    for (const component of variant.components ?? []) {
      if (component.role !== 'vae' && component.role !== 'embed') continue;
      const key = `${model.name}/${component.role}`;
      const seen = sharedDigest.get(key);
      if (seen && seen !== component.blob) {
        throw new Error(
          `${key} has different digests across variants - shared-blob dedup is broken`,
        );
      }
      sharedDigest.set(key, component.blob);
    }
  }
}

// The backends manifest. Same reasoning as the catalog: a node that cannot
// parse this cannot load an engine at all. Absent is allowed - it ships after
// the catalog - but present and malformed is not.
const backendsPath = join(here, '..', 'public', 'backends', 'v1.json');
let backends = null;
try {
  backends = JSON.parse(await readFile(backendsPath, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (backends) {
  if (backends.schema !== 1) {
    throw new Error(`backends schema must be 1, found ${backends.schema}`);
  }
  if (!Array.isArray(backends.engines)) {
    throw new Error('backends.engines must be an array');
  }
  for (const engine of backends.engines) {
    if (!Number.isInteger(engine.abi)) {
      throw new Error(`engine ${engine.name} has a non-integer abi`);
    }
    for (const b of engine.backends ?? []) {
      const where = `${engine.name}/${b.backend}-${b.arch}`;
      if (!/^[0-9a-f]{64}$/.test(b.sha256 ?? '')) {
        throw new Error(`${where} has a malformed sha256`);
      }
      if (!Number.isInteger(b.bytes) || b.bytes <= 0) {
        throw new Error(`${where} has a missing or non-positive byte count`);
      }
      if (!/^https:\/\//.test(b.url ?? '')) {
        throw new Error(`${where} url must be https`);
      }
    }
  }
}

console.log('assets ok: public/install.sh -> node/install.sh');
console.log(`catalog ok: schema ${catalog.schema}, ${catalog.models.length} model(s)`);
for (const model of catalog.models) {
  for (const variant of model.variants ?? []) {
    console.log(`  ${model.name}:${variant.tag} (${(variant.components ?? []).length} components)`);
  }
}
if (backends) {
  const n = backends.engines.reduce((a, e) => a + (e.backends ?? []).length, 0);
  console.log(`backends ok: schema ${backends.schema}, ${n} artifact(s)`);
} else {
  console.log('backends: absent (not yet published)');
}

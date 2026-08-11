import {
  deriveConstants,
  loadValidate,
} from '../../../protocol/transport/generate.mjs';

/**
 * The integration client reads the transport manifest directly instead of
 * carrying a sixth generated copy of it. `spec.json` is the same authority the
 * node, app, relay, and Android constants are rendered from.
 */
export const spec = await loadValidate();
export const derived = deriveConstants(spec);

export const {
  versions: VERSIONS,
  noise: NOISE,
  domains: DOMAINS,
  kinds: KINDS,
  headers: HEADERS,
  sizes: SIZES,
  bounds: BOUNDS,
} = spec;

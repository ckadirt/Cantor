/* eslint-disable no-bitwise */

/**
 * FNV-1a over a string: a key reduced to a stable integer, the same on every
 * device. The lenses hash a recipe the same way (`lenses/face.ts`).
 */
export function fnv1a(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

/* eslint-enable no-bitwise */

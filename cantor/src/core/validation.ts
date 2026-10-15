export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

/**
 * A stage, unit or code by name: a short lowercase identifier. Names this app
 * does not know are kept (a newer node's), malformed ones are refused.
 */
export function isWireName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value);
}

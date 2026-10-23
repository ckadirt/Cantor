/**
 * `cantorfm.com/app/latest.json`: the newest published Cantor, written by the
 * site from its `APP` record (`docs/src/site.ts`) and checked by
 * `deploy-site`. Schema 1. A field this app does not know is ignored; a field
 * it needs that is missing or malformed makes the whole manifest unknown,
 * because a wrong "you are up to date" is worse than no answer.
 */
export const MANIFEST_URL = 'https://cantorfm.com/app/latest.json';

export type AppManifest = Readonly<{
  versionCode: number;
  versionName: string;
  url: string;
  sha256: string;
  bytes: number;
  /** One line of what changed; may be empty. */
  notes: string;
}>;

export function decodeManifest(value: unknown): AppManifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.schema !== 1) return null;
  const { versionCode, versionName, url, sha256, bytes, notes } = m;
  if (typeof versionCode !== 'number' || !Number.isInteger(versionCode) || versionCode < 1) return null;
  if (typeof versionName !== 'string' || !/^\d+\.\d+\.\d+$/.test(versionName)) return null;
  // Only an APK over https: the file is checked against the hash anyway, but
  // nothing here should ever fetch from a plain-text address.
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) return null;
  return {
    versionCode,
    versionName,
    url,
    sha256,
    bytes,
    notes: typeof notes === 'string' ? notes.trim() : '',
  };
}

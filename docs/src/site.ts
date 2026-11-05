/**
 * The published Android app: the newest `app-v…` release. The release script
 * (`cantor/scripts/release-apk.mjs`) rewrites this record, and nothing else
 * should: the site's download links and `/app/latest.json`, which installed
 * apps read to offer an update, both come from it.
 */
export const APP = {
  versionName: '0.1.10',
  versionCode: 11,
  apk: 'https://github.com/ckadirt/Cantor/releases/download/app-v0.1.10/cantor-0.1.10-arm64.apk',
  sha256: 'e2922b4b79d084e288bf81a4d3402e40df27c5ec2a5fe776a732a10a7af98e99',
  bytes: 63782289,
  notes: 'Faster find and map, steadier lens changes, quicker marbling seeks',
} as const;

/** Links the landing and the docs share, in one place. */
export const SITE = {
  /** The install line people copy. The site serves node/install.sh itself. */
  install: 'curl -fsSL https://cantorfm.com/install.sh | sh',
  /** The Android app's APK, from the release record above. */
  apk: APP.apk,
  github: 'https://github.com/ckadirt/Cantor',
} as const;

/**
 * What `/app/latest.json` says: the newest app, for an installed one to compare
 * itself against (`cantor/src/features/update`). Schema 1; an app ignores
 * fields it does not know, and treats anything malformed as unknown.
 */
export function appManifest() {
  return {
    schema: 1,
    versionCode: APP.versionCode,
    versionName: APP.versionName,
    url: APP.apk,
    sha256: APP.sha256,
    bytes: APP.bytes,
    notes: APP.notes,
  };
}

/**
 * Short addresses on cantorfm.com, written to the built site's `_redirects`
 * (astro.config.mjs) so the long links above stay the only copy.
 */
export const REDIRECTS: Record<string, string> = {
  '/download': SITE.apk,
  '/apk': SITE.apk,
  '/source': SITE.github,
  '/github': SITE.github,
  '/releases': `${SITE.github}/releases`,
  '/start': '/docs/start/',
};

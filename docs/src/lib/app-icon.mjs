// The app's launcher icon, which the site uses as its favicon
// (src/pages/favicon.svg.ts). Plain JavaScript so astro.config.mjs can use it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The icon's two halves in the app: what is drawn, and what it is drawn on. */
const RES = resolve(process.cwd(), '../cantor/android/app/src/main/res');
export const APP_ICON = {
  foreground: resolve(RES, 'drawable/ic_launcher_foreground.xml'),
  background: resolve(RES, 'values/ic_launcher_background.xml'),
};

/**
 * The favicon's address, versioned by the icon's own bytes: browsers keep a
 * favicon long after it changes, so a new icon has to be a new URL.
 */
export function faviconHref() {
  const hash = createHash('sha256');
  for (const file of Object.values(APP_ICON)) hash.update(readFileSync(file));
  return `/favicon.svg?v=${hash.digest('hex').slice(0, 10)}`;
}

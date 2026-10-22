// The app's launcher icon, which the site uses as its favicon and its mark
// (src/pages/favicon.svg.ts, components/art/AppIcon.astro). Plain JavaScript
// so astro.config.mjs can use it too.
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
 * The icon read from its vector drawable: its paths, the viewport they are
 * drawn in, its background colour, and the box its ink fills.
 */
export function appIcon() {
  const foreground = readFileSync(APP_ICON.foreground, 'utf8');
  const background = /<color name="ic_launcher_background">(#[0-9A-Fa-f]{6})</.exec(readFileSync(APP_ICON.background, 'utf8'))?.[1] ?? '#FFFFFF';
  const size = Number(/android:viewportWidth="([\d.]+)"/.exec(foreground)?.[1] ?? 512);
  const paths = [...foreground.matchAll(/android:fillColor="(#[0-9A-Fa-f]{6,8})"\s+android:pathData="([^"]+)"/g)].map(([, fill, d]) => ({ fill, d }));
  // Every point the paths pass through; an arc's radii (after its A) are not points.
  const points = paths.flatMap(({ d }) => [...d.matchAll(/(?<![A\d.])(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const round = (v) => +v.toFixed(2);
  const ink = { x: round(Math.min(...xs)), y: round(Math.min(...ys)), w: round(Math.max(...xs) - Math.min(...xs)), h: round(Math.max(...ys) - Math.min(...ys)) };
  return { size, background, paths, ink };
}

/**
 * The favicon's address, versioned by the icon's own bytes: browsers keep a
 * favicon long after it changes, so a new icon has to be a new URL.
 */
export function faviconHref() {
  const hash = createHash('sha256');
  for (const file of Object.values(APP_ICON)) hash.update(readFileSync(file));
  return `/favicon.svg?v=${hash.digest('hex').slice(0, 10)}`;
}

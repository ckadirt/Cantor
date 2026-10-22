import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIRoute } from 'astro';

/**
 * The favicon is the app's own launcher icon, read at build time from its
 * vector drawable, so the two never drift: the foreground's paths on the
 * icon's white background, cropped to the part a launcher shows (72 of the
 * adaptive icon's 108 dp).
 */
const RES = '../cantor/android/app/src/main/res';

export const GET: APIRoute = () => {
  const foreground = readFileSync(resolve(process.cwd(), RES, 'drawable/ic_launcher_foreground.xml'), 'utf8');
  const background = /<color name="ic_launcher_background">(#[0-9A-Fa-f]{6})</.exec(
    readFileSync(resolve(process.cwd(), RES, 'values/ic_launcher_background.xml'), 'utf8'),
  )?.[1] ?? '#FFFFFF';
  const size = Number(/android:viewportWidth="([\d.]+)"/.exec(foreground)?.[1] ?? 512);
  const paths = [...foreground.matchAll(/android:fillColor="(#[0-9A-Fa-f]{6,8})"\s+android:pathData="([^"]+)"/g)]
    .map(([, fill, d]) => `<path fill="${fill}" d="${d}"/>`)
    .join('');
  const shown = +((size * 72) / 108).toFixed(2);
  const inset = +((size - shown) / 2).toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${inset} ${inset} ${shown} ${shown}"><rect x="${inset}" y="${inset}" width="${shown}" height="${shown}" rx="${(shown * 0.22).toFixed(2)}" fill="${background}"/>${paths}</svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
};

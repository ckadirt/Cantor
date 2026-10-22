import type { APIRoute } from 'astro';
import { appIcon } from '../lib/app-icon.mjs';

/**
 * The favicon is the app's own launcher icon, read at build time from its
 * vector drawable, so the two never drift: the foreground's paths on the
 * icon's background, cropped to the part a launcher shows (72 of the
 * adaptive icon's 108 dp). Linked with a version (`faviconHref`), so a new
 * icon is never hidden behind a cached one.
 */
export const GET: APIRoute = () => {
  const { size, background, paths } = appIcon();
  const shown = +((size * 72) / 108).toFixed(2);
  const inset = +((size - shown) / 2).toFixed(2);
  const ink = paths.map(({ fill, d }) => `<path fill="${fill}" d="${d}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${inset} ${inset} ${shown} ${shown}"><rect x="${inset}" y="${inset}" width="${shown}" height="${shown}" rx="${(shown * 0.22).toFixed(2)}" fill="${background}"/>${ink}</svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
};

import type { APIRoute } from 'astro';
import { sealDots } from '../lib/art';

/** The favicon is the site's seal, drawn at build time like every other mark. */
export const GET: APIRoute = () => {
  const dots = sealDots('cantorfm.com', 2)
    .map((d) => `<circle cx="${d.x}" cy="${d.y}" r="${(d.r * 1.15).toFixed(4)}"/>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.55 -0.55 1.1 1.1"><style>circle{fill:#000}@media (prefers-color-scheme:dark){circle{fill:#fff}}</style>${dots}</svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
};

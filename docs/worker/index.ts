/**
 * cantorfm.com's front door. Everything is the built site's static assets
 * (dist/, with its `_redirects`); this only sends www.cantorfm.com to the one
 * canonical host, path and query intact.
 */
interface Env {
  ASSETS: Fetcher;
}

const CANONICAL = 'cantorfm.com';

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL && url.hostname.endsWith(`.${CANONICAL}`)) {
      url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

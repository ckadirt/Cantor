/**
 * cantorfm.com's front door. Nearly everything is the built site's static
 * assets (dist/, with its `_redirects`). The Worker does two things itself:
 * it sends www.cantorfm.com to the one canonical host, path and query intact,
 * and it keeps the Cantor Cloud list (`POST /api/cloud-list`), the only thing
 * this site ever stores about anyone.
 */
interface Env {
  ASSETS: Fetcher;
  /** The Cantor Cloud list (wrangler.jsonc). Absent until first deployed. */
  WAITLIST?: D1Database;
}

const CANONICAL = 'cantorfm.com';
const LIST_PATH = '/api/cloud-list';

/** One row per address: when it asked, and which link brought it (`?from=`). */
const SCHEMA =
  'CREATE TABLE IF NOT EXISTS cloud_list (email TEXT PRIMARY KEY, at TEXT NOT NULL, source TEXT)';
/** Loose on purpose: one @, a dot after it, no spaces. The mail decides the rest. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_SOURCE = 40;
const MAX_BODY = 2048;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function joinList(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  // Only the site's own form posts here: another page's script cannot.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return json(403, { ok: false, error: 'origin' });
  }
  if (!env.WAITLIST) return json(503, { ok: false, error: 'unavailable' });

  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { ok: false, error: 'too-long' });
  let body: { email?: unknown; from?: unknown; website?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: 'json' });
  }
  // The form's hidden field: a person leaves it empty, a form-filler does not.
  // It is told all went well, and nothing is kept.
  if (typeof body.website === 'string' && body.website !== '') return json(200, { ok: true });

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > MAX_EMAIL || !EMAIL.test(email)) return json(400, { ok: false, error: 'email' });
  const source =
    typeof body.from === 'string' ? body.from.replace(/[^a-z0-9_-]/gi, '').slice(0, MAX_SOURCE).toLowerCase() : '';

  // Asking twice keeps the first row, so the date stays the day they first asked.
  await env.WAITLIST.batch([
    env.WAITLIST.prepare(SCHEMA),
    env.WAITLIST.prepare('INSERT OR IGNORE INTO cloud_list (email, at, source) VALUES (?1, ?2, ?3)').bind(
      email,
      new Date().toISOString(),
      source || null,
    ),
  ]);
  return json(200, { ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== CANONICAL && url.hostname.endsWith(`.${CANONICAL}`)) {
      url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === LIST_PATH) {
      try {
        return await joinList(request, env);
      } catch {
        return json(500, { ok: false, error: 'unavailable' });
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

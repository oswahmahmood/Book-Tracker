/* Cloudflare Worker: the only thing standing between a reading list and a lost
 * phone. Paste this into a Worker, bind a KV namespace called LISTS, deploy.
 * Setup instructions are in the README.
 *
 * There are no accounts. A list is addressed by a long random key the app makes
 * for itself, and holding that key is what grants access — so the key is a
 * password, and a sync link carries it. Losing it means losing the list; giving
 * it away gives away the list. For a list of books that is the right trade: no
 * sign-in, nothing to remember, nothing of yours stored anywhere else.
 */
const MAX_BYTES = 256 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

const reply = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/list\/([^/]+)$/);
    if (!match || !KEY_PATTERN.test(match[1])) {
      return reply({ error: 'no list at that address' }, 404, cors);
    }
    const key = `list:${match[1]}`;

    if (request.method === 'GET') {
      const stored = await env.LISTS.get(key);
      if (!stored) return reply({ error: 'nothing stored yet' }, 404, cors);
      return new Response(stored, { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    if (request.method === 'PUT') {
      const body = await request.text();
      if (body.length > MAX_BYTES) return reply({ error: 'list too large' }, 413, cors);

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        return reply({ error: 'not JSON' }, 400, cors);
      }
      if (!Array.isArray(parsed?.books)) return reply({ error: 'expected a books array' }, 400, cors);

      await env.LISTS.put(key, body);
      return reply({ ok: true, savedAt: Date.now(), books: parsed.books.length }, 200, cors);
    }

    return reply({ error: 'method not allowed' }, 405, cors);
  },
};

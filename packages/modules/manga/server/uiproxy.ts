/**
 * Suwayomi's own web UI, served through this app.
 *
 * ### Why a proxy is the only way this works on a phone
 *
 * An `<iframe src="http://127.0.0.1:4567">` fails twice over. The PWA is served
 * over HTTPS by `tailscale serve`, and a browser blocks an http frame inside an
 * https page as mixed content — and worse, `127.0.0.1` *on the phone* is the
 * phone. There is no address that means "the PC's loopback" from another device.
 *
 * So the frame has to be same-origin, and the app has to carry the traffic.
 *
 * ### Suwayomi supports this, which is what makes it clean rather than a hack
 *
 * Its UI is built with relative asset paths and a `<base href="/">`, and its
 * `SubpathUtil` *derives its subpath from that base tag* — router basename, API
 * base and websocket URL all follow it. So rewriting one attribute to
 * `/manga/ui/` relocates the entire application, using a mechanism its authors
 * put there on purpose.
 *
 * Nothing else is rewritten. No JavaScript is patched, no URLs are found and
 * replaced in compiled bundles — the one edit is an attribute in the HTML, and
 * everything else follows from it.
 *
 * ### Websockets are not optional here
 *
 * The UI splits its Apollo link: queries and mutations over HTTP, subscriptions
 * over `graphql-ws`. Suwayomi answers an upgrade on the same path (verified:
 * HTTP 101). Without the upgrade proxied, the UI would load and work while
 * spraying reconnect failures and never showing live download progress — which
 * is worse than not offering it.
 *
 * It is proxied as a raw byte pipe rather than by parsing frames. A websocket
 * after the handshake is just bytes both ways, so nothing here needs to
 * understand them, and no dependency is added to do it.
 *
 * ### The cookie, which is this app's first
 *
 * A frame cannot send an `Authorization` header, and neither can the requests it
 * makes for its own scripts, images and socket. That leaves three carriers and
 * only one is any good:
 *
 *   - **a service worker** injecting the header — cannot work, because service
 *     workers do not intercept websockets;
 *   - **a token in the path** — works, and this project has already written down
 *     why it will not do that: the SSE stream uses `fetch` rather than
 *     `EventSource` precisely to avoid "putting the bearer token in a query
 *     string where it lands in history and proxy logs". A path segment has the
 *     same problem;
 *   - **a cookie**, which browsers attach to subresources and to the websocket
 *     upgrade alike.
 *
 * So a cookie, and a deliberately small one: its own random value rather than
 * the device token, `HttpOnly` so no script can read it, `SameSite=Strict` so it
 * is never sent from another site, `Path=/manga/ui` so it reaches nothing else,
 * `Secure` whenever the request arrived over TLS, and an expiry in memory so a
 * restart invalidates every one.
 *
 * It is minted by an ordinary authenticated `/api/` call, so the bearer token is
 * still what proves who you are. The cookie only carries that proof to a frame.
 */
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

/** Where the frame lives. Outside `/api/`, because nothing here can send a bearer token. */
export const UI_PREFIX = '/manga/ui';

const COOKIE = 'manga_ui';

/** Long enough for an evening's reading, short enough that a forgotten tab stops working. */
const SESSION_MS = 12 * 60 * 60_000;

/**
 * Live frame sessions, in memory only.
 *
 * A restart invalidates them all, which is the right default for something that
 * exists to let a frame talk to a local process — and it means nothing to clean
 * up on disk, unlike a device token.
 */
const sessions = new Map<string, number>();

function sweepSessions(now: number): void {
  for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
}

export function mintSession(now = Date.now()): { token: string; maxAgeSeconds: number } {
  sweepSessions(now);
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, now + SESSION_MS);
  return { token, maxAgeSeconds: Math.floor(SESSION_MS / 1000) };
}

export function sessionIsValid(token: string | null, now = Date.now()): boolean {
  if (!token) return false;
  const expires = sessions.get(token);
  if (expires === undefined) return false;
  if (expires <= now) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/**
 * One cookie's value out of a `Cookie` header.
 *
 * Parsed by hand rather than adding `@fastify/cookie` for a single name — the
 * same call `zip.ts` and the WAV writer make about their formats. Values here
 * are base64url, so nothing needs unescaping.
 */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${COOKIE}=${token}`,
    `Path=${UI_PREFIX}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * Headers that must not be forwarded.
 *
 * `host` because the target has its own; the hop-by-hop ones because they
 * describe *this* connection rather than the request; `cookie` because our
 * session cookie is ours and Suwayomi has no use for it; and the content
 * framing headers because `fetch` sets those itself from the body it is given.
 */
const SKIP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'content-length',
]);

const SKIP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

/**
 * The one edit: point the base tag at where this is actually served.
 *
 * `SubpathUtil.getServerSubpath()` reads exactly this and derives the router
 * basename, the API base and the websocket URL from it. Left alone, the UI would
 * load its assets correctly — they are relative — and then ask for
 * `/api/graphql` at the app's root, which is not Suwayomi.
 */
export function rewriteBase(html: string, prefix: string): string {
  return html.replace(/<base\s+href="[^"]*"\s*\/?>/i, `<base href="${prefix}/">`);
}

export function registerUiProxy(
  app: FastifyInstance,
  options: {
    /** Where Suwayomi is, or null when nothing is configured. */
    target: () => string | null;
    /** Called before proxying, so the frame can start a source that is only run on demand. */
    ensure: () => Promise<boolean>;
  }
): void {
  /*
   * Registered inside a plugin so the raw-body parser below is encapsulated.
   *
   * Fastify parses JSON into an object, and forwarding a re-serialised object is
   * not forwarding a request — it would reorder keys, drop anything the parser
   * did not understand, and mangle any non-JSON upload outright. A `*` parser
   * that keeps the buffer fixes it, and Fastify's encapsulation is what stops
   * that leaking out to every other route in the app.
   */
  void app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  /**
   * Everything under the prefix, any method.
   *
   * A wildcard rather than a route per path because this is a whole application
   * behind it — its assets, its API, its manifest and its service worker — and
   * enumerating those would be a list that goes stale on their next release.
   */
  scope.all(`${UI_PREFIX}/*`, async (request, reply) => {
    if (!sessionIsValid(cookieValue(request.headers.cookie, COOKIE))) {
      return reply.code(401).send({ error: 'open this from the Manga screen' });
    }

    const base = options.target();
    if (!base) return reply.code(400).send({ error: 'no source is configured' });
    if (!(await options.ensure())) return reply.code(502).send({ error: 'Suwayomi is not running' });

    const path = request.url.slice(UI_PREFIX.length) || '/';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (SKIP_REQUEST.has(key) || value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${base}${path}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : (request.body as any),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      return reply.code(502).send({ error: 'could not reach Suwayomi' });
    }

    for (const [key, value] of upstream.headers) {
      if (!SKIP_RESPONSE.has(key.toLowerCase())) reply.header(key, value);
    }
    reply.code(upstream.status);

    /*
     * HTML is buffered so the base tag can be rewritten; everything else is
     * streamed. Buffering the lot would hold a chapter's images in memory for no
     * reason, and streaming the HTML would mean rewriting across chunk
     * boundaries — where the tag could be split in half.
     */
    const type = upstream.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      return reply.send(rewriteBase(await upstream.text(), UI_PREFIX));
    }

    if (!upstream.body) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body as any));
  });
  });

  /**
   * The websocket, piped raw.
   *
   * Fastify has no route for an upgrade, so this hangs off the underlying HTTP
   * server — which is also why it re-checks the cookie itself rather than
   * inheriting any route's guard.
   */
  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url ?? '';
    if (!url.startsWith(`${UI_PREFIX}/`)) return;

    /*
     * Wrapped, because this is not a route.
     *
     * Fastify catches what a handler throws and answers 500; an `upgrade`
     * listener has nothing around it, so anything thrown here is an uncaught
     * exception and the whole server goes down — over a websocket for a frame
     * nobody may even have open.
     */
    try {
      proxyUpgrade(request, socket, head, options);
    } catch {
      socket.destroy();
    }
  });

  function proxyUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    options: { target: () => string | null }
  ): void {
    const url = request.url ?? '';

    const bail = (line: string) => {
      socket.write(`HTTP/1.1 ${line}\r\n\r\n`);
      socket.destroy();
    };

    if (!sessionIsValid(cookieValue(request.headers.cookie, COOKIE))) return bail('401 Unauthorized');

    const base = options.target();
    if (!base) return bail('400 Bad Request');

    let target: URL;
    try {
      target = new URL(base);
    } catch {
      return bail('500 Internal Server Error');
    }

    const path = url.slice(UI_PREFIX.length) || '/';
    const upstream = connect(Number(target.port || 80), target.hostname, () => {
      /*
       * The handshake is replayed by hand: the request line with the prefix
       * stripped, then the original headers with `Host` corrected. After the
       * server answers 101 nothing here understands the protocol — it is bytes
       * in both directions, which is all a websocket is once it is established.
       */
      const lines = [`GET ${path} HTTP/1.1`, `Host: ${target.host}`];
      for (const [key, value] of Object.entries(request.headers)) {
        if (key.toLowerCase() === 'host' || value === undefined) continue;
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    // Either side going away takes the other with it, or a dead pipe leaks a
    // socket per reconnect — and this client reconnects eagerly.
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }
}

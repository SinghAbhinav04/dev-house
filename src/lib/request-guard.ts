/**
 * Who may talk to this server.
 *
 * Hackeroom's API spawns agent sessions, edits the roster, starts and stops
 * runs and answers approvals, and none of it asks who is calling. That is
 * acceptable for exactly one caller: the page this server serves, in a browser
 * on the same machine. This module is what holds everyone else to that.
 *
 * Binding to 127.0.0.1 keeps other machines out, and is done in package.json.
 * It does nothing about the caller that is already on the machine: any web
 * page open in the user's browser can send a request to localhost. Three
 * checks, each closing a different way in:
 *
 * - **Host.** A hostile page cannot read our responses across origins - unless
 *   it makes its own name resolve to 127.0.0.1 (DNS rebinding), at which point
 *   the browser considers us the same origin as the attacker. The request
 *   still carries the attacker's name in Host, so a Host that is not a
 *   loopback name is refused. This is the only check that protects reads.
 * - **Origin.** A browser attaches Origin to every cross-origin request that
 *   can change anything. When present it has to be this server's own origin -
 *   not merely *a* localhost origin, because another local app on another port
 *   is as foreign to us as a remote site.
 * - **Content-Type.** A request that changes state has to be
 *   `application/json`. A cross-origin page cannot send that without the
 *   browser asking permission first (a preflight), which we never grant. It
 *   also means a form post or a `text/plain` body is not quietly parsed as
 *   JSON, which is what every route did before.
 *
 * A caller that is not a browser - curl, a script - sends no Origin and is not
 * what this defends against: it is already running as the user.
 *
 * Imports nothing from Next, so it can be tested as plain functions and used
 * both from the proxy and from a route.
 */

export type GuardVerdict = { ok: true } | { ok: false; status: number; error: string };

/**
 * A Host header naming this machine's loopback, with or without a port.
 *
 * Matched as text rather than parsed as a URL: `evil.example@127.0.0.1` parses
 * to the hostname 127.0.0.1, and a check for who the request was addressed to
 * is no place to be generous.
 */
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export function isLoopbackHost(host: string | null | undefined): boolean {
  return typeof host === 'string' && LOOPBACK_HOST.test(host);
}

/**
 * Whether an Origin header names the same origin the request was sent to.
 *
 * Compared on host and port. The scheme is left out on purpose: behind
 * `next dev --experimental-https` the Origin is https while nothing in the
 * request says so, and a page cannot share our host and port without being us.
 */
export function isSameOrigin(origin: string, host: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Includes the literal "null" a sandboxed frame or a file:// page sends.
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.host.toLowerCase() === host.toLowerCase();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Judge one request. `headers` is anything with a `get`, so both a `Headers`
 * and a `NextRequest`'s headers fit.
 */
export function checkRequest(request: {
  method: string;
  headers: { get(name: string): string | null };
}): GuardVerdict {
  const host = request.headers.get('host');
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      status: 403,
      error: 'Hackeroom only answers requests addressed to localhost.',
    };
  }

  const origin = request.headers.get('origin');
  if (origin !== null && !isSameOrigin(origin, host as string)) {
    return {
      ok: false,
      status: 403,
      error: 'Cross-origin requests are not accepted.',
    };
  }

  if (!SAFE_METHODS.has(request.method.toUpperCase()) && !isJsonContentType(request.headers.get('content-type'))) {
    return {
      ok: false,
      status: 415,
      error: 'Requests that change anything must be sent as application/json.',
    };
  }

  return { ok: true };
}

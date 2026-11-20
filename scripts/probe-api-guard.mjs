#!/usr/bin/env node

/**
 * Fire the requests a hostile page could cause at a RUNNING server and check
 * each is refused - and that the page's own requests are not.
 *
 * The unit suite (test-request-guard.mjs) proves the rules. It cannot prove
 * they are wired in: that is Next's doing, and only a real server shows it.
 * So this is a probe, like the others here, and not part of `npm test`.
 *
 *   npm run build && npm start &
 *   node scripts/probe-api-guard.mjs                       # http://127.0.0.1:3000
 *   node scripts/probe-api-guard.mjs http://127.0.0.1:4000
 *   node scripts/probe-api-guard.mjs --any-interface       # skip the bind check
 *
 * Changes nothing on the server: every request that gets past the guard is
 * one its route rejects on its own before acting.
 */

import http from 'node:http';
import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const anyInterface = args.includes('--any-interface');
const base = new URL(args.find((arg) => !arg.startsWith('--')) ?? 'http://127.0.0.1:3000');
const port = Number(base.port || 80);
const own = `localhost:${port}`;

/** A raw request, because fetch() will not let a caller choose Host or Origin. */
function send({ method = 'GET', path, host = own, headers = {}, body, address = base.hostname }) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: address, port, method, path, headers: { Host: host, ...headers }, timeout: 8000 },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          // An SSE stream never ends; the status is all that is wanted.
          text += chunk;
          if (text.length > 4000) response.destroy();
        });
        response.on('end', () => resolve({ status: response.statusCode, text }));
        response.on('close', () => resolve({ status: response.statusCode, text }));
      }
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (err) => resolve({ status: 0, text: err.code || err.message }));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

const JSON_TYPE = { 'Content-Type': 'application/json' };
const OWN_ORIGIN = { Origin: `http://${own}` };

// A POST the guard should let through and the route then turns down by itself.
const harmless = { method: 'POST', path: '/api/pipeline-control', body: JSON.stringify({ action: 'probe-noop' }) };

const checks = [
  // ── The page's own traffic ──────────────────────────────────────────
  ['the office page loads', { path: '/' }, 200],
  ['the team page loads', { path: '/team' }, 200],
  ['the state can be read', { path: '/api/state' }, 200],
  ['under 127.0.0.1 as well as localhost', { path: '/api/state', host: `127.0.0.1:${port}` }, 200],
  ["the page's own POST reaches its route", { ...harmless, headers: { ...OWN_ORIGIN, ...JSON_TYPE } }, 200, /Unsupported pipeline control action/],
  ['a script with no Origin reaches it too', { ...harmless, headers: JSON_TYPE }, 200],

  // ── Addressed to somebody else (DNS rebinding) ──────────────────────
  ['a rebound name cannot read the state', { path: '/api/state', host: 'evil.example' }, 403],
  ['nor the roster', { path: '/api/team', host: `evil.example:${port}` }, 403],
  ['nor the plan', { path: '/api/plan', host: 'evil.example' }, 403],
  ['nor open the event stream', { path: '/api/stream', host: 'evil.example' }, 403],
  ['nor load a page', { path: '/', host: 'evil.example' }, 403],
  ['a LAN address in Host is refused', { path: '/api/state', host: `192.168.1.20:${port}` }, 403],
  ['a name that only starts like localhost', { path: '/api/state', host: `localhost.evil.example:${port}` }, 403],

  // ── Sent by a page that is not ours ─────────────────────────────────
  ['a POST from another site', { ...harmless, headers: { Origin: 'http://evil.example', ...JSON_TYPE } }, 403],
  ['from another port on this machine', { ...harmless, headers: { Origin: 'http://localhost:8080', ...JSON_TYPE } }, 403],
  ['from a sandboxed frame', { ...harmless, headers: { Origin: 'null', ...JSON_TYPE } }, 403],
  ['Stop from another site', { method: 'POST', path: '/api/stop-pipeline', body: '{}', headers: { Origin: 'http://evil.example', ...JSON_TYPE } }, 403],
  ['Reset from another site', { method: 'POST', path: '/api/reset', body: '{}', headers: { Origin: 'http://evil.example', ...JSON_TYPE } }, 403],
  ['a chat turn from another site', { method: 'POST', path: '/api/chat', body: '{}', headers: { Origin: 'http://evil.example', ...JSON_TYPE } }, 403],
  ['a roster edit from another site', { method: 'POST', path: '/api/team', body: '{}', headers: { Origin: 'http://evil.example', ...JSON_TYPE } }, 403],
  ['a credential from another local app', { method: 'POST', path: '/api/cli-providers', body: '{}', headers: { Origin: 'http://localhost:8080', ...JSON_TYPE } }, 403],

  // ── Sent without asking: the three "simple" body types ──────────────
  ['a text/plain body', { ...harmless, headers: { ...OWN_ORIGIN, 'Content-Type': 'text/plain' } }, 415],
  ['a form post', { ...harmless, headers: { ...OWN_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' } }, 415],
  ['a multipart post', { ...harmless, headers: { ...OWN_ORIGIN, 'Content-Type': 'multipart/form-data; boundary=x' } }, 415],
  ['no Content-Type at all', { ...harmless, headers: OWN_ORIGIN }, 415],

  // ── Around the proxy ────────────────────────────────────────────────
  //
  // The header that let requests skip middleware entirely in Next releases
  // before 15.2.3 (CVE-2025-29927).
  ...['middleware:middleware:middleware:middleware:middleware', 'src/middleware:src/middleware:src/middleware:src/middleware:src/middleware', 'src/proxy:src/proxy:src/proxy:src/proxy:src/proxy', 'proxy:proxy:proxy:proxy:proxy'].map((value) => [
    `the old middleware-skipping header (${value.split(':')[0]})`,
    { ...harmless, headers: { Origin: 'http://evil.example', ...JSON_TYPE, 'x-middleware-subrequest': value } },
    403,
  ]),

  // ── A projectDir that is not a project ──────────────────────────────
  ['approving in a directory outside ~/Builds', { method: 'POST', path: '/api/approve', body: JSON.stringify({ approved: true, projectDir: '/tmp' }), headers: { ...OWN_ORIGIN, ...JSON_TYPE } }, 400, /inside ~\/Builds/],
  ['resuming in the root directory', { method: 'POST', path: '/api/resume-pipeline', body: JSON.stringify({ projectDir: '/' }), headers: { ...OWN_ORIGIN, ...JSON_TYPE } }, 400, /inside ~\/Builds/],
  ['an audit action somewhere else', { method: 'POST', path: '/api/audit-action', body: JSON.stringify({ action: 'deploy', projectDir: '/tmp' }), headers: { ...OWN_ORIGIN, ...JSON_TYPE } }, 400, /inside ~\/Builds/],
];

let failures = 0;
const report = (passed, name, detail) => {
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${passed ? '' : `  ${detail}`}`);
};

for (const [name, request, expected, bodyPattern] of checks) {
  const response = await send(request);
  const passed = response.status === expected && (!bodyPattern || bodyPattern.test(response.text));
  report(passed, name, `expected ${expected}${bodyPattern ? ` matching ${bodyPattern}` : ''}, got ${response.status} ${response.text.slice(0, 120)}`);
}

// ── Not listening anywhere but loopback ───────────────────────────────
//
// `npm run dev` and `npm start` bind 127.0.0.1. A server bound to every
// interface would answer here, whatever the guard then said.
if (anyInterface) {
  console.log('SKIP the bind check (--any-interface)');
} else {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);

  if (addresses.length === 0) console.log('SKIP the bind check (this machine has no other IPv4 address)');

  for (const address of addresses) {
    const response = await send({ path: '/api/state', address, host: `${address}:${port}` });
    report(response.status === 0, `nothing answers on ${address}:${port}`, `got ${response.status} ${response.text.slice(0, 60)}`);
  }
}

if (failures > 0) {
  console.error(`\nAPI guard probe failed: ${failures} check(s).`);
  process.exit(1);
}
console.log('\nAPI guard probe passed.');

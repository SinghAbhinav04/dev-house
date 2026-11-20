#!/usr/bin/env node

/**
 * Who the server will answer.
 *
 * The API has no authentication, so its whole defence is refusing every
 * caller except the page it serves. These are the requests a browser can be
 * made to send by a page that is not ours, and each has to be refused; and the
 * ones the real page sends, which must not be.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { checkRequest, isJsonContentType, isLoopbackHost, isSameOrigin } = await import('../src/lib/request-guard.ts');

function request(method, headers) {
  return { method, headers: new Headers(headers) };
}

const verdict = (method, headers) => checkRequest(request(method, headers));
const status = (method, headers) => {
  const result = verdict(method, headers);
  return result.ok ? 200 : result.status;
};

const JSON_TYPE = { 'content-type': 'application/json' };

// ── Host: who the request was addressed to ───────────────────────────

for (const host of ['localhost', 'localhost:3000', 'LOCALHOST:3000', '127.0.0.1', '127.0.0.1:3000', '[::1]', '[::1]:3000']) {
  assert.equal(isLoopbackHost(host), true, `${host} is this machine`);
}

for (const host of [
  'evil.example',
  'evil.example:3000',
  '192.168.1.20:3000',
  '10.0.0.71:3000',
  '0.0.0.0:3000',
  'localhost.evil.example',
  'evil.example.localhost',
  'localhost.',
  '127.0.0.1.evil.example',
  '127.0.0.2',
  'evil.example@127.0.0.1',
  'localhost:3000@evil.example',
  'localhost:3000/evil',
  'localhost:99999999',
  ' localhost',
  '',
  null,
  undefined,
]) {
  assert.equal(isLoopbackHost(host), false, `${JSON.stringify(host)} is not`);
}

assert.equal(status('GET', { host: 'localhost:3000' }), 200, 'the page loads');
assert.equal(status('GET', { host: 'evil.example:3000' }), 403, 'a rebound name cannot read anything');
assert.equal(status('GET', { host: '192.168.1.20:3000' }), 403, 'nor a request addressed to the LAN address');
assert.equal(status('GET', {}), 403, 'no Host at all is refused');
assert.equal(status('POST', { host: 'evil.example:3000', ...JSON_TYPE }), 403);

// ── Origin: where the page that sent it came from ────────────────────

assert.equal(isSameOrigin('http://localhost:3000', 'localhost:3000'), true);
assert.equal(isSameOrigin('http://127.0.0.1:3000', '127.0.0.1:3000'), true);
assert.equal(isSameOrigin('https://localhost:3000', 'localhost:3000'), true, 'https in front of the dev server is still us');
assert.equal(isSameOrigin('http://LOCALHOST:3000', 'localhost:3000'), true);

assert.equal(isSameOrigin('http://localhost:8080', 'localhost:3000'), false, 'another local app is not us');
assert.equal(isSameOrigin('http://127.0.0.1:3000', 'localhost:3000'), false, 'nor a different name for the same socket');
assert.equal(isSameOrigin('http://evil.example', 'localhost:3000'), false);
assert.equal(isSameOrigin('http://localhost:3000.evil.example', 'localhost:3000'), false);
assert.equal(isSameOrigin('null', 'localhost:3000'), false, 'a sandboxed frame or a file:// page');
assert.equal(isSameOrigin('file://', 'localhost:3000'), false);
assert.equal(isSameOrigin('chrome-extension://abcdef', 'localhost:3000'), false);
assert.equal(isSameOrigin('', 'localhost:3000'), false);

const own = { host: 'localhost:3000', origin: 'http://localhost:3000' };

assert.equal(status('POST', { ...own, ...JSON_TYPE }), 200, "the page's own POST is accepted");
assert.equal(
  status('POST', { host: 'localhost:3000', origin: 'http://evil.example', ...JSON_TYPE }),
  403,
  'a POST from another site is refused'
);
assert.equal(
  status('POST', { host: 'localhost:3000', origin: 'http://localhost:8080', ...JSON_TYPE }),
  403,
  'and from another port on this machine - the old check let that one through'
);
assert.equal(status('POST', { host: 'localhost:3000', origin: 'null', ...JSON_TYPE }), 403);
assert.equal(status('GET', { host: 'localhost:3000', origin: 'http://evil.example' }), 403, 'a cross-origin read is refused too');
assert.equal(status('POST', { host: 'localhost:3000', ...JSON_TYPE }), 200, 'curl sends no Origin and is not what this is for');

// ── Content-Type: what a page can send without asking ────────────────

for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', ' application/json ']) {
  assert.equal(isJsonContentType(type), true, `${type} is JSON`);
}
for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', 'text/json', '', null, undefined]) {
  assert.equal(isJsonContentType(type), false, `${JSON.stringify(type)} is not`);
}

// The three types a cross-origin page may send with no preflight. Before,
// every route parsed the body as JSON whatever it claimed to be.
for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
  assert.equal(status('POST', { ...own, 'content-type': type }), 415, `a ${type} POST is refused`);
}
assert.equal(status('POST', own), 415, 'so is a POST with no Content-Type at all');
assert.equal(status('PUT', own), 415);
assert.equal(status('DELETE', own), 415);
assert.equal(status('PATCH', { ...own, 'content-type': 'text/plain' }), 415);
assert.equal(status('post', { ...own, ...JSON_TYPE }), 200, 'the method is matched whatever its case');
assert.equal(status('GET', own), 200, 'a read needs no body and so no type');
assert.equal(status('HEAD', own), 200);

// Host is judged first: a refused request learns nothing about the rest.
assert.equal(status('POST', { host: 'evil.example', origin: 'http://localhost:3000', 'content-type': 'text/plain' }), 403);

const refusal = verdict('POST', { host: 'localhost:3000', origin: 'http://evil.example', ...JSON_TYPE });
assert.equal(refusal.ok, false);
assert.match(refusal.error, /cross-origin/i, 'a refusal says why');
assert.ok(!refusal.error.includes('evil.example'), 'without echoing what the caller sent');

// ── It is actually wired in ──────────────────────────────────────────
//
// A guard nothing calls protects nothing. These read the source, because the
// wiring is Next's to perform and cannot be exercised without a server; the
// live check is scripts/probe-api-guard.mjs.

const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

const proxy = read('src/proxy.ts');
assert.match(proxy, /export function proxy\(/, 'Next 16 looks for a function named proxy in src/proxy.ts');
assert.match(proxy, /checkRequest\(request\)/, 'and it consults the guard');
assert.match(proxy, /matcher: \['\/\(\(\?!_next\/\)\.\*\)'\]/, "on every path that is not one of Next's own assets");

function routeFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /^route\.(ts|tsx|js)$/.test(name) ? [relative(repoRoot, path)] : [];
  });
}

const routes = routeFiles(join(repoRoot, 'src', 'app'));
assert.ok(routes.length >= 15, 'the routes were found');
for (const route of routes) {
  assert.ok(!route.includes('_next'), `${route} is not under a path the proxy skips`);
}

const scripts = JSON.parse(read('package.json')).scripts;
assert.match(scripts.dev, /-H 127\.0\.0\.1\b/, 'npm run dev binds to loopback, not to every interface');
assert.match(scripts.start, /-H 127\.0\.0\.1\b/, 'and so does npm start');

// A POST the page sends without a JSON type is now a 415, so every one of
// them has to carry it. This is what Stop looked like before.
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'api' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

let posts = 0;
for (const file of sourceFiles(join(repoRoot, 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/fetch\(\s*['"`]\/api\/[^)]*?method:\s*'(POST|PUT|PATCH|DELETE)'[\s\S]{0,200}/g)) {
    posts++;
    assert.match(match[0], /'Content-Type':\s*'application\/json'/, `${relative(repoRoot, file)} sends JSON: ${match[0].slice(0, 50)}`);
  }
}
assert.ok(posts >= 10, 'the page\'s own POSTs were found');

console.log('request guard checks passed');

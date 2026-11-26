#!/usr/bin/env node

/**
 * The floating "more below" arrows.
 *
 * A pane that scrolls can hide what the user wants under its fold: the Start
 * button was below the fold of the dashboard, the chat box a screen below the
 * office. Every such pane gets an arrow at its bottom that scrolls it down.
 *
 * The rules - which panes get one, and where it goes - are plain functions
 * and are tested here. The DOM side cannot be run without a browser, so the
 * source is read to check it is wired: mounted once in the root layout, and
 * looking for panes itself rather than waiting to be told about each.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(repoRoot, path), 'utf8');

const {
  HINT_GAP,
  HINT_MARGIN,
  HINT_SIZE,
  MIN_PANE_HEIGHT,
  MIN_REMAINING,
  placeHints,
  remainingBelow,
  restingPlace,
  visibleBox,
  wantsHint,
} = await import('../src/lib/scroll-hints.ts');

const viewport = { width: 1280, height: 800 };

// ── How much is hidden below ────────────────────────────────────────

assert.equal(remainingBelow({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }), 600, 'at the top, everything past the fold is below');
assert.equal(remainingBelow({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }), 0, 'at the bottom, nothing is');
assert.equal(remainingBelow({ scrollTop: 640, scrollHeight: 1000, clientHeight: 400 }), 0, 'overscroll is not a negative amount');

// ── Which panes get an arrow ────────────────────────────────────────

assert.ok(wantsHint({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }), 'a pane with content below gets one');
assert.ok(!wantsHint({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }), 'scrolled to the bottom, it goes away');
assert.ok(!wantsHint({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 }), 'a pane that fits has none');
assert.ok(
  !wantsHint({ scrollTop: 600 - (MIN_REMAINING - 1), scrollHeight: 1000, clientHeight: 400 }),
  'a line or so short of the bottom counts as the bottom'
);
assert.ok(wantsHint({ scrollTop: 600 - MIN_REMAINING, scrollHeight: 1000, clientHeight: 400 }), 'and one pixel more does not');
assert.ok(
  !wantsHint({ scrollTop: 0, scrollHeight: 500, clientHeight: MIN_PANE_HEIGHT - 1 }),
  'a pane too short to carry an arrow (a growing text box) has none'
);

// ── The part of a pane that is on screen ────────────────────────────

assert.deepEqual(
  visibleBox({ left: 100, top: 600, width: 300, height: 500 }, viewport),
  { left: 100, top: 600, width: 300, height: 200 },
  'a pane running off the bottom of the screen is cut at the screen edge'
);
assert.equal(visibleBox({ left: 100, top: 900, width: 300, height: 500 }, viewport), null, 'a pane wholly below the screen has no visible part');
assert.equal(visibleBox({ left: -400, top: 0, width: 300, height: 500 }, viewport), null, 'nor one off to the side');

// ── Where one arrow goes ────────────────────────────────────────────

const pane = { left: 800, top: 100, width: 400, height: 500 };
assert.deepEqual(
  restingPlace(pane, viewport),
  { left: 800 + 200 - HINT_SIZE / 2, top: 100 + 500 - HINT_SIZE - HINT_MARGIN },
  'centred, just above the bottom edge of the pane'
);
assert.equal(
  restingPlace({ left: 800, top: 500, width: 400, height: 900 }, viewport).top,
  800 - HINT_SIZE - HINT_MARGIN,
  'for a pane running off the screen, just above the bottom of the screen: on the pane, where it can be seen'
);
assert.equal(
  restingPlace({ left: 800, top: 800 - (MIN_PANE_HEIGHT - 1), width: 400, height: 900 }, viewport),
  null,
  'a pane with only a sliver on screen gets none'
);
assert.equal(restingPlace({ left: 0, top: 0, width: HINT_SIZE, height: 500 }, viewport), null, 'nor one too narrow to hold it');

// ── Several at once ─────────────────────────────────────────────────

const page = { id: 'page', box: { left: 0, top: 0, width: 1280, height: 800 }, root: true };
const dashboard = { id: 'dashboard', box: { left: 830, top: 90, width: 420, height: 600 }, root: false };
const feed = { id: 'feed', box: { left: 40, top: 470, width: 780, height: 220 }, root: false };

const three = placeHints([dashboard, feed, page], viewport);
assert.deepEqual(three.map((hint) => hint.id), ['page', 'dashboard', 'feed'], 'the page is placed first, whatever order they were found in');
assert.deepEqual(
  three.find((hint) => hint.id === 'dashboard'),
  { id: 'dashboard', ...restingPlace(dashboard.box, viewport) },
  'an arrow with nothing in its way sits at its resting place'
);

// A pane centred at the bottom of the screen would put its arrow exactly
// where the page's is. It moves up instead.
const centred = { id: 'centred', box: { left: 440, top: 300, width: 400, height: 500 }, root: false };
const stacked = placeHints([centred, page], viewport);
const pageHint = stacked.find((hint) => hint.id === 'page');
const centredHint = stacked.find((hint) => hint.id === 'centred');
assert.deepEqual(pageHint, { id: 'page', ...restingPlace(page.box, viewport) }, 'the page keeps the bottom of the screen');
assert.equal(centredHint.left, pageHint.left, 'the other stays in its own column');
assert.equal(centredHint.top, pageHint.top - (HINT_SIZE + HINT_GAP), 'one step higher, clear of the first');

// No two arrows ever touch, however many panes share a column.
const column = [1, 2, 3].map((n) => ({ id: `pane-${n}`, box: { left: 440, top: 100, width: 400, height: 700 }, root: false }));
const many = placeHints([page, ...column], viewport);
assert.equal(many.length, 4, 'all four fit');
for (const a of many) {
  for (const b of many) {
    if (a === b) continue;
    const apart = Math.abs(a.left - b.left) >= HINT_SIZE + HINT_GAP || Math.abs(a.top - b.top) >= HINT_SIZE + HINT_GAP;
    assert.ok(apart, `${a.id} and ${b.id} do not overlap`);
  }
}

// A pane with no room left above the arrows already there goes without,
// rather than drawing its arrow outside itself.
const squat = { id: 'squat', box: { left: 440, top: 800 - MIN_PANE_HEIGHT, width: 400, height: MIN_PANE_HEIGHT }, root: false };
const crowded = placeHints([page, { ...squat, id: 'squat-1' }, { ...squat, id: 'squat-2' }], viewport);
assert.deepEqual(crowded.map((hint) => hint.id), ['page', 'squat-1'], 'the pane that cannot fit one is dropped');
for (const hint of crowded.filter((entry) => entry.id !== 'page')) {
  assert.ok(hint.top >= squat.box.top + HINT_MARGIN, 'and no arrow leaves the top of its own pane');
}

assert.deepEqual(placeHints([], viewport), [], 'no panes, no arrows');

// ── Wired in ────────────────────────────────────────────────────────

const layout = read('src/app/layout.tsx');
assert.match(layout, /import \{ ScrollDownHints \} from '@\/components\/shared\/ScrollDownHints'/, 'the root layout imports the arrows');
assert.equal(layout.match(/<ScrollDownHints \/>/g)?.length, 1, 'and mounts them once, so every page has them');

const component = read('src/components/shared/ScrollDownHints.tsx');
assert.match(component, /^'use client';/, 'the component runs in the browser');
assert.match(component, /querySelectorAll<HTMLElement>\('\*'\)/, 'it finds the panes itself: none has to be registered');
assert.match(component, /window\.scrollY/, 'the page itself is one of them');
assert.match(component, /addEventListener\('scroll', schedule, \{ capture: true/, 'it hears every pane scroll (scroll does not bubble)');
assert.match(component, /scrollTo\(\{ top: target\.scrollHeight/, 'a click takes the pane to its bottom');
assert.match(component, /aria-label="Scroll to bottom"/, 'and the button says what it does');
assert.match(component, /elementsFromPoint/, 'an arrow is not drawn through whatever covers its pane');
assert.match(component, /prefers-reduced-motion/, 'the scroll is not animated for someone who asked for no motion');

console.log('scroll hint checks passed');

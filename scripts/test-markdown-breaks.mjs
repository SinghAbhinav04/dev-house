import assert from 'node:assert/strict';

import { markdownForBoard, softenBreaks } from '../src/lib/markdown-breaks.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('<br> separates inside a table row and breaks the line elsewhere', () => {
  assert.equal(softenBreaks('a<br/>b\n| x<br>y | z |'), 'a\nb\n| x · y | z |');
  assert.equal(softenBreaks('no tags'), 'no tags');
});

test('a plan table becomes whiteboard lines, one per person', () => {
  const board = markdownForBoard(
    ['## Team and tasks', '| Who | Tasks | Estimate |', '|---|:--|--:|', '| Ada (coder) | DH-2 **Board**<br>DH-3 `drag` | 25m |', '| Rex | Reviews | — |'].join('\n'),
  );
  assert.equal(board, ['## Team and tasks', '- Ada (coder): DH-2 Board · DH-3 drag · 25m', '- Rex: Reviews'].join('\n'));
});

test('emphasis, code and links lose their marks; bullets and headings stay', () => {
  assert.equal(markdownForBoard('# Plan\n- **bold**, *it*, `code`, [link](http://x)\n* star bullet'), '# Plan\n- bold, it, code, link\n* star bullet');
});

console.log(`\n${passed} markdown board tests passed`);

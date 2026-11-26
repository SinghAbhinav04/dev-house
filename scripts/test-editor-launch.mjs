import assert from 'node:assert/strict';

import { findEditor } from '../src/lib/editor-launch.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const has = (...paths) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};

test('Windows: VS Code bin\\code.cmd resolves to Code.exe beside the install, never the batch file', () => {
  const plan = findEditor('C:\\review\\dh-2', {
    platform: 'win32',
    env: { PATH: 'C:\\Windows;C:\\Program Files\\Microsoft VS Code\\bin' },
    exists: has('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', 'C:\\Program Files\\Microsoft VS Code\\Code.exe'),
  });
  assert.equal(plan.label, 'VS Code');
  assert.equal(plan.command.toLowerCase(), 'c:\\program files\\microsoft vs code\\code.exe');
  assert.deepEqual(plan.args, ['C:\\review\\dh-2']);
});

test('Windows: Cursor is preferred, found three levels up from its launcher', () => {
  const plan = findEditor('C:\\r', {
    platform: 'win32',
    env: { Path: 'C:\\Cursor\\resources\\app\\bin;C:\\VSCode\\bin' },
    exists: has('C:\\Cursor\\resources\\app\\bin\\cursor.cmd', 'C:\\Cursor\\Cursor.exe', 'C:\\VSCode\\bin\\code.cmd', 'C:\\VSCode\\Code.exe'),
  });
  assert.equal(plan.label, 'Cursor');
  assert.equal(plan.command.toLowerCase(), 'c:\\cursor\\cursor.exe');
});

test('Linux: the first editor on PATH', () => {
  const plan = findEditor('/r', { platform: 'linux', env: { PATH: '/usr/bin:/snap/bin' }, exists: has('/snap/bin/code') });
  assert.equal(plan.command, '/snap/bin/code');
});

test('macOS: an app with no command-line tool opens with open -a', () => {
  const plan = findEditor('/r', {
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/Users/me' },
    exists: has('/Applications/Visual Studio Code.app/Contents/Info.plist'),
  });
  assert.deepEqual([plan.command, ...plan.args], ['open', '-a', 'Visual Studio Code', '/r']);
});

test('HACKEROOM_EDITOR wins; nothing installed gives null', () => {
  const plan = findEditor('/r', { platform: 'linux', env: { PATH: '/bin', HACKEROOM_EDITOR: 'nvim-qt' }, exists: has('/bin/nvim-qt', '/bin/code') });
  assert.equal(plan.command, '/bin/nvim-qt');
  assert.equal(findEditor('/r', { platform: 'linux', env: { PATH: '/bin' }, exists: () => false }), null);
});

console.log(`\n${passed} editor launch tests passed`);

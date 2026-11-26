import assert from 'node:assert/strict';
import { win32 } from 'node:path';

import {
  buildsDir,
  killPlan,
  parseCmdShim,
  resolveCommand,
  userHome,
} from '../src/lib/platform.ts';
import { antigravityHookCommand } from '../src/lib/cli/gates.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Home ─────────────────────────────────────────────────────────────

test('HOME wins on POSIX when it is absolute', () => {
  assert.equal(userHome({ HOME: '/tmp/h' }, 'linux'), '/tmp/h');
  assert.equal(userHome({ HOME: '/tmp/h' }, 'darwin'), '/tmp/h');
  assert.equal(buildsDir({ HOME: '/tmp/h' }, 'linux').replace(/\\/g, '/'), '/tmp/h/Builds');
});

test('on Windows HOME is honoured only as a native path', () => {
  assert.equal(userHome({ HOME: 'C:\\sandbox\\home' }, 'win32'), 'C:\\sandbox\\home');
  assert.equal(userHome({ HOME: '\\\\server\\share\\me' }, 'win32'), '\\\\server\\share\\me');
  // msys style, from Git Bash: not a path a native process can open.
  assert.notEqual(userHome({ HOME: '/c/Users/me' }, 'win32'), '/c/Users/me');
  assert.notEqual(userHome({ HOME: 'relative' }, 'linux'), 'relative');
});

// ── Kill ─────────────────────────────────────────────────────────────

test('stopping a run is a process-group signal on POSIX and taskkill /T on Windows', () => {
  assert.deepEqual(killPlan(4321, 'linux'), { command: 'signal-group', args: ['-4321', 'SIGTERM'] });
  assert.deepEqual(killPlan(4321, 'darwin'), { command: 'signal-group', args: ['-4321', 'SIGTERM'] });
  assert.deepEqual(killPlan(4321, 'win32'), { command: 'taskkill', args: ['/PID', '4321', '/T', '/F'] });
});

// ── Finding a CLI ────────────────────────────────────────────────────

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

test('an npm .cmd shim is seen through to its script', () => {
  assert.equal(
    parseCmdShim(NPM_SHIM, 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'),
    win32.resolve('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'),
  );
  assert.equal(parseCmdShim('@echo off\r\nsomething.exe %*\r\n', 'C:\\x\\y.cmd'), null, 'not an npm shim');
});

test('POSIX keeps the bare name for execvp', () => {
  assert.deepEqual(resolveCommand('claude', { platform: 'linux' }), { command: 'claude', prefixArgs: [], path: 'claude' });
});

const fakeFs = (files) => ({
  exists: (file) => Object.prototype.hasOwnProperty.call(files, file.toLowerCase()),
  readFile: (file) => files[file.toLowerCase()],
});

test('Windows takes .exe before a shim within one directory', () => {
  const resolved = resolveCommand('claude', {
    platform: 'win32',
    env: { PATH: 'C:\\bin', PATHEXT: '.COM;.CMD;.EXE' },
    ...fakeFs({ 'c:\\bin\\claude.cmd': NPM_SHIM, 'c:\\bin\\claude.exe': '' }),
  });
  assert.equal(resolved.command, 'C:\\bin\\claude.exe', 'even when PATHEXT lists .CMD first');
});

test('Windows follows PATH order across directories, seeing through an npm shim', () => {
  const files = {
    'c:\\npm\\claude.cmd': NPM_SHIM,
    'c:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '',
    'c:\\winget\\claude.exe': '',
  };
  const resolved = resolveCommand('claude', {
    platform: 'win32',
    env: { PATH: 'C:\\npm;C:\\winget', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    ...fakeFs(files),
    nodePath: 'C:\\node\\node.exe',
  });
  // First directory wins, as PATH order demands — but within it, .exe first.
  assert.equal(resolved.command, 'C:\\node\\node.exe', 'the npm dir comes first on PATH, so its shim is used');
  assert.deepEqual(resolved.prefixArgs, [win32.resolve('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')]);
});

test('Windows runs an .exe directly', () => {
  const resolved = resolveCommand('agy', {
    platform: 'win32',
    env: { Path: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
    ...fakeFs({ 'c:\\tools\\agy.exe': '' }),
  });
  assert.deepEqual(resolved, { command: 'C:\\tools\\agy.exe', prefixArgs: [], path: 'C:\\tools\\agy.exe' });
});

test('a batch file that cannot be seen through is never run via cmd.exe', () => {
  const resolved = resolveCommand('tool', {
    platform: 'win32',
    env: { PATH: 'C:\\bin' },
    ...fakeFs({ 'c:\\bin\\tool.bat': '@echo off\r\nsomething %*' }),
  });
  assert.equal(resolved.command, 'tool', 'falls through to ENOENT rather than shelling out');
});

test('an explicit PATH overrides an inherited Path', () => {
  const resolved = resolveCommand('agy', {
    platform: 'win32',
    env: { Path: 'C:\\real', PATH: 'C:\\stub' },
    ...fakeFs({ 'c:\\real\\agy.exe': '', 'c:\\stub\\agy.exe': '' }),
  });
  assert.equal(resolved.command, 'C:\\stub\\agy.exe');
});

// ── Hook commands ────────────────────────────────────────────────────

test('agy is given a runnable hook command on every platform', () => {
  assert.equal(antigravityHookCommand('/p/.claude/hooks/gate-antigravity.mjs', 'linux'), '/p/.claude/hooks/gate-antigravity.mjs');
  const win = antigravityHookCommand('C:\\p\\.claude\\hooks\\gate-antigravity.mjs', 'win32');
  assert.match(win, /^"[^"]+" "C:\\p\\\.claude\\hooks\\gate-antigravity\.mjs"$/, 'node and the shim, each quoted');
});

console.log(`\n${passed} platform tests passed`);

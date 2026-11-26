/**
 * Find the user's code editor and open a folder in it — for reviewing a
 * ticket's branch. Tried in order: $HACKEROOM_EDITOR, Cursor, VS Code,
 * Windsurf, VS Code Insiders, Zed, Sublime Text.
 *
 * Never through a shell. On Windows the editors' `bin\code.cmd`-style
 * launchers are batch files, so the real `.exe` beside the install is found
 * and run directly; on macOS an app bundle is opened with `open -a` when its
 * command-line tool was never installed.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export interface EditorCandidate {
  id: string;
  label: string;
  command: string;
  /** macOS application name, for `open -a`. */
  macApp?: string;
}

export const EDITORS: readonly EditorCandidate[] = [
  { id: 'cursor', label: 'Cursor', command: 'cursor', macApp: 'Cursor' },
  { id: 'code', label: 'VS Code', command: 'code', macApp: 'Visual Studio Code' },
  { id: 'windsurf', label: 'Windsurf', command: 'windsurf', macApp: 'Windsurf' },
  { id: 'code-insiders', label: 'VS Code Insiders', command: 'code-insiders', macApp: 'Visual Studio Code - Insiders' },
  { id: 'zed', label: 'Zed', command: 'zed', macApp: 'Zed' },
  { id: 'subl', label: 'Sublime Text', command: 'subl', macApp: 'Sublime Text' },
];

export interface LaunchPlan {
  label: string;
  command: string;
  args: string[];
}

export interface FindOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const value = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '';
  return value.split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** On Windows: `…\Microsoft VS Code\bin\code.cmd` → `…\Microsoft VS Code\Code.exe`. */
function windowsExeFor(cmdPath: string, name: string, exists: (p: string) => boolean): string | null {
  let dir = win32.dirname(cmdPath);
  const exe = `${name}.exe`.toLowerCase();
  for (let up = 0; up < 4; up++) {
    for (const candidate of [win32.join(dir, exe), win32.join(dir, exe.charAt(0).toUpperCase() + exe.slice(1))]) {
      if (exists(candidate)) return candidate;
    }
    const parent = win32.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** How to open `folder` in the first editor found, or null if none is installed. */
export function findEditor(folder: string, options: FindOptions = {}): LaunchPlan | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const dirs = pathDirs(env, platform);
  const preferred = env.HACKEROOM_EDITOR?.trim();
  const list: EditorCandidate[] = preferred
    ? [{ id: preferred, label: preferred, command: preferred }, ...EDITORS.filter((e) => e.command !== preferred)]
    : [...EDITORS];

  for (const editor of list) {
    if (platform === 'win32') {
      for (const dir of dirs) {
        const exe = win32.join(dir, `${editor.command}.exe`);
        if (exists(exe)) return { label: editor.label, command: exe, args: [folder] };
        for (const ext of ['.cmd', '.bat']) {
          const shim = win32.join(dir, `${editor.command}${ext}`);
          if (!exists(shim)) continue;
          // `code` → Code.exe, `cursor` → Cursor.exe beside the install.
          const real = windowsExeFor(shim, editor.command.replace(/-insiders$/, ' - Insiders'), exists) ?? windowsExeFor(shim, editor.command, exists);
          if (real) return { label: editor.label, command: real, args: [folder] };
        }
      }
      continue;
    }
    for (const dir of dirs) {
      const bin = posix.join(dir, editor.command);
      if (exists(bin)) return { label: editor.label, command: bin, args: [folder] };
    }
    if (platform === 'darwin' && editor.macApp) {
      for (const root of ['/Applications', posix.join(env.HOME ?? '', 'Applications')]) {
        if (exists(posix.join(root, `${editor.macApp}.app`, 'Contents', 'Info.plist'))) {
          return { label: editor.label, command: 'open', args: ['-a', editor.macApp, folder] };
        }
      }
    }
  }
  return null;
}

/** Start the editor detached, so it outlives the request and the dev server. */
export function launchEditor(plan: LaunchPlan): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!existsSync(plan.command) && plan.command !== 'open') {
      resolve({ ok: false, error: `${plan.label} was not found at ${plan.command}` });
      return;
    }
    try {
      const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (err) => resolve({ ok: false, error: err.message }));
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
    }
  });
}

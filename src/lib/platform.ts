/**
 * Everything that differs between Windows, macOS and Linux, in one place.
 *
 * The app used to assume a POSIX host throughout: `chmod`, `pgrep -g`, signals
 * to a negative pid, `npx`, `open`, a bash hook and a bare binary name for
 * every CLI. Each of those fails on Windows, several of them silently. Code
 * that needs one of these asks here instead of branching on the platform
 * itself, and the branches are tested in scripts/test-platform.mjs with the
 * platform injected.
 *
 * No imports beyond node built-ins, so the hooks and the tests can load it.
 */

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter as hostDelimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';

export type Platform = NodeJS.Platform;

export const IS_WINDOWS = process.platform === 'win32';

/**
 * The user's home directory, honouring `HOME` when it is a real path.
 *
 * `os.homedir()` already reads HOME on POSIX. On Windows it reads USERPROFILE
 * and ignores HOME, which meant every test that sandboxed HOME was in fact
 * writing to the real ~/Builds, and the gate, run under Git Bash, could look
 * at a different Builds folder from the server. A msys-style `/c/Users/x` is
 * not a path a native process can open, so on Windows HOME is only taken when
 * it has a drive letter or is a UNC path.
 */
export function userHome(env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): string {
  const home = env.HOME;
  if (home) {
    if (platform === 'win32') {
      if (/^[a-zA-Z]:[\\/]/.test(home) || home.startsWith('\\\\')) return home;
    } else if (isAbsolute(home)) {
      return home;
    }
  }
  return homedir();
}

export function buildsDir(env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): string {
  return join(userHome(env, platform), 'Builds');
}

/** `chmod`, which means nothing on Windows and must not fail there. */
export function makeExecutable(file: string, platform: Platform = process.platform): void {
  if (platform === 'win32') return;
  try {
    chmodSync(file, 0o755);
  } catch {}
}

// ── Finding a CLI binary ─────────────────────────────────────────────

export interface ResolvedCommand {
  /** What to pass to spawn as the command. */
  command: string;
  /** Arguments that go before the caller's own. */
  prefixArgs: string[];
  /** Absolute path that was found, for diagnostics. */
  path: string;
}

interface ResolveOptions {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
  nodePath?: string;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * npm's Windows shim, `foo.cmd`, ends in a line that runs node on the package's
 * real entry point:
 *
 *   "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
 *
 * Running the .cmd itself needs `cmd.exe`, and cmd.exe re-parses every
 * argument — a prompt containing `&`, `|`, `^`, `%` or a newline would be cut
 * short or, worse, run. So the script is pulled out of the shim and run with
 * node directly, where arguments pass through untouched.
 */
export function parseCmdShim(text: string, shimPath: string): string | null {
  const match = /"%(?:dp0|~dp0)%\\?([^"]+?\.(?:c?js|mjs))"/i.exec(text);
  if (!match) return null;
  const relative = match[1].replace(/\\/g, '/');
  return win32.resolve(win32.dirname(shimPath), relative);
}

/**
 * Turn a CLI name into something spawn can run without a shell, on any OS.
 *
 * POSIX keeps the bare name: execvp searches PATH. On Windows, PATH and
 * PATHEXT are walked so `claude` finds `claude.exe` or an npm `claude.cmd`
 * shim; the shim is unwrapped into `node cli.js`. Nothing is ever run through
 * a shell.
 */
export function resolveCommand(name: string, options: ResolveOptions = {}): ResolvedCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command: name, prefixArgs: [], path: name };

  const env = options.env ?? process.env;
  const exists = options.exists ?? isFile;
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  const nodePath = options.nodePath ?? process.execPath;

  // Already a path: only the extension may need finding.
  // Windows env names are case-insensitive, so a copied env can hold PATH and
  // Path at once. An explicit PATH is the override and wins.
  const pathValue = env.PATH ?? env.Path ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const dirs = /[\\/]/.test(name) ? [''] : pathValue.split(';').filter(Boolean);
  const pathExt = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  // .exe first: a native binary is always the better thing to run than a shim.
  const order = ['.exe', ...pathExt.filter((e) => e !== '.exe')];
  const hasExt = /\.[a-z0-9]+$/i.test(name);

  for (const dir of dirs) {
    const base = dir ? win32.join(dir, name) : name;
    const candidates = hasExt ? [base] : order.map((ext) => `${base}${ext}`);
    for (const candidate of candidates) {
      if (!exists(candidate)) continue;
      const lower = candidate.toLowerCase();
      if (lower.endsWith('.exe') || lower.endsWith('.com')) {
        return { command: candidate, prefixArgs: [], path: candidate };
      }
      if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
        let script: string | null = null;
        try {
          script = parseCmdShim(readFile(candidate), candidate);
        } catch {}
        if (script && exists(script)) return { command: nodePath, prefixArgs: [script], path: candidate };
        // A batch file we cannot see through is skipped rather than run via
        // cmd.exe; see parseCmdShim for why.
        continue;
      }
    }
  }

  // Not found: hand back the name and let spawn report ENOENT as it would.
  return { command: name, prefixArgs: [], path: name };
}

// ── Processes ────────────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface KillPlan {
  command: 'taskkill' | 'signal-group';
  args: string[];
}

/** What stopping a process tree means on this platform. Pure, for tests. */
export function killPlan(pid: number, platform: Platform = process.platform): KillPlan {
  if (platform === 'win32') return { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return { command: 'signal-group', args: [String(-pid), 'SIGTERM'] };
}

/**
 * Stop a process and everything it started. Returns false when there was
 * nothing left to stop.
 *
 * POSIX: the orchestrator is spawned detached, so it leads its own process
 * group and every member turn inherits it; one signal to the group reaches
 * all of them. Windows has no process groups to signal, so `taskkill /T`
 * walks the tree instead.
 */
export function killProcessTree(pid: number, platform: Platform = process.platform): boolean {
  const plan = killPlan(pid, platform);
  if (plan.command === 'taskkill') {
    if (!isProcessAlive(pid)) return false;
    try {
      execFileSync('taskkill', plan.args, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch (err) {
      // 128: no such process. It went away between the check and the kill.
      if ((err as { status?: number }).status === 128) return false;
      throw err;
    }
  }
  try {
    process.kill(-pid, 'SIGTERM');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

/** Open a file or URL with the desktop's default handler. Never throws. */
export function openPath(target: string, platform: Platform = process.platform): void {
  try {
    const [command, args] =
      platform === 'darwin'
        ? ['open', [target]]
        : platform === 'win32'
          ? ['cmd', ['/c', 'start', '""', target.replace(/[&|<>^]/g, '')]]
          : ['xdg-open', [target]];
    const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

/**
 * How to run a TypeScript entry point with tsx, without `npx`.
 *
 * `npx` is a shell script on POSIX and a .cmd on Windows, and resolves tsx
 * from the network if it is not installed — which it was not. tsx is now a
 * dependency, and its CLI is run with this very node binary.
 */
export function tsxCommand(entry: string, args: string[], repoRoot: string = process.cwd()): { command: string; args: string[] } {
  const cli = tsxCliPath(repoRoot);
  if (!cli) throw new Error(`tsx is not installed in ${repoRoot}. Run "pnpm install".`);
  return { command: process.execPath, args: [cli, entry, ...args] };
}

export function tsxCliPath(repoRoot: string): string | null {
  for (const candidate of [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(dirname(repoRoot), 'node_modules', 'tsx', 'dist', 'cli.mjs')]) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

export const PATH_DELIMITER = hostDelimiter;

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');

export async function GET() {
  try {
    if (existsSync(BUILDS_DIR)) {
      const dirs = readdirSync(BUILDS_DIR)
        .map(name => join(BUILDS_DIR, name))
        .filter(p => {
          try { return statSync(p).isDirectory() && statSync(join(p, 'plan.md')).isFile(); }
          catch { return false; }
        })
        .sort((a, b) => statSync(join(b, 'plan.md')).mtimeMs - statSync(join(a, 'plan.md')).mtimeMs);

      if (dirs.length > 0) {
        const content = readFileSync(join(dirs[0], 'plan.md'), 'utf8');
        return NextResponse.json({ content });
      }
    }

    // Fallback to project root plan.md
    const rootPlan = join(process.cwd(), 'plan.md');
    if (existsSync(rootPlan)) {
      const content = readFileSync(rootPlan, 'utf8');
      return NextResponse.json({ content });
    }
  } catch {}
  return NextResponse.json({ content: null }, { status: 404 });
}

export async function POST(req: Request) {
  try {
    const { content } = await req.json();
    if (typeof content !== 'string') {
      return NextResponse.json({ error: 'Plan content must be a string' }, { status: 400 });
    }

    // 1. Write to project root plan.md
    const rootPlan = join(process.cwd(), 'plan.md');
    writeFileSync(rootPlan, content, 'utf8');

    // 2. Also write to latest build directory if it exists
    try {
      if (!existsSync(BUILDS_DIR)) {
        mkdirSync(BUILDS_DIR, { recursive: true });
      }
      const dirs = readdirSync(BUILDS_DIR)
        .map(name => join(BUILDS_DIR, name))
        .filter(p => {
          try { return statSync(p).isDirectory(); }
          catch { return false; }
        })
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

      if (dirs.length > 0) {
        writeFileSync(join(dirs[0], 'plan.md'), content, 'utf8');
      }
    } catch {}

    return NextResponse.json({ ok: true, content });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to save plan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

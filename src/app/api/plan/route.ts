import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextResponse } from 'next/server';

const BUILDS_DIR = join(homedir(), 'Builds');

export async function GET() {
  try {
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
  } catch {}
  return NextResponse.json({ content: null }, { status: 404 });
}

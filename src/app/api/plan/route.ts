import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { NextResponse } from 'next/server';

import { findLatestProject } from '@/lib/pipeline-control';

/**
 * The plan of the latest run, read-only.
 *
 * This used to accept writes too, and put them in `plan.md` at the root of
 * this repository and in whichever Builds folder was touched last. Nothing
 * ever read either copy back, so an edit on the whiteboard silently went
 * nowhere. The whiteboard now writes a brief through /api/board, which the
 * planner is given; the plan itself is the planner's to write.
 */
export async function GET() {
  try {
    const projectDir = findLatestProject();
    if (projectDir) {
      const file = join(projectDir, 'plan.md');
      if (existsSync(file)) return NextResponse.json({ content: readFileSync(file, 'utf8') });
    }
  } catch {}
  return NextResponse.json({ content: null }, { status: 404 });
}

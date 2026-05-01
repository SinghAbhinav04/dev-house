import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PendingApproval {
  requestId: string;
  projectDir: string;
  agent: string;
  tool: string;
  input: Record<string, unknown>;
  description: string;
  createdAt: string;
  approved: boolean | null;
  sessionId?: string;
  phase?: string;
  reason?: string;
}

export const PENDING_APPROVAL_FILE = 'pipeline-pending.json';
export const APPROVED_BASH_GRANT_FILE = 'pipeline-approved-bash.json';

export interface ApprovedBashGrant {
  requestId: string;
  projectDir: string;
  agent: string;
  command: string;
  createdAt: string;
}

export function pendingApprovalPath(projectDir: string): string {
  return join(projectDir, PENDING_APPROVAL_FILE);
}

export function approvedBashGrantPath(projectDir: string): string {
  return join(projectDir, APPROVED_BASH_GRANT_FILE);
}

export function readPendingApproval(projectDir: string): PendingApproval | null {
  const file = pendingApprovalPath(projectDir);
  if (!existsSync(file)) return null;

  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PendingApproval;
  } catch {
    return null;
  }
}

export function writePendingApproval(projectDir: string, pending: PendingApproval): void {
  writeFileSync(pendingApprovalPath(projectDir), JSON.stringify(pending, null, 2));
}

export function readApprovedBashGrant(projectDir: string): ApprovedBashGrant | null {
  const file = approvedBashGrantPath(projectDir);
  if (!existsSync(file)) return null;

  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ApprovedBashGrant;
  } catch {
    return null;
  }
}

export function writeApprovedBashGrant(projectDir: string, grant: ApprovedBashGrant): void {
  writeFileSync(approvedBashGrantPath(projectDir), JSON.stringify(grant, null, 2));
}

export function clearApprovedBashGrant(projectDir: string, requestId?: string): void {
  const current = readApprovedBashGrant(projectDir);
  if (!current) return;
  if (requestId && current.requestId !== requestId) return;

  try {
    unlinkSync(approvedBashGrantPath(projectDir));
  } catch {}
}

export function clearPendingApproval(projectDir: string, requestId?: string): void {
  const current = readPendingApproval(projectDir);
  if (!current) return;
  if (requestId && current.requestId !== requestId) return;

  try {
    unlinkSync(pendingApprovalPath(projectDir));
  } catch {}
}

export function updatePendingApproval(projectDir: string, approved: boolean, requestId?: string): boolean {
  const current = readPendingApproval(projectDir);
  if (!current) return false;
  if (requestId && current.requestId !== requestId) return false;

  current.approved = approved;
  writePendingApproval(projectDir, current);
  return true;
}

export function findLatestPendingApproval(
  buildsDir: string = join(homedir(), 'Builds')
): { projectDir: string; pending: PendingApproval } | null {
  try {
    const dirs = readdirSync(buildsDir)
      .filter((name) => name !== '.staging' && name !== '.manual')
      .map((name) => join(buildsDir, name))
      .filter((projectDir) => {
        try {
          return statSync(projectDir).isDirectory() && statSync(pendingApprovalPath(projectDir)).isFile();
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          statSync(pendingApprovalPath(b)).mtimeMs - statSync(pendingApprovalPath(a)).mtimeMs
      );

    for (const projectDir of dirs) {
      const pending = readPendingApproval(projectDir);
      if (pending?.approved === null) {
        return { projectDir, pending };
      }
    }
  } catch {}

  return null;
}

export async function waitForPendingApproval(
  projectDir: string,
  requestId: string,
  timeoutMs: number = 60 * 60 * 1000,
  pollMs: number = 350
): Promise<boolean | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pending = readPendingApproval(projectDir);
    if (!pending || pending.requestId !== requestId) return null;
    if (pending.approved !== null) return pending.approved;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return null;
}

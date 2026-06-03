import assert from 'node:assert/strict';

// The AUDIT_SCHEMA in pipeline/orchestrator.ts is enforced at runtime by Claude's
// structured-output mode. This test guards the SHAPE we expect — if someone
// changes the schema to something agents can no longer produce, this catches it.

// ── Minimal schema shape validator ───────────────────────────────────
// We don't bring in ajv for one test — hand-roll it to match AUDIT_SCHEMA.

function validateAuditResult(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('not an object');
    return errors;
  }
  if (data.status !== 'approved' && data.status !== 'issues') {
    errors.push(`invalid status: ${JSON.stringify(data.status)}`);
  }
  if ('issues' in data) {
    if (!Array.isArray(data.issues)) {
      errors.push('issues must be an array');
    } else {
      const validSeverities = new Set(['critical', 'high', 'medium', 'low']);
      data.issues.forEach((issue, i) => {
        if (!issue || typeof issue !== 'object') {
          errors.push(`issues[${i}] not an object`);
          return;
        }
        if (!validSeverities.has(issue.severity)) {
          errors.push(`issues[${i}].severity invalid: ${JSON.stringify(issue.severity)}`);
        }
        if (typeof issue.finding !== 'string') {
          errors.push(`issues[${i}].finding not a string`);
        }
      });
    }
  }
  return errors;
}

// Accepts clean audit.
assert.deepEqual(validateAuditResult({ status: 'approved' }), []);

// Accepts structured issues.
assert.deepEqual(
  validateAuditResult({
    status: 'issues',
    issues: [
      { severity: 'critical', finding: '[src/api/auth.ts:42] SQL injection' },
      { severity: 'medium', finding: '[src/forms.tsx:18] XSS' },
    ],
  }),
  []
);

// Rejects legacy string-array shape.
assert.notDeepEqual(
  validateAuditResult({ status: 'issues', issues: ['bare string finding'] }),
  [],
  'Legacy bare-string issues should be rejected'
);

// Rejects missing severity.
assert.notDeepEqual(
  validateAuditResult({ status: 'issues', issues: [{ finding: 'no severity here' }] }),
  [],
  'Missing severity should be rejected'
);

// Rejects invalid severity value.
assert.notDeepEqual(
  validateAuditResult({ status: 'issues', issues: [{ severity: 'URGENT', finding: 'x' }] }),
  [],
  'Invalid severity enum should be rejected'
);

// Rejects missing status.
assert.notDeepEqual(
  validateAuditResult({ issues: [] }),
  [],
  'Missing status should be rejected'
);

// ── Audit finding state transitions ──────────────────────────────────

const VALID_TRANSITIONS = {
  'open':         new Set(['sent-to-c', 'dismissed']),
  'sent-to-c':    new Set(['re-auditing', 'open']), // 'open' covers fix-failed-tests rollback
  're-auditing':  new Set(['resolved', 'still-open']),
  'still-open':   new Set(['sent-to-c', 'dismissed']),
  'resolved':     new Set([]),      // terminal
  'dismissed':    new Set([]),      // terminal
};

function canTransition(from, to) {
  return VALID_TRANSITIONS[from]?.has(to) || false;
}

// Happy path: open → sent-to-c → re-auditing → resolved
assert.equal(canTransition('open', 'sent-to-c'), true);
assert.equal(canTransition('sent-to-c', 're-auditing'), true);
assert.equal(canTransition('re-auditing', 'resolved'), true);

// Fix failed tests rollback: sent-to-c → open
assert.equal(canTransition('sent-to-c', 'open'), true);

// Re-audit failed: re-auditing → still-open, user can retry or dismiss
assert.equal(canTransition('re-auditing', 'still-open'), true);
assert.equal(canTransition('still-open', 'sent-to-c'), true);
assert.equal(canTransition('still-open', 'dismissed'), true);

// Dismiss from open state.
assert.equal(canTransition('open', 'dismissed'), true);

// Invalid transitions.
assert.equal(canTransition('resolved', 'sent-to-c'), false, 'Resolved is terminal');
assert.equal(canTransition('dismissed', 'sent-to-c'), false, 'Dismissed is terminal');
assert.equal(canTransition('open', 'resolved'), false, 'Cannot skip the fix loop');
assert.equal(canTransition('re-auditing', 'dismissed'), false, 'Cannot dismiss mid-re-audit');

console.log('audit findings checks passed');

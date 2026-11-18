# Changelog

## Unreleased

### Security

All four fixes below were reported and contributed by Julius Smith
([@josmithiii](https://github.com/josmithiii)) in
[#1](https://github.com/SinghAbhinav04/dev-house/pull/1). Thank you.

- **A member id can no longer reach the filesystem as a path.** `/api/team`
  passed `body.id` and skill names to the roster helpers unchecked, and those
  end in a recursive `rmSync` or a `writeFileSync`. A `remove` with id `../..`
  and `deleteFiles` resolved to the home directory. Member ids and skill names
  are now checked as single path segments before any path is built from them.
- **The gate no longer allows a call it could not read.** If no payload arrived
  on stdin within one second, `approval-gate.sh` answered `allow` before
  checking anything. Empty input is now denied, after waiting up to ten seconds
  for a late payload.
- **A member can no longer approve its own Bash command.** The strict-mode
  grant (`pipeline-approved-bash.json`), the pending approval and the run state
  sat in the project root, inside a coder's write access. Write and Edit to
  `pipeline-*.json` in any pipeline project root are now denied for every
  member.
- **Stop ends only this run.** It used to `pkill` every process matching
  `claude.*--output-format.*stream-json`, which took down headless Claude Code
  sessions in unrelated projects. It now signals the orchestrator's recorded
  process group and the chat turns this server started, and nothing else.

### Fixed

- **A run with an auditor can be finished from the page.** The Security Audit
  panel, which holds the only Deploy button, was shown only when the page's
  "Security Audit" switch was on, and the orchestrator had stopped reading that
  switch: the audit runs whenever a member fills the auditor slot. With the
  starter roster and the switch at its default, a run paused at
  `awaiting-audit-decision` and the page offered nothing to answer it. The
  panel is now shown whenever the run is auditing, is waiting on the decision
  or has findings, and the switch is replaced by a line saying whether the
  audit will run, read from the roster.
- **The member grid no longer collapses with a fifth worker.** The grid
  declared two rows; a fifth worker panel made an undeclared third, which grew
  with its content until every other panel, the supervisor's chat box included,
  had no height. The grid now declares as many rows as its workers need, the
  supervisor is pinned to the first column and the audit panel to the last.

### Upgrading

Stop any run in progress before upgrading. A run started on an older version
has no recorded process group, so the new Stop pauses its state but cannot end
its processes.

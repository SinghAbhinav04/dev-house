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

The API has no authentication, and until now anything that could reach port
3000 could use it. It now answers one caller: the page it serves, in a browser
on the same machine.

- **The server listens on 127.0.0.1 only.** `npm run dev` and `npm start`
  used Next's default, which is every interface, so the app was reachable from
  the whole network.
- **Requests addressed to any other host are refused.** A Host header that is
  not `localhost`, `127.0.0.1` or `[::1]` gets a 403, for pages as well as the
  API. This is what stops a hostile site reading the roster or the run state by
  pointing its own name at 127.0.0.1 (DNS rebinding).
- **Requests from any other origin are refused.** An Origin header has to be
  this server's own origin. The one route that checked before,
  `/api/cli-providers`, accepted any localhost origin, so a page served by
  another local app on another port could post to it.
- **Requests that change anything must be `application/json`.** Every route
  parsed its body as JSON whatever the Content-Type said, which let a page on
  any site send one as `text/plain` with no preflight. Those now get a 415.
- **A `projectDir` in a request has to be a project.** `/api/approve`,
  `/api/resume-pipeline` and `/api/audit-action` used the path as given. It
  must now resolve, through symlinks, to a directory directly inside
  `~/Builds`.
- **Stop always pauses the run.** It could throw if `pgrep` was missing, or if
  the orchestrator exited between being found and being signalled, and that
  left the run marked as running. It now pauses regardless and says in the run
  log when it could not confirm the orchestrator has stopped.
- **The gate refuses shell writes to the run's control files.** The Write and
  Edit block on `pipeline-*.json` now has a Bash counterpart for the grant, the
  pending approval and the run state. Reading them from a shell is still
  allowed.

### Changed

- **Text about the team names its members.** The feed, the supervisor's
  recommendations and the audit panel still called members by the letters of
  the old fixed team: "Ask S to start", "Sent plan to B for review", "Send to
  C". Each now uses the name of the member filling that seat, or the seat's
  label when it is empty. The prompts the orchestrator writes for one member
  about another's work do the same.

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

The app can no longer be opened from another machine. To use it remotely,
forward the port over SSH (`ssh -L 3000:127.0.0.1:3000 <host>`) and open
`http://localhost:3000` as before.

Anything scripted against the API has to send `Content-Type:
application/json` on every POST, including ones with no body, such as
`/api/stop-pipeline`.

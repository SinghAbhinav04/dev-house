# Security

Read this before pointing Hackeroom at anything you care about.

## What this is

Hackeroom spawns Claude Code sessions that write files and run shell commands
on your machine. A `PreToolUse` hook gates every tool call against a capability
manifest, so a member told "only write the plan" is actually prevented from
writing code rather than merely asked not to.

**It is a role guardrail, not a sandbox.** It keeps well-behaved sessions in
their lane and stops the ordinary accidents. It is not a containment boundary
against a model actively trying to escape one.

## What the hook guarantees

These hold regardless of how a member is configured. No manifest value unlocks
them:

| Guarantee | Why it matters |
|---|---|
| `.claude/` is unwritable by every member | Stops a member editing the hook, the settings, or its own capability entry |
| Non-supervisor members are jailed to the project root | A coder cannot reach into another project or your home directory |
| The Agent tool is blocked | No recursive spawning of sub-agents that would inherit nothing |
| Bash cannot mutate hooks or settings | Closes the obvious route around the file-write rules |
| Bash cannot run `claude` or set `PIPELINE_AGENT` | Stops a member re-spawning itself with a different identity |
| Bash cannot create links | Closes the symlink and hardlink escape from the write jail |
| Slot artifacts have exactly one owner | This is what "the plan is locked" actually means |
| A member absent from the manifest is denied everything | Unknown identity fails closed |
| Any unhandled tool is denied | New tools are denied by default, not allowed by default |

Paths are resolved before checking: `..` is rejected outright, and directory
and file symlinks are resolved so a link cannot point outside the jail.

54 contract tests in `scripts/test-hook-contract.mjs` run the real shell script
against a temporary `$HOME`. A reimplementation would prove nothing, so the
tests drive the actual file that ships.

```bash
npm run test:hook
```

## What it does not protect against

Be clear-eyed about these.

**Indirect execution.** The Bash filters are pattern matches on the command
string. `python3 -c`, `eval`, `base64 -d | sh` and similar can express anything
the filters block. This cannot be fixed with more patterns — it needs OS-level
isolation.

**Hardlinks.** Symlinks are resolved; hardlinks are not detectable this way. A
pre-existing hardlink into the project could be written through.

**A member with `bash: "all"` or `bypassPermissions`.** Both are available and
both are real reductions in safety. `bypassPermissions` skips Claude's own
classifier entirely, leaving only the hook between that member and your files.
The `/team` page says so next to the setting. Use them when you mean it.

**Anything outside `~/Builds` is only protected by the jail.** The jail is a
path prefix check in shell. It is careful, but it is shell.

**Prompt injection through project content.** A member reading a file that
contains instructions may act on them. Nothing here detects that. If you point
this at a repository you did not write, assume its contents can influence what
your members do.

**The signal fallback fails open.** If a member's structured output cannot be
parsed at all, the orchestrator treats it as approval and advances. A member
that crashes mid-sentence can therefore look like an approval.

## Modes

**Fast** (default) — members with `bash: "safe"` run commands without asking.
Claude's own permission classifier still applies.

**Strict** — those same members must have every Bash call approved by you.
Approvals are single-use and matched on the exact command; a grant issued to
one member is not honoured for another.

Per-member `bash` levels sit on top: `none` blocks Bash entirely, `approval`
always asks even in fast mode, `all` never asks even in strict mode.

## Isolation

A Docker runner exists (`pipeline/runner.ts`) with per-member network profiles
and read-only mounts for members that do not need to write. It is **not the
default** and is not the recommended path: Claude Code subscription
authentication inside containers is not reliable enough.

When it is unavailable, the run does not quietly continue without it. Losing
isolation changes what a member can reach, so it is treated as a safety
decision rather than an availability one:

- **Ask** (default) — the run pauses before the session starts and asks whether
  to continue on the host. Denying stops the run.
- **Required** — the run fails instead of asking. The runner enforces this
  itself, so nothing above it can relocate the member to the host.

Both the coder and the tester default to `preferIsolated`, so they are the two
this applies to. Every turn records which side of the boundary it ran on.

See [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md) for the honest status.

## Reasonable precautions

- Run it against projects you own, in a directory you would not mind losing
- Keep strict mode on for anything unfamiliar
- Leave `bypassPermissions` alone unless you have a specific reason
- Read `plan.md` before letting the coder start — it is the whole instruction
  set for everything that follows
- Set token budgets so a runaway member is visible early

## Reporting something

Open an issue at
<https://github.com/SinghAbhinav04/dev-house/issues>. If it is a genuine escape
from the hook's guarantees rather than one of the known limitations above,
please say so in the title and I will treat it as a priority.

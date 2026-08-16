# Security roadmap

The honest status of what is built, what is not, and what is not planned.

For what the hook guarantees today and where it falls short, see
[SECURITY.md](SECURITY.md).

## Shipped

**Manifest-driven enforcement.** The hook resolves each member against a
capability manifest written by the server at run start. Members are
user-authored, so there is no fixed set of identities to hardcode — but an
unknown one is denied rather than defaulted.

**Unconditional clamps.** `.claude/` unwritable, project jail, Agent tool
blocked, no link creation, no `claude` re-spawn, no `PIPELINE_AGENT`
reassignment, deny-by-default on unhandled tools. No configuration reaches
these.

**Artifact ownership.** A slot's artifact belongs to one member. Everyone else
is locked out even with project-wide write access.

**Per-member permission modes.** Each member carries its own
`--permission-mode`, resolved per spawn. Previously the mode was read once at
module load, so one setting applied to a whole run.

**Request-scoped Bash approvals.** Strict mode escalates each command to you.
Grants are single-use and bound to both the member and the exact command
string.

**Per-member token budgets.** A warning when a member passes its allowance,
with the numbers visible on `/team`. Deliberately not a hard stop — see below.

**Contract tests.** 54 cases driving the real hook script, including malformed
member ids, a missing manifest, and attempts to rewrite the hook or the
manifest from a member with `bash: "all"`.

## Not shipped, would accept

**Hardlink detection.** Symlinks are resolved; hardlinks are not. Detecting
them means stat-ing inode link counts on every write, which is doable.

**Signal fallback failing closed.** Unparseable structured output is currently
treated as approval. It should be treated as failure, but changing it without
care would make transient CLI hiccups look like build failures. Needs a
distinction between "no output" and "output I could not parse".

**Append-only event log.** The state file is rewritten whole on every event
with no locking. This blocks parallel members in one slot, and is the reason
multi-fill is accepted by the schema but not run.

**Egress allowlisting.** `web: true` is currently all-or-nothing per member.
Per-domain would be better for a planner that should read documentation but
not arbitrary URLs.

## Not planned

**Sandboxed execution as the default.** The Docker runner exists, with
per-member network profiles and read-only mounts, and it works in narrow cases.
It is not the default and is not going to become it: Claude Code subscription
authentication inside containers is unreliable enough that runs fail in ways
that look like the tool being broken. When it does fail, the run falls back to
the host and says so in the event log.

If you need genuine isolation, run the whole thing in a VM. That is a real
answer; a container that cannot reliably authenticate is not.

**Defeating indirect execution.** The Bash filters are pattern matches. `python3
-c`, `eval` and `base64 -d | sh` can express anything they block, and no amount
of additional patterns changes that. Anyone claiming a shell-pattern allowlist
is a security boundary is selling something. This is a guardrail against
accidents, and it is described that way throughout.

**Hard-stopping a member at its budget.** Killing a run mid-coding leaves a
half-written project and no path to finish it. The budget tells you a member is
more expensive than expected; stopping is your call.

## Threat model

What this defends against:

- A member doing something outside its role by accident or misunderstanding
- A prompt that talks a member into exceeding its remit
- Ordinary mistakes: writing to the wrong project, editing a locked plan,
  running something destructive without asking

What it does not defend against:

- A model deliberately working to escape the guardrail
- Malicious content in a repository influencing what members do
- Anything requiring OS-level isolation to prevent

If your threat model includes the second list, this is the wrong tool, and no
version of it will be the right one. Use a VM.

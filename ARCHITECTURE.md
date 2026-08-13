# Architecture

Hackeroom gives Claude Code a dev team. You create the members; the system runs
them as real Claude Code sessions, routes work between them, and enforces what
each one may do.

There is no built-in squad. Everything below resolves against a roster you own.

## The roster

A member is a name, a role prompt, a set of skills, a model, a permission mode,
and a set of capabilities. All of it lives on disk under `HACKEROOM_HOME`
(default `~/.hackeroom`):

```
team.json                       the roster and workflow config
members/<id>/role.md            the member's system prompt, used verbatim
members/<id>/plugin/            the member's skills, as a Claude Code plugin
  .claude-plugin/plugin.json
  skills/<skill>/SKILL.md
templates/roles/*.md            starter roles offered when creating a member
```

Member ids are lowercase slugs. The id is the directory name, the
`PIPELINE_AGENT` value the security hook checks, and the key under which
sessions and token spend are recorded — which is why it is validated hard and
is not renameable.

The office has room for **seven** members. Past that you are told the office is
too small.

## Slots

A slot is a seat in the workflow, not a person. The orchestrator never names a
member; it asks the roster who is filling a slot.

| Slot | Job | Default write | Default bash | Web |
|---|---|---|---|---|
| `planner` | Researches, writes `plan.md`, confirms completion | its artifact | none | yes |
| `reviewer` | Challenges the plan until there are no gaps | none | none | yes |
| `coder` | Builds exactly what the locked plan says | the project | safe | no |
| `tester` | Reviews code against the plan, then runs it | none | safe | no |
| `auditor` | Read-only OWASP-class pass over the result | none | none | no |
| `supervisor` | Human-facing front door, explains and recovers | `~/Builds` | safe | yes |

Capabilities are defaults for member *creation*, not enforcement. Enforcement
is the hook.

**Multi-fill is accepted by the schema but not yet run.** Two members can be
assigned to one slot; the runtime uses the first and reports the rest as
ignored. Running them concurrently needs an append-only event log first — today
the whole state file is rewritten on every event with no locking, so parallel
writers would corrupt it.

## The run

`buildRunPlan()` turns the roster into what will actually happen. An empty or
switched-off slot is skipped, and the skips cascade:

- **no planner** — the run refuses to start; nothing would own the plan
- **no coder** — plan-only, whatever the configured goal says
- **no reviewer** — the plan locks after the planner's own pass, with no
  external approval gate to wait on
- **no tester** — *both* the code-review loop and the testing loop are skipped
- **no auditor** — the audit phase does not run

The plan is announced in the event log at run start, including every skip, so
the shape of a run is visible rather than inferred from what never happened.

### Phases

```
concept → planning → plan-review → coding → code-review → testing
        → security-audit → deploy → complete
```

`pipeline/orchestrator.ts` is deterministic code, not an LLM. It spawns
sessions in order, parses their streaming JSON, routes structured signals,
advances on approval, tracks spend per member, persists recoverable session
ids, and writes everything to `pipeline-events.json`.

The orchestrator cannot be talked out of a step.

### Signals

Members do not communicate in prose. They emit structured output:

```json
{ "status": "approved" }
{ "status": "questions", "questions": ["What about error handling?"] }
{ "status": "issues", "issues": ["Missing input validation on POST /users"] }
{ "status": "passed" }
{ "status": "failed", "failures": ["PUT /users returns 500 on empty body"] }
```

The preferred path is `--json-schema` plus a `StructuredOutput` tool result.
There is a text-parsing fallback, and it is worth knowing that **the fallback
fails open**: output that cannot be parsed at all is treated as approval.

## Spawning

Each member runs as its own Claude Code session:

```bash
claude -p "<prompt>" \
  --permission-mode acceptEdits \
  --model haiku \
  --effort max \
  --system-prompt-file ~/.hackeroom/members/reacty/role.md \
  --plugin-dir  <repo>/templates/team-plugin \
  --plugin-dir  ~/.hackeroom/members/reacty/plugin \
  --output-format stream-json --verbose
```

Everything varying in that command comes from the member record, resolved per
spawn. Two members in the same run routinely differ in model, effort and
permission mode.

`PIPELINE_AGENT` carries the member id to the hook.
`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` stops a `cd` leaking into later
file edits.

### Skills

Per-member skills work because `--plugin-dir` is session-scoped. The shared
`<cwd>/.claude/skills` location could not isolate anything — every member runs
with the same working directory.

This also makes attached documentation nearly free. A skill's name and
description sit in context; the body loads only when the model invokes it.

## Enforcement

LLMs ignore instructions in prompts. A member told "only write plan.md" will
write code.

`pipeline/.claude/hooks/approval-gate.sh` gates every tool call. Since members
are user-authored there is no fixed set of identities to match, so the server
writes a capability manifest at run start and the hook reads it:

```json
{ "version": 1,
  "artifacts": { "plan.md": "pat" },
  "members": {
    "pat":    { "slot": "planner", "write": "artifact", "bash": "none", "web": true,  "denyPhases": ["concept"] },
    "reacty": { "slot": "coder",   "write": "project",  "bash": "safe", "web": false, "denyPhases": [] }
  } }
```

The manifest is data the hook *consults*, not a grant of authority. These hold
regardless of what it says:

- `.claude/` is unwritable by every member — which is what stops one editing
  its own permissions
- every member whose write level is not `builds` is jailed to the project root
- the Agent tool is blocked, so nothing spawns sub-agents
- Bash cannot mutate hooks or settings, create links, spawn `claude`, or touch
  `PIPELINE_AGENT`
- an artifact belongs to one member; nobody else may write it even with
  project-wide access — that is what "the plan is locked" means
- a member absent from the manifest is denied outright
- any tool not explicitly handled is denied

The one deliberate widening is the memory inbox: every member may `Write` a new
`.md` file directly into `.squad/memory/inbox/`, including the read-only ones.
A reviewer that cannot record what it found is a reviewer whose findings die
with its session. Never `Edit`, no subdirectories, no other extensions.

54 contract tests in `scripts/test-hook-contract.mjs` drive the real shell
script against a temp `$HOME`.

**This is a guardrail, not a sandbox.** See [SECURITY.md](SECURITY.md).

## Shared memory

Members cannot see each other's sessions. Memory is how anything survives a
turn, and it is designed around token cost:

```
<project>/.squad/memory/
  index.md              one ~120-char line per fact — the only part injected
  entries/<id>.md       full detail, read on demand
  inbox/<member>-*.md   where members drop new facts
  archive.md            rotated-out index lines
```

A line looks like:

```
[m17] decision · auth · Sessions are JWT-based, not database-backed · src/lib/auth.ts
```

Members write to the inbox; the orchestrator folds it into the index between
turns, so the index has exactly one writer. Claims are deduplicated on a
normalised form, so the same fact phrased differently by two members is
recorded once. The index is capped and rotates to `archive.md`, which keeps the
injected block a fixed cost however much the team has learned.

Recording is exposed as a `squad-memory` skill attached to every member, so the
instructions for it cost roughly one line until used.

## Accounting

`state.usage` is `{ total, byMember, byModel }`. The CLI reports usage and
`total_cost_usd` on each result event and the orchestrator always knows which
member it spawned, so attribution is free.

Budgets count input + output + cache *writes*. Cache reads are excluded on
purpose — counting them would make a member look expensive precisely when
caching is working. A member over budget gets a warning, not a halt: killing a
run mid-coding leaves a half-written project and no way to finish it.

`runtime.activeTurns` records, per member, what they are working on and when
that turn started. That is what the office hover card reads.

## The viewer

A Next.js app. State reaches the browser over SSE (`/api/stream`), which
replaced three concurrent polls — a 400 ms state poll, a 500 ms approvals poll
and a 1 s clock, together about five requests a second, each re-parsing the
whole state file. The server watches the file's mtime and pushes only on
change.

**Office** (`/`) — the room, one desk per member. Desk positions are measured
against the artwork; slot assignment decides who sits where. Empty desks draw
nothing.

**Squad** (`/squad`) — the same runtime without scenery, plus a terminal pane
rendering tool calls and their results.

**Team** (`/team`) — roster management, role editing, skill attachment, models,
permissions, budgets, per-slot toggles and live spend.

### API

| Route | Purpose |
|---|---|
| `GET /api/stream` | SSE state and approvals |
| `GET /api/state` | Snapshot; initial load and fallback |
| `POST /api/chat` | Spawn a session for direct chat |
| `GET/POST /api/team` | Roster read and mutation |
| `POST /api/start-pipeline` | Promote staging to a project, spawn the orchestrator |
| `POST /api/pipeline-control` | Arm or clear stop-after-review |
| `POST /api/resume-pipeline` | Continue an approved plan, or resume a stalled turn |
| `POST /api/stop-pipeline` | Kill the orchestrator and its sessions |
| `POST /api/approve` | Answer a pending Bash approval |
| `POST /api/audit-action` | Send a finding to the coder, dismiss it, or deploy |
| `POST /api/reset` | Clear staging and reset stuck projects |

## Data flow

```
You type in a view
  → POST /api/chat → spawns a claude session → writes .staging/pipeline-events.json
  → /api/stream notices the file changed → pushes state → the view updates

You start a run
  → POST /api/start-pipeline
  → staging becomes ~/Builds/<project>/
  → the capability manifest and hook are written into <project>/.claude/
  → the orchestrator spawns detached and writes pipeline-events.json
  → /api/stream pushes each change
```

## Manual mode

The orchestrator does not exist. You are it.

No phases, no automation. Each member gets a one-line system prompt derived
from their slot and speciality rather than their full role file. State lives in
`~/Builds/.manual/manual-state.json`. Sessions resume via `--resume`. Claude's
own permission prompts still apply; the pipeline guardrails do not.

## Known rough edges

- The signal text-fallback fails open on unparseable output
- Multi-fill slots are accepted but only the first member runs
- The state file is rewritten whole on every event, with no locking; events
  rotate to numbered archives past a cap, but concurrent writers would still
  corrupt it
- Sandboxed execution is not the default and is not on the roadmap; see
  [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md)

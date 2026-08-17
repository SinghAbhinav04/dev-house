# Hackeroom

Give Claude Code a dev team.

You create the members. Each one gets a name, a role you write in markdown,
skills you attach, a model, and a permission mode. They fill seats in a
workflow, work in real Claude Code sessions, share what they learn, and you
watch the whole thing happen in an office.

There is no built-in squad. The team is whoever you hire.

---

## What it actually does

**Members are yours.** Create `reacty` as a frontend coder on Haiku with
auto-accept, attach your UI guidelines as a skill, and give him a role prompt
you wrote. Create `pat` as a planner on Opus who only ever writes the plan.
Nothing is hardcoded — not the names, not the count, not the capabilities.

**Skills are per member.** Each member's skills are packaged as a Claude Code
plugin loaded with `--plugin-dir` for that session only. Attaching a long
document to one member costs about fifteen tokens of context until they
actually need it, and nobody else can see it.

**They remember things.** Members run as separate sessions and cannot see each
other's conversations, so anything one learns dies with its turn unless it is
written down. Shared memory splits into a one-line-per-fact index that goes
into every prompt, and full entries read on demand. The injected block stays a
bounded cost no matter how much the team has recorded.

**You choose who runs.** A slot with nobody in it is skipped. Building a
frontend and don't want the tester? Switch the slot off and code review and
testing drop out of the run:

```
Phases: planning → coding → deploy
• No tester — code review and testing are skipped.
```

**You can see the cost.** Tokens and spend are attributed per member and per
model, so you can tell which member is expensive and move them to a cheaper
one.

---

## Getting started

```bash
pnpm install
npm run dev
```

Open <http://localhost:3000>, then **Manage Team** to hire someone. Or from the
terminal:

```bash
npm run team -- starter                      # one member per slot, to start from
npm run team -- add reacty --name Reacty --title Frontend \
                 --slot coder --model haiku --permission acceptEdits
npm run team -- skill reacty ui-docs ./ui-guidelines.md \
                 --desc "House style for buttons and spacing"
npm run team -- slot tester off              # skip the tester on the next run
npm run team -- list
```

Your team lives in `~/.hackeroom/` — `team.json`, plus a directory per member
holding their `role.md` and their skills.

### Requirements

- Node 22+ and pnpm
- Claude Code 2.1.220 or newer, logged in
- Docker, only if you want the isolated runner (it is not the default; see
  [SECURITY-ROADMAP.md](SECURITY-ROADMAP.md))

---

## The three views

**Office** (`/`) — the room. One desk per member, and you watch them work:
walking between desks to hand things over, wandering to the café or the sofas
when idle. Hover anyone for uptime, tokens, cost, energy and what they are
doing right now.

**Squad** (`/squad`) — the same run without the scenery. Supervisor-first chat,
direct tabs for each member, and a terminal pane showing the live tool calls
and their results.

**Team** (`/team`) — hire, fire, edit roles, attach skills, set models and
permissions and budgets, switch slots on and off, and see what everyone has
spent.

---

## Slots

The workflow has six seats. A member takes one by being assigned to it.

| Slot | Does | Can write |
|---|---|---|
| `planner` | Researches and writes the build plan | `plan.md` only |
| `reviewer` | Pokes holes in the plan until there are none | nothing |
| `coder` | Builds exactly what the locked plan says | the project |
| `tester` | Reviews the code, then runs and tests it | nothing |
| `auditor` | Read-only OWASP-class pass over the result | nothing |
| `supervisor` | Your front door; explains and recovers the run | `~/Builds` |

Leave a seat empty and its phase is skipped. No planner means no run at all —
nothing would own the plan.

---

## How restrictions are enforced

Not by asking nicely in a prompt. A `PreToolUse` hook gates every tool call
against a capability manifest the server writes at run start, and members
cannot write to `.claude/` so they cannot edit their own permissions.

Some clamps are unconditional and no configuration can unlock them: `.claude/`
is unwritable, every member except the supervisor is jailed to the project
directory, the Agent tool is blocked so nothing can spawn sub-agents, Bash
cannot mutate hooks or spawn `claude`, and any tool that is not explicitly
handled is denied.

The hook has 54 contract tests covering exactly these cases.

**It is a guardrail, not a sandbox.** Read [SECURITY.md](SECURITY.md) before
you point this at anything you care about.

---

## Where things live

```
src/lib/team/      roster, slots, capabilities, memory, token accounting
src/app/api/       chat, run control, SSE state stream, team management
pipeline/          the orchestrator, the runner, the security hook
templates/roles/   starter roles offered when creating a member
scripts/           the test suite and the team CLI
```

`ARCHITECTURE.md` has the full picture.

---

## Tests

```bash
npm test          # 13 suites
npm run typecheck
npm run lint
```

Plain node scripts with `node:assert` — no framework. The hook contract test
runs the real shell script against a temp `$HOME`, because a reimplementation
of a security boundary tests nothing.

---

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE). Use it, change it, share it, run it,
learn from it — freely. Selling it, or building it into something you sell,
needs permission.

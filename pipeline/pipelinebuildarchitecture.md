# Pipeline Build Architecture

One supervisor. Four core specialists, plus one optional security auditor. They pass work back and forth until it's right.

This file is the conceptual pipeline sketch. For the current implementation and security model, use [ARCHITECTURE.md](../ARCHITECTURE.md), [SECURITY.md](../SECURITY.md), and [SECURITY-ROADMAP.md](../SECURITY-ROADMAP.md).

---

## The Agents

- **S — Supervisor**: Supervisor/operator for the team. Reads broadly, helps when things go wrong, and is the direction for the human-facing control surface.
- **A — Planner**: Builds the plan, answers questions, and handles the final handoff
- **B — Plan Reviewer**: Pokes holes in the plan until there are none left
- **C — Coder**: Follows the approved plan and writes the code
- **D — Code Reviewer + Tester**: Reviews the code against the plan, then tests it
- **E — Security Auditor** *(optional)*: Read-only OWASP-class audit after `D` reports tests passing. Only runs if the user enabled the Security Audit toggle at build start. Severity-ranked findings are surfaced to the user, not auto-merged. The user decides per finding whether to send a scoped fix to `C`, dismiss, or ignore — then explicitly clicks Deploy.

## Shared Doctrine

The team should operate from the same doctrine:

- `build-plan-template.md`
- `checklist.md`
- the locked `plan.md` once approved

That is the backbone of the team model. The hook supports discipline and safety, but the doctrine is what keeps the team aligned.

---

## The Flow

### Phase 0: Concept

1. The **user** usually gives the build concept to **S** first. Direct Planner chat still works, but the supervisor is now the recommended front door.
2. **S** captures the concept and can start the team, pause after review, continue an approved plan, or help recover a stalled run.
3. **A** can still ask clarifying questions when the concept is not complete enough to plan against.
4. From this point forward, the pipeline runs autonomously by default. The user can still steer through the supervisor, intervene directly with specialists, or approve Bash commands in strict mode.

### Phase 1: Planning

5. The pipeline creates a project folder in `~/Builds/` — named based on the project theme or idea. All files for this build live here.
6. **A** reads `build-plan-template.md`. This is A's playbook. A follows it step by step.
7. **A** completes the entire checklist in the template — research, write, verify, context, and one self-review pass.
8. **A** writes the plan to `plan.md` in the project folder. This is the single source of truth.
9. When the checklist is fully complete, **A** sends the plan to **B** with context — what was researched, what was verified, what the coder needs to know.
10. **B** reads the plan and sends questions back to **A**. These are real questions — gaps, assumptions, things that do not add up. If B has no questions, B approves immediately.
11. **A** answers every question with verified information and updates the plan file.
12. **B** reviews the answers. If satisfied, **B** approves. If not, **B** sends more questions.
13. This continues until **B** is fully satisfied. There is no round limit. The plan is not done until **B** says it is done.
14. Once approved, the plan is locked. No agent changes this file from that point forward. If the supervisor selected `Plan Only` or `Stop After Review`, the run can pause cleanly here.

### Phase 2: Coding

15. The approved plan is handed to **C**.
16. **C** reads the plan and builds exactly what it says. No improvising, no interpreting, no "improving."
17. If **C** has a question — something unexpected at implementation time — **C** asks **A**. **A** answers. **C** continues.
18. When **C** is finished coding, the work moves to **D**.

### Phase 3: Code Review

19. **D** reads the plan. **D** reads the code. **D** checks: does the code match the plan?
20. If **D** has issues — missing pieces, wrong implementation, things that don't match the plan — **D** sends recommended fixes back to **C**.
21. **C** makes the fixes and sends back to **D**.
22. **D** reviews the fixes. If **D** still has issues, back to **C**. If **D** is satisfied with the code, **D** moves to testing.

### Phase 4: Testing

23. **D** runs the code. Tests it. Confirms it actually works — not just that it looks right, but that it runs.
24. If tests fail, **D** sends failures back to **C** with what broke. **C** fixes and sends back. **D** tests again.
25. When **D** is satisfied the code is correct and working, **D** sends it forward.

### Phase 4b: Security Audit (optional)

This phase runs only if the user enabled the **Security Audit** toggle at build start.

25a. **D** sends the reviewed and tested code to **E**.
25b. **E** reads the locked plan and every file **C** produced. Static analysis only — no Bash, no Write/Edit, no `WebSearch`/`WebFetch`, no Agent tool.
25c. **E** audits for OWASP Top 10, path traversal, ReDoS, and missing input validation. Each finding is ranked `critical` / `high` / `medium` / `low`.
25d. **E** emits a structured verdict (`{status: "approved"}` or `{status: "issues", "issues": [{severity, finding}, ...]}`) and the orchestrator pauses the pipeline (`pipelineStatus = 'awaiting-audit-decision'`).
25e. The user reviews findings in the Security Audit panel. Per finding, the user picks **Send to C** (scoped fix → **D** verifies tests → **E** re-audits only that finding) or **Dismiss** (logged in events).
25f. The user clicks **Deploy now** to advance. A confirmation modal warns if any findings remain unresolved.

If the toggle is off, this phase does not run and the pipeline goes straight from Phase 4 to Phase 5.

### Phase 5: Deploy

26. **A** receives the reviewed (and optionally audited) code.
27. The orchestrator handles final host-side commit/open behavior if applicable, and **A** confirms the build is complete.
28. Build complete.

---

## Rules

- **A** is still the central worker inside the current pipeline flow.
- **S** is the supervisor above the flow and the direction for the human-facing operator role.
- **B** only ever talks to **A**. B reviews the plan and nothing else.
- **C** talks to **A** (questions) and **D** (code handoff and fixes). **C** may also receive scoped security fix requests from the orchestrator during the optional Phase 4b.
- **D** talks to **C** (review feedback) and forwards the final result. During the optional Phase 4b, the orchestrator may also ask **D** to verify a scoped security fix by re-running tests.
- **E** does not talk to any other agent. **E** reads, audits, emits a JSON verdict, and answers the user's follow-up questions about findings. The orchestrator handles all handoffs to and from **E**.
- Every agent is aware of every other agent and their role.
- The pipeline creates a project folder in `~/Builds/` for every build. All files live there — plan, checklist, code.
- **A** reads and follows `build-plan-template.md`. The entire checklist — research, write, verify, context, review — is A's job. A completes every checkbox before sending anything to B. A sends the plan with context so B knows what was researched and verified.
- The plan is one file in one location. All agents reference it by path. After B approves, A locks it — no agent modifies it from that point forward.
- If it's not verified from source, it doesn't go in the plan. If it's not in the plan, it doesn't go in the code.
- No agent guesses. No agent improvises. No agent skips steps.

## Session Spawning

Each agent runs as a separate Claude Code session. Sessions are spawned with:

```bash
claude --permission-mode auto --model claude-opus-4-6
```

- `--permission-mode auto` is the default. Override via the dashboard Permission Mode toggle or `PIPELINE_PERMISSION_MODE` env var (`auto`, `plan`, or `dangerously-skip-permissions`).
- Auto mode uses Claude's classifier for general safety, but pipeline builds can still surface approval prompts for Bash depending on command risk and future strict-mode settings.
- Our PreToolUse hook stacks on top — enforces per-agent restrictions (A can only write plan.md, D can't write, etc.).
- `--model claude-opus-4-6` sets Opus 4.6.
- Each session gets a CLAUDE.md or system prompt defining its role, what it can do, and who it talks to.
- Stronger containment is a roadmap item, not a current guarantee. See [SECURITY-ROADMAP.md](../SECURITY-ROADMAP.md).

## Human Interaction

The user is mainly involved at the start:
1. User gives the build concept to A.
2. A can ask clarifying questions. User answers.
3. Pipeline runs autonomously from that point in the default mode, but the UI can still surface approvals for some Bash operations and future strict mode adds approval for all C/D Bash.
4. User gets notified when the build is complete.

The dashboard is more than a monitoring window now. It also shows supervisor guidance, current-turn recovery state, execution-path status, and the fallback controls that mirror supervisor actions.

---

## Visual

```
╔══════════════════════════════════════════════════════════════════════════╗
║                        PHASE 0: CONCEPT                                ║
║                                                                        ║
║   ┌───────────┐       build concept        ┌───────────┐              ║
║   │    YOU     │ ─────────────────────────→ │     A     │              ║
║   │  (human)   │ ←─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │  PLANNER  │              ║
║   └───────────┘   clarifying questions      └───────────┘              ║
║                    (if needed)                                          ║
║                                                                        ║
║   usually last direct human input — strict mode can still ask later    ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 1: PLANNING                               ║
║                                                                        ║
║   ┌───────────┐                                                        ║
║   │     A     │  1. work inside project folder in ~/Builds/            ║
║   │  PLANNER  │  2. read build-plan-template.md                        ║
║   │           │  3. research, write, verify, context, self-review once  ║
║   │           │  4. write plan to project folder (plan.md)             ║
║   └───────────┘                                                        ║
║        │                                                               ║
║        │            sends plan                                         ║
║        ▼                                                               ║
║   ┌───────────┐                             ┌───────────┐              ║
║   │           │ ─────────────────────────→  │           │              ║
║   │     A     │                             │     B     │              ║
║   │  PLANNER  │  ←───────────────────────── │ PLAN      │              ║
║   │           │   questions / no feedback    │ REVIEWER  │              ║
║   └───────────┘                             └───────────┘              ║
║        │  ↑                                      │                     ║
║        │  │    answers + updated plan             │                     ║
║        │  └──────────────────────────────────────┘                     ║
║        │                                                               ║
║        │        ↕ repeats until B is satisfied                         ║
║        │        ✓ B approves → B is done forever                       ║
║        │                                                               ║
║   ┌───────────┐                                                        ║
║   │     A     │  locks the plan — final, unmodifiable copy             ║
║   │  PLANNER  │  all agents reference this file from now on            ║
║   └───────────┘                                                        ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 2: CODING                                 ║
║                                                                        ║
║   ┌───────────┐       approved plan        ┌───────────┐              ║
║   │     A     │ ─────────────────────────→ │     C     │              ║
║   │  PLANNER  │                             │   CODER   │              ║
║   │           │ ←─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │           │              ║
║   └───────────┘   questions (if needed)     └───────────┘              ║
║                                                  │                     ║
║                          C builds exactly what the plan says           ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 3: CODE REVIEW                            ║
║                                                                        ║
║   ┌───────────┐        sends code          ┌───────────┐              ║
║   │     C     │ ─────────────────────────→ │     D     │              ║
║   │   CODER   │                             │   CODE    │              ║
║   │           │ ←───────────────────────── │ REVIEWER   │              ║
║   └───────────┘    recommended fixes        └───────────┘              ║
║        │  ↑                                      │                     ║
║        │  │         sends fixed code             │                     ║
║        │  └──────────────────────────────────────┘                     ║
║        │                                                               ║
║        │        ↕ repeats until D is satisfied with code               ║
║        │        ✓ D satisfied → moves to testing                       ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 4: TESTING                                ║
║                                                                        ║
║   ┌───────────┐                             ┌───────────┐              ║
║   │     C     │                             │     D     │              ║
║   │   CODER   │ ←───────────────────────── │  TESTER   │              ║
║   │           │     test failures            │           │              ║
║   │           │ ─────────────────────────→  │           │              ║
║   └───────────┘     fixes                   └───────────┘              ║
║                                                  │                     ║
║                  ↕ repeats until all tests pass   │                    ║
║                  ✓ D satisfied → sends to A       │                    ║
║                                                                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║                        PHASE 5: DEPLOY                                 ║
║                                                                        ║
║   ┌───────────┐                                                        ║
║   │     D     │ ── tested + reviewed code ──→ ┌───────────┐           ║
║   └───────────┘                                │     A     │           ║
║                                                │  PLANNER  │           ║
║                                                │           │           ║
║                                                │ • confirm │           ║
║                                                │   complete│           ║
║                                                │ • final   │           ║
║                                                │   handoff │           ║
║                                                └───────────┘           ║
║                                                     │                  ║
║                                                   DONE                 ║
╚══════════════════════════════════════════════════════════════════════════╝
```

```
COMMUNICATION MAP — who talks to who

     ┌─────┐
     │ YOU │  gives concept, answers A's questions (Phase 0 only)
     └──┬──┘
        │
        │ concept + answers
        │
        ┌─────┐
        │  B  │  plan reviewer
        └──┬──┘
           │
           │ only talks to A
           │
     ┌─────┴─────┐
     │     A     │
     │ planner / │
     │  deployer │
     └─────┬─────┘
           │
    ┌──────┴──── ─ ─ (questions if needed)
    │      │
    │  ┌───┴───┐
    │  │   C   │  coder
    │  └───┬───┘
    │      │
    │      │ code + fixes
    │      │
    │  ┌───┴───┐
    └──│   D   │  code reviewer + tester
       └───────┘
           │
           └──→ back to A when done

    after Phase 0, pipeline runs autonomous by default
    all sessions: claude --permission-mode auto --model claude-opus-4-6
```

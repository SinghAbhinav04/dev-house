# Pipeline Checklist

This checklist travels with the build. Each agent checks off their section before passing it forward. No agent should move to the next phase until the previous section is fully checked off.

This is not just pipeline paperwork. It is part of the team's shared doctrine. The supervisor, planner, reviewer, coder, and tester should all treat it as the operating system for the build.

Every handoff includes a message. The message format is specified at each handoff point — follow it exactly.

**Build:** _(name of feature/task)_
**Started:** _(date)_
**Project folder:** _(The pipeline creates this in `~/Builds/` based on the project theme — e.g. `~/Builds/auth-refactor/`)_

---

## Phase 0: Concept — you and the planner

### Concept Intake (A)
- [ ] Received build concept from user
- [ ] Asked clarifying questions (if needed)
- [ ] Received answers from user (if needed)
- [ ] Concept is clear — ready to plan

> **From:** User
> **To:** A (Planner)
> **Phase:** Concept
> **Build concept:** _(what the user wants built)_

If A needs clarification:

> **From:** A (Planner)
> **To:** User
> **Phase:** Concept
> **Questions:**
> 1. _(question)_

User answers, A continues. This is usually the last direct human interaction in fast mode. In strict mode, the UI can still surface Bash approvals later.

Today the pipeline still starts with A in Phase 0. The product direction is for S to become the primary manager/operator above the rest of the team.

---

## Phase 1: Planning — the planner

### Setup (A)
- [ ] Work inside the project folder in `~/Builds/` — named based on the project theme or idea
- [ ] Copy this checklist into the project folder (e.g. `~/Builds/project-name/checklist.md`)
- [ ] Read `build-plan-template.md` — this is your playbook. Follow it step by step. Understand the principles: research first, verify from source, no guesswork, give the coder full context, review until bulletproof.
- [ ] Create the plan file in the project folder (e.g. `~/Builds/project-name/plan.md`)

### Research (A)
- [ ] Read relevant architecture docs
- [ ] Read the actual source code for files that will be modified
- [ ] Web search if needed (external APIs, packages, docs)
- [ ] GitHub search if needed (repos, issues, examples)
- [ ] Package verify if needed (install, read source, confirm it works)

### Write (A)
- [ ] What we're building — clear, concise summary
- [ ] How it works — the pattern/flow
- [ ] Files to create — with code templates
- [ ] Files to modify — with exact line numbers and code snippets
- [ ] Special cases called out
- [ ] Architecture rules listed

### Verify (A)
- [ ] Zero guesses — every package, function, field, and line number verified from actual source
- [ ] No shortcuts — everything works completely or is explicitly deferred with a reason

### Context (A)
- [ ] Coder has full context — knows what to read, research, and build before starting
- [ ] Coder can build without asking a single question

### Self-Review (A)
- [ ] Read the plan as a fresh session — found and filled all gaps
- [ ] Reviewed again

### Handoff (A → B)
- [ ] All above checkboxes complete
- [ ] Plan file is written and saved in the project folder
- [ ] Send message to B:

> **From:** A (Planner)
> **To:** B (Plan Reviewer)
> **Phase:** Plan Review
> **Action needed:** Review this plan. Send back any questions — gaps, assumptions, anything unverified. If you have zero concerns, approve it and send it back.
>
> **The plan:** _(path to plan file in project folder)_
> **What I researched:** _(list sources read — docs, source code, web)_
> **What I verified:** _(list what was confirmed from source)_
> **What the coder needs to know:** _(key context for C)_

The goal is not just "hand B a file." The goal is to hand the team a plan that the rest of the build can trust.

---

## Phase 1b: Plan Review — the reviewer

### Review (B)
- [ ] Read the full plan

### B either has feedback or doesn't:

**If B has no feedback** → approve immediately:

> **From:** B (Plan Reviewer)
> **To:** A (Planner)
> **Phase:** Plan Approved
> **Action needed:** No feedback. Plan is perfect. Send it to C (Coder) to begin building.

**If B has questions** → send to A:

> **From:** B (Plan Reviewer)
> **To:** A (Planner)
> **Phase:** Plan Review
> **Action needed:** Answer these questions with verified information. Update the plan and send it back to me.
>
> **Questions:**
> 1. _(question)_
> 2. _(question)_
> 3. _(question)_

### When A responds → A sends back to B:

> **From:** A (Planner)
> **To:** B (Plan Reviewer)
> **Phase:** Plan Review
> **Action needed:** Review my answers. If satisfied, approve the plan. If not, send more questions.
>
> **Answers:**
> 1. _(answer with source verification)_
> 2. _(answer with source verification)_
> 3. _(answer with source verification)_
>
> **Updated plan:** _(path to plan file — A updates the same file)_

### B reviews answers and either sends more questions (repeat above) or approves.

### Resolution (B)
- [ ] All questions answered by A with verified information _(or N/A — no questions needed)_
- [ ] No remaining gaps, assumptions, or unknowns
- [ ] Plan is bulletproof

### Approval (B → A)
- [ ] Plan approved
- [ ] Send message to A:

> **From:** B (Plan Reviewer)
> **To:** A (Planner)
> **Phase:** Plan Approved
> **Action needed:** Plan is approved. Send it to C (Coder) to begin building.

**B is done. B is not in the loop again.**

### Final Plan (A)
- [ ] A locks the plan — this is now the final, unmodifiable copy. No agent changes this file from this point forward. All agents reference this single file as the source of truth.

---

## Phase 2: Coding — the coder

### Handoff (A → C)
- [ ] A sends message to C:

> **From:** A (Planner)
> **To:** C (Coder)
> **Phase:** Coding
> **Action needed:** Build exactly what this plan says. No improvising, no interpreting, no "improving." When finished, send the code to D (Code Reviewer). If you hit something unexpected, ask me before guessing.
>
> **Plan file:** _(path to the locked plan file in project folder — read this, do not modify it)_
> **Key context:** _(what C needs to know to start)_
> **Files to read first:** _(if any)_

### Receive (C)
- [ ] Received approved plan from A
- [ ] Read the full plan

### Build (C)
- [ ] Built exactly what the plan says
- [ ] All files created as specified in the plan
- [ ] All files modified as specified in the plan
- [ ] All special cases handled as specified in the plan

### Questions (C → A) _(if needed)_

> **From:** C (Coder)
> **To:** A (Planner)
> **Phase:** Coding
> **Action needed:** I hit something unexpected. Answer this so I can continue.
>
> **Question:** _(describe what's unexpected and what you need to know)_

### A responds:

> **From:** A (Planner)
> **To:** C (Coder)
> **Phase:** Coding
> **Action needed:** Here's your answer. Continue building.
>
> **Answer:** _(answer with verification)_

### Handoff (C → D)
- [ ] All build checkboxes complete
- [ ] Send message to D:

> **From:** C (Coder)
> **To:** D (Code Reviewer)
> **Phase:** Code Review
> **Action needed:** Review this code against the plan. Check that every item in the plan is accounted for. If you have issues, send them to me and I will fix. If the code matches the plan, move to testing.
>
> **The code:** _(what was built — files created, files modified)_
> **Plan file:** _(path to the locked plan file so D can compare)_

---

## Phase 3: Code Review — the tester

D reviews. D never touches the code. D sends issues back to C. C fixes.

### Review (D)
- [ ] Read the plan
- [ ] Read the code
- [ ] Code matches the plan — every item accounted for
- [ ] No missing pieces
- [ ] No wrong implementations
- [ ] No deviations from the plan

### If D has issues → send to C:

> **From:** D (Code Reviewer)
> **To:** C (Coder)
> **Phase:** Code Review
> **Action needed:** Fix these issues and send back the updated code.
>
> **Issues:**
> 1. _(what's wrong and what the fix should be)_
> 2. _(what's wrong and what the fix should be)_

### C fixes and sends back to D:

> **From:** C (Coder)
> **To:** D (Code Reviewer)
> **Phase:** Code Review
> **Action needed:** Review my fixes. If satisfied, move to testing. If not, send more issues.
>
> **Fixes applied:**
> 1. _(what was fixed)_
> 2. _(what was fixed)_

### D reviews fixes and either sends more issues (repeat above) or moves to testing.

### Code Approval (D)
- [ ] Satisfied with the code _(fixes applied if needed)_
- [ ] Code matches the plan and is correct
- [ ] Moving to testing

---

## Phase 4: Testing — the tester

D tests. D never touches the code. If something fails, D sends it back to C. C fixes. They loop until it works.

### Test (D)
- [ ] Code runs
- [ ] Code works as expected
- [ ] All functionality confirmed against the plan
- [ ] No errors, no broken behavior

### If tests fail → send to C:

> **From:** D (Tester)
> **To:** C (Coder)
> **Phase:** Testing
> **Action needed:** These tests failed. Fix and send back.
>
> **Failures:**
> 1. _(what failed and how it broke)_
> 2. _(what failed and how it broke)_

### C fixes and sends back to D:

> **From:** C (Coder)
> **To:** D (Tester)
> **Phase:** Testing
> **Action needed:** Re-test. These are the fixes I applied.
>
> **Fixes applied:**
> 1. _(what was fixed)_
> 2. _(what was fixed)_

### D re-tests and either sends more failures (repeat above) or approves.

### Test Approval (D)
- [ ] All tests pass
- [ ] Code is reviewed, tested, and ready

### Handoff (D → A)
- [ ] Send message to A:

> **From:** D (Code Reviewer + Tester)
> **To:** A (Planner)
> **Phase:** Deploy
> **Action needed:** Code is reviewed and tested. Ready for commit, push, and deploy.
>
> **What was reviewed:** _(summary of code review — what matched, what was fixed)_
> **What was tested:** _(summary of tests — what passed, what was fixed)_
> **The code:** _(final state of all files)_

---

## Phase 4b: Security Audit — the auditor (skipped if the slot is empty)

This phase runs only if the user enabled the optional Security Audit at build start AND D's tests all passed. The pipeline pauses after E's initial audit so the user can review findings, optionally send scoped fixes to C (with D verification and E re-audit), and then explicitly deploy.

### Initial Audit (E)
- [ ] Read the locked plan
- [ ] Read every code file C produced
- [ ] Audit for OWASP Top 10
- [ ] Audit for path traversal, ReDoS, missing input validation
- [ ] Rank each finding by severity: critical / high / medium / low
- [ ] Each finding includes file/line, vulnerability type, and the concrete fix
- [ ] Emit `{"status": "approved"}` or `{"status": "issues", "issues": [{severity, finding}, ...]}`

### User Decision Gate (orchestrator waits)
- [ ] Orchestrator writes findings to state, sets `pipelineStatus = 'awaiting-audit-decision'`, exits cleanly
- [ ] UI surfaces findings in the Security Audit panel with per-finding action buttons
- [ ] User chooses per finding: Send to C, or Dismiss. Actions serialize — only one fix in flight at a time.
- [ ] User explicitly clicks Deploy when satisfied.

> **From:** E (Security Auditor)
> **To:** User (via orchestrator)
> **Phase:** Security Audit
> **Action needed:** Review the findings. For each one, decide: send to C to fix, or dismiss. When you're done, click Deploy.
>
> **Findings:** _(list — each entry: severity + [file/line] type: description and fix)_

### Optional Scoped Fix Pass (per finding the user chose to send)
- [ ] C receives a tightly-scoped fix request — fix ONLY the one finding
- [ ] D runs existing tests to verify the fix did not regress anything
- [ ] E re-audits ONLY the one finding — approves or reports still-open
- [ ] Finding card updates to Resolved ✓ or Still Open
- [ ] User decides again: resend, dismiss, or move on

### Chat with E
- [ ] User may ask E follow-up questions about any finding at any time during the pause
- [ ] E explains reasoning, severity calls, and proposed fixes — does not re-audit

### Deploy (user-gated)
- [ ] User clicks Deploy. Orchestrator runs the existing deploy block (A's deploy message → git commit → open file → BUILD COMPLETE).
- [ ] The audit panel remains visible after deploy so the user can still chat with E retroactively. Clears on reset.

E does not message any other agent directly. The orchestrator handles every handoff.

---

## Phase 5: Deploy — the planner

### Receive (A)
- [ ] Received reviewed and tested code from D
- [ ] Confirmed D's review and test summaries look correct

### Finalize (A)
- [ ] Committed _(if repo exists)_
- [ ] Pushed _(if repo exists)_
- [ ] Deployed _(if applicable)_
- [ ] Build complete

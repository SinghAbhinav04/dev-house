# Pipeline

The orchestrator, agent roles, hooks, and templates that power Hackeroom's supervisor-led dev team.

See the [main README](../README.md) for the product overview and [ARCHITECTURE.md](../ARCHITECTURE.md) for the current supervisor/team architecture.

The key idea is that this folder contains the team's shared operating system:

- role files for the supervisor and specialists
- the master build plan template
- the shared checklist
- the hook guardrails that keep the team disciplined
- the orchestrator logic behind `plan-only`, `stop after review`, and stalled-turn recovery

## Files

- `orchestrator.ts` — Spawns agent sessions, routes signals, enforces pipeline flow, handles supervisor pause/resume controls, and (when the optional Security Audit toggle is on) drives the audit phase + per-finding fix loop
- `runner.ts` — Runner abstraction. Contains `HostRunner` (the default execution path) and `DockerRunner` (kept for the narrow cases where it works; not the default — see [SECURITY.md](../SECURITY.md))
- `.claude/hooks/approval-gate.sh` — Per-member permission enforcement, driven by the capability manifest the server writes to `<project>/.claude/team-manifest.json`
- `.claude/settings.json` — Hook configuration
- `build-plan-template.md` — Template the planner follows when writing plans
- `checklist-template.md` — Pipeline checklist copied to each build (includes the optional Phase 4b: Security Audit section)
- `pipelinebuildarchitecture.md` — Full architecture specification

Role prompts are no longer stored here. Members own their own `role.md` under
`~/.hackeroom/members/<id>/`, and `templates/roles/` in the repo root holds the
starter templates offered when creating one.

#!/bin/bash
#
# Team Role Guardrails (Hardened v3 — manifest driven)
#
# Per-member permission enforcement with DENY-BY-DEFAULT.
#
# Members are user-authored, so there is no fixed set of agent letters to match
# against. Instead the server writes a capability manifest to
# <project>/.claude/team-manifest.json at run start and this hook looks the
# member up in it. The manifest is data the hook *consults*; it is not a grant
# of authority. These clamps are unconditional and no manifest value can unlock
# them:
#
#   - writes to .claude/ are denied for every member (that is what stops an
#     agent from editing this hook or its own permissions)
#   - every member whose write level is not "builds" is jailed to the active
#     project root
#   - the Agent tool is blocked for everyone (no recursive spawning)
#   - Bash cannot mutate hooks/settings, create links, spawn `claude`, or touch
#     PIPELINE_AGENT
#   - any tool not explicitly handled is denied
#   - a member absent from the manifest is denied outright
#
# Manifest schema:
#   { "version": 1,
#     "artifacts": { "plan.md": "<member-id>" },
#     "members": { "<member-id>": { "slot": "coder", "write": "none|artifact|project|builds",
#                                   "bash": "none|approval|safe|all", "web": true|false,
#                                   "denyPhases": ["concept"] } } }
#
# MODES: fast=default autonomy, strict=escalate "safe" Bash to approval.
#
# LIMITATIONS: this is a role guardrail, not a security sandbox. A sufficiently
# adversarial agent could bypass bash-level grep filters via indirect execution
# (python3 -c, eval, base64). For true isolation, use OS-level sandboxing.
# See SECURITY.md.
#

# Claude can occasionally invoke the hook in a context where stdin is not
# closed yet. Avoid hanging forever on an empty bootstrap/probe invocation.
# Read a single byte first so JSON payloads without a trailing newline still
# count as real input instead of timing out.
if IFS= read -r -t 1 -n 1 FIRST_CHAR; then
  REST=$(cat)
  INPUT="${FIRST_CHAR}${REST}"
else
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input')
CWD=$(echo "$INPUT" | jq -r '.cwd')

# Canonicalize BUILDS_DIR to handle symlinks in $HOME
BUILDS_DIR=$(readlink -f "$HOME/Builds" 2>/dev/null || echo "$HOME/Builds")
MEMBER="${PIPELINE_AGENT:-}"
SECURITY_MODE="${PIPELINE_SECURITY_MODE:-fast}"

lower_path() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

find_project_root() {
  local check="$CWD"
  while [ "$check" != "/" ]; do
    if [ -f "$check/pipeline-events.json" ]; then
      printf '%s\n' "$check"
      return
    fi
    check=$(dirname "$check")
  done
  printf '%s\n' "$CWD"
}

# ── Reject empty/malformed tool name ─────────────────────────────────

if [ -z "$TOOL_NAME" ] || [ "$TOOL_NAME" = "null" ]; then
  echo "BLOCKED: Could not parse tool name" >&2
  exit 2
fi

# ── Resolve identity against the team manifest ───────────────────────

# The member id is also a path segment and an env value, so keep it strict.
if [[ ! "$MEMBER" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "BLOCKED: Invalid member identity '$MEMBER'" >&2
  exit 2
fi

PROJECT_ROOT=$(find_project_root)
MANIFEST="$PROJECT_ROOT/.claude/team-manifest.json"

if [ ! -f "$MANIFEST" ]; then
  echo "BLOCKED: No team manifest at $MANIFEST — cannot verify member '$MEMBER'" >&2
  exit 2
fi

MEMBER_ENTRY=$(jq -c --arg m "$MEMBER" '.members[$m] // empty' "$MANIFEST" 2>/dev/null || echo "")

if [ -z "$MEMBER_ENTRY" ]; then
  echo "BLOCKED: Member '$MEMBER' is not on the team manifest" >&2
  exit 2
fi

MEMBER_WRITE=$(printf '%s' "$MEMBER_ENTRY" | jq -r '.write // "none"')
MEMBER_BASH=$(printf '%s' "$MEMBER_ENTRY" | jq -r '.bash // "none"')
MEMBER_WEB=$(printf '%s' "$MEMBER_ENTRY" | jq -r '.web // false')

# Reject manifest values outside the known vocabulary rather than treating an
# unrecognised level as permissive.
case "$MEMBER_WRITE" in
  none|artifact|project|builds) ;;
  *)
    echo "BLOCKED: Member '$MEMBER' has an unrecognised write level '$MEMBER_WRITE'" >&2
    exit 2
    ;;
esac

case "$MEMBER_BASH" in
  none|approval|safe|all) ;;
  *)
    echo "BLOCKED: Member '$MEMBER' has an unrecognised bash level '$MEMBER_BASH'" >&2
    exit 2
    ;;
esac

# ── Auto-approve read-only tools (all members) ───────────────────────

case "$TOOL_NAME" in
  Read|Glob|Grep|ToolSearch|TaskCreate|TaskUpdate|TaskGet|TaskList|TaskOutput|LSP|StructuredOutput)
    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
    ;;
esac

# ── Block Agent tool for ALL members ─────────────────────────────────

if [ "$TOOL_NAME" = "Agent" ]; then
  echo "BLOCKED: Member $MEMBER cannot spawn sub-agents" >&2
  exit 2
fi

# ── Gate WebFetch and WebSearch (egress risk) ────────────────────────

if [ "$TOOL_NAME" = "WebFetch" ] || [ "$TOOL_NAME" = "WebSearch" ]; then
  if [ "$MEMBER_WEB" = "true" ]; then
    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
  fi
  echo "BLOCKED: Member $MEMBER cannot use $TOOL_NAME" >&2
  exit 2
fi

# ── Helper: resolve and validate file path ───────────────────────────

resolve_filepath() {
  local fp="$1"
  # Make absolute
  if [[ "$fp" != /* ]]; then
    fp="$CWD/$fp"
  fi
  # Reject .. in paths
  if [[ "$fp" == *".."* ]]; then
    echo "BLOCKED"
    return
  fi
  # Resolve directory symlinks
  local dir_resolved
  dir_resolved=$(cd "$(dirname "$fp")" 2>/dev/null && pwd -P)
  if [ -z "$dir_resolved" ]; then
    echo "BLOCKED"
    return
  fi
  fp="$dir_resolved/$(basename "$fp")"
  # Resolve file-level symlinks (NOTE: does not detect hardlinks — known limitation)
  if [ -e "$fp" ]; then
    local resolved
    resolved=$(readlink -f "$fp" 2>/dev/null)
    if [ -n "$resolved" ]; then
      fp="$resolved"
    fi
  fi
  echo "$fp"
}

# ── Write/Edit/NotebookEdit rules ────────────────────────────────────

case "$TOOL_NAME" in
  Write|Edit|NotebookEdit)
    FILEPATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""')
    FILEPATH=$(resolve_filepath "$FILEPATH")

    if [ "$FILEPATH" = "BLOCKED" ]; then
      echo "BLOCKED: Invalid file path" >&2
      exit 2
    fi

    FILENAME=$(basename "$FILEPATH")
    BUILDS_DIR_CI=$(lower_path "$BUILDS_DIR")
    FILEPATH_CI=$(lower_path "$FILEPATH")

    PROJECT_ROOT=$(readlink -f "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")
    PROJECT_ROOT_CI=$(lower_path "$PROJECT_ROOT")
    EVENTS_FILE="$PROJECT_ROOT/pipeline-events.json"

    IN_BUILDS=0
    IN_PIPELINE_PROJECT=0

    if [[ "$FILEPATH_CI" == "$BUILDS_DIR_CI/"* ]]; then
      IN_BUILDS=1
    fi

    if [ -f "$EVENTS_FILE" ] && [[ "$FILEPATH_CI" == "$PROJECT_ROOT_CI/"* ]]; then
      IN_PIPELINE_PROJECT=1
    fi

    if [ "$IN_BUILDS" -ne 1 ] && [ "$IN_PIPELINE_PROJECT" -ne 1 ]; then
      echo "BLOCKED: Cannot write to $FILEPATH — outside the active pipeline project" >&2
      exit 2
    fi

    # Jail every member to the active project root unless their write level is
    # "builds", which the roster only ever grants to the supervisor slot.
    if [ "$MEMBER_WRITE" != "builds" ]; then
      if [[ "$FILEPATH_CI" != "$PROJECT_ROOT_CI/"* ]]; then
        echo "BLOCKED: Cannot write to $FILEPATH — outside current project" >&2
        exit 2
      fi
    fi

    # Block writes to every agent CLI's config directory, for ALL members.
    # Unconditional: this is what keeps the hooks, the settings and the
    # manifest itself out of agent reach.
    #
    # One directory per supported CLI, because each keeps its gate somewhere
    # different: .claude/ holds Claude Code's settings and this script,
    # .opencode/ holds OpenCode's generated gate plugin AND the generated agent
    # definition that carries a member's system prompt, .agents/ holds
    # Antigravity's hooks.json and workspace skills, .gemini/ its settings.
    # A member that can write any of them can rewrite either what it is
    # permitted to do or who it was told to be.
    case "$FILEPATH" in
      */.claude/*|*/.claude|\
      */.opencode/*|*/.opencode|\
      */.agents/*|*/.agents|\
      */.gemini/*|*/.gemini)
        echo "BLOCKED: Cannot modify hook/settings files" >&2
        exit 2
        ;;
    esac

    # ── Shared-memory inbox ──────────────────────────────────────────
    #
    # Every member may drop a memory entry, including the read-only ones —
    # a reviewer that cannot record what it found is a reviewer whose findings
    # die with its session.
    #
    # Deliberately narrow: only Write (never Edit, so nothing existing can be
    # rewritten), only directly inside inbox/ (no subdirectories, no escaping
    # via a nested path), and only plain .md filenames. The orchestrator reads
    # this directory, folds it into the index and empties it between turns.
    MEMORY_INBOX="$PROJECT_ROOT/.squad/memory/inbox"
    if [[ "$FILEPATH" == "$MEMORY_INBOX/"* ]]; then
      INBOX_REL="${FILEPATH#"$MEMORY_INBOX/"}"
      if [ "$TOOL_NAME" = "Write" ] && [[ "$INBOX_REL" =~ ^[A-Za-z0-9._-]+\.md$ ]]; then
        echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
        exit 0
      fi
      echo "BLOCKED: The memory inbox only accepts new .md files written directly into it" >&2
      exit 2
    fi

    if [ "$MEMBER_WRITE" = "none" ]; then
      echo "BLOCKED: Member $MEMBER cannot write files" >&2
      exit 2
    fi

    # Phase gate — default to BLOCKED if the events file is missing.
    DENY_PHASES=$(printf '%s' "$MEMBER_ENTRY" | jq -r '(.denyPhases // []) | join(" ")')
    if [ -n "$DENY_PHASES" ]; then
      CURRENT_PHASE="concept"
      if [ -f "$EVENTS_FILE" ]; then
        CURRENT_PHASE=$(jq -r '.currentPhase // "concept"' "$EVENTS_FILE" 2>/dev/null || echo "concept")
      fi
      for denied in $DENY_PHASES; do
        if [ "$CURRENT_PHASE" = "$denied" ]; then
          echo "BLOCKED: Member $MEMBER cannot write during phase '$CURRENT_PHASE'" >&2
          exit 2
        fi
      done
    fi

    # Artifact ownership. A slot artifact (the planner's plan.md) belongs to
    # exactly one member; everyone else is locked out of it even with
    # project-wide write access, which is what "the plan is locked" means.
    ARTIFACT_OWNER=$(jq -r --arg f "$FILENAME" '.artifacts[$f] // ""' "$MANIFEST" 2>/dev/null || echo "")

    if [ "$MEMBER_WRITE" = "artifact" ]; then
      if [ -z "$ARTIFACT_OWNER" ] || [ "$ARTIFACT_OWNER" != "$MEMBER" ]; then
        echo "BLOCKED: Member $MEMBER can only write the artifact it owns, not $FILENAME" >&2
        exit 2
      fi
    elif [ -n "$ARTIFACT_OWNER" ] && [ "$ARTIFACT_OWNER" != "$MEMBER" ]; then
      echo "BLOCKED: $FILENAME is owned by member $ARTIFACT_OWNER and is locked" >&2
      exit 2
    fi

    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
    exit 0
    ;;
esac

# ── Bash rules ───────────────────────────────────────────────────────

if [ "$TOOL_NAME" = "Bash" ]; then
  if [ "$MEMBER_BASH" = "none" ]; then
    echo "BLOCKED: Member $MEMBER cannot run commands" >&2
    exit 2
  fi

  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
  APPROVED_BASH_FILE="$PROJECT_ROOT/pipeline-approved-bash.json"

  # Block direct shell-level modifications of any CLI's config dir, hooks, or
  # settings. Keep this narrow enough that harmless string mentions (for
  # example in a Python snippet or allowlist check) do not get blocked as
  # false positives.
  #
  # The filenames track the config dirs blocked in the Write branch above:
  # hooks.json is Antigravity's gate, opencode.json and plugin.json are
  # OpenCode's, auth.json is where a CLI keeps credentials.
  GATE_FILES='\.claude(/|[[:space:]]|$)|\.opencode(/|[[:space:]]|$)|\.agents(/|[[:space:]]|$)|\.gemini(/|[[:space:]]|$)|approval-gate(\.sh)?|settings\.json|team-manifest\.json|hooks\.json|opencode\.json|plugin\.json|auth\.json|hooks/'

  if printf '%s\n' "$COMMAND" | grep -Eiq "(^|[;&|[:space:]])(rm|mv|cp|chmod|chown|touch|mkdir|rmdir|sed|tee)\b.*($GATE_FILES)"; then
    echo "BLOCKED: Cannot modify hook or settings files via Bash" >&2
    exit 2
  fi

  if printf '%s\n' "$COMMAND" | grep -Eiq "(>|>>|<).*($GATE_FILES)"; then
    echo "BLOCKED: Cannot modify hook or settings files via Bash" >&2
    exit 2
  fi

  # Block mv/cp/rm with any glob that could target .claude (e.g., .c*, .cl*)
  # Block these commands entirely when they contain glob wildcards near dot-files
  case "$COMMAND" in
    *"mv "*"."*"*"*|*"cp "*"."*"*"*|*"rm "*"."*"*"*)
      echo "BLOCKED: Cannot mv/cp/rm with glob patterns on dot-files" >&2
      exit 2
      ;;
    *"mv ."*|*"cp ."*|*"rm ."*|*"rm -"*" ."*)
      echo "BLOCKED: Cannot mv/cp/rm dot-files or dot-directories" >&2
      exit 2
      ;;
  esac

  # Block ln entirely — prevents hardlink and symlink bypasses
  case "$COMMAND" in
    *"ln "*|"ln "*|*";ln "*|*"&&ln "*|*"|ln "*|*'$(ln'*|*'`ln'*)
      echo "BLOCKED: Cannot create links via Bash" >&2
      exit 2
      ;;
  esac

  # Block direct agent-CLI invocations and PIPELINE_AGENT manipulation.
  #
  # A member that can spawn its own agent session escapes the gate entirely:
  # the new process is not the one the manifest describes. Every CLI the
  # roster can run is blocked, not just Claude Code -- a coder on Claude
  # spawning `opencode run` would be just as far outside the manifest.
  #
  # NOTE: Indirect execution (python3 -c, eval, base64) is a KNOWN LIMITATION
  # that cannot be solved with bash pattern matching. See SECURITY.md.
  # Matched on the invocation form rather than the bare binary name, exactly
  # as the `claude -` rule always was: "opencode" and "agy" are short enough
  # to appear inside ordinary prose, and a gate that blocks
  # `print('opencode is a word')` trains people to turn it off.
  case "$COMMAND" in
    *"PIPELINE_AGENT"*|\
    *"claude -"*|*"claude --"*|\
    *"opencode run"*|*"opencode -"*|\
    *"agy -"*)
      echo "BLOCKED: Cannot spawn agent sessions or modify agent identity via Bash" >&2
      exit 2
      ;;
  esac

  # "all" opts out of approval escalation entirely; "approval" always requires
  # it; "safe" requires it only when the run is in strict mode.
  NEEDS_APPROVAL=0
  if [ "$MEMBER_BASH" = "approval" ]; then
    NEEDS_APPROVAL=1
  elif [ "$MEMBER_BASH" = "safe" ] && [ "$SECURITY_MODE" = "strict" ]; then
    NEEDS_APPROVAL=1
  fi

  if [ "$NEEDS_APPROVAL" -eq 1 ]; then
    if [ -f "$APPROVED_BASH_FILE" ]; then
      GRANT_AGENT=$(jq -r '.agent // ""' "$APPROVED_BASH_FILE" 2>/dev/null || echo "")
      GRANT_COMMAND=$(jq -r '.command // ""' "$APPROVED_BASH_FILE" 2>/dev/null || echo "")
      if [ "$GRANT_AGENT" = "$MEMBER" ] && [ "$GRANT_COMMAND" = "$COMMAND" ]; then
        rm -f "$APPROVED_BASH_FILE" 2>/dev/null || true
        echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
        exit 0
      fi
    fi

    jq -n --arg reason "Member $MEMBER Bash requires approval" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
  fi

  # Auto mode handles remaining bash safety.
  echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'
  exit 0
fi

# ── DENY BY DEFAULT ──────────────────────────────────────────────────
# Any tool not explicitly handled above is BLOCKED.

echo "BLOCKED: Tool '$TOOL_NAME' is not allowed for member $MEMBER" >&2
exit 2

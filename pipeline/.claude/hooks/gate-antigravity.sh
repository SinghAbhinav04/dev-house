#!/bin/bash
#
# Antigravity PreToolUse shim.
#
# Translates what `agy` hands a hook into what approval-gate.sh expects, and
# translates the answer back. It decides nothing itself: there is one gate, one
# manifest and one set of contract tests, and a second implementation would be a
# second thing to drift.
#
# agy sends:
#   {"toolCall":{"name":"run_command","args":{"CommandLine":"...","Cwd":"..."}},
#    "conversationId":"...","stepIdx":19,"workspacePaths":[...]}
#
# and reads a denial from stdout:
#   {"decision":"deny","reason":"..."}
#
# approval-gate.sh speaks Claude's dialect — {tool_name, tool_input, cwd},
# `exit 2` plus a stderr reason to deny — so this is the adapter between them.
#
# FAIL CLOSED, and specifically about argument keys. The gate reads a path out
# of the arguments to decide whether a write is allowed. agy's keys are
# PascalCase and inconsistent between tools (`view_file` says AbsolutePath,
# `write_to_file` says TargetFile), and a key that does not exist yields an
# empty string. An empty path resolves to the working directory, the working
# directory is inside the project root, and the project root is a path the gate
# ALLOWS. So a wrong or missing key is not a loud failure — it is a silent
# permit. Every branch below that would hand the gate a path checks first that
# it actually has one.
#
# Keys here were observed by running the binary, not read from the docs, which
# name exactly one of them. See scripts/probe-antigravity.mjs.

set -uo pipefail

GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/approval-gate.sh"

# Deny, in agy's dialect. Always exit 0: agy's contract is that a refusal comes
# from this JSON, and a non-zero exit is an undefined hook failure that may well
# be treated as "carry on". The stderr copy is what reaches tool_info.error, so
# the decoder can recognise a gate denial and replay it to the approval flow.
deny() {
  local reason="${1:-Denied}"
  printf '%s\n' "BLOCKED: $reason" >&2
  jq -nc --arg reason "BLOCKED: $reason" '{decision: "deny", reason: $reason}'
  exit 0
}

allow() {
  exit 0
}

command -v jq >/dev/null 2>&1 || {
  # No jq means no translation and no gate. Refusing is the only safe answer,
  # but it cannot be said in JSON, so say it plainly and refuse.
  printf '%s\n' 'BLOCKED: jq is required by the Hackeroom gate and is not installed' >&2
  printf '%s\n' '{"decision":"deny","reason":"BLOCKED: jq is not installed"}'
  exit 0
}

# Same one-byte read as the gate: a payload without a trailing newline is real
# input, not an empty probe. Unlike the gate, a timeout here denies — this shim
# is only ever invoked with a tool call to judge.
if IFS= read -r -t 5 -n 1 FIRST_CHAR; then
  REST=$(cat)
  INPUT="${FIRST_CHAR}${REST}"
else
  deny "no tool call was received on stdin"
fi

NATIVE_TOOL=$(printf '%s' "$INPUT" | jq -r '.toolCall.name // ""' 2>/dev/null) || deny "hook payload was not readable JSON"
ARGS=$(printf '%s' "$INPUT" | jq -c '.toolCall.args // {}' 2>/dev/null) || deny "hook payload was not readable JSON"

[ -n "$NATIVE_TOOL" ] || deny "the hook payload named no tool"

# Where the gate should consider itself to be. The hook's own working directory
# is <project>/.agents, NOT the project root — observed, not assumed — and the
# gate walks up from cwd looking for pipeline-events.json, so handing it the
# parent is both correct and enough.
WORKSPACE=$(printf '%s' "$INPUT" | jq -r '.workspacePaths[0] // ""' 2>/dev/null)
if [ -z "$WORKSPACE" ] || [ ! -d "$WORKSPACE" ]; then
  WORKSPACE=$(cd .. 2>/dev/null && pwd)
fi

arg() {
  printf '%s' "$ARGS" | jq -r --arg key "$1" '.[$key] // ""' 2>/dev/null
}

# Hand a Claude-shaped payload to the gate and translate its verdict back.
# Called once per path; see multi-path note below.
consult_gate() {
  local tool_name="$1"
  local tool_input="$2"

  local stderr_file
  stderr_file=$(mktemp)

  local stdout_text
  stdout_text=$(
    jq -nc --arg t "$tool_name" --argjson i "$tool_input" --arg c "$WORKSPACE" \
      '{tool_name: $t, tool_input: $i, cwd: $c}' \
      | "$GATE" 2>"$stderr_file"
  )
  local status=$?

  local reason
  reason=$(head -n 1 "$stderr_file")
  rm -f "$stderr_file"

  if [ "$status" -eq 2 ]; then
    deny "${reason#BLOCKED: }"
  fi

  if [ "$status" -ne 0 ]; then
    deny "the gate exited unexpectedly (${status})"
  fi

  local decision
  decision=$(printf '%s' "$stdout_text" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null)

  case "$decision" in
    allow) return 0 ;;
    # agy has no way to ask the user mid-turn, so a request for approval is a
    # refusal here. It is reported as one so the run log says why, rather than
    # looking like an ordinary block.
    ask) deny "${reason:-this member needs approval for that, which this CLI cannot ask for}" ;;
    *) deny "the gate returned no readable verdict" ;;
  esac
}

# ── Tools whose verdict needs no arguments ───────────────────────────
#
# The gate decides these on the tool name and the member's capabilities alone
# and never reads the input, so an unprobed argument key cannot widen anything.

case "$NATIVE_TOOL" in
  view_file)
    consult_gate Read '{}'
    allow
    ;;

  grep_search)
    consult_gate Grep '{}'
    allow
    ;;

  list_dir|find_by_name)
    consult_gate Glob '{}'
    allow
    ;;

  read_url_content)
    consult_gate WebFetch '{}'
    allow
    ;;

  search_web)
    consult_gate WebSearch '{}'
    allow
    ;;

  # Four of these, where the docs describe three: browser_subagent only appears
  # in the live tool list. All map onto the Agent block, which refuses every
  # member unconditionally.
  invoke_subagent|define_subagent|manage_subagents|browser_subagent)
    consult_gate Agent '{}'
    allow
    ;;
esac

# ── Tools whose verdict depends on an argument ───────────────────────

case "$NATIVE_TOOL" in
  write_to_file|replace_file_content)
    TARGET=$(arg TargetFile)
    # The check this whole file exists for.
    [ -n "$TARGET" ] || deny "$NATIVE_TOOL named no TargetFile, so there is no path to check"

    CANONICAL=Write
    [ "$NATIVE_TOOL" = "replace_file_content" ] && CANONICAL=Edit

    consult_gate "$CANONICAL" "$(jq -nc --arg p "$TARGET" '{file_path: $p}')"
    allow
    ;;

  run_command)
    COMMAND=$(arg CommandLine)
    [ -n "$COMMAND" ] || deny "run_command named no CommandLine, so there is no command to check"

    # Exactly once. The gate's strict-mode approval grant is consumed on use,
    # so consulting it twice for one command would burn the grant on the first
    # call and refuse the second.
    consult_gate Bash "$(jq -nc --arg c "$COMMAND" '{command: $c}')"
    allow
    ;;
esac

# ── Everything else ──────────────────────────────────────────────────
#
# agy offers 57 tools. Anything not named above — browser automation, notebook
# editing, MCP calls, task scheduling, and any tool a later version adds — is
# refused here rather than being passed through under a name the gate would not
# recognise. Two write-capable tools are deliberately in this bucket:
# sed_file and multi_replace_file_content, whose argument keys have not been
# observed. They stay refused until someone runs them and looks.

deny "$NATIVE_TOOL is not a tool this member may use"

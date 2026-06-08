#!/usr/bin/env bash
set -uo pipefail

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
PROMPT_TEXT="${PROMPT_TEXT:-Respond with exactly the text AUTH_TEST_OK and nothing else}"
OUTPUT_FORMAT="${OUTPUT_FORMAT:-json}"

CLAUDE_JSON="$HOME/.claude.json"
if [ -d "$CLAUDE_JSON" ]; then
  rm -rf "$CLAUDE_JSON"
fi
if [ ! -f "$CLAUDE_JSON" ]; then
  echo '{}' > "$CLAUDE_JSON"
fi

node -e "
const fs = require('fs');
const p = process.argv[1];
let d = {};
try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
d.hasCompletedOnboarding = true;
fs.writeFileSync(p, JSON.stringify(d, null, 2));
" "$CLAUDE_JSON"

STDERR_FILE="$(mktemp)"
if OUTPUT="$("$CLAUDE_BIN" -p "$PROMPT_TEXT" --permission-mode auto --model claude-sonnet-4-6 --output-format "$OUTPUT_FORMAT" 2>"$STDERR_FILE")"; then
  echo "RC=0"
  echo "STDOUT_START"
  printf '%s\n' "$OUTPUT"
  echo "STDOUT_END"
else
  RC=$?
  echo "RC=$RC"
  echo "STDOUT_START"
  printf '%s\n' "${OUTPUT:-}"
  echo "STDOUT_END"
fi

echo "STDERR_START"
cat "$STDERR_FILE"
echo "STDERR_END"
rm -f "$STDERR_FILE"

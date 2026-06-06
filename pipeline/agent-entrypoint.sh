#!/bin/bash
set -euo pipefail

export HOME="${HOME:-/home/node}"

CLAUDE_STATE_FILE="$HOME/.claude.json"
if [ -d "$CLAUDE_STATE_FILE" ]; then
  rm -rf "$CLAUDE_STATE_FILE"
fi
if [ ! -f "$CLAUDE_STATE_FILE" ]; then
  printf '{}\n' > "$CLAUDE_STATE_FILE"
fi
node -e "
const fs = require('fs');
const p = process.argv[1];
let d = {};
try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
d.hasCompletedOnboarding = true;
fs.writeFileSync(p, JSON.stringify(d, null, 2));
" "$CLAUDE_STATE_FILE" >/dev/null 2>&1 || true

if [ -n "${AGENT_NETWORK_PROFILE:-}" ]; then
  sudo /usr/local/bin/agent-firewall.sh "$AGENT_NETWORK_PROFILE"
fi

exec "$@"

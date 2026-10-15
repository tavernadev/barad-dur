#!/usr/bin/env bash
# One Claude Code session per terminal tab. ttyd (-a) passes the id from ?arg=<id> as $1.
#   main     -> the workspace session on the home page (display/UI changes)
#   <card>   -> a session scoped to cards/<card>/ (the ticket work)
# The id comes from the URL, so it is validated before use; session ids are remembered in .sessions/<id>.
# Settings come from .env / the environment (see example.env): DATA_DIR, CLAUDE_BIN.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DATA="${DATA_DIR:-.}"
DATA="${DATA/#\~/$HOME}"
CLAUDE="${CLAUDE_BIN:-claude}"
ID="${1:-}"
if [[ ! "$ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { [ "$ID" != "main" ] && [ ! -f "$DATA/cards/$ID/card.json" ]; }; then
  echo "Unknown card: '$ID'"; sleep 5; exit 1
fi
mkdir -p "$DATA/.sessions"
DATA_ABS="$(cd "$DATA" && pwd)"
ADD=()
# Private data may live outside this folder (DATA_DIR): let Claude read and write it without permission prompts.
[ "$DATA_ABS" != "$(pwd)" ] && ADD=(--add-dir "$DATA_ABS")
FILE="$DATA/.sessions/$ID"
if [ -s "$FILE" ]; then
  exec "$CLAUDE" ${ADD[@]+"${ADD[@]}"} --resume "$(head -n1 "$FILE")"
fi
UUID="$(uuidgen | tr 'A-Z' 'a-z')"
echo "$UUID" > "$FILE"
if [ "$ID" = "main" ]; then
  PROMPT="This is the main workspace session for this command center. Read CLAUDE.md first. You handle changes to the workspace itself (server.js, shell.html, home.html, the card template, scripts). Ticket investigation happens in the per-card sessions, not here. Wait for my instructions."
else
  PROMPT="This session is dedicated to card $ID and is scoped to that ticket. Your card folder is $DATA_ABS/cards/$ID. Read CLAUDE.md, $DATA_ABS/cards/$ID/card.json and $DATA_ABS/cards/$ID/index.html first, then wait for my instructions. Keep the report page up to date as we work, and keep this card's TODO column current: create tasks and write updates on them in cards/$ID/$DATA_ABS/cards/$ID/tasks.json (format in CLAUDE.md). Do not change workspace code (server.js, shell.html, home.html, scripts); workspace changes belong in the main session on the home page."
fi
exec "$CLAUDE" ${ADD[@]+"${ADD[@]}"} --session-id "$UUID" "$PROMPT"

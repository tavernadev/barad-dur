#!/usr/bin/env bash
# One Claude Code session per terminal tab. ttyd (-a) passes the id from ?arg=<id> as $1.
#   main     -> the workspace session on the home page (display/UI changes)
#   <number> -> a session scoped to one card (its number, e.g. 12)
# The id comes from the URL, so it is validated before use; session ids are remembered in <data>/.sessions/<id>.
# Settings come from .env / the environment (see example.env): DATA_DIR, CLAUDE_BIN, PORT.
set -euo pipefail
cd "$(dirname "$0")"
. ./load-env.sh   # .env values; real environment variables win
DATA="${DATA_DIR:-data}"
DATA="${DATA/#\~/$HOME}"
CLAUDE="${CLAUDE_BIN:-claude}"
ID="${1:-}"
if [[ ! "$ID" =~ ^([0-9]+|main)$ ]]; then echo "Unknown card: '$ID'"; sleep 5; exit 1; fi
# A card's folder depends on its state: inbox/<n> or topics/<n>, and inside a done/ folder once it is Done.
CARD_DIR=""
if [ "$ID" != "main" ]; then
  for d in "$DATA/topics/$ID" "$DATA/inbox/$ID" "$DATA/topics/done/$ID" "$DATA/inbox/done/$ID"; do
    if [ -f "$d/card.json" ]; then CARD_DIR="$(cd "$d" && pwd)"; break; fi
  done
  if [ -z "$CARD_DIR" ]; then echo "Unknown card: '$ID'"; sleep 5; exit 1; fi
fi
mkdir -p "$DATA/.sessions"
DATA_ABS="$(cd "$DATA" && pwd)"
FILE="$DATA_ABS/.sessions/$ID" # absolute: the script may cd to the session's own directory below
# A card can adopt an existing Claude session (.sessions/<n> = its id). Claude only finds a session from the directory it
# was started in, so that directory is kept in .sessions/<n>.cwd and used when it exists.
RUN_DIR="$(pwd)"
if [ -s "$FILE.cwd" ] && [ -d "$(head -n1 "$FILE.cwd")" ]; then RUN_DIR="$(cd "$(head -n1 "$FILE.cwd")" && pwd)"; fi
ADD=()
# Only when the data folder is outside the directory Claude runs in: let it read and write the data without permission prompts.
case "$DATA_ABS/" in "$RUN_DIR/"*) ;; *) ADD=(--add-dir "$DATA_ABS") ;; esac
cd "$RUN_DIR"
if [ -s "$FILE" ]; then
  exec "$CLAUDE" ${ADD[@]+"${ADD[@]}"} --resume "$(head -n1 "$FILE")"
fi
UUID="$(uuidgen | tr 'A-Z' 'a-z')"
echo "$UUID" > "$FILE"
TABS_NOTE=""
if [ -n "$CARD_DIR" ] && [ -f "$CARD_DIR/tabs.json" ]; then
  TABS_NOTE=" This card has tabs: put what the ticket initially told us and your first investigation in $CARD_DIR/tabs/scoping.html, put what you actually identify while working on the tasks in $CARD_DIR/tabs/findings.html, and when the user asks for another tab (for example what we are fixing, or changes to review) create it with POST http://127.0.0.1:${PORT:-8080}/api/cards/$ID/tabs and a JSON body {\"title\":\"...\"}, then write its HTML fragment in the file it creates (format in CLAUDE.md). The first tab, Artifact, is optional and stays empty until the user asks you to attach a claude.ai artifact: never create, publish or attach one on your own (see CLAUDE.md)."
fi
if [ "$ID" = "main" ]; then
  PROMPT="This is the main workspace session for this command center. Read CLAUDE.md first. You handle changes to the workspace itself (server.js, shell.html, home.html, the card template, scripts). Ticket investigation happens in the per-card sessions, not here. Wait for my instructions."
else
  PROMPT="This session is dedicated to card $ID and is scoped to that card. Its folder is $CARD_DIR. A card lives in $DATA_ABS/inbox/$ID while it awaits a decision, in $DATA_ABS/topics/$ID once it is being worked on, and moves into a done/ folder next to those when its status is Done, so if that path is gone look in the other places. Read CLAUDE.md, then card.json and index.html in the card folder, then wait for my instructions. Keep the report page up to date as we work, and keep this card's TODO column current: tasks are folders at <card folder>/tasks/$ID-<k>/task.json, created and updated through the API (POST http://127.0.0.1:${PORT:-8080}/api/cards/$ID/tasks, format in CLAUDE.md).$TABS_NOTE Write for a human reader: lead with the answer, then short bullets, never a wall of text (see CLAUDE.md). Do not change workspace code (server.js, shell.html, home.html, scripts); workspace changes belong in the main session on the home page."
fi
exec "$CLAUDE" ${ADD[@]+"${ADD[@]}"} --session-id "$UUID" "$PROMPT"

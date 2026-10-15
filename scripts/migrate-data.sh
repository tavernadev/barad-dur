#!/usr/bin/env bash
# Moves private data (cards/, .sessions/, .counter) out of the repo folder into DATA_DIR and records it in .env.
# Stop `npm start` first: the web server and the terminal must not be running while files move.
# Usage: scripts/migrate-data.sh [target-dir]    (default: DATA_DIR from .env, else ~/barad-dur-data)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
TARGET="${1:-${DATA_DIR:-$HOME/barad-dur-data}}"
TARGET="${TARGET/#\~/$HOME}"
for p in "${PORT:-8080}" "${TTYD_PORT:-7681}"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p is in use. Stop npm start first." >&2; exit 1
  fi
done
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
if [ "$TARGET" = "$(pwd)" ]; then echo "Target is the repo folder; nothing to do."; exit 0; fi
for item in cards .sessions .counter; do
  if [ -e "$item" ] && [ -e "$TARGET/$item" ]; then
    echo "$TARGET/$item already exists; refusing to overwrite." >&2; exit 1
  fi
done
for item in cards .sessions .counter; do
  if [ -e "$item" ]; then mv "$item" "$TARGET/$item"; echo "moved $item"; fi
done
touch .env
grep -v '^DATA_DIR=' .env > .env.tmp || true
echo "DATA_DIR=$TARGET" >> .env.tmp
mv .env.tmp .env
echo "Data is now in $TARGET (DATA_DIR saved in .env). Run npm start."

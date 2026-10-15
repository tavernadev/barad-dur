#!/usr/bin/env bash
# Starts the web server and the browser terminal; Ctrl-C stops both.
# Settings (see example.env): PORT, HOST, TTYD_PORT, OPEN_BROWSER.
set -euo pipefail
cd "$(dirname "$0")"
. ./load-env.sh   # .env values; real environment variables win
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT INT TERM
./terminal.sh &
node --watch server.js &
if [ "${OPEN_BROWSER:-1}" != "0" ]; then
  OPENER="$(command -v open || command -v xdg-open || true)"
  [ -n "$OPENER" ] && (sleep 1; "$OPENER" "http://${HOST:-127.0.0.1}:${PORT:-8080}/") &
fi
wait

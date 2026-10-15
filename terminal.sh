#!/usr/bin/env bash
# Browser terminal (ttyd) bound to loopback only; one Claude session per card.
# -a lets the page pass ?arg=<card id> to card-terminal.sh (which validates it).
# -O rejects WebSocket connections from other origins, so other webpages can't drive the shell.
# Settings (see example.env): TTYD_PORT, TTYD_INTERFACE.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
IFACE="${TTYD_INTERFACE:-$([ "$(uname)" = Darwin ] && echo lo0 || echo lo)}"
exec ttyd -W -O -a -i "$IFACE" -p "${TTYD_PORT:-7681}" ./card-terminal.sh

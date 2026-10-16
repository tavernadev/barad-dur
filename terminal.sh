#!/usr/bin/env bash
# Browser terminal (ttyd) bound to loopback only; one Claude session per card.
# -a lets the page pass ?arg=<card id> to card-terminal.sh (which validates it).
# -O rejects WebSocket connections from other origins, so other webpages can't drive the shell.
# -s is the signal ttyd sends to the session when its browser tab closes. ttyd's default, SIGHUP, did not end Claude Code (27 claude
# processes piled up for 4 open tabs), so the default here is SIGKILL: closing a tab ends its session; the transcript is saved as it goes,
# so opening the card again resumes it.
# Settings (see example.env): TTYD_PORT, TTYD_INTERFACE, TTYD_CLOSE_SIGNAL.
set -euo pipefail
cd "$(dirname "$0")"
. ./load-env.sh   # .env values; real environment variables win
IFACE="${TTYD_INTERFACE:-$([ "$(uname)" = Darwin ] && echo lo0 || echo lo)}"
exec ttyd -W -O -a -s "${TTYD_CLOSE_SIGNAL:-SIGKILL}" -i "$IFACE" -p "${TTYD_PORT:-7681}" ./card-terminal.sh

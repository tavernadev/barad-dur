#!/usr/bin/env bash
# Browser terminal (ttyd) bound to loopback only; one Claude session per card.
# -a lets the page pass ?arg=<card id> to card-terminal.sh (which validates it).
# -O rejects WebSocket connections from other origins, so other webpages can't drive the shell.
# -s is the signal ttyd sends to the session when its browser tab closes. ttyd's default, SIGHUP, did not end Claude Code (27 claude
# processes piled up for 4 open tabs), so the default here is SIGKILL: closing a tab ends its session; the transcript is saved as it goes,
# so opening the card again resumes it.
# ttyd's own page asks "Leave site? Changes you made may not be saved." whenever the tab is closed or refreshed. That is a browser popup the user
# decided against, so it is switched off (client option disableLeaveAlert) unless TTYD_LEAVE_ALERT=1. Nothing can tell from outside whether Claude is
# in the middle of a reply, so there is no "only when busy" version: closing a tab ends its Claude process (see -s above), and the user decides.
# Settings (see example.env): TTYD_PORT, TTYD_INTERFACE, TTYD_CLOSE_SIGNAL, TTYD_BACKGROUND, TTYD_LEAVE_ALERT.
set -euo pipefail
cd "$(dirname "$0")"
. ./load-env.sh   # .env values; real environment variables win
IFACE="${TTYD_INTERFACE:-$([ "$(uname)" = Darwin ] && echo lo0 || echo lo)}"
BG="${TTYD_BACKGROUND:-#000000}"
LEAVE=(-t disableLeaveAlert=true)
[ "${TTYD_LEAVE_ALERT:-0}" = "1" ] && LEAVE=()
exec ttyd -W -O -a -s "${TTYD_CLOSE_SIGNAL:-SIGKILL}" -i "$IFACE" -p "${TTYD_PORT:-7681}" -t "theme={\"background\":\"$BG\"}" ${LEAVE[@]+"${LEAVE[@]}"} ./card-terminal.sh

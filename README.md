# Barad-dûr

A local, all-seeing command center. One browser page shows every ticket or topic you are working on as a card,
and each card gets its own tasks (the TODO column) and its own [Claude Code](https://claude.com/claude-code)
session running in an in-browser terminal.

```
 terminal (Claude session)  |  Topics grid + Inbox   or   a card's report + TODO column
```

## Requirements

- Node.js 20.12 or newer (no npm dependencies)
- [ttyd](https://github.com/tsl0922/ttyd) for the browser terminal (`brew install ttyd`)
- The `claude` CLI (Claude Code) on your PATH

## Run it

```bash
cp example.env .env     # optional: every setting has a default
npm start               # web server + terminal; opens the browser
```

The first run creates `cards/` and seeds one example card. Add your own from the Inbox (`+`).

Tests (no ports, no real data): `npm test`.

## Configuration

All settings are environment variables; a local `.env` is loaded if present (see `example.env`).

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `Barad-dûr` | Browser tab title |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Web server. Keep it on loopback |
| `TTYD_PORT` / `TTYD_INTERFACE` | `7681` / `lo0` or `lo` | Browser terminal |
| `DATA_DIR` | `.` | Where `cards/`, `.sessions/` and `.counter` live |
| `LINEAR_BASE_URL` | empty | Ticket links, e.g. `https://linear.app/<workspace>/issue/` |
| `CLAUDE_BIN` | `claude` | Claude Code executable |
| `OPEN_BROWSER` | `1` | Open the browser on `npm start` |

## Your data stays out of git

Tickets, cards, tasks and Claude session ids are private. `cards/`, `.sessions/`, `.counter` and `.env` are
gitignored; only the code, `CLAUDE.md` (instructions for the agents) and `examples/` are committed. To keep data
completely outside the repo, set `DATA_DIR` to another folder. Already have cards in the repo folder? Stop the
app and run `scripts/migrate-data.sh [target]`; it moves `cards/`, `.sessions/` and `.counter` and saves `DATA_DIR`
in `.env`. Claude sessions get the data folder through `--add-dir`, so they can read and write it without prompts.

## Security

The terminal gives a shell, so everything binds to loopback only, and the terminal rejects connections from other
origins. Do not expose these ports to a network.

## License

[MIT](LICENSE)

## For agents

`CLAUDE.md` is the contract every Claude session in this repo reads: roles (main session vs card sessions), how to
keep tasks and reports current, and the rules for changing the workspace.

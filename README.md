<p align="center"><img src="static/barad-dur.png" alt="Barad-dûr, the all-seeing eye" width="180"></p>

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
| `DATA_DIR` | `data` | Where your private data lives (`cards/`, `.sessions/`, `.counter`): a folder inside the repo (relative to the repo folder) or a full path like `/home/you/barad-dur-data` or `~/barad-dur-data` |
| `LINEAR_BASE_URL` | empty | Ticket links, e.g. `https://linear.app/<workspace>/issue/` |
| `CLAUDE_BIN` | `claude` | Claude Code executable |
| `OPEN_BROWSER` | `1` | Open the browser on `npm start` |

## Your data stays out of git

Tickets, cards, tasks and Claude session ids are private. They live in `./data`, which is gitignored (so are `.env` and
the legacy `cards/`, `.sessions/` and `.counter` locations); only the code, `CLAUDE.md` (instructions for the agents),
`examples/` and the docs are committed.

Set `DATA_DIR` to keep the data somewhere else: a folder inside the repo (relative to the repo folder) or a full path
such as `/home/you/barad-dur-data` or `~/barad-dur-data`. When the data is outside the repo folder, Claude sessions get
it through `--add-dir`, so they can read and write it without permission prompts.

Have cards in the repo folder from an older install? Stop the app and move `cards/`, `.sessions/` and `.counter` into
`./data` (or your `DATA_DIR`). Until you do, the old location keeps working and the server says so at startup.

## Security

The terminal gives a shell, so everything binds to loopback only, and the terminal rejects connections from other
origins. Do not expose these ports to a network.

## License

[MIT](LICENSE)

## For agents

`CLAUDE.md` is the contract every Claude session in this repo reads: roles (main session vs card sessions), how to
keep tasks and reports current, and the rules for changing the workspace.

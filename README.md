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
- [ttyd](https://github.com/tsl0922/ttyd) for the browser terminal (`brew install ttyd`, or `sudo apt install ttyd` on Ubuntu/WSL)
- The `claude` CLI (Claude Code) on your PATH

> **WSL/Ubuntu:** the `ttyd` package starts a system service on port 7681 that shows a `login:` prompt instead of
> Claude. Disable it with `sudo systemctl disable --now ttyd`.

## Run it

```bash
cp example.env .env     # optional: every setting has a default
npm start               # web server + terminal; opens the browser
```

The first run creates `data/` and seeds one example card. Add your own from the Inbox (`+`).

Tests (no ports, no real data): `npm test`.

## Configuration

All settings are environment variables; a local `.env` is loaded if present (see `example.env`).

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `Barad-dûr` | Browser tab title |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Web server. Keep it on loopback |
| `TTYD_PORT` / `TTYD_INTERFACE` | `7681` / `lo0` or `lo` | Browser terminal |
| `DATA_DIR` | `data` | Where your private data lives (`inbox/`, `topics/`, `.sessions/`, `.counter`): a folder inside the repo (relative to the repo folder) or a full path like `/home/you/barad-dur-data` or `~/barad-dur-data` |
| `LINEAR_BASE_URL` | empty | Ticket links, e.g. `https://linear.app/<workspace>/issue/` |
| `CLAUDE_BIN` | `claude` | Claude Code executable |
| `OPEN_BROWSER` | `1` | Open the browser on `npm start` |

## How it is organized

The main page has two columns: the **Inbox** (cards awaiting a decision on whether they will be worked on) and
**Topics** (cards you are working on). Move a card from the Inbox to Topics with its button or by dragging it. Every
card can have **tasks** (the TODO column on its page), and each card gets its own Claude session in its own tab.

## Your data stays out of git

Everything you create is private and lives in one folder, `./data` by default (gitignored; so are `.env` and the older
`cards/`, `.sessions/` and `.counter` locations of older installs). Only the code, `CLAUDE.md` (instructions for the agents), `examples/`
and the docs are committed.

```
data/
  inbox/<n>/             a card awaiting a decision (n = the card's number; no name or date in folder names)
  topics/<n>/            a card being worked on
  inbox/done/, topics/done/   finished cards, so the active folders only hold pending or working ones
    <card>/tasks/<n>-<k>/     one folder per task (card number - task number); tasks/done/ for finished tasks
  .sessions/<n>          Claude session id of each card;  .counter  last card number handed out
```

Finished work moves into `done/` by itself when its status becomes Done, so you can archive or delete those folders
whenever you like.

Set `DATA_DIR` to keep the data somewhere else: a folder inside the repo (relative to the repo folder) or a full path
such as `/home/you/barad-dur-data` or `~/barad-dur-data`. When it is outside the repo folder, Claude sessions get it
through `--add-dir`, so they can read and write it without permission prompts.

Upgrading from an older install? Nothing to do: at startup the server converts the old `cards/<name>/` layout into the
folders above, once (it keeps card numbers and Claude sessions). Take a copy of your data first if you want a backup.

## Security

The terminal gives a shell, so everything binds to loopback only, and the terminal rejects connections from other
origins. Do not expose these ports to a network.

## License

[MIT](LICENSE)

## For agents

`CLAUDE.md` is the contract every Claude session in this repo reads: roles (main session vs card sessions), how to
keep tasks and reports current, and the rules for changing the workspace.

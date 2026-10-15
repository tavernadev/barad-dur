# Barad-dûr (command center)

Local browser workspace, the all-seeing command center: a terminal (ttyd) on the left, ticket/topic cards and
reports on the right. The user runs it themselves with `npm start`. See `README.md` for setup and `example.env`
for every setting.

## Quick start for agents (read this first)

**Which session are you?** Your first prompt says. "dedicated to card `<id>`" = a **card session**;
"main workspace session" = the **main session**. Everything about a card session is scoped to
`cards/<id>/` and nothing else.

**Vocabulary:** a *card* is a ticket or topic (a folder under `cards/`). The **TODO** column on a card's page
lists that card's **tasks**. A task belongs to exactly one card and is never shared across cards.

### Standing rule: record every rule the user gives

Whenever the user states a rule, specification, preference, or convention ("always...", "never...", "it should...",
"each card must...", a naming or layout choice), **write it into this file in the same turn, without asking**:
put it in the section where it belongs (or add one), phrase it as an instruction to future agents, replace
anything it contradicts instead of leaving both, and mention in your reply that `CLAUDE.md` was updated.
This applies to every session. Workspace-wide rules go here; a rule that only concerns one card belongs in that
card's own folder (its report or `card.json`), not here. Don't record one-off requests ("fix this bug") as rules.

### Card session: do this automatically, without being asked

1. **On start**, read `cards/<id>/card.json`, `index.html` and `tasks.json` (if present), then wait for the
   user's instruction.
2. **Keep the card's tasks current.** If `tasks.json` is empty or missing and the goal is clear, create the
   task list yourself: 3-8 concrete tasks, ordered, imperative short titles, status `Pending`, a priority.
   Add tasks as you discover work, and reorder when the plan changes.
3. **Track progress on the task itself.** When you start a task set it `In Progress` (keep one or two at a
   time) and add an update; when you finish set `Done` with an update saying what was found or changed and how
   you know; if blocked, add an update saying what is needed and from whom. Write updates with
   `"by": "claude"`, short and factual, no secrets.
4. **Keep the card in sync.** Move `card.json` status forward (Scoping, In Progress, Code Review, Testing,
   Done) when the overall state really changes. Don't change priority unless the user asks.
5. **Keep the report current.** Put findings in `cards/<id>/index.html`, say where each fact came from, and
   mark inferences as inferences.
6. **Stay in scope.** Don't edit other cards or workspace code (`server.js`, `shell.html`, `home.html`,
   `static/`, scripts). For separate work you find, add a task noting it, or suggest an Inbox card.

How to write tasks safely: re-read `tasks.json` right before editing (the user may have changed it in the
browser), change only what you mean to, keep valid JSON, keep ids unique (`t<N>`), append to `updates` rather
than rewriting history, and use a real UTC time for `at` (`date -u +%Y-%m-%dT%H:%M:%SZ`). Direct file edits and
`POST /api/cards/<id>/tasks` are both fine.

### Main session

- Owns the workspace itself: `server.js`, `shell.html`, `home.html`, `static/`, scripts, card template.
- **Keep this file in sync.** It is the contract every agent reads. Whenever you change behavior, routes, file
  layout, or conventions, update it in the same turn.
- Test server logic in an isolated harness (no ports, scratch directory), not by starting servers: add or update
  a test in `test/api.test.js` for every API or behavior change and run `npm test` before telling the user it works.
- Tell the user what needs a browser refresh or a restart (see "What reloads automatically").

## Configuration and privacy (repo hygiene)

- **Where the data lives:** `cards/`, `.sessions/` and `.counter` are in the data folder, `./data` by default
  (gitignored). `DATA_DIR` overrides it: a folder inside the repo (relative to the repo folder, not the shell's
  directory) or a full path (`/home/you/...` or `~/...`). Until an old install is migrated
  by hand, data still in the repo folder keeps being used. Every `cards/<id>/` path in these
  docs means `<data folder>/cards/<id>/`. Card sessions are told their absolute card folder in their first prompt
  and get `--add-dir` when the data is outside the repo folder, so use that absolute path, not a relative one.

- **Settings are environment variables**, never hardcoded: `APP_NAME`, `HOST`, `PORT`, `TTYD_PORT`,
  `TTYD_INTERFACE`, `DATA_DIR`, `LINEAR_BASE_URL`, `CLAUDE_BIN`, `OPEN_BROWSER`. The server loads `.env` at start
  (real environment wins) and serves the browser-safe ones at `/api/config`. When you add a setting, add it to
  `example.env` with a default and a comment, and to the README table in the same turn. Edits to `.env` need a
  server restart (tell the user); `node --watch` only watches `server.js`.
- **Private data is never committed:** `cards/`, `.sessions/`, `.counter`, `data/` and `.env` are gitignored and
  must stay that way. Never `git add -f` them, never copy card content, customer names, or ticket text into
  committed files (code, `CLAUDE.md`, README, `examples/`). Examples use fake data and the generic ticket key
  `ABC-123`. Secrets never go in `example.env` or any committed file.
- **`scripts/` is never committed** (it is gitignored: local one-off helpers). Don't reference a script from there in
  committed docs or code; describe the manual step instead.
- Org rule: no real ticket or incident IDs in committed code or docs.
- Committing or pushing is something the user asks for; don't do it on your own.

## Hard rules

- **Never start, restart, or stop servers.** The web server (`node --watch server.js`, default port 8080) and the
  terminal (`ttyd`, default port 7681; both set by `PORT` / `TTYD_PORT`) are owned by the user. Do not run `npm start`, `npm run web`,
  `npm run terminal`, `node server.js`, `ttyd`, or `start.sh`, and do not use `kill`/`pkill` on anything
  listening on 8080 or 7681. The ttyd process hosts the Claude session you are running in; killing it ends
  the conversation.
- **Do not open other ports either** (no test servers on 8090 etc.) without asking. Test against the
  already-running server on `http://127.0.0.1:8080` with read-only `curl` GETs, or in a no-port harness.
  Normal card work may call the card's own APIs (`POST /api/cards/<id>` for status, `.../tasks` for tasks);
  don't send other mutating requests just to test.
- If a change needs a server restart (it usually doesn't, see below), say so and let the user do it.
- Never reload or restructure `shell.html` casually: it hosts the terminal iframe, and reloading it restarts
  the terminal's `claude --resume` process. It is intentionally served without the live-reload snippet.

## What reloads automatically

- Files under `cards/` and `home.html`: the server pushes an SSE `reload` event; only the right-hand content
  iframe reloads, the terminal is untouched.
- `card.json` changes emit a `card` event instead: generated card pages (which set `window.__cardLive`) refresh
  their fields in place so you never lose focus while editing; hand-written reports and the home page still
  reload. `tasks.json` changes emit `tasks` and refresh only the TODO column.
- `server.js`: `node --watch` restarts the server on its own. Open pages must be refreshed afterward, which
  also restarts the terminal, so batch `server.js` edits and tell the user.
- `shell.html`: needs a manual browser refresh (restarts the terminal). Warn the user before editing it.

## Layout

```
server.js            dependency-free Node server (routes, SSE live reload, card API)
shell.html           split view: terminal iframe | content iframe, URL drives the content pane
home.html            Topics grid + Inbox column at / (shown next to the main terminal)
static/              shared assets: card.css/card.js (generated pages), tasks.js (TODO column, injected),
                     favicon.png (tab icon, 128x128, the "Molten golden all-seeing eye") and barad-dur.png (the official project image, 512x512, used as the
                     README logo); both are the user's own generated "Fiery Eye of Sauron" art, transparent background
data/                private data, gitignored (or wherever DATA_DIR points); the three items below live in it
  .counter           last card number handed out (server-managed, never reused)
  cards/<id>/
    card.json        title, summary, status, priority, tags, updated
    index.html       the report, served at /card/<id>
    tasks.json       the card's tasks (TODO column), written by its Claude session and by the user
  .sessions/<id>     Claude session id for that card (one session per card)
examples/cards/      sample card seeded on first run (so a fresh clone is not empty)
start.sh, terminal.sh, card-terminal.sh
scripts/             local helper scripts, gitignored and not in the repo (e.g. a one-off data migration); never commit this folder
test/api.test.js     API tests in a no-port harness (`npm test`); .github/workflows/test.yml runs them in CI
example.env          every setting with its default (committed); .env is the local copy (gitignored)
README.md, .gitignore, package.json
```

URLs: `/` card grid, `/card/<id>` a report with its own terminal. Content pages are served under
`/content/...` and navigate the shell via `postMessage`, so the terminal iframe stays mounted.

## Claude sessions: one main, one per card

- **Main session** (the home tab at `/`, ttyd `?arg=main`, session id in `.sessions/main`): changes to the
  workspace itself, i.e. `server.js`, `shell.html`, `home.html`, the card template and scripts.
- **Card session** (a `/card/<id>` tab, ttyd `?arg=<id>`, session id in `.sessions/<id>`): scoped to that
  ticket. Work on `cards/<id>/` only (report, `card.json`, investigation). **Do not change workspace code
  from a card session**; tell the user to ask the main session instead. Don't edit other cards unless asked.
- Clicking a card on the grid opens `/card/<id>` in a **new browser tab** named `card-<id>`; the home tab is
  named `home`. Clicking again focuses the existing tab instead of starting a second session.
- ttyd runs `card-terminal.sh <id>`, which validates the id (`main` or an existing `cards/<id>/card.json`),
  then resumes the stored session or starts a new one with `--session-id` and a scoped first prompt.
- Reloading a tab restarts only that tab's `claude --resume` process; the session history is kept.
  Two tabs must not drive the same session at once.

## Cards

- To add a topic, create `cards/<id>/card.json` and `cards/<id>/index.html`. The card appears in the grid
  automatically. `<id>` is usually the ticket key (e.g. `ABC-123`).
- **Inbox:** the right column on the home page. The `+` button creates a card (`POST /api/cards` with
  `title` and `description`) as a real folder `cards/<yyyymmdd-slug>/` with `card.json` (`"inbox": true`,
  status Pending) and a generated `index.html` (shared styles/scripts in `static/`). "Move to Topics" sets
  `inbox` to false; dragging an Inbox card onto the Topics column does the same (the button remains as the
  keyboard fallback). Inbox cards show their description; Topics cards show title only. Opening an inbox card
  starts its own scoped session like any other card. There is no delete in the UI; remove the folder by hand.
- **Identifiers:** every card has a workspace `number` in `card.json` (shown as `#1`, `#2`, ...). It is
  assigned by the server (counter in `.counter`, never reused) and is the display ID. The folder name is only
  the routing key (`/card/<folder>`). The Linear ticket key is optional: `ticket` in `card.json` (e.g.
  `ABC-123`), set from the "+ Linear ticket" chip or `POST /api/cards/<id>` with `{"ticket":"ABC-123"}`
  (empty string removes it). Once a ticket is set, the grid shows only its link: there is deliberately no "edit"
  button next to it, so change it through the API or `card.json`. Never treat the ticket key as the card's unique ID.
- Allowed values (defined in `server.js`, `OPTIONS`):
  - status: Pending, Scoping, In Progress, Code Review, Testing, Done
  - priority: Low, Medium, High, Urgent (unset is allowed, shown as "Not set")
- Change status/priority by editing `card.json` or `POST /api/cards/<id>` with `Content-Type: application/json`
  and a body like `{"status":"Testing"}` (also accepts `inbox`, `ticket`, `title`, `description`, `notes`). Always keep `updated` as an ISO date (the API sets it for you).
  The user may have changed these in the browser, so re-read `card.json` before editing it and never revert
  their changes.
- **Generated (Inbox) cards are editable in the browser:** the title, description and notes are inputs that save
  to `card.json` automatically when you leave the field (Escape reverts, Enter saves the title). `card.json` is
  the source of truth for `title`, `description` and `notes`; the static text inside a generated `index.html`
  can be stale, so read `card.json`. Update them with `POST /api/cards/<id>` (`title` is required and at most
  200 characters; `description` at most 4000; `notes` at most 20000) or by editing `card.json`.
- Report pages may load assets from their own folder via relative paths. Link back with `href="/"` and
  link to other cards with `href="/card/<id>"`; external links open in a new tab automatically.

## Tasks (the TODO column on every card page)

- Every card's report page gets a right-hand **TODO** column, injected by the server (`static/tasks.js`), so
  hand-written reports need no markup for it. The column has a middle button to collapse/expand it and a
  drag handle to resize it (width and state are remembered).
- A **task belongs to a card** and has: `order`, `title`, `status`, `priority`, and `updates` (a log). Clicking
  a task opens it as a card layered over the report (not a popup), with an input box for writing updates.
- Stored in `cards/<id>/tasks.json`, an ordered array:
  `{"id":"t1","order":1,"title":"...","status":"Pending","priority":"High","updates":[{"at":"<ISO time>","by":"claude","text":"..."}]}`
  Status and priority use the same values as cards (see "Cards"; priority may be `""` for not set).
- **A card's Claude session creates the tasks** for the ticket and writes progress as updates with
  `"by": "claude"` (the user writes with `"by": "me"` from the UI). Editing `tasks.json` directly is fine; the
  column refreshes by itself without reloading the page. Use a fresh ISO timestamp for `at`, keep ids unique,
  append to `updates` instead of rewriting existing entries, and re-read the file first because the user may
  have edited it in the browser.
- API (same guards as the card API): `GET /api/cards/<id>/tasks`; `POST` with `{"title":"..."}` adds;
  `{"id":"t1","status":"Done"}` / `priority` / `title` edits; `{"id":"t1","update":"...","by":"claude"}` adds an
  update; `{"id":"t1","move":"up"|"down"}` reorders; `{"id":"t1","remove":true}` deletes.

## Content conventions

- Reports are static HTML, light/dark aware, self-contained (no build step, no frameworks).
- Reports are working notes, not a source of truth. Say where facts came from (Linear, email thread, code)
  and mark inferences as inferences.
- Do not write to Linear, Slack, or email from here unless the user asks in that turn.
- Follow the org rules from the parent `laurel/CLAUDE.md` (for example the `lrl` MongoDB connect commands).
- No credentials or customer secrets in cards. Customer names and ticket details already in the briefing
  are fine; don't add personal data beyond what the work needs.

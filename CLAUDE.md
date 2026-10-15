# Barad-dûr (command center)

Local browser workspace, the all-seeing command center: a terminal (ttyd) on the left, cards and reports on the
right. The user runs it themselves with `npm start`. See `README.md` for setup and `example.env` for every setting.

## The model (read this first)

The main page has two columns, and everything on it is a **card**:

- **Inbox** (right): cards that are alone, awaiting a decision on whether they will be worked on.
- **Topics** (left): cards the user decided to work on and is tracking.

Moving a card from the Inbox to Topics (the "Move to Topics" button, or dragging it over) is how it gets picked up.
**Every card, in the Inbox or in Topics, can have tasks.** The **TODO** column on a card's page lists that card's
tasks; a task belongs to exactly one card and is never shared. A card with status Done (and a task with status Done)
is filed in a `done/` folder, so the active folders only ever hold pending or working items and can be cleaned up
whenever the user wants.

## Quick start for agents

**Which session are you?** Your first prompt says. "dedicated to card `<n>`" = a **card session**; "main workspace
session" = the **main session**. A card session is scoped to its own card folder and nothing else.

### Standing rule: record every rule the user gives

Whenever the user states a rule, specification, preference, or convention ("always...", "never...", "it should...",
"each card must...", a naming or layout choice), **write it into this file in the same turn, without asking**:
put it in the section where it belongs (or add one), phrase it as an instruction to future agents, replace
anything it contradicts instead of leaving both, and mention in your reply that `CLAUDE.md` was updated.
This applies to every session. Workspace-wide rules go here; a rule that only concerns one card belongs in that
card's own folder (its report or `card.json`), not here. Don't record one-off requests ("fix this bug") as rules.

### Card session: do this automatically, without being asked

1. **On start**, read the card's `card.json` and `index.html` and its tasks, then wait for the user's instruction.
   Your first prompt gives the card folder; remember it can move (see "Where things live").
2. **Keep the card's tasks current.** If the card has no tasks and the goal is clear, create the list yourself:
   3-8 concrete tasks, ordered, imperative short titles, status `Pending`, a priority. Add tasks as you discover
   work, and reorder when the plan changes. Create and change tasks through the API (see "Tasks").
3. **Track progress on the task itself.** When you start a task set it `In Progress` (keep one or two at a
   time) and add an update; when you finish set `Done` with an update saying what was found or changed and how
   you know; if blocked, add an update saying what is needed and from whom. Write updates with
   `"by": "claude"`, short and factual, no secrets.
4. **Keep the card in sync.** Move the card's status forward (Scoping, In Progress, Code Review, Testing, Done) when
   the overall state really changes, through the API so the folder follows. Don't change priority unless asked.
5. **Keep the report current.** Put findings in the card's `index.html`, say where each fact came from, and mark
   inferences as inferences.
6. **Stay in scope.** Don't edit other cards or workspace code (`server.js`, `shell.html`, `home.html`, `static/`,
   scripts). For separate work you find, add a task noting it, or suggest a new Inbox card.
7. **Never delete or clean up `done/` folders yourself.** Cleaning them is the user's call.

### Main session

- Owns the workspace itself: `server.js`, `shell.html`, `home.html`, `static/`, scripts, card template.
- **Keep this file in sync.** It is the contract every agent reads. Whenever you change behavior, routes, file
  layout, or conventions, update it in the same turn.
- Test server logic in an isolated harness (no ports, scratch directory), not by starting servers: add or update
  a test in `test/api.test.js` for every API or behavior change and run `npm test` before telling the user it works.
  The harness's `fs.watch` must refuse folders that do not exist, like the real one, so startup-order bugs show up.
- Tell the user what needs a browser refresh or a restart (see "What reloads automatically").
- **A data layout change is a migration:** add the one-time conversion to `server.js` (locked, idempotent, never
  overwrites), test it on a copy of real data in the scratch folder first, and take a backup before the live server
  restarts onto it. Never save a `server.js` that has not booted successfully in the harness: `node --watch` restarts
  the user's live server on every save.

## Where things live

All private data is in the data folder: `./data` by default (gitignored), or wherever `DATA_DIR` points (a folder inside
the repo, relative to the repo folder, or a full path like `/home/you/...` or `~/...`). Below, `<data>` is that folder.

```
<data>/
  inbox/<n>/                  a card awaiting a decision          (n = the card's number, nothing else in the name)
  inbox/done/<n>/             an Inbox card whose status is Done
  topics/<n>/                 a card being worked on
  topics/done/<n>/            a Topics card whose status is Done
  <card folder>/
    card.json                 number, title, description, status, priority, ticket, tags, notes, created, updated
    index.html                the card's report, served at /card/<n>
    tasks/<n>-<k>/task.json   one folder per task: card number - task number (1-1, 1-2, ... 12-3)
    tasks/done/<n>-<k>/       tasks whose status is Done
    tasks/.counter            last task number handed out for this card (never reused)
  .sessions/<n>               Claude session id of card n (one session per card); .sessions/main for the main session
  .counter                    last card number handed out (never reused)
```

- **Naming convention:** folders are numbers only, no title and no date. The number is global across Inbox and Topics,
  assigned by the server, never reused, and is what the UI shows as `#n`. The title lives in `card.json`.
- **A card's folder changes with its state.** Inbox -> Topics moves `inbox/<n>` to `topics/<n>`; status Done moves it
  under `done/`; reopening moves it back. The **server does the move** when you change the card through the API
  (`POST /api/cards/<n>`), so use the API for `status` and `inbox`; editing `card.json` by hand does not move the folder.
  Always find a card by number: it is in one of `topics/<n>`, `inbox/<n>`, `topics/done/<n>`, `inbox/done/<n>`.
  Tasks follow the same idea inside the card: status Done moves a task folder into `tasks/done/`.
- **Old layout:** `cards/<slug>/` (with `inbox: true`, one `tasks.json`, sessions named by slug) is converted once at
  server start into the layout above. Don't write to a `cards/` folder.

Repo files:

```
server.js            dependency-free Node server (routes, SSE live updates, card and task APIs, migration)
shell.html           split view: terminal iframe | content iframe, URL drives the content pane
home.html            Topics grid and Inbox column at / (shown next to the main terminal)
static/              shared assets: card.css/card.js (generated pages), tasks.js (TODO column, injected),
                     live.js + live-worker.js (one shared live-update connection), favicon.png (tab icon,
                     256x256, the "Molten golden all-seeing eye" cropped tight) and barad-dur.png (the
                     official project image, 512x512, the README logo); both are the user's own generated art
examples/topics/     sample card (with tasks) seeded into <data>/topics on the first run of a fresh clone
start.sh, terminal.sh, card-terminal.sh, load-env.sh   launchers; load-env.sh reads .env without overriding the environment
scripts/             local helper scripts, gitignored and not in the repo; never commit this folder
test/api.test.js     API, storage and migration tests in a no-port harness (`npm test`); CI runs them
example.env          every setting with its default (committed); .env is the local copy (gitignored)
README.md, LICENSE, .gitignore, package.json
```

URLs: `/` the main page, `/card/<n>` a card's report with its own terminal. Content pages are served under
`/content/...` and navigate the shell via `postMessage`, so the terminal iframe stays mounted.

## Configuration and privacy (repo hygiene)

- **Settings are environment variables**, never hardcoded: `APP_NAME`, `HOST`, `PORT`, `TTYD_PORT`,
  `TTYD_INTERFACE`, `DATA_DIR`, `LINEAR_BASE_URL`, `CLAUDE_BIN`, `OPEN_BROWSER`. The server loads `.env` at start
  and the shell scripts load it through `load-env.sh`; in both, **real environment variables win over `.env`**. The
  browser-safe settings are served at `/api/config`. When you add a setting, add it to `example.env` with a default and
  a comment, and to the README table in the same turn. Edits to `.env` need a server restart (tell the user);
  `node --watch` only watches `server.js`.
- **Private data is never committed:** `data/` (and the legacy `topics/`, `inbox/`, `cards/`, `.sessions/`,
  `.counter`), `.env` and `.backup-*` are gitignored and must stay that way. Never `git add -f` them, never copy card
  content, customer names, or ticket text into committed files (code, `CLAUDE.md`, README, `examples/`). Examples use
  fake data and the generic ticket key `ABC-123`. Secrets never go in `example.env` or any committed file.
- **`scripts/` is never committed** (it is gitignored: local one-off helpers). Don't reference a script from there in
  committed docs or code; describe the manual step instead.
- Org rule: no real ticket or incident IDs in committed code or docs.
- Committing or pushing is something the user asks for; don't do it on your own. Before a commit, check what is
  staged for private data.

## Hard rules

- **Never start, restart, or stop servers.** The web server (`node --watch server.js`, default port 8080) and the
  terminal (`ttyd`, default port 7681; set by `PORT` / `TTYD_PORT`) are owned by the user. Do not run `npm start`,
  `npm run web`, `npm run terminal`, `node server.js`, `ttyd`, or `start.sh`, and do not use `kill`/`pkill` on
  anything listening on those ports. The ttyd process hosts the Claude session you are running in; killing it ends
  the conversation. Saving `server.js` restarts the web server by itself; that is expected.
- **Do not run `claude` from a script or test.** Dry-run launchers with `CLAUDE_BIN=echo`, and check it took effect.
- **Do not open other ports either** (no test servers on 8090 etc.) without asking. Test against the
  already-running server on `http://127.0.0.1:8080` with read-only `curl` GETs, or in a no-port harness.
  Normal card work may call the card's own APIs (`POST /api/cards/<n>` for status, `.../tasks` for tasks);
  don't send other mutating requests just to test.
- If a change needs a server restart (it usually doesn't, see below), say so and let the user do it.
- Never reload or restructure `shell.html` casually: it hosts the terminal iframe, and reloading it restarts
  the terminal's `claude --resume` process. It is intentionally served without the live-reload snippet.

## What reloads automatically

- Changes under `inbox/` or `topics/` (a report, a card moving between Inbox, Topics and `done/`): the server pushes an
  SSE `reload` event; only the right-hand content iframe reloads, the terminal is untouched. So does `home.html`.
- `card.json` changes emit a `card` event instead: generated card pages (which set `window.__cardLive`) refresh
  their fields in place so you never lose focus while editing; hand-written reports and the home page still
  reload. Anything under a card's `tasks/` emits `tasks` and refreshes only the TODO column.
- All tabs share one live-update connection (`static/live.js` + a shared worker), because browsers allow only about
  six connections per host. Never open a new `EventSource` from page scripts; use `window.__live.on(event, fn)`.
- Never watch a single file with `fs.watch` for reloads: on macOS it also fires on plain reads, and every reload is a read, so the page
  reloads in a loop (it did, with `home.html`). Watch the folder and compare modification times before broadcasting.
- `server.js`: `node --watch` restarts the server on its own. Open pages must be refreshed afterward, which
  also restarts the terminal, so batch `server.js` edits and tell the user.
- `shell.html`: needs a manual browser refresh (restarts the terminal). Warn the user before editing it.

## Claude sessions: one main, one per card

- **Main session** (the home tab at `/`, ttyd `?arg=main`, session id in `.sessions/main`): changes to the
  workspace itself, i.e. `server.js`, `shell.html`, `home.html`, the card template and scripts.
- **Card session** (a `/card/<n>` tab, ttyd `?arg=<n>`, session id in `.sessions/<n>`): scoped to that card. Work on
  its folder only (report, `card.json`, tasks, investigation). **Do not change workspace code from a card session**;
  tell the user to ask the main session instead. Don't edit other cards unless asked.
- Clicking a card on the main page opens `/card/<n>` in a **new browser tab** named `card-<n>`; the home tab is
  named `home`. Clicking again focuses the existing tab instead of starting a second session.
- ttyd runs `card-terminal.sh <n>`, which validates the id (`main` or the number of an existing card), finds the
  card's folder, then resumes the stored session or starts a new one with `--session-id` and a first prompt that
  names the folder. It adds `--add-dir <data>` only when the data folder is outside the repo.
- Reloading a tab restarts only that tab's `claude --resume` process; the session history is kept.
  Two tabs must not drive the same session at once.

## Cards

- **Inbox:** the right column on the main page. The `+` button creates a card (`POST /api/cards` with `title` and
  `description`) in `inbox/<n>/` with `card.json` (status Pending) and a generated `index.html` (shared
  styles/scripts in `static/`). "Move to Topics" does `POST /api/cards/<n>` with `{"inbox": false}`; dragging an Inbox
  card onto the Topics column does the same. Inbox cards show their description; Topics cards show title only.
  Opening a card, in either column, starts its own scoped session. There is no delete in the UI: remove a folder by
  hand (the user's call).
- **Done cards are hidden on the main page** behind a "Show done (N)" toggle next to the Topics heading (remembered in the
  browser); shown ones are dimmed. The cards' "Updated <date>" line stays: the user asked to keep it.
- **Topics:** cards being worked on. A hand-made Topics card needs `topics/<n>/card.json` (with `number` equal to the
  folder name) and an `index.html`; use the next free number from `.counter` (or create it in the Inbox and move it).
- **Identifiers:** every card has a workspace `number` (`#1`, `#2`, ...), also its folder name; see "Where things
  live". The Linear ticket key is optional: `ticket` in `card.json` (e.g. `ABC-123`), set from the "+ Linear ticket"
  chip or `POST /api/cards/<n>` with `{"ticket":"ABC-123"}` (empty string removes it). Once a ticket is set, the grid
  shows only its link: there is deliberately no "edit" button next to it, so change it through the API or
  `card.json`. Never treat the ticket key as the card's unique ID.
- Allowed values (defined in `server.js`, `OPTIONS`):
  - status: Pending, Scoping, In Progress, Code Review, Testing, Done
  - priority: Low, Medium, High, Urgent (unset is allowed, shown as "Not set")
- Change a card with `POST /api/cards/<n>`, `Content-Type: application/json`, a body like `{"status":"Testing"}`
  (accepts `status`, `priority`, `inbox`, `ticket`, `title`, `description`, `notes`). The API keeps `updated` current and
  moves the folder when `status` becomes or stops being Done, or `inbox` changes. The user may have changed things
  in the browser, so re-read `card.json` before editing it and never revert their changes.
- **Generated (Inbox) cards are editable in the browser:** the title, description and notes are inputs that save
  to `card.json` automatically when you leave the field (Escape reverts, Enter saves the title). `card.json` is
  the source of truth for `title`, `description` and `notes`; the static text inside a generated `index.html`
  can be stale, so read `card.json`. Limits: `title` required, at most 200 characters; `description` 4000; `notes` 20000.
- Report pages may load assets from their own folder via relative paths. Link back with `href="/"` and
  link to other cards with `href="/card/<n>"`; external links open in a new tab automatically.

## Tasks (the TODO column on every card page)

- Every card's report page gets a right-hand **TODO** column, injected by the server (`static/tasks.js`), so
  hand-written reports need no markup for it. It has a middle button to collapse/expand it and a drag handle to resize
  it (width and state are remembered).
- A **task belongs to a card** and has: `order`, `title`, `status`, `priority`, and `updates` (a log). Clicking
  a task opens it as a card layered over the report (not a popup), with an input box for writing updates.
- Stored as one folder per task, `<card folder>/tasks/<card number>-<k>/task.json` (`tasks/done/` once Done):
  `{"id":"12-3","order":3,"title":"...","status":"Pending","priority":"High","updates":[{"at":"<ISO time>","by":"claude","text":"..."}]}`
  The id is the folder name: the card's number, a dash, then the task's own number (never reused per card).
  Status and priority use the same values as cards (priority may be `""` for not set).
- **A card's Claude session creates the tasks** for the ticket and writes progress as updates with `"by": "claude"`
  (the user writes with `"by": "me"` from the UI). **Use the API to create tasks and move them** so numbering,
  ordering and the `done/` folder stay right; editing an existing `task.json` in place (for example appending to
  `updates`) is fine and the column refreshes by itself. Use a real UTC time for `at`
  (`date -u +%Y-%m-%dT%H:%M:%SZ`), append to `updates` instead of rewriting history, and re-read first because the
  user may have edited it in the browser.
- API (same guards as the card API; `<n>` is the card number): `GET /api/cards/<n>/tasks` lists every task, active and
  done. `POST` with `{"title":"..."}` adds one; `{"id":"<n>-1","status":"Done"}` / `priority` / `title` edits (Done
  moves the folder into `tasks/done/`); `{"id":"<n>-1","update":"...","by":"claude"}` adds an update;
  `{"id":"<n>-1","move":"up"|"down"}` reorders; `{"id":"<n>-1","remove":true}` deletes the task folder.

## Content conventions

- Reports are static HTML, light/dark aware, self-contained (no build step, no frameworks).
- Reports are working notes, not a source of truth. Say where facts came from (Linear, email thread, code)
  and mark inferences as inferences.
- Do not write to Linear, Slack, or email from here unless the user asks in that turn.
- Follow the org rules from the parent `laurel/CLAUDE.md` (for example the `lrl` MongoDB connect commands).
- No credentials or customer secrets in cards. Customer names and ticket details already in the briefing
  are fine; don't add personal data beyond what the work needs.

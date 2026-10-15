// Barad-dûr: tiny dependency-free dev server for the command center. Configuration comes from the environment
// (see example.env); a local .env file is loaded if present and never overrides real environment variables.
//   /                -> shell (terminal iframe + content iframe)
//   /card/<n>        -> same shell, content iframe shows card n
//   /content/home    -> the Topics grid and the Inbox
//   /content/<n>/*   -> files of card n (HTML gets the live-reload snippet; the report also gets the TODO column)
//   /api/config      -> public settings (app name, terminal port, Linear base URL)
//   /api/cards       -> GET every card; POST creates a card in the Inbox (title, description)
//   /api/cards/<n>   -> POST status / priority / inbox / ticket / title / description / notes changes
//   /api/cards/<n>/tasks -> GET the card's tasks; POST add / update / remove / move
//   /static/*        -> shared CSS/JS (generated card pages, TODO column, live-update channel)
//   /events          -> SSE: "reload", "card" (card.json changed) and "tasks" (a task changed)
// The shell itself is never reloaded automatically, so the terminal keeps running.
//
// On disk (see CLAUDE.md): <DATA>/inbox/<n>/ cards awaiting a decision, <DATA>/topics/<n>/ cards being worked on, and
// <card>/tasks/<n>-<k>/ one folder per task. Finished items live in a done/ folder next to the active ones
// (inbox/done/, topics/done/, <card>/tasks/done/) so the active folders only hold pending or working items.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: defaults and the real environment apply */ }
// Private data lives in ./data (gitignored); DATA_DIR overrides it: a folder inside the repo (relative to the repo
// folder), a full path, or ~/...
const DATA = process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR.replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(ROOT, 'data');
const TOPICS = path.join(DATA, 'topics');     // cards you are working on
const INBOX = path.join(DATA, 'inbox');       // cards awaiting a decision to be worked on
const DONE = 'done';                          // finished items, inside topics/, inbox/ and <card>/tasks/
const SESSIONS = path.join(DATA, '.sessions'); // Claude session id per card number (and "main")
const COUNTER = path.join(DATA, '.counter');   // last card number handed out
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
// Public settings the browser needs (served at /api/config). No secrets here.
const CONFIG = {
  appName: process.env.APP_NAME || 'Barad-dûr',
  ttydPort: Number(process.env.TTYD_PORT || 7681),
  linearBaseUrl: process.env.LINEAR_BASE_URL || '', // e.g. https://linear.app/<workspace>/issue/ ; empty = tickets are not links
};

const isNumber = (s) => /^\d+$/.test(s);
const isTaskId = (s) => /^\d+-\d+$/.test(s);
const readCounter = (file) => parseInt(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '0', 10) || 0;

function moveSafe(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); // other volume
  }
}

// Where a card's folder lives, by number: inbox or topics, and in done/ once its status is Done.
const cardPath = (id, inbox, done) => path.join(inbox ? INBOX : TOPICS, ...(done ? [DONE] : []), String(id));
function findCard(id) {
  if (!isNumber(String(id))) return null;
  for (const inbox of [false, true]) for (const done of [false, true]) {
    const dir = cardPath(id, inbox, done);
    if (fs.existsSync(path.join(dir, 'card.json'))) return { id: String(id), dir, inbox, done };
  }
  return null;
}

// ---- tasks: one folder per task, <card>/tasks/<card number>-<task number>/task.json (done ones in tasks/done/)
const TASK_BY = ['me', 'claude'];
const taskPath = (cardDir, tid, done) => path.join(cardDir, 'tasks', ...(done ? [DONE] : []), tid);

function cleanTask(t, order) {
  return {
    order,
    title: t.title ?? t.text,
    status: OPTIONS.status.includes(t.status) ? t.status : (t.done ? 'Done' : 'Pending'),
    priority: OPTIONS.priority.includes(t.priority) ? t.priority : '',
    updates: (Array.isArray(t.updates) ? t.updates : []).filter((u) => u && typeof u.text === 'string')
      .map((u) => ({ at: typeof u.at === 'string' ? u.at : '', by: TASK_BY.includes(u.by) ? u.by : 'claude', text: u.text })),
  };
}
// Every task of a card (active and done), ordered. Tolerates hand-written task.json files (legacy "text", no order).
function readTasks(cardDir) {
  const found = [];
  for (const done of [false, true]) {
    const base = path.join(cardDir, 'tasks', ...(done ? [DONE] : []));
    let names = [];
    try { names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && isTaskId(d.name)).map((d) => d.name); } catch { /* none yet */ }
    for (const name of names) {
      let raw;
      try { raw = JSON.parse(fs.readFileSync(path.join(base, name, 'task.json'), 'utf8')); } catch { continue; }
      if (raw && typeof (raw.title ?? raw.text) === 'string') found.push({ id: name, k: Number(name.split('-')[1]), raw });
    }
  }
  found.sort((a, b) => (Number(a.raw.order) || a.k) - (Number(b.raw.order) || b.k) || a.k - b.k);
  return found.map((x, i) => ({ id: x.id, ...cleanTask(x.raw, i + 1) }));
}
// Write one task into its folder; a task whose status is Done lives in tasks/done/.
function saveTask(cardDir, t) {
  const here = taskPath(cardDir, t.id, t.status === 'Done'), other = taskPath(cardDir, t.id, t.status !== 'Done');
  if (!fs.existsSync(here) && fs.existsSync(other)) moveSafe(other, here);
  fs.mkdirSync(here, { recursive: true });
  fs.writeFileSync(path.join(here, 'task.json'),
    JSON.stringify({ id: t.id, order: t.order, title: t.title, status: t.status, priority: t.priority, updates: t.updates }, null, 2) + '\n');
}
const removeTask = (cardDir, tid) => { for (const d of [false, true]) fs.rmSync(taskPath(cardDir, tid, d), { recursive: true, force: true }); };
function nextTaskNumber(cardDir, cardId) {
  const file = path.join(cardDir, 'tasks', '.counter');
  const n = Math.max(readCounter(file), ...readTasks(cardDir).map((t) => Number(t.id.split('-')[1]))) + 1;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, n + '\n');
  return n;
}
// Old layout: a single tasks.json per card -> task folders.
function convertLegacyTasks(cardDir, cardId) {
  const file = path.join(cardDir, 'tasks.json');
  if (!fs.existsSync(file)) return;
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: leave the file where it is */ return; }
  const list = (Array.isArray(raw) ? raw : []).map((t, i) => ({ t, i })).filter(({ t }) => t && typeof (t.title ?? t.text) === 'string')
    .sort((a, b) => (Number(a.t.order) || a.i + 1) - (Number(b.t.order) || b.i + 1) || a.i - b.i);
  list.forEach(({ t }, k) => saveTask(cardDir, { id: `${cardId}-${k + 1}`, ...cleanTask(t, k + 1) }));
  fs.mkdirSync(path.join(cardDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(cardDir, 'tasks', '.counter'), list.length + '\n');
  fs.rmSync(file);
}

// Editable card fields and their allowed values (shared with the UI via /api/options).
const OPTIONS = {
  status: ['Pending', 'Scoping', 'In Progress', 'Code Review', 'Testing', 'Done'],
  priority: ['Low', 'Medium', 'High', 'Urgent'],
};

const STATIC = path.join(ROOT, 'static');

const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Every card gets a workspace number (#1, #2, ...) that is ours and never reused; it is also the card's folder name.
// The Linear ticket key ("ticket" in card.json) is optional and can be added later, so it is not the identifier.
function nextNumber() {
  const n = Math.max(readCounter(COUNTER), ...listCards().map((c) => c.number)) + 1;
  fs.writeFileSync(COUNTER, n + '\n');
  return n;
}

function renderCardHtml(meta) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<link rel="stylesheet" href="/static/card.css">
</head>
<body>
<nav><a href="/">&larr; All cards</a></nav>
<div class="wrap">
  <h1><span class="muted">#${meta.number}</span> ${esc(meta.title)}</h1>
  <div class="meta">
    <div><b>Status</b><select data-field="status" aria-label="Status"></select></div>
    <div><b>Priority</b><select data-field="priority" aria-label="Priority"></select></div>
    <div><b>Created</b>${esc(meta.created)}</div>
  </div>
  <h2>Description</h2>
  <p class="desc">${esc(meta.description) || '<span class="muted">No description.</span>'}</p>
  <h2>Notes</h2>
  <p class="muted">Working notes for this card go here.</p>
</div>
<script src="/static/card.js"></script>
</body>
</html>
`;
}

// JSON content type forces a CORS preflight, which we never grant; the Origin check is belt and braces.
function guardJson(req, res) {
  const origin = req.headers.origin;
  if (!/^application\/json/.test(req.headers['content-type'] || '') || (origin && new URL(origin).host !== req.headers.host)) {
    send(res, 403, 'Forbidden');
    return false;
  }
  return true;
}

function readJson(req, res, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 16384) req.destroy(); });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return send(res, 400, 'Bad JSON'); }
    cb(data || {});
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

const LIVE_JS = '<script src="/static/live.js"></script>'; // shared event channel, injected first
const LIVE_RELOAD = `<script>(function(){
  if (window.parent !== window) {
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a'); if (!a) return;
      var h = a.getAttribute('href'); if (!h || h.charAt(0) === '#') return;
      if (/^https?:/.test(h) && new URL(h).origin !== location.origin) {
        e.preventDefault(); window.open(h, '_blank', 'noopener'); return;
      }
      if (h.charAt(0) === '/' && h.indexOf('/content/') !== 0 && !a.target) {
        e.preventDefault(); parent.postMessage({ type: 'navigate', path: h }, location.origin);
      }
    });
  }
  window.__live.on('reload', function () { location.reload(); });
  window.__live.on('card', function () { if (!window.__cardLive) location.reload(); });
})();</script>`;

const clients = new Set();
const timers = {};
function broadcast(event = 'reload', data = '1') {
  clearTimeout(timers[event + data]);
  timers[event + data] = setTimeout(() => clients.forEach((res) => res.write(`event: ${event}\ndata: ${data}\n\n`)), 100);
}
// Task edits (UI or a card's Claude session) refresh only the TODO column; card.json edits refresh a card's fields in
// place; anything else (moves between inbox/topics/done, reports) reloads the content pane.
function onCardsChange(_ev, name) {
  const parts = String(name || '').split(/[\\/]/);
  if (parts[0] === DONE) parts.shift();
  if (isNumber(parts[0] || '') && parts[1] === 'tasks') broadcast('tasks', parts[0]);
  else if (isNumber(parts[0] || '') && parts[1] === 'card.json') broadcast('card', parts[0]);
  else broadcast('reload');
}
const watchCards = () => { for (const d of [TOPICS, INBOX]) fs.watch(d, { recursive: true }, onCardsChange); }; // called once the folders exist
// home.html: watch the folder (survives editors that save by replacing the file) and reload only when the file's
// modification time really changed. A single-file fs.watch on macOS also fires on mere reads, and every reload is a
// read: that made the main page reload every second or two.
const HOME = path.join(ROOT, 'home.html');
let homeMtime = fs.statSync(HOME).mtimeMs;
fs.watch(ROOT, (_ev, name) => {
  if (name !== 'home.html') return;
  let m; try { m = fs.statSync(HOME).mtimeMs; } catch { return; }
  if (m !== homeMtime) { homeMtime = m; broadcast('reload'); }
});
setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 25000).unref();

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// inject=false for the shell: it hosts the terminal iframe and must never auto-reload.
function sendFile(res, file, inject = true, extra = '') {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (inject && type.startsWith('text/html')) {
      const html = data.toString('utf8');
      const i = html.lastIndexOf('</body>');
      const add = LIVE_RELOAD + extra;
      const withTail = i === -1 ? html + add : html.slice(0, i) + add + html.slice(i);
      const body = /<head[^>]*>/i.test(withTail) ? withTail.replace(/<head[^>]*>/i, (m) => m + LIVE_JS) : LIVE_JS + withTail;
      return send(res, 200, body, type);
    }
    send(res, 200, data, type);
  });
}

// Old layout: <base>/cards/<slug>/ (card.json with "inbox", one tasks.json), <base>/.sessions/<slug>, <base>/.counter,
// where <base> is the data folder or the repo folder. Moved once into inbox/<n> or topics/<n> (done/ for finished
// cards), tasks.json becomes task folders, sessions follow the number. Nothing is overwritten.
function migrateLegacyLayout() {
  const bases = [...new Set([DATA, ROOT])].filter((b) => fs.existsSync(path.join(b, 'cards')));
  if (!bases.length) return;
  // Exclusive lock: a second instance starting at the same moment waits, then finds nothing left to move.
  const lock = path.join(DATA, '.migrating');
  fs.mkdirSync(DATA, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (i >= 100) { fs.rmSync(lock, { recursive: true, force: true }); continue; } // 10s: a crashed run left it behind
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { moveLegacyCards(bases); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
function moveLegacyCards(bases) {
  const moved = [];
  for (const base of bases) {
    const old = path.join(base, 'cards');
    if (!fs.existsSync(old)) continue; // another instance already moved it
    for (const d of [TOPICS, INBOX, SESSIONS]) fs.mkdirSync(d, { recursive: true });
    const cards = fs.readdirSync(old, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(old, d.name, 'card.json')))
      .map((d) => {
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(old, d.name, 'card.json'), 'utf8')); } catch { /* keep going */ }
        return { name: d.name, meta, born: fs.statSync(path.join(old, d.name)).birthtimeMs };
      }).sort((a, b) => a.born - b.born || a.name.localeCompare(b.name)); // creation time is not reported on every filesystem: tie-break by name
    const used = new Set(listCards().map((c) => c.number));
    let max = Math.max(readCounter(COUNTER), readCounter(path.join(base, '.counter')), ...used, ...cards.map((c) => Number(c.meta.number) || 0));
    for (const c of cards) { // keep a card's own number when it is free, so "#4" stays "#4"
      const n = Number(c.meta.number);
      if (Number.isInteger(n) && n > 0 && !used.has(n)) { c.n = n; used.add(n); }
    }
    for (const c of cards) if (!c.n) { c.n = ++max; used.add(c.n); }
    for (const c of cards) {
      const inbox = !!c.meta.inbox, done = c.meta.status === 'Done';
      delete c.meta.inbox; // derived from where the folder lives
      c.meta.number = c.n;
      fs.writeFileSync(path.join(old, c.name, 'card.json'), JSON.stringify(c.meta, null, 2) + '\n');
      const dst = cardPath(c.n, inbox, done);
      moveSafe(path.join(old, c.name), dst);
      convertLegacyTasks(dst, c.n);
      const sess = path.join(base, '.sessions', c.name);
      if (fs.existsSync(sess) && !fs.existsSync(path.join(SESSIONS, String(c.n)))) moveSafe(sess, path.join(SESSIONS, String(c.n)));
      moved.push(`#${c.n} <- cards/${c.name}  (${inbox ? 'inbox' : 'topics'}${done ? '/done' : ''})`);
    }
    const mainSess = path.join(base, '.sessions', 'main');
    if (base !== DATA && fs.existsSync(mainSess) && !fs.existsSync(path.join(SESSIONS, 'main'))) moveSafe(mainSess, path.join(SESSIONS, 'main'));
    fs.writeFileSync(COUNTER, Math.max(max, readCounter(COUNTER)) + '\n');
    if (base !== DATA) fs.rmSync(path.join(base, '.counter'), { force: true });
    for (const leftover of [old, path.join(base, '.sessions')]) { try { fs.rmdirSync(leftover); } catch { /* not empty: left for you to look at */ } }
  }
  if (moved.length) console.log(`Moved ${moved.length} cards into ${DATA}:\n  ${moved.join('\n  ')}`);
}

// Every card: active ones plus those in done/. inbox / done come from where the folder lives, the number from its name.
function listCards() {
  const out = [];
  for (const inbox of [false, true]) for (const done of [false, true]) {
    const base = path.dirname(cardPath(0, inbox, done));
    let names = [];
    try { names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && isNumber(d.name)).map((d) => d.name); } catch { /* folder not created yet */ }
    for (const name of names) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(base, name, 'card.json'), 'utf8'));
        out.push({ ...meta, id: name, number: Number(name), inbox, done });
      } catch { /* not a card */ }
    }
  }
  return out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}

migrateLegacyLayout();

// First run on a fresh clone: create the folders and seed one example card so the UI is not empty.
if (!fs.existsSync(TOPICS) && !fs.existsSync(INBOX)) {
  fs.mkdirSync(TOPICS, { recursive: true });
  try { fs.cpSync(path.join(ROOT, 'examples', 'topics'), TOPICS, { recursive: true }); } catch { /* examples are optional */ }
}
for (const d of [TOPICS, INBOX]) fs.mkdirSync(d, { recursive: true });
watchCards();

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = decodeURIComponent(url.pathname);

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/cards' && req.method === 'POST') {
    // Create a card in the Inbox: title + description -> inbox/<number>/{card.json,index.html}
    if (!guardJson(req, res)) return;
    return readJson(req, res, (d) => {
      const title = typeof d.title === 'string' ? d.title.trim() : '';
      const description = typeof d.description === 'string' ? d.description.trim() : '';
      if (!title || title.length > 200 || description.length > 4000) return send(res, 400, 'Invalid title or description');
      const number = nextNumber();
      const dir = cardPath(number, true, false);
      const meta = { number, title, description, status: 'Pending', tags: [], created: today(), updated: today() };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), renderCardHtml(meta));
      fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify(meta, null, 2) + '\n'); // last: the card appears once complete
      send(res, 201, JSON.stringify({ ...meta, id: String(number), inbox: true, done: false }), TYPES['.json']);
    });
  }
  if (p === '/api/cards') return send(res, 200, JSON.stringify(listCards()), TYPES['.json']);
  if (p === '/api/options') return send(res, 200, JSON.stringify(OPTIONS), TYPES['.json']);
  if (p === '/api/config') return send(res, 200, JSON.stringify(CONFIG), TYPES['.json']);

  const td = p.match(/^\/api\/cards\/([^/]+)\/tasks$/);
  if (td) {
    const card = findCard(td[1]);
    if (!card) return send(res, 404, 'Not found');
    if (req.method === 'GET') return send(res, 200, JSON.stringify(readTasks(card.dir)), TYPES['.json']);
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    if (!guardJson(req, res)) return;
    return readJson(req, res, (d) => {
      const list = readTasks(card.dir);
      const bad = (m) => send(res, 400, m);
      if (d.status !== undefined && !OPTIONS.status.includes(d.status)) return bad('Unknown status');
      if (d.priority !== undefined && !OPTIONS.priority.includes(d.priority)) return bad('Unknown priority');
      if (d.id === undefined) { // add a task: folder <card number>-<next task number>
        const title = typeof d.title === 'string' ? d.title.trim() : '';
        if (!title || title.length > 300) return bad('Invalid title');
        const id = `${card.id}-${nextTaskNumber(card.dir, card.id)}`;
        list.push({ id, order: list.length + 1, title, status: d.status || 'Pending', priority: d.priority || '', updates: [] });
      } else { // change an existing task
        const i = list.findIndex((t) => t.id === d.id);
        if (i === -1) return send(res, 404, 'No such task');
        const t = list[i];
        if (d.remove === true) { removeTask(card.dir, t.id); list.splice(i, 1); }
        else {
          if (d.status !== undefined) t.status = d.status;
          if (d.priority !== undefined) t.priority = d.priority;
          if (typeof d.title === 'string' && d.title.trim() && d.title.length <= 300) t.title = d.title.trim();
          if (d.update !== undefined) { // write an update on the task (by: "me" or "claude")
            const text = typeof d.update === 'string' ? d.update.trim() : '';
            if (!text || text.length > 4000) return bad('Invalid update');
            t.updates.push({ at: new Date().toISOString(), by: TASK_BY.includes(d.by) ? d.by : 'me', text });
          }
          if (d.move === 'up' || d.move === 'down') {
            const j = i + (d.move === 'up' ? -1 : 1);
            if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
          }
        }
      }
      list.forEach((t, k) => { t.order = k + 1; saveTask(card.dir, t); });
      send(res, 200, JSON.stringify(list), TYPES['.json']);
    });
  }

  const st = p.match(/^\/api\/cards\/([^/]+)$/);
  if (st && req.method === 'POST') {
    if (!guardJson(req, res)) return;
    const card = findCard(st[1]);
    if (!card) return send(res, 404, 'Not found');
    return readJson(req, res, (changes) => {
      const fields = Object.keys(changes);
      const ticketOk = (v) => typeof v === 'string' && (v.trim() === '' || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(v.trim()));
      const textOk = (f, v) => typeof v === 'string' && (f === 'title' ? v.trim() !== '' && v.trim().length <= 200 : v.length <= (f === 'notes' ? 20000 : 4000));
      const valid = (f) => (OPTIONS[f] && OPTIONS[f].includes(changes[f])) || (f === 'inbox' && typeof changes[f] === 'boolean') || (f === 'ticket' && ticketOk(changes[f]))
        || (['title', 'description', 'notes'].includes(f) && textOk(f, changes[f]));
      if (!fields.length || !fields.every(valid)) return send(res, 400, 'Unknown field or value');
      const file = path.join(card.dir, 'card.json');
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      fields.forEach((f) => {
        if (f === 'inbox') return; // not stored: it is where the folder lives
        if (f === 'title' || f === 'description') meta[f] = changes[f].trim();
        else if (f !== 'ticket') meta[f] = changes[f];
        else if (changes[f].trim()) meta.ticket = changes[f].trim().toUpperCase(); // Linear key, e.g. ABC-123
        else delete meta.ticket;
      });
      delete meta.inbox;
      meta.number = Number(card.id);
      meta.updated = today();
      fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
      // Moving a card between Inbox and Topics, or to/from done/, is moving its folder.
      const inbox = changes.inbox !== undefined ? changes.inbox : card.inbox, done = meta.status === 'Done';
      const dir = cardPath(card.id, inbox, done);
      if (dir !== card.dir) moveSafe(card.dir, dir);
      send(res, 200, JSON.stringify({ ...meta, id: card.id, inbox, done }), TYPES['.json']);
    });
  }

  const sm = p.match(/^\/static\/([^/]+)$/);
  if (sm) {
    const file = path.join(STATIC, sm[1]);
    if (!file.startsWith(STATIC + path.sep)) return send(res, 403, 'Forbidden');
    return sendFile(res, file);
  }
  if (p === '/' || /^\/card\/[^/]+\/?$/.test(p)) return sendFile(res, path.join(ROOT, 'shell.html'), false);
  if (p === '/content/home') return sendFile(res, path.join(ROOT, 'home.html'));

  const m = p.match(/^\/content\/([^/]+)\/(.*)$/);
  if (m) {
    const card = findCard(m[1]);
    if (!card) return send(res, isNumber(m[1]) ? 404 : 403, isNumber(m[1]) ? 'Not found' : 'Forbidden');
    const file = path.join(card.dir, m[2] || 'index.html');
    if (!file.startsWith(card.dir + path.sep)) return send(res, 403, 'Forbidden'); // stay inside the card's folder
    const isReport = file === path.join(card.dir, 'index.html');
    return sendFile(res, file, true, isReport ? '<script src="/static/tasks.js" defer></script>' : '');
  }
  send(res, 404, 'Not found');
}).listen(PORT, HOST, () => console.log(`${CONFIG.appName}: http://${HOST}:${PORT}/`));

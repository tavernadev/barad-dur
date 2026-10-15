// Barad-dûr: tiny dependency-free dev server for the command center. Configuration comes from the environment
// (see example.env); a local .env file is loaded if present and never overrides real environment variables.
//   /                -> shell (terminal iframe + content iframe)
//   /card/<id>       -> same shell, content iframe shows that card
//   /content/home    -> card grid
//   /content/<id>/*  -> files from cards/<id>/ (HTML gets the live-reload snippet)
//   /api/config      -> public settings (app name, terminal port, Linear base URL)
//   /api/cards       -> GET card metadata from cards/*/card.json; POST creates an Inbox card (title, description)
//   /api/cards/<id>  -> POST status / priority / inbox / ticket / title / description / notes changes
//   /static/*        -> shared CSS/JS for generated card pages
//   /api/cards/<id>/tasks -> GET list; POST add / update / remove (stored in cards/<id>/tasks.json)
// Every card's index.html also gets the TODO column injected (static/tasks.js).
//   /events          -> SSE; emits "reload" when cards/ or home.html change
// The shell itself is never reloaded automatically, so the terminal keeps running.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env: defaults and the real environment apply */ }
const DATA = path.resolve(ROOT, (process.env.DATA_DIR || '.').replace(/^~(?=$|[\\/])/, os.homedir())); // private data: cards/, .sessions/, .counter
const CARDS = path.join(DATA, 'cards');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
// Public settings the browser needs (served at /api/config). No secrets here.
const CONFIG = {
  appName: process.env.APP_NAME || 'Barad-d\u00fbr',
  ttydPort: Number(process.env.TTYD_PORT || 7681),
  linearBaseUrl: process.env.LINEAR_BASE_URL || '', // e.g. https://linear.app/<workspace>/issue/ ; empty = tickets are not links
};

// Data was moved out with DATA_DIR but old data is still in the repo folder: say so instead of silently starting empty.
if (DATA !== ROOT && fs.existsSync(path.join(ROOT, 'cards')) && !fs.existsSync(path.join(DATA, 'cards'))) {
  console.warn(`DATA_DIR is ${DATA} but cards/ still exists in ${ROOT}. Stop the app and run scripts/migrate-data.sh to move it.`);
}

// First run on a fresh clone: create the data folder and seed one example card so the UI is not empty.
if (!fs.existsSync(CARDS)) {
  fs.mkdirSync(CARDS, { recursive: true });
  try { fs.cpSync(path.join(ROOT, 'examples', 'cards'), CARDS, { recursive: true }); } catch { /* examples are optional */ }
}

// Editable card fields and their allowed values (shared with the UI via /api/options).
const OPTIONS = {
  status: ['Pending', 'Scoping', 'In Progress', 'Code Review', 'Testing', 'Done'],
  priority: ['Low', 'Medium', 'High', 'Urgent'],
};

const STATIC = path.join(ROOT, 'static');

const today = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Every card gets a workspace number (#1, #2, ...) that is ours and never reused; the Linear ticket key
// ("ticket" in card.json) is optional and can be added later, so it is not the identifier.
const COUNTER = path.join(DATA, '.counter');
function nextNumber() {
  const stored = parseInt(fs.existsSync(COUNTER) ? fs.readFileSync(COUNTER, 'utf8') : '0', 10) || 0;
  const n = Math.max(stored, ...listCards().map((c) => Number(c.number) || 0)) + 1;
  fs.writeFileSync(COUNTER, n + '\n');
  return n;
}
// Cards created before numbering existed get numbers in the order their folders were created.
function backfillNumbers() {
  listCards().filter((c) => !c.number)
    .map((c) => ({ c, t: fs.statSync(path.join(CARDS, c.id)).birthtimeMs }))
    .sort((a, b) => a.t - b.t)
    .forEach(({ c }) => {
      const file = path.join(CARDS, c.id, 'card.json');
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      meta.number = nextNumber();
      fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
    });
}

// Inbox items are real cards: cards/<id>/ with card.json + a generated index.html, flagged "inbox": true.
function newCardId(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
  const base = `${today().replace(/-/g, '')}-${slug}`;
  let id = base, n = 2;
  while (fs.existsSync(path.join(CARDS, id))) id = `${base}-${n++}`;
  return id;
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

// Tasks belong to a card: cards/<id>/tasks.json, an ordered list of
//   { "id": "t1", "order": 1, "title": "...", "status": "Pending", "priority": "High",
//     "updates": [{ "at": "<ISO time>", "by": "me" | "claude", "text": "..." }] }
// A card's Claude session can edit the file directly (append to "updates" with by: "claude"); the column and
// API normalize whatever is there (legacy "text" -> title, missing ids/order, unknown status/priority).
const TASK_BY = ['me', 'claude'];
const taskFile = (id) => {
  const file = path.join(CARDS, id, 'tasks.json');
  return file.startsWith(CARDS + path.sep) && fs.existsSync(path.join(CARDS, id, 'card.json')) ? file : null;
};
function readTasks(file) {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* missing or invalid: start empty */ }
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).map((t, i) => ({ t, i }))
    .filter(({ t }) => t && typeof (t.title ?? t.text) === 'string')
    .sort((a, b) => (Number(a.t.order) || a.i + 1) - (Number(b.t.order) || b.i + 1) || a.i - b.i)
    .map(({ t }, k) => {
      let id = typeof t.id === 'string' && t.id ? t.id : 't' + (k + 1);
      while (seen.has(id)) id += '_';
      seen.add(id);
      return {
        id, order: k + 1, title: t.title ?? t.text,
        status: OPTIONS.status.includes(t.status) ? t.status : (t.done ? 'Done' : 'Pending'),
        priority: OPTIONS.priority.includes(t.priority) ? t.priority : '',
        updates: (Array.isArray(t.updates) ? t.updates : []).filter((u) => u && typeof u.text === 'string')
          .map((u) => ({ at: typeof u.at === 'string' ? u.at : '', by: TASK_BY.includes(u.by) ? u.by : 'claude', text: u.text })),
      };
    });
}
const writeTasks = (file, list) => fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');

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
// tasks.json edits (by the UI or by a card's Claude session) refresh only the TODO column, never the whole page.
fs.watch(CARDS, { recursive: true }, (_ev, name) => {
  const n = name ? String(name) : '';
  const t = n.match(/^([^/\\]+)[/\\]tasks\.json$/), c = n.match(/^([^/\\]+)[/\\]card\.json$/);
  if (t) broadcast('tasks', t[1]); else if (c) broadcast('card', c[1]); else broadcast('reload');
});
fs.watch(path.join(ROOT, 'home.html'), () => broadcast('reload'));
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

function listCards() {
  return fs.readdirSync(CARDS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(CARDS, d.name, 'card.json'), 'utf8'));
        return [{ id: d.name, ...meta }];
      } catch { return []; }
    })
    .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}

try { backfillNumbers(); } catch (e) { console.error('number backfill failed:', e.message); }

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
    // Create an Inbox card: title + description -> cards/<id>/{card.json,index.html}
    if (!guardJson(req, res)) return;
    return readJson(req, res, (d) => {
      const title = typeof d.title === 'string' ? d.title.trim() : '';
      const description = typeof d.description === 'string' ? d.description.trim() : '';
      if (!title || title.length > 200 || description.length > 4000) return send(res, 400, 'Invalid title or description');
      const id = newCardId(title);
      const dir = path.join(CARDS, id);
      const meta = { number: nextNumber(), title, description, inbox: true, status: 'Pending', tags: [], created: today(), updated: today() };
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'index.html'), renderCardHtml(meta));
      fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify(meta, null, 2) + '\n'); // last: the card appears once complete
      send(res, 201, JSON.stringify({ id, ...meta }), TYPES['.json']);
    });
  }
  if (p === '/api/cards') return send(res, 200, JSON.stringify(listCards()), TYPES['.json']);
  if (p === '/api/options') return send(res, 200, JSON.stringify(OPTIONS), TYPES['.json']);
  if (p === '/api/config') return send(res, 200, JSON.stringify(CONFIG), TYPES['.json']);

  const td = p.match(/^\/api\/cards\/([^/]+)\/tasks$/);
  if (td) {
    const file = taskFile(td[1]);
    if (!file) return send(res, 404, 'Not found');
    if (req.method === 'GET') return send(res, 200, JSON.stringify(readTasks(file)), TYPES['.json']);
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    if (!guardJson(req, res)) return;
    return readJson(req, res, (d) => {
      const list = readTasks(file);
      const bad = (m) => send(res, 400, m);
      if (d.status !== undefined && !OPTIONS.status.includes(d.status)) return bad('Unknown status');
      if (d.priority !== undefined && !OPTIONS.priority.includes(d.priority)) return bad('Unknown priority');
      if (d.id === undefined) { // add a task
        const title = typeof d.title === 'string' ? d.title.trim() : '';
        if (!title || title.length > 300) return bad('Invalid title');
        let n = list.length + 1;
        while (list.some((t) => t.id === 't' + n)) n++;
        list.push({ id: 't' + n, order: list.length + 1, title, status: d.status || 'Pending', priority: d.priority || '', updates: [] });
      } else { // change an existing task
        const i = list.findIndex((t) => t.id === d.id);
        if (i === -1) return send(res, 404, 'No such task');
        const t = list[i];
        if (d.remove === true) list.splice(i, 1);
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
      list.forEach((t, k) => { t.order = k + 1; });
      writeTasks(file, list);
      send(res, 200, JSON.stringify(list), TYPES['.json']);
    });
  }

  const st = p.match(/^\/api\/cards\/([^/]+)$/);
  if (st && req.method === 'POST') {
    if (!guardJson(req, res)) return;
    const file = path.join(CARDS, st[1], 'card.json');
    if (!file.startsWith(CARDS + path.sep) || !fs.existsSync(file)) return send(res, 404, 'Not found');
    return readJson(req, res, (changes) => {
      const fields = Object.keys(changes);
      const ticketOk = (v) => typeof v === 'string' && (v.trim() === '' || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(v.trim()));
      const textOk = (f, v) => typeof v === 'string' && (f === 'title' ? v.trim() !== '' && v.trim().length <= 200 : v.length <= (f === 'notes' ? 20000 : 4000));
      const valid = (f) => (OPTIONS[f] && OPTIONS[f].includes(changes[f])) || (f === 'inbox' && typeof changes[f] === 'boolean') || (f === 'ticket' && ticketOk(changes[f]))
        || (['title', 'description', 'notes'].includes(f) && textOk(f, changes[f]));
      if (!fields.length || !fields.every(valid)) return send(res, 400, 'Unknown field or value');
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      fields.forEach((f) => {
        if (f === 'title' || f === 'description') meta[f] = changes[f].trim();
        else if (f !== 'ticket') meta[f] = changes[f];
        else if (changes[f].trim()) meta.ticket = changes[f].trim().toUpperCase(); // Linear key, e.g. ABC-123
        else delete meta.ticket;
      });
      meta.updated = today();
      fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
      send(res, 200, JSON.stringify(meta), TYPES['.json']);
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
    const dir = path.join(CARDS, m[1]);
    const file = path.join(dir, m[2] || 'index.html');
    // Stay inside cards/<id>/ and never serve metadata-less dirs outside cards/
    if (!file.startsWith(dir + path.sep) || !dir.startsWith(CARDS + path.sep)) return send(res, 403, 'Forbidden');
    const isReport = file === path.join(dir, 'index.html');
    return sendFile(res, file, true, isReport ? '<script src="/static/tasks.js" defer></script>' : '');
  }
  send(res, 404, 'Not found');
}).listen(PORT, HOST, () => console.log(`${CONFIG.appName}: http://${HOST}:${PORT}/`));

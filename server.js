// Barad-dûr: tiny dependency-free dev server for the command center. Configuration comes from the environment
// (see example.env); a local .env file is loaded if present and never overrides real environment variables.
//   /                -> shell (terminal iframe + content iframe)
//   /card/<n>        -> same shell, content iframe shows card n
//   /content/home    -> the Topics grid and the Inbox
//   /content/<n>/*   -> files of card n (HTML gets the live-reload snippet; the report also gets the TODO column)
//   /api/config      -> public settings (app name, terminal port, Linear base URL)
//   /api/cards       -> GET every card; POST creates a card in the Inbox (title, description), or from a template ({template, values, instructions?}); "topics": true files the new card in Topics instead of the Inbox
//   /api/templates   -> GET the card templates (what the + dialog offers)
//   /api/version     -> GET { server: <boot id>, shell: <shell.html mtime> }: the shell polls it to tell you when a refresh is available (it is never reloaded on its own)
//   /api/open-vscode -> POST (no arguments): runs `code <this project's folder>` so VS Code opens the project; the folder is fixed, never taken from the request
//   /api/sessions/<id> -> GET whether a Claude session is stored for main or a card (and whether it was adopted); .../history lists it and the archived ones; POST .../reset archives it (next start is new), .../switch {name} swaps an archived one back in, .../delete [{name}] erases one for good
//   /api/cards/<n>   -> POST status / priority / inbox / ticket / notion / project / pr / title / description / notes changes
//   /api/cards/<n>/tasks -> GET the card's tasks; POST add / update / remove / move
//   /api/cards/<n>/artifact -> GET the attached claude.ai artifact (or null); .../artifact/page its saved copy, sandboxed; POST {url,title,html} attaches, {remove:true} detaches
//   /api/cards/<n>/tabs  -> GET the card's tabs; GET .../tabs/<id> the tab's HTML; POST {title} adds a tab, POST {order:[ids]} reorders them
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
const { execFile } = require('child_process');

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
const TEMPLATES = path.join(DATA, 'templates'); // card templates: templates/<id>/template.json
const CODE_BIN = process.env.CODE_BIN || 'code'; // the VS Code command, run by the header's "Open in VS Code" on this project's folder
const GH_BIN = process.env.GH_BIN || 'gh'; // the GitHub CLI, only used to read pull request details for a card template
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
// Public settings the browser needs (served at /api/config). No secrets here.
const CONFIG = {
  appName: process.env.APP_NAME || 'Barad-dûr',
  ttydPort: Number(process.env.TTYD_PORT || 7681),
  linearBaseUrl: process.env.LINEAR_BASE_URL || '', // e.g. https://linear.app/<workspace>/issue/ ; empty = tickets are not links
};

const isNumber = (s) => /^\d+$/.test(s);
// "New session" (the bar above the terminal): move a session's stored id (and its adopted directory, if any) into .sessions/archive/ so the
// next terminal start for that tab begins a new conversation. Nothing is deleted: the old id stays there and `claude --resume <id>` still works.
function archiveSession(id, keep) {
  const file = path.join(SESSIONS, id);
  if (!fs.existsSync(file)) return null;
  const dir = path.join(SESSIONS, 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let name = `${id}-${stamp}`, n = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${id}-${stamp}-${++n}`;
  let uuid = ''; try { uuid = fs.readFileSync(file, 'utf8').split('\n')[0].trim(); } catch { /* unreadable: no summary */ }
  fs.renameSync(file, path.join(dir, name));
  if (fs.existsSync(file + '.cwd')) fs.renameSync(file + '.cwd', path.join(dir, name + '.cwd'));
  if (fs.existsSync(file + '.lock')) fs.renameSync(file + '.lock', path.join(dir, name + '.lock')); // a lock follows its session
  if (fs.existsSync(file + '.title')) fs.renameSync(file + '.title', path.join(dir, name + '.title')); // so does a name you gave it
  if (keep) fs.writeFileSync(path.join(dir, name + '.kept'), '\n'); // filed straight into the Archived section
  saveSummary(path.join(dir, name), uuid); // the one-line "what it was doing", written now so nothing has to keep it up to date
  return name;
}
// Session history for the switcher next to "New session": the stored session plus everything archived for the same id, each with a short label
// taken from Claude's own transcript (~/.claude/projects/<dir>/<session id>.jsonl, or under CLAUDE_CONFIG_DIR): its generated title when it has one,
// else the first real message. Only the start and the end of the file are read, so a long session stays quick.
const LAUNCH_PROMPT = /^(This is the main workspace session|This session is dedicated to card)/;
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); // where Claude Code keeps its own session files
function transcriptFile(uuid) {
  const root = path.join(claudeDir(), 'projects');
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return null;
  try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, uuid + '.jsonl'); if (fs.existsSync(f)) return f; } } catch { /* no transcripts */ }
  return null;
}
// One line about what the session was last doing: the first sentence of Claude's last reply (it leads with the answer), found by reading the
// transcript from the end, a chunk at a time, so a long session with huge request blobs near the end still works. Only done when a session is
// archived (and once, later, for older archives), never on every open of the list. Falls back to the last thing you asked.
function summaryLine(text) {
  const lines = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').split('\n')
    .map((l) => l.replace(/^\s*(?:[-*\u2022>#]+|\d+[.)])\s+/, '').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return '';
  const m = lines[0].match(/^(.{20,}?[.!?])(?:\s|$)/);
  const one = m ? m[1] : lines[0];
  return one.length > 150 ? one.slice(0, 147).trimEnd() + '\u2026' : one;
}
function summarizeSession(uuid) {
  const file = transcriptFile(uuid);
  if (!file) return '';
  const CHUNK = 524288, BUDGET = 16 * 1024 * 1024, textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '').trim();
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    let pos = fs.fstatSync(fd).size, carry = Buffer.alloc(0), scanned = 0, asked = '';
    while (pos > 0 && scanned < BUDGET) {
      const len = Math.min(CHUNK, pos); pos -= len; scanned += len;
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, pos);
      let data = Buffer.concat([buf, carry]), start = 0;
      if (pos > 0) { // the first line may continue in the chunk before: keep its bytes for the next round (a giant line is dropped, not kept forever)
        const nl = data.indexOf(10);
        if (nl === -1) { carry = data.length > BUDGET ? Buffer.alloc(0) : data; continue; }
        carry = data.subarray(0, nl); start = nl + 1;
      } else carry = Buffer.alloc(0);
      const lines = data.toString('utf8', start).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].startsWith('{') || lines[i].length > 400000) continue;
        let j; try { j = JSON.parse(lines[i]); } catch { continue; }
        if (!j.message || j.isSidechain || j.isMeta) continue;
        const t = textOf(j.message.content);
        if (!t) continue;
        if (j.type === 'assistant') return summaryLine(t);
        if (j.type === 'user' && !asked && !t.startsWith('<') && !LAUNCH_PROMPT.test(t)) asked = t;
      }
    }
    return asked ? 'You asked: ' + summaryLine(asked) : '';
  } finally { fs.closeSync(fd); }
}
// The summary lives next to the archived session id as <name>.summary. Older archives get theirs the first time the list is opened.
function saveSummary(archiveFile, uuid) {
  try { const t = uuid && summarizeSession(uuid); if (t) fs.writeFileSync(archiveFile + '.summary', t + '\n'); } catch { /* no summary: the list just shows the title */ }
}
// Delete a session for good, the way the X button in the list asks for: Claude's own files for that session id, so it is gone from `claude --resume`
// and /resume too: its transcript (every project folder) and the folder beside it, the checkpoints, environment and debug files, the project's
// session index entry, and the prompts it added to the prompt history. Only ever called with an id read from our own session files, never one
// that came from the browser, and every path is built from that exact id. The running-process registry (sessions/) is left alone.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function rewriteKeepingMode(file, text) { // atomic, and the file keeps its permissions
  const mode = fs.statSync(file).mode & 0o777, tmp = file + '.barad-tmp';
  fs.writeFileSync(tmp, text, { mode }); fs.renameSync(tmp, file);
}
function eraseClaudeSession(uuid) {
  if (!UUID.test(uuid)) return 0;
  const root = claudeDir();
  let removed = 0;
  const rm = (p) => { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed++; } } catch { /* left in place */ } };
  const named = (dir) => { try { for (const f of fs.readdirSync(dir)) if (f === uuid || f.startsWith(uuid + '.') || f.startsWith(uuid + '-')) rm(path.join(dir, f)); } catch { /* no such folder */ } };
  try {
    for (const d of fs.readdirSync(path.join(root, 'projects'))) {
      const dir = path.join(root, 'projects', d);
      rm(path.join(dir, uuid + '.jsonl')); rm(path.join(dir, uuid));
      const index = path.join(dir, 'sessions-index.json');
      try {
        const j = JSON.parse(fs.readFileSync(index, 'utf8'));
        if (Array.isArray(j.entries) && j.entries.some((e) => e && e.sessionId === uuid)) { j.entries = j.entries.filter((e) => !(e && e.sessionId === uuid)); rewriteKeepingMode(index, JSON.stringify(j, null, 2) + '\n'); removed++; }
      } catch { /* no index, or not one we understand: untouched */ }
    }
  } catch { /* no projects folder */ }
  for (const sub of ['file-history', 'session-env', 'debug', 'todos']) named(path.join(root, sub));
  try {
    const history = path.join(root, 'history.jsonl');
    const lines = fs.readFileSync(history, 'utf8').split('\n');
    const keep = lines.filter((l) => { if (!l.includes(uuid)) return true; try { return JSON.parse(l).sessionId !== uuid; } catch { return true; } }); // every other line stays byte for byte
    if (keep.length !== lines.length) { rewriteKeepingMode(history, keep.join('\n')); removed++; }
  } catch { /* no history file */ }
  return removed;
}
// name given: that archived session; no name: the stored (current) one. Returns null when there is nothing to delete.
function deleteSession(id, name) {
  const current = name === undefined;
  if (!current && (typeof name !== 'string' || !ARCHIVE_NAME(id).test(name))) return null;
  const file = current ? path.join(SESSIONS, id) : path.join(SESSIONS, 'archive', name);
  if (!fs.existsSync(file)) return null;
  let uuid = ''; try { uuid = fs.readFileSync(file, 'utf8').split('\n')[0].trim(); } catch { /* unreadable: only our own files go */ }
  if (fs.existsSync(file + '.lock')) return { locked: true }; // a locked session cannot be deleted until it is unlocked
  const adopted = fs.existsSync(file + '.cwd');
  for (const f of [file, file + '.cwd', file + '.summary', file + '.lock', file + '.kept', file + '.title']) { try { fs.rmSync(f, { force: true }); } catch { /* leave it */ } }
  const erased = eraseClaudeSession(uuid);
  // The terminal of a running session is closed first, but a process that is still ending may write its transcript once more: sweep again shortly after.
  if (current && uuid) { const t = setTimeout(() => eraseClaudeSession(uuid), 2500); if (t.unref) t.unref(); }
  return { current, adopted, erased };
}
function sessionLabel(uuid) {
  const file = transcriptFile(uuid);
  if (!file) return { label: '', updated: '' };
  const chunk = (from, len) => { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, from); return b.toString('utf8', 0, n); } finally { fs.closeSync(fd); } };
  const size = fs.statSync(file).size;
  const head = chunk(0, Math.min(size, 262144));
  const tail = size > 262144 ? chunk(Math.max(0, size - 131072), 131072) : '';
  let title = '', first = '';
  for (const text of [head, tail]) for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; } // a chunk can start or end in the middle of a line
    if (j.type === 'ai-title' && typeof j.aiTitle === 'string' && j.aiTitle.trim()) title = j.aiTitle.trim();
    else if (!first && j.type === 'user' && j.message) {
      const c = j.message.content;
      const t = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '').replace(/\s+/g, ' ').trim();
      if (t && !t.startsWith('<') && !LAUNCH_PROMPT.test(t)) first = t;
    }
  }
  return { label: (title || first).slice(0, 90), updated: fs.statSync(file).mtime.toISOString() };
}
const ARCHIVE_NAME = (id) => new RegExp('^' + id + '-(\\d{8})T(\\d{6})Z(?:-\\d+)?$');
function sessionHistory(id) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n')[0].trim(); } catch { return ''; } };
  // A name you typed (<file>.title) wins over the generated label; `auto` keeps the generated one so the page can offer it when you clear the name.
  const entry = (extra, uuid, file) => {
    const l = sessionLabel(uuid), custom = read(file + '.title');
    return { ...extra, resumeId: uuid, ...l, label: custom || l.label, auto: l.label, renamed: !!custom };
  };
  const cur = path.join(SESSIONS, id);
  const current = fs.existsSync(cur) ? entry({ adopted: fs.existsSync(cur + '.cwd'), locked: fs.existsSync(cur + '.lock') }, read(cur), cur) : null;
  let archived = [];
  try {
    const re = ARCHIVE_NAME(id);
    archived = fs.readdirSync(path.join(SESSIONS, 'archive')).map((name) => ({ name, m: name.match(re) })).filter((x) => x.m).map((x) => {
      const d = x.m[1], t = x.m[2];
      const at = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6))).toISOString();
      const f = path.join(SESSIONS, 'archive', x.name);
      if (!fs.existsSync(f + '.summary')) saveSummary(f, read(f));
      return entry({ name: x.name, at, adopted: fs.existsSync(f + '.cwd'), locked: fs.existsSync(f + '.lock'), kept: fs.existsSync(f + '.kept'), summary: read(f + '.summary') }, read(f), f);
    }).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.name < b.name ? 1 : -1));
  } catch { /* nothing archived yet */ }
  return { id, current, archived };
}
// Swap: the stored session is archived (if there is one) and the chosen archived one becomes the stored session again.
function switchSession(id, name) {
  if (typeof name !== 'string' || !ARCHIVE_NAME(id).test(name)) return null; // the name is matched against a fixed pattern: never a path
  const src = path.join(SESSIONS, 'archive', name);
  if (!fs.existsSync(src)) return null;
  const archived = archiveSession(id);
  const dest = path.join(SESSIONS, id);
  fs.renameSync(src, dest);
  if (fs.existsSync(src + '.cwd')) fs.renameSync(src + '.cwd', dest + '.cwd');
  if (fs.existsSync(src + '.lock')) fs.renameSync(src + '.lock', dest + '.lock');
  if (fs.existsSync(src + '.title')) fs.renameSync(src + '.title', dest + '.title');
  try { fs.rmSync(src + '.kept', { force: true }); } catch { /* it is the current session again, not an archived one */ }
  try { fs.rmSync(src + '.summary', { force: true }); } catch { /* a leftover note is harmless */ } // it runs again, so its summary is rewritten when it is archived next
  return { archived, restored: name };
}
// Lock and Archive are two independent marks on a session: <file>.lock (cannot be deleted) and <file>.kept (listed in the Archived section).
// name given: that archived session; no name: the stored (current) one. Returns null when there is no such session.
function sessionFile(id, name) {
  if (name === undefined) { const f = path.join(SESSIONS, id); return fs.existsSync(f) ? f : null; }
  if (typeof name !== 'string' || !ARCHIVE_NAME(id).test(name)) return null;
  const f = path.join(SESSIONS, 'archive', name);
  return fs.existsSync(f) ? f : null;
}
function setTitle(id, name, title) { // an empty title goes back to the generated one
  const f = sessionFile(id, name);
  if (!f) return null;
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (t) fs.writeFileSync(f + '.title', t + '\n'); else fs.rmSync(f + '.title', { force: true });
  return t;
}
function setMark(id, name, mark, on) {
  const f = sessionFile(id, name);
  if (!f) return null;
  if (on) fs.writeFileSync(f + '.' + mark, '\n'); else fs.rmSync(f + '.' + mark, { force: true });
  return true;
}
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
  // number = the task's permanent number (the k in <card>-<k>); order = its current position. Moving a task changes order only.
  return found.map((x, i) => ({ id: x.id, number: x.k, ...cleanTask(x.raw, i + 1) }));
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
// ---- tabs: the content area of a card. <card>/tabs.json is the ordered list [{ id, title }] and each tab's content is an HTML
// fragment in <card>/tabs/<id>.html (no <html>/<head>/<body>), written by the card's Claude session. New cards start with
// Scoping (what the ticket initially told us) and Findings (what working on the tasks actually showed). Cards without a
// tabs.json (everything created before tabs existed) keep their single report page.
const TAB_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const readTabs = (dir) => {
  let raw = [];
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'tabs.json'), 'utf8')); } catch { return []; }
  return (Array.isArray(raw) ? raw : [])
    .filter((t) => t && TAB_ID.test(String(t.id)) && typeof t.title === 'string' && t.title.trim())
    .map((t) => ({ id: t.id, title: t.title.trim() }));
};
function addTab(dir, title) {
  const tabs = readTabs(dir);
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'tab';
  let id = base, n = 2;
  while (tabs.some((t) => t.id === id) || id === 'artifact') id = `${base}-${n++}`; // 'artifact' belongs to the built-in first tab
  fs.mkdirSync(path.join(dir, 'tabs'), { recursive: true });
  const file = path.join(dir, 'tabs', id + '.html');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  tabs.push({ id, title });
  fs.writeFileSync(path.join(dir, 'tabs.json'), JSON.stringify(tabs, null, 2) + '\n');
  return tabs;
}

// ---- artifact: an optional claude.ai artifact attached to a card, shown as the first tab ("Artifact"; greyed out while there is none).
// artifact.json = { url, title, savedAt } and the saved copy of the page is artifact/index.html. The server never creates one;
// a card session publishes and attaches it in the same turn, only when the user asks for an artifact. The saved page is untrusted data and is rendered sandboxed.
const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+(?:\?[A-Za-z0-9_=&.-]*)?$/;
// A ticket can be a link to any tracker (ClickUp, Linear, Jira, Trello, ...): http(s), one line, no credentials in it. The page works out the label.
const isTicketLink = (v) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > 500 || /\s/.test(t)) return false;
  try { const u = new URL(t); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password; } catch { return false; }
};
const BOOT_ID = String(Date.now()); // changes whenever the server restarts (node --watch restarts it on every save of server.js)
const MAX_ARTIFACT = 6 * 1024 * 1024;
const MAX_TEXT_BODY = 16 * 1024 * 1024; // request-size safety net for text fields (card description, task updates): there is no character limit on them
function readArtifact(dir) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'artifact.json'), 'utf8'));
    if (!a || !ARTIFACT_URL.test(a.url) || !fs.existsSync(path.join(dir, 'artifact', 'index.html'))) return null;
    return { url: a.url, title: String(a.title || 'Artifact').slice(0, 200), savedAt: String(a.savedAt || '') };
  } catch { return null; }
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
// Statuses that must carry a reason, and the card.json field that holds it.
// Optional document links on a card, each shown as its own tile on the card page. Empty string removes the link.
const LINK_FIELDS = {
  notion: { hosts: /(^|\.)notion\.(so|site|com)$/i, path: null }, // a Notion doc: https://www.notion.so/..., https://app.notion.com/p/...
  project: { hosts: /^(www\.)?linear\.app$/i, path: /\/project\// }, // a Linear project: https://linear.app/<workspace>/project/...
  pr: { hosts: /^(www\.)?github\.com$/i, path: /^\/[^/]+\/[^/]+\/pull\/\d+/ } // a GitHub pull request: https://github.com/<org>/<repo>/pull/<n>
};
const linkOk = (f, v) => {
  if (typeof v !== 'string') return false;
  if (v.trim() === '') return true;
  let u; try { u = new URL(v.trim()); } catch { return false; }
  const spec = LINK_FIELDS[f];
  return v.trim().length <= 500 && u.protocol === 'https:' && spec.hosts.test(u.hostname) && (!spec.path || spec.path.test(u.pathname));
};
const REASON_FIELD = { Blocked: 'blockedReason', Cancelled: 'cancelledReason' };
const OPTIONS = {
  status: ['Pending', 'Scoping', 'In Progress', 'Blocked', 'Code Review', 'Testing', 'Done', 'Cancelled'],
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

// ---- card templates: <data>/templates/<id>/template.json
// { name, title, place ("Inbox" or "Topics"), status, description, blanks: [{ key, label, hint, kind }], defaults: { <blank>: "text" }, progress: true }.
// `progress: true` marks the cards made from it with taskProgress, which turns on the task progress bar for those cards only. `title` and `description` hold
// {{blanks}}. The user gives only the blanks listed in `blanks`; a blank of kind "github-pr" is a pull request link and the server
// fills repo, number, title, short_title, ticket, files, added, removed and draft from it with `gh pr view` (read-only, fixed arguments,
// never a shell string). Blanks that cannot be filled stay visible as {{name}} in the new card. The default templates ship in
// examples/templates/ and are copied here once, when the templates folder does not exist yet; an edited copy is never overwritten.
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BLANK_KEY = /^[a-z][a-z0-9_]{0,29}$/;
const TEMPLATE_STATUS = ['Pending', 'Scoping', 'In Progress', 'Code Review', 'Testing']; // no Done, Blocked or Cancelled: those need a folder move or a reason
function readTemplate(id) {
  if (!TEMPLATE_ID.test(String(id))) return null;
  let t; try { t = JSON.parse(fs.readFileSync(path.join(TEMPLATES, id, 'template.json'), 'utf8')); } catch { return null; }
  const str = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;
  if (!t || typeof t !== 'object' || !str(t.name, 60) || !str(t.title, 300) || !str(t.description, 3500)) return null;
  const blanks = (Array.isArray(t.blanks) ? t.blanks : []).filter((b) => b && BLANK_KEY.test(String(b.key)) && str(b.label, 80)).slice(0, 5)
    .map((b) => ({ key: b.key, label: b.label, hint: typeof b.hint === 'string' ? b.hint.slice(0, 120) : '', kind: b.kind === 'github-pr' ? 'github-pr' : 'text' }));
  if (!blanks.length) return null;
  // `defaults`: values for blanks the user is not asked for (for example the name of a skill that is specific to one team). They live in this
  // file, which is in the gitignored data folder, so local choices never reach the open-source repo; the shipped template keeps a generic value.
  const defaults = {};
  if (t.defaults && typeof t.defaults === 'object' && !Array.isArray(t.defaults)) for (const [k, v] of Object.entries(t.defaults)) if (BLANK_KEY.test(k) && typeof v === 'string' && v.length <= 200) defaults[k] = v;
  return { id, name: t.name.trim(), defaults, progress: t.progress === true, title: t.title, description: t.description, blanks, place: t.place === 'Topics' ? 'Topics' : 'Inbox',
    status: TEMPLATE_STATUS.includes(t.status) ? t.status : 'Pending' };
}
function listTemplates() {
  let ids = []; try { ids = fs.readdirSync(TEMPLATES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* no templates folder */ }
  return ids.map(readTemplate).filter(Boolean);
}
const fillBlanks = (text, values) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m)); // one pass: values are never re-expanded

// Only https://github.com/<org>/<repo>/pull/<number> (optionally followed by /files, /changes, /commits or /checks; a ?query or #fragment is ignored) is accepted.
function parsePullLink(v) {
  let u; try { u = new URL(String(v).trim()); } catch { return null; }
  const m = u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password && !u.port
    && u.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,8})(?:\/(?:files|changes|commits|checks))?\/?$/);
  return m ? { org: m[1], repo: m[2], number: Number(m[3]), link: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` } : null;
}
// Read the pull request's metadata with the GitHub CLI. Resolves { values } or { warning }; it never rejects and never writes to GitHub.
function ghPull(p) {
  return new Promise((resolve) => {
    const args = ['pr', 'view', String(p.number), '--repo', `${p.org}/${p.repo}`, '--json', 'title,isDraft,changedFiles,additions,deletions,headRefName,state'];
    execFile(GH_BIN, args, { timeout: 20000, maxBuffer: 1 << 20, env: process.env }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || '');
        if (err.code === 'ENOENT') return resolve({ warning: 'The GitHub CLI (gh) is not installed, so the pull request details were not filled in.' });
        if (/auth login|not logged in|authentication|GH_TOKEN/i.test(msg)) return resolve({ warning: 'gh is not signed in (run "gh auth login"), so the pull request details were not filled in.' });
        if (/could not resolve|not found|no pull requests/i.test(msg)) return resolve({ warning: 'Pull request not found, so its details were not filled in.' });
        return resolve({ warning: 'Could not read the pull request, so its details were not filled in.' });
      }
      let j; try { j = JSON.parse(stdout); } catch { return resolve({ warning: 'Could not read the pull request, so its details were not filled in.' }); }
      const title = typeof j.title === 'string' ? j.title.trim() : '';
      const key = (title.match(/\b[A-Z][A-Z0-9]*-\d+\b/) || String(j.headRefName || '').match(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/) || [''])[0].toUpperCase();
      const short = title.replace(/^\w+(\([^)]*\))?!?:\s*/, '').replace(/^[A-Z][A-Z0-9]*-\d+:\s*/, '').trim() || title;
      const num = (n) => (Number.isFinite(Number(n)) ? String(Number(n)) : '?');
      resolve({ values: { title, short_title: short, ticket: key || 'no ticket', files: num(j.changedFiles), added: num(j.additions), removed: num(j.deletions),
        draft: j.isDraft ? 'draft' : (String(j.state || 'OPEN') === 'OPEN' ? 'ready for review' : String(j.state).toLowerCase()) }, ticketKey: key });
    });
  });
}

// Create a card (folder, page, Scoping and Findings tabs, card.json last so the card appears once complete).
function createCard({ title, description, inbox = true, status = 'Pending', ticket, pr, taskProgress }) {
  const number = nextNumber();
  const dir = cardPath(number, inbox, false);
  const meta = { number, title, description, status, tags: [], created: today(), updated: today() };
  if (ticket) meta.ticket = ticket;
  if (pr) meta.pr = pr;
  if (taskProgress) meta.taskProgress = true; // cards built from a template that sets `progress`: the task progress bar (TODO column and header)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), renderCardHtml(meta));
  addTab(dir, 'Scoping'); addTab(dir, 'Findings');
  fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify(meta, null, 2) + '\n');
  return { ...meta, id: String(number), inbox, done: false };
}
async function createFromTemplate(d, res) {
  try {
    const tpl = typeof d.template === 'string' ? readTemplate(d.template) : null;
    if (!tpl) return send(res, 400, 'Unknown template');
    const given = d.values && typeof d.values === 'object' && !Array.isArray(d.values) ? d.values : {};
    const values = { ...tpl.defaults }; let warning = '', pr = '', ticket = '';
    for (const b of tpl.blanks) {
      const v = typeof given[b.key] === 'string' ? given[b.key].trim() : '';
      if (!v || v.length > 500) return send(res, 400, `Missing value: ${b.label}`);
      if (b.kind !== 'github-pr') { values[b.key] = v; continue; }
      const p = parsePullLink(v);
      if (!p) return send(res, 400, 'Invalid pull request link (expected https://github.com/<org>/<repo>/pull/<number>)');
      pr = p.link; Object.assign(values, { [b.key]: p.link, org: p.org, repo: p.repo, number: String(p.number) });
      const got = await ghPull(p);
      if (got.warning) warning = got.warning; else { Object.assign(values, got.values); ticket = got.ticketKey; }
    }
    // Optional extra instructions for the card's Claude session, typed in the dialog: appended to the description, which the session reads first.
    const extra = d.instructions === undefined || d.instructions === null ? '' : typeof d.instructions === 'string' ? d.instructions.trim() : null;
    if (extra === null || extra.length > 1500) return send(res, 400, 'Invalid instructions (text, at most 1500 characters)');
    const tail = extra ? `\n\nExtra instructions (follow these as well as the steps above):\n${extra}` : '';
    const title = fillBlanks(tpl.title, values).replace(/\s+/g, ' ').trim().slice(0, 200) || tpl.name;
    const description = fillBlanks(tpl.description, values) + tail;
    const card = createCard({ title, description, inbox: tpl.place !== 'Topics' && d.topics !== true, status: tpl.status, ticket, pr, taskProgress: tpl.progress });
    send(res, 201, JSON.stringify(warning ? { ...card, warning } : card), TYPES['.json']);
  } catch (e) { send(res, 500, 'Could not create the card from the template'); }
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
  let sameOrigin = true;
  if (origin) { try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; } } // "null" (sandboxed frames) is not ours
  if (!/^application\/json/.test(req.headers['content-type'] || '') || !sameOrigin) {
    send(res, 403, 'Forbidden');
    return false;
  }
  return true;
}

function readJson(req, res, cb, limit = 16384) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > limit) req.destroy(); });
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
  // Never reload under someone who is typing. While a field holds text the user typed and has not posted or saved yet,
  // wait (checking every 1.5 s) and reload once it is empty or saved. Fields marked data-autosave save when you leave them.
  var edited = new WeakSet();
  document.addEventListener('input', function (e) { edited.add(e.target); }, true);
  function hasDraft() {
    var els = document.querySelectorAll('input, textarea');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!edited.has(el) || el.value === '' || /^(checkbox|radio|hidden)$/.test(el.type)) continue;
      if (el.hasAttribute('data-autosave') && document.activeElement !== el) continue;
      return true;
    }
    return false;
  }
  var waiting = null;
  function safeReload() {
    if (!hasDraft()) return location.reload();
    if (waiting) return;
    var n = document.createElement('div');
    n.textContent = 'Updated elsewhere. This page refreshes when you finish typing.';
    n.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;padding:6px 10px;border-radius:6px;font:12px system-ui,sans-serif;background:#222;color:#eee;opacity:.9;pointer-events:none';
    document.body.appendChild(n);
    waiting = setInterval(function () { if (!hasDraft()) { clearInterval(waiting); location.reload(); } }, 1500);
  }
  window.__live.on('reload', safeReload);
  window.__live.on('card', function () { if (!window.__cardLive) safeReload(); });
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
  else if (isNumber(parts[0] || '') && (parts[1] === 'tabs' || parts[1] === 'tabs.json' || parts[1] === 'artifact' || parts[1] === 'artifact.json')) broadcast('tabs', parts[0]);
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

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
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
if (!fs.existsSync(TEMPLATES)) { // default card templates, once; an edited or deleted copy is never put back over
  try { fs.cpSync(path.join(ROOT, 'examples', 'templates'), TEMPLATES, { recursive: true, force: false }); } catch { fs.mkdirSync(TEMPLATES, { recursive: true }); }
}
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
      if (d.topics !== undefined && typeof d.topics !== 'boolean') return send(res, 400, 'topics must be true or false');
      if (d.template !== undefined) return createFromTemplate(d, res); // { template: "<id>", values: { <blank>: "..." }, instructions?, topics? }
      const title = typeof d.title === 'string' ? d.title.trim() : '';
      const description = typeof d.description === 'string' ? d.description.trim() : '';
      if (!title || title.length > 200) return send(res, 400, 'Invalid title or description');
      send(res, 201, JSON.stringify(createCard({ title, description, inbox: d.topics !== true })), TYPES['.json']); // topics: true files it in Topics, not the Inbox
    }, MAX_TEXT_BODY);
  }
  if (p === '/api/cards') return send(res, 200, JSON.stringify(listCards()), TYPES['.json']);
  if (p === '/api/open-vscode') { // the header's Settings menu: open this project in VS Code. Fixed command and folder, no shell, same write guards as the card API.
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    if (!guardJson(req, res)) return;
    return readJson(req, res, () => {
      execFile(CODE_BIN, [ROOT], { timeout: 15000, env: process.env }, (err) => {
        if (err) {
          const error = err.code === 'ENOENT' ? `The "${CODE_BIN}" command was not found. In VS Code run "Shell Command: Install 'code' command in PATH", or set CODE_BIN.` : 'VS Code did not start.';
          return send(res, 500, JSON.stringify({ error }), TYPES['.json']);
        }
        send(res, 200, JSON.stringify({ ok: true, folder: path.basename(ROOT) }), TYPES['.json']);
      });
    });
  }
  const sr = p.match(/^\/api\/sessions\/(main|\d+)(\/reset|\/history|\/switch|\/delete|\/lock|\/keep|\/rename)?$/);
  if (sr) { // only "main" and the number of an existing card; the id never becomes a path of its own
    const id = sr[1];
    if (id !== 'main' && !findCard(id)) return send(res, 404, 'Not found');
    if (sr[2] === '/history') {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      return send(res, 200, JSON.stringify(sessionHistory(id)), TYPES['.json']);
    }
    if (sr[2] === '/delete') { // {name} deletes that archived session for good; no name deletes the current one (the page closes its terminal first)
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      if (!guardJson(req, res)) return;
      return readJson(req, res, (d) => {
        const r = deleteSession(id, d.name);
        if (!r) return send(res, 404, 'Not found');
        if (r.locked) return send(res, 423, JSON.stringify({ error: 'This session is locked. Unlock it first.' }), TYPES['.json']);
        send(res, 200, JSON.stringify({ ok: true, id, ...r }), TYPES['.json']);
      });
    }
    if (sr[2] === '/lock') { // {name?, locked: boolean}: a locked session cannot be deleted
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      if (!guardJson(req, res)) return;
      return readJson(req, res, (d) => {
        if (typeof d.locked !== 'boolean') return send(res, 400, JSON.stringify({ error: '"locked" must be true or false' }), TYPES['.json']);
        if (!setMark(id, d.name, 'lock', d.locked)) return send(res, 404, 'Not found');
        send(res, 200, JSON.stringify({ ok: true, id, locked: d.locked }), TYPES['.json']);
      });
    }
    if (sr[2] === '/rename') { // {name?, title}: your own name for a session (empty = back to the generated one)
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      if (!guardJson(req, res)) return;
      return readJson(req, res, (d) => {
        if (typeof d.title !== 'string') return send(res, 400, JSON.stringify({ error: '"title" must be text' }), TYPES['.json']);
        const t = setTitle(id, d.name, d.title);
        if (t === null) return send(res, 404, 'Not found');
        send(res, 200, JSON.stringify({ ok: true, id, title: t }), TYPES['.json']);
      });
    }
    if (sr[2] === '/keep') { // {name, kept: boolean} files an earlier session in the Archived section (or takes it out); no name: archive the current one, like New session
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      if (!guardJson(req, res)) return;
      return readJson(req, res, (d) => {
        if (d.name === undefined) { const name = archiveSession(id, true); return name ? send(res, 200, JSON.stringify({ ok: true, id, archived: name, kept: true }), TYPES['.json']) : send(res, 404, 'Not found'); }
        if (typeof d.kept !== 'boolean') return send(res, 400, JSON.stringify({ error: '"kept" must be true or false' }), TYPES['.json']);
        if (!setMark(id, d.name, 'kept', d.kept)) return send(res, 404, 'Not found');
        send(res, 200, JSON.stringify({ ok: true, id, kept: d.kept }), TYPES['.json']);
      });
    }
    if (sr[2] === '/switch') {
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
      if (!guardJson(req, res)) return;
      return readJson(req, res, (d) => {
        const r = switchSession(id, d.name);
        if (!r) return send(res, 404, 'Not found');
        send(res, 200, JSON.stringify({ ok: true, id, ...r }), TYPES['.json']);
      });
    }
    if (!sr[2]) {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      const file = path.join(SESSIONS, id);
      return send(res, 200, JSON.stringify({ id, exists: fs.existsSync(file), adopted: fs.existsSync(file + '.cwd') }), TYPES['.json']);
    }
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    if (!guardJson(req, res)) return;
    return readJson(req, res, () => {
      const adopted = fs.existsSync(path.join(SESSIONS, id + '.cwd'));
      send(res, 200, JSON.stringify({ ok: true, id, archived: archiveSession(id), adopted }), TYPES['.json']);
    });
  }
  if (p === '/api/templates' && req.method === 'GET') return send(res, 200, JSON.stringify(listTemplates().map((t) => ({ id: t.id, name: t.name, place: t.place, status: t.status, blanks: t.blanks }))), TYPES['.json']);
  if (p === '/api/version') { // for the shell's "Update available" note: the server restarted, or shell.html changed
    let shell = 0; try { shell = Math.round(fs.statSync(path.join(ROOT, 'shell.html')).mtimeMs); } catch { /* missing: 0 */ }
    return send(res, 200, JSON.stringify({ server: BOOT_ID, shell }), TYPES['.json']);
  }
  if (p === '/api/options') return send(res, 200, JSON.stringify(OPTIONS), TYPES['.json']);
  if (p === '/api/config') return send(res, 200, JSON.stringify(CONFIG), TYPES['.json']);

  const ar = p.match(/^\/api\/cards\/([^/]+)\/artifact(?:\/(page))?$/);
  if (ar) {
    const card = findCard(ar[1]);
    if (!card) return send(res, 404, 'Not found');
    if (req.method === 'GET') {
      const art = readArtifact(card.dir);
      if (!ar[2]) return send(res, 200, JSON.stringify(art), TYPES['.json']); // null when the card has none
      if (!art) return send(res, 404, 'Not found');
      // The saved page runs in a sandbox: scripts allowed, but no access to this app, its storage or its API.
      return send(res, 200, fs.readFileSync(path.join(card.dir, 'artifact', 'index.html')), TYPES['.html'],
        { 'Content-Security-Policy': 'sandbox allow-scripts allow-popups', 'X-Content-Type-Options': 'nosniff' });
    }
    if (req.method === 'POST' && !ar[2]) { // attach / replace: { url, title?, html }   or detach: { remove: true }
      if (!guardJson(req, res)) return;
      return readJson(req, res, (d) => {
        if (d.remove === true) {
          fs.rmSync(path.join(card.dir, 'artifact.json'), { force: true });
          fs.rmSync(path.join(card.dir, 'artifact'), { recursive: true, force: true });
          return send(res, 200, 'null', TYPES['.json']);
        }
        if (typeof d.url !== 'string' || !ARTIFACT_URL.test(d.url)) return send(res, 400, 'Invalid artifact link');
        if (typeof d.html !== 'string' || !d.html.trim() || Buffer.byteLength(d.html) > MAX_ARTIFACT) return send(res, 400, 'Invalid page');
        const title = typeof d.title === 'string' && d.title.trim() ? d.title.trim().slice(0, 200) : 'Artifact';
        fs.mkdirSync(path.join(card.dir, 'artifact'), { recursive: true });
        fs.writeFileSync(path.join(card.dir, 'artifact', 'index.html'), d.html);
        fs.writeFileSync(path.join(card.dir, 'artifact.json'), JSON.stringify({ url: d.url, title, savedAt: new Date().toISOString() }, null, 2) + '\n'); // last: it appears once complete
        send(res, 201, JSON.stringify(readArtifact(card.dir)), TYPES['.json']);
      }, MAX_ARTIFACT + 65536);
      return;
    }
    return send(res, 405, 'Method not allowed');
  }

  const tb = p.match(/^\/api\/cards\/([^/]+)\/tabs(?:\/([^/]+))?$/);
  if (tb) {
    const card = findCard(tb[1]);
    if (!card) return send(res, 404, 'Not found');
    if (req.method === 'GET') {
      if (!tb[2]) return send(res, 200, JSON.stringify(readTabs(card.dir)), TYPES['.json']);
      if (!TAB_ID.test(tb[2]) || !readTabs(card.dir).some((t) => t.id === tb[2])) return send(res, 404, 'Not found');
      let html = '';
      try { html = fs.readFileSync(path.join(card.dir, 'tabs', tb[2] + '.html'), 'utf8'); } catch { /* not written yet */ }
      return send(res, 200, html, TYPES['.txt']); // served as text: the page inserts it, and opening the URL never runs it
    }
    if (req.method === 'POST' && !tb[2]) { // add a tab: { "title": "..." }
      if (!guardJson(req, res)) return;
      return readJson(req, res, (d) => {
        if (d.order !== undefined) { // reorder: { "order": ["findings", "scoping", ...] } must list every existing tab id exactly once
          const tabs = readTabs(card.dir), ids = Array.isArray(d.order) ? d.order : [];
          if (ids.length !== tabs.length || new Set(ids).size !== ids.length || !ids.every((i) => tabs.some((t) => t.id === i))) return send(res, 400, 'Order must list every tab once');
          const sorted = ids.map((i) => tabs.find((t) => t.id === i));
          fs.writeFileSync(path.join(card.dir, 'tabs.json'), JSON.stringify(sorted, null, 2) + '\n');
          return send(res, 200, JSON.stringify(sorted), TYPES['.json']);
        }
        const title = typeof d.title === 'string' ? d.title.trim() : '';
        if (!title || title.length > 40) return send(res, 400, 'Invalid title');
        send(res, 201, JSON.stringify(addTab(card.dir, title)), TYPES['.json']);
      });
    }
    return send(res, 405, 'Method not allowed');
  }

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
        list.push({ id, number: Number(id.split('-')[1]), order: list.length + 1, title, status: d.status || 'Pending', priority: d.priority || '', updates: [] });
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
            if (!text) return bad('Invalid update');
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
    }, MAX_TEXT_BODY);
  }

  const st = p.match(/^\/api\/cards\/([^/]+)$/);
  if (st && req.method === 'POST') {
    if (!guardJson(req, res)) return;
    const card = findCard(st[1]);
    if (!card) return send(res, 404, 'Not found');
    return readJson(req, res, (changes) => {
      const fields = Object.keys(changes);
      const ticketOk = (v) => typeof v === 'string' && (v.trim() === '' || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(v.trim()) || isTicketLink(v)); // a key (ABC-123) or a link to any tracker
      const textOk = (f, v) => typeof v === 'string' && (f === 'title' ? v.trim() !== '' && v.trim().length <= 200 : (f === 'notes' ? v.length <= 20000 : true)); // the description has no length limit
      const valid = (f) => (OPTIONS[f] && OPTIONS[f].includes(changes[f])) || ((f === 'inbox' || f === 'taskProgress') && typeof changes[f] === 'boolean') || (f === 'ticket' && ticketOk(changes[f])) || (LINK_FIELDS[f] && linkOk(f, changes[f]))
        || (['title', 'description', 'notes'].includes(f) && textOk(f, changes[f]))
        || (Object.values(REASON_FIELD).includes(f) && typeof changes[f] === 'string' && changes[f].trim() !== '' && changes[f].trim().length <= 1000);
      if (!fields.length || !fields.every(valid)) return send(res, 400, 'Unknown field or value');
      const file = path.join(card.dir, 'card.json');
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Blocked and Cancelled always carry a reason: required when the status changes to it, editable while it stays.
      const becomes = changes.status !== undefined ? changes.status : meta.status;
      for (const [st, rf] of Object.entries(REASON_FIELD)) {
        if (becomes === st && !(changes[rf] || (changes.status === undefined || meta.status === st) && meta[rf])) return send(res, 400, `A reason is required when a card is ${st}`);
        if (becomes !== st && changes[rf] !== undefined) return send(res, 400, `A reason only applies to a ${st} card`);
      }
      fields.forEach((f) => {
        if (f === 'inbox') return; // not stored: it is where the folder lives
        if (f === 'taskProgress') { if (changes[f]) meta.taskProgress = true; else delete meta.taskProgress; return; }
        if (f === 'title' || f === 'description' || Object.values(REASON_FIELD).includes(f)) meta[f] = changes[f].trim();
        else if (LINK_FIELDS[f]) { if (changes[f].trim()) meta[f] = changes[f].trim(); else delete meta[f]; }
        else if (f !== 'ticket') meta[f] = changes[f];
        else if (changes[f].trim()) meta.ticket = isTicketLink(changes[f]) ? changes[f].trim() : changes[f].trim().toUpperCase(); // a link is kept as given; a key is upper-cased, e.g. ABC-123
        else delete meta.ticket;
      });
      delete meta.inbox;
      for (const [st, rf] of Object.entries(REASON_FIELD)) if (meta.status !== st) delete meta[rf]; // leaving the status drops its reason
      meta.number = Number(card.id);
      meta.updated = today();
      fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
      // Moving a card between Inbox and Topics, or to/from done/, is moving its folder.
      const inbox = changes.inbox !== undefined ? changes.inbox : card.inbox, done = meta.status === 'Done';
      const dir = cardPath(card.id, inbox, done);
      if (dir !== card.dir) moveSafe(card.dir, dir);
      send(res, 200, JSON.stringify({ ...meta, id: card.id, inbox, done }), TYPES['.json']);
    }, MAX_TEXT_BODY);
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
    return sendFile(res, file, true, isReport ? '<script src="/static/dialog.js"></script><script src="/static/ticket.js"></script><script src="/static/blocked.js" defer></script><script src="/static/tasks.js" defer></script>' : '');
  }
  send(res, 404, 'Not found');
}).listen(PORT, HOST, () => console.log(`${CONFIG.appName}: http://${HOST}:${PORT}/`));

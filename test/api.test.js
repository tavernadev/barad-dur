// API and storage tests: load server.js in-process with a stubbed http module (no ports) in a throwaway folder, and
// call its request handler directly. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const exists = (...p) => fs.existsSync(path.join(...p));

// Build a throwaway "repo" (with the real examples/ and static/), let `prepare` set up files first, then load the server.
function boot({ dataDir, prepare, noBirthtime, env: extraEnv } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-root-'));
  fs.cpSync(path.join(REPO, 'examples'), path.join(root, 'examples'), { recursive: true });
  fs.cpSync(path.join(REPO, 'static'), path.join(root, 'static'), { recursive: true });
  for (const f of ['home.html', 'shell.html']) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  if (prepare) prepare(root);
  const env = { ...process.env };
  delete env.DATA_DIR;
  if (dataDir !== undefined) env.DATA_DIR = dataDir;
  Object.assign(env, extraEnv);
  let handler;
  const fakeHttp = { createServer: (h) => { handler = h; return { listen() {} }; } };
  // Like the real fs.watch, refuse a folder that does not exist (a server that watches before creating it must fail here).
  const watchers = [];
  // noBirthtime: act like filesystems that do not report creation times (GitHub's Linux runners), so ordering must not rely on them
  const statSync = noBirthtime ? (p, o) => new Proxy(fs.statSync(p, o), { get: (t, k) => (k === 'birthtimeMs' ? 0 : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : fs.statSync;
  const fakeFs = { ...fs, statSync, watch: (p, ...rest) => { if (!fs.existsSync(p)) throw new Error(`ENOENT: cannot watch ${p}`); watchers.push({ path: p, cb: rest.at(-1) }); return {}; } };
  const fakeProcess = new Proxy(process, { get: (t, k) => (k === 'env' ? env : k === 'loadEnvFile' ? () => { throw new Error('no .env'); } : t[k]) });
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    // like Module.wrap, plus a `process` parameter so each boot() gets its own environment variables
    const wrapped = vm.runInThisContext('(function (exports, require, module, __filename, __dirname, process) {' + src + '\n})');
    wrapped({}, (id) => (id === 'http' ? fakeHttp : id === 'fs' ? fakeFs : require(id)), { exports: {} }, path.join(root, 'server.js'), root, fakeProcess);
  } finally { console.log = log; }
  const call = (method, url, body, headers = {}) => new Promise((resolve) => {
    const r = new EventEmitter();
    r.method = method; r.url = url;
    r.headers = { host: '127.0.0.1:8080', 'content-type': 'application/json', ...headers };
    const res = { writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { let json; try { json = JSON.parse(b); } catch { /* not json */ } resolve({ status: this.status, headers: this.headers, body: String(b), json }); } };
    handler(r, res);
    if (body !== undefined) r.emit('data', JSON.stringify(body));
    r.emit('end');
  });
  // Open the live-event stream and return what it has received so far.
  const events = () => {
    const got = [];
    const r = new EventEmitter();
    r.method = 'GET'; r.url = '/events'; r.headers = { host: '127.0.0.1:8080' };
    handler(r, { writeHead() {}, write: (c) => got.push(String(c)), end() {} });
    return got;
  };
  return { root, data: dataDir && path.isAbsolute(dataDir) ? dataDir : path.join(root, dataDir || 'data'), call, logs, watchers, events };
}

test('first run creates the folders and seeds the example card (and the server can start watching them)', async () => {
  const { call, data } = boot();
  assert.ok(exists(data, 'topics', '1', 'card.json'));
  assert.ok(exists(data, 'inbox'));
  const cards = (await call('GET', '/api/cards')).json;
  assert.deepEqual(cards.map((c) => [c.id, c.number, c.inbox, c.done]), [['1', 1, false, false]]);
  const tasks = (await call('GET', '/api/cards/1/tasks')).json;
  assert.deepEqual(tasks.map((t) => [t.id, t.status]), [['1-1', 'Done'], ['1-2', 'Pending']]);
});

test('a new card goes to inbox/<number>: no name or date in the folder', async () => {
  const { call, data } = boot();
  const a = await call('POST', '/api/cards', { title: '  First  ', description: 'd' });
  const b = await call('POST', '/api/cards', { title: 'First' });
  assert.equal(a.status, 201);
  assert.deepEqual([a.json.id, a.json.title, a.json.inbox], ['2', 'First', true]);
  assert.equal(b.json.id, '3');
  assert.ok(exists(data, 'inbox', '2', 'card.json') && exists(data, 'inbox', '3', 'index.html'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'inbox', '2', 'card.json'), 'utf8')).inbox, undefined, 'inbox is where the folder lives, not a field');
  assert.equal((await call('POST', '/api/cards', { title: ' ' })).status, 400);
  assert.equal((await call('POST', '/api/cards', { title: 'x'.repeat(201) })).status, 400);
});

test('Inbox -> Topics is a folder move, and back', async () => {
  const { call, data } = boot();
  await call('POST', '/api/cards', { title: 'Idea' }); // #2 in the inbox
  const moved = (await call('POST', '/api/cards/2', { inbox: false })).json;
  assert.equal(moved.inbox, false);
  assert.ok(exists(data, 'topics', '2', 'card.json') && !exists(data, 'inbox', '2'));
  await call('POST', '/api/cards/2', { inbox: true });
  assert.ok(exists(data, 'inbox', '2', 'card.json') && !exists(data, 'topics', '2'));
});

test('Done cards move into done/ next to the active ones, and come back when reopened', async () => {
  const { call, data } = boot();
  await call('POST', '/api/cards', { title: 'Idea' }); // #2, inbox
  let r = (await call('POST', '/api/cards/1', { status: 'Done' })).json;
  assert.equal(r.done, true);
  assert.ok(exists(data, 'topics', 'done', '1', 'card.json') && !exists(data, 'topics', '1'));
  assert.equal((await call('GET', '/content/1/')).status, 200, 'its report is still served from done/');
  assert.equal((await call('GET', '/api/cards/1/tasks')).json.length, 2, 'its tasks come along');
  r = (await call('POST', '/api/cards/2', { status: 'Done' })).json;
  assert.ok(exists(data, 'inbox', 'done', '2', 'card.json'), 'inbox cards have their own done/');
  await call('POST', '/api/cards/1', { status: 'Testing' });
  assert.ok(exists(data, 'topics', '1', 'card.json') && !exists(data, 'topics', 'done', '1'));
  const all = (await call('GET', '/api/cards')).json;
  assert.deepEqual(all.map((c) => [c.number, c.inbox, c.done]).sort(), [[1, false, false], [2, true, true]]);
});

test('Blocked needs a reason, shows it, and drops it when unblocked', async () => {
  const { call } = boot();
  const U = '/api/cards/1';
  assert.equal((await call('POST', U, { status: 'Blocked' })).status, 400, 'no reason');
  assert.equal((await call('POST', U, { status: 'Blocked', blockedReason: '  ' })).status, 400, 'blank reason');
  assert.equal((await call('POST', U, { status: 'Testing', blockedReason: 'x' })).status, 400, 'reason on a card that is not blocked');
  let r = (await call('POST', U, { status: 'Blocked', blockedReason: ' waiting for a decision ' })).json;
  assert.deepEqual([r.status, r.blockedReason], ['Blocked', 'waiting for a decision']);
  assert.equal((await call('POST', U, { blockedReason: 'waiting for access' })).json.blockedReason, 'waiting for access', 'reason can be edited while blocked');
  assert.equal((await call('POST', U, { priority: 'High' })).json.blockedReason, 'waiting for access', 'other edits keep it');
  assert.equal((await call('GET', '/api/cards')).json.find((c) => c.number === 1).blockedReason, 'waiting for access');
  r = (await call('POST', U, { status: 'In Progress' })).json;
  assert.equal(r.blockedReason, undefined);
  // Cancelled works the same way, with its own field
  assert.equal((await call('POST', U, { status: 'Cancelled' })).status, 400, 'cancelled needs a reason');
  assert.equal((await call('POST', U, { status: 'Cancelled', blockedReason: 'x' })).status, 400, 'wrong reason field');
  r = (await call('POST', U, { status: 'Cancelled', cancelledReason: ' no longer needed ' })).json;
  assert.deepEqual([r.status, r.cancelledReason, r.blockedReason], ['Cancelled', 'no longer needed', undefined]);
  r = (await call('POST', U, { status: 'Blocked', blockedReason: 'again' })).json;
  assert.deepEqual([r.cancelledReason, r.blockedReason], [undefined, 'again'], 'switching drops the other reason');
});

test('ticket.js names the tracker from the link, and never links anything but http(s)', () => {
  const win = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', 'static', 'ticket.js'), 'utf8'))(win);
  const info = win.ticketInfo;
  const label = (v, base) => { const t = info(v, base); return t && [t.label, t.href]; };
  assert.deepEqual(label('https://app.clickup.com/t/1234567/17abcdef'), ['ClickUp 17abcdef', 'https://app.clickup.com/t/1234567/17abcdef']);
  assert.equal(info('https://app.clickup.com/t/17abcdef').label, 'ClickUp 17abcdef', 'a link without the workspace part');
  assert.equal(info('https://linear.app/example/issue/abc-12/some-title').label, 'Linear ABC-12');
  assert.equal(info('https://example.atlassian.net/browse/PRJ-9').label, 'Jira PRJ-9');
  assert.equal(info('https://jira.example.com/browse/PRJ-9').label, 'Jira PRJ-9');
  assert.equal(info('https://trello.com/c/AbC123/45-some-card').label, 'Trello AbC123');
  assert.equal(info('https://github.com/example-org/my-service/issues/12').label, 'GitHub my-service#12');
  assert.equal(info('https://app.asana.com/0/111/222222').label, 'Asana 222222');
  assert.equal(info('https://app.shortcut.com/example/story/4321/title').label, 'Shortcut 4321');
  assert.equal(info('https://www.tracker.example.org/items/42').label, 'tracker.example.org 42', 'anything else: the site name');
  assert.equal(info('https://tracker.example.org/').label, 'tracker.example.org');
  // a bare key keeps working: linked only when LINEAR_BASE_URL is set
  assert.deepEqual(label('abc-123', 'https://linear.app/example/issue/'), ['ABC-123', 'https://linear.app/example/issue/ABC-123']);
  assert.deepEqual(label('ABC-123', ''), ['ABC-123', '']);
  // unsafe or unreadable values are shown as text and never linked
  assert.deepEqual(label('javascript:alert(1)'), ['javascript:alert(1)', '']);
  assert.equal(info('   '), null);
  assert.equal(info(undefined), null);
});

test('card fields: dropdowns, ticket, text', async () => {
  const { call } = boot();
  const U = '/api/cards/1';
  assert.equal((await call('POST', U, { status: 'Testing', priority: 'Urgent' })).json.status, 'Testing');
  assert.equal((await call('POST', U, { ticket: ' abc-123 ' })).json.ticket, 'ABC-123');
  assert.equal((await call('POST', U, { ticket: '' })).json.ticket, undefined);
  // a ticket can also be a link to any tracker: kept exactly as given (not upper-cased), http(s) only, one line, no credentials
  for (const link of ['https://app.example-tracker.com/t/123456/abc123def', 'https://example.atlassian.net/browse/ABC-123', 'http://tracker.local/issue/7?x=1#top']) {
    assert.equal((await call('POST', U, { ticket: ` ${link} ` })).json.ticket, link, link);
  }
  for (const bad of ['javascript:alert(1)', 'ftp://example.com/a', 'https://user:pw@example.com/a', 'https://example.com/a b', 'https://', 'x'.repeat(501)]) {
    assert.equal((await call('POST', U, { ticket: bad })).status, 400, bad.slice(0, 40));
  }
  assert.equal((await call('POST', U, { ticket: '' })).json.ticket, undefined);
  const t = (await call('POST', U, { title: '  New  ', description: ' d ', notes: 'a\nb ' })).json;
  assert.deepEqual([t.title, t.description, t.notes], ['New', 'd', 'a\nb ']);
  // optional document links: a Notion doc and a Linear project, https only, on the right hosts; empty removes
  const notion = 'https://app.notion.com/p/team/RFC-Thing-3d180a6931918030b6a8ffcc697ec4b3';
  assert.equal((await call('POST', U, { notion: ` ${notion} `, project: 'https://linear.app/ws/project/my-project-abc123' })).json.notion, notion);
  assert.equal((await call('GET', '/api/cards')).json.find((c) => c.number === 1).project, 'https://linear.app/ws/project/my-project-abc123');
  const pr = 'https://github.com/example-org/my-service/pull/12';
  assert.equal((await call('POST', U, { pr: ` ${pr} ` })).json.pr, pr);
  const cleared = (await call('POST', U, { notion: '', project: '', pr: '' })).json;
  assert.deepEqual([cleared.notion, cleared.project, cleared.pr], [undefined, undefined, undefined]);
  for (const bad of [{ notion: 'http://www.notion.so/x' }, { notion: 'https://evil.example/notion.so' }, { notion: 'javascript:alert(1)' }, { notion: 5 },
    { project: 'https://linear.app/ws/issue/ABC-1' }, { project: 'https://example.com/project/x' }, { pr: 'https://github.com/example-org/my-service/issues/12' }, { pr: 'https://gitlab.com/example-org/my-service/pull/12' }, { pr: 'http://github.com/example-org/my-service/pull/12' }, { notion: 'https://www.notion.so/' + 'x'.repeat(500) }]) {
    assert.equal((await call('POST', U, bad)).status, 400, JSON.stringify(bad));
  }
  for (const bad of [{ status: 'Nope' }, { priority: 'Nope' }, { inbox: 'yes' }, { ticket: 'not a key' }, { title: ' ' }, { notes: 5 }, { nope: 1 }]) {
    assert.equal((await call('POST', U, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', '/api/cards/99', { status: 'Done' })).status, 404);
  assert.equal((await call('POST', '/api/cards/abc', { status: 'Done' })).status, 404);
});

test('tasks are folders: <card>/tasks/<card>-<k>/task.json, Done ones in tasks/done/', async () => {
  const { call, data } = boot();
  const T = '/api/cards/1/tasks';
  const base = path.join(data, 'topics', '1', 'tasks');
  let list = (await call('POST', T, { title: '  Third  ', priority: 'High' })).json;
  const mine = list.at(-1);
  assert.deepEqual([mine.id, mine.title, mine.status, mine.priority], ['1-3', 'Third', 'Pending', 'High']);
  assert.ok(exists(base, '1-3', 'task.json'));
  list = (await call('POST', T, { id: '1-3', status: 'Done', title: 'Renamed' })).json;
  assert.ok(exists(base, 'done', '1-3', 'task.json') && !exists(base, '1-3'), 'Done moves into tasks/done/');
  list = (await call('POST', T, { id: '1-3', status: 'Testing' })).json;
  assert.ok(exists(base, '1-3', 'task.json') && !exists(base, 'done', '1-3'), 'and back out again');
  list = (await call('POST', T, { id: '1-3', update: 'checked logs', by: 'claude' })).json;
  assert.deepEqual([list.at(-1).updates[0].by, !!list.at(-1).updates[0].at], ['claude', true]);
  assert.equal((await call('POST', T, { id: '1-3', update: 'hi' })).json.at(-1).updates[1].by, 'me', 'default author is me');
  list = (await call('POST', T, { id: '1-3', move: 'up' })).json;
  assert.equal(list.at(-2).id, '1-3');
  assert.deepEqual([list.at(-2).number, list.at(-2).order], [3, 2], 'moving changes the position, never the task number');
  assert.deepEqual(list.map((t) => t.number), [1, 3, 2], 'numbers stay with their tasks, only the order of the list changed');
  assert.deepEqual(list.map((t) => t.order), list.map((_, i) => i + 1));
  list = (await call('POST', T, { id: '1-3', remove: true })).json;
  assert.ok(!exists(base, '1-3') && !exists(base, 'done', '1-3'));
  assert.equal((await call('POST', T, { title: 'Fourth' })).json.at(-1).id, '1-4', 'a removed task number is not reused');
  for (const bad of [{ title: ' ' }, { id: '1-99', status: 'Done' }, { id: '1-1', status: 'Nope' }, { id: '1-1', update: ' ' }]) {
    assert.ok([400, 404].includes((await call('POST', T, bad)).status), JSON.stringify(bad));
  }
  assert.equal((await call('GET', '/api/cards/abc/tasks')).status, 404);
});

test('hand-written task folders are normalized (legacy "text", no order, junk ignored)', async () => {
  const { call, data } = boot();
  const base = path.join(data, 'topics', '1', 'tasks');
  fs.rmSync(base, { recursive: true });
  const put = (name, obj) => { fs.mkdirSync(path.join(base, name), { recursive: true }); fs.writeFileSync(path.join(base, name, 'task.json'), JSON.stringify(obj)); };
  put('1-1', { text: 'legacy', done: true });
  put('1-2', { title: 'second', order: 1, status: 'Testing', updates: [{ text: 'edit' }] });
  put('not-a-task', { title: 'ignored' });
  fs.mkdirSync(path.join(base, '1-3'), { recursive: true }); // folder without task.json
  const list = (await call('GET', '/api/cards/1/tasks')).json;
  assert.deepEqual(list.map((t) => [t.id, t.order, t.title, t.status]), [['1-1', 1, 'legacy', 'Done'], ['1-2', 2, 'second', 'Testing']]);
  assert.equal(list[1].updates[0].by, 'claude');
});

test('an old install is migrated once: cards/<slug> -> inbox|topics/<number>, tasks.json -> task folders', async () => {
  const prepare = (root) => {
    const w = (p, v) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), typeof v === 'string' ? v : JSON.stringify(v)); };
    w('cards/PROJ-9/card.json', { number: 1, title: 'Worked on', status: 'Scoping' });
    w('cards/PROJ-9/index.html', '<html><body>report</body></html>');
    w('cards/PROJ-9/tasks.json', [{ id: 't1', order: 2, title: 'second', status: 'Pending' }, { id: 't2', order: 1, title: 'first', status: 'Done' }]);
    w('cards/20261015-idea/card.json', { number: 2, title: 'Idea', inbox: true, status: 'Pending' });
    w('cards/20261015-shipped/card.json', { number: 3, title: 'Shipped', status: 'Done' });
    w('cards/20261015-clash/card.json', { number: 2, title: 'Same number as Idea', inbox: true }); // clashing number gets a fresh one
    w('.sessions/PROJ-9', 'session-uuid-1\n');
    w('.sessions/main', 'main-uuid\n');
    w('.counter', '3\n');
  };
  const { call, data, root, logs } = boot({ prepare, noBirthtime: true });
  assert.ok(exists(data, 'topics', '1', 'index.html'), 'the report moved untouched');
  assert.ok(exists(data, 'inbox', '2', 'card.json'));
  assert.ok(exists(data, 'topics', 'done', '3', 'card.json'), 'a Done card lands in done/');
  const cards = (await call('GET', '/api/cards')).json;
  assert.equal(cards.length, 4);
  // two old cards claimed #2: which one keeps it depends on the filesystem, so assert the outcome, not the order
  assert.deepEqual(cards.filter((c) => /Idea|Same number/.test(c.title)).map((c) => c.number).sort(), [2, 4]);
  // with no creation times the tie is broken by folder name: 20261015-clash comes before 20261015-idea and keeps #2
  assert.deepEqual([cards.find((c) => c.title === 'Same number as Idea').number, cards.find((c) => c.title === 'Idea').number], [2, 4]);
  assert.deepEqual((await call('GET', '/api/cards/1/tasks')).json.map((t) => [t.id, t.title, t.status]), [['1-1', 'first', 'Done'], ['1-2', 'second', 'Pending']]);
  assert.ok(exists(data, 'topics', '1', 'tasks', 'done', '1-1', 'task.json') && !exists(data, 'topics', '1', 'tasks.json'));
  assert.equal(fs.readFileSync(path.join(data, '.sessions', '1'), 'utf8').trim(), 'session-uuid-1', 'sessions follow the card number');
  assert.ok(exists(data, '.sessions', 'main'));
  assert.equal(parseInt(fs.readFileSync(path.join(data, '.counter'), 'utf8'), 10), 4);
  assert.ok(!exists(root, 'cards') && !exists(root, '.sessions') && !exists(root, '.counter'), 'nothing left in the old places');
  assert.ok(!exists(data, '.migrating'), 'the lock is released');
  assert.match(logs.join('\n'), /Moved 4 cards/);
});

test('DATA_DIR accepts a folder inside the repo (relative) or a full path, with ~ expanded', async () => {
  const rel = boot({ dataDir: 'my-private-data' });
  await rel.call('POST', '/api/cards', { title: 'Rel' });
  assert.ok(exists(rel.root, 'my-private-data', 'inbox', '2', 'card.json'), 'relative paths resolve from the repo folder');
  assert.ok(!exists(rel.root, 'data'));

  const abs = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-data-'));
  const outside = boot({ dataDir: abs });
  await outside.call('POST', '/api/cards', { title: 'Abs' });
  assert.ok(exists(abs, 'inbox', '2', 'card.json'));
  assert.ok(!exists(outside.root, 'data') && !exists(outside.root, 'inbox'), 'nothing is written into the repo folder');

  const name = '.barad-dur-test-' + process.pid;
  const home = path.join(os.homedir(), name);
  try {
    const tilde = boot({ dataDir: '~/' + name });
    await tilde.call('POST', '/api/cards', { title: 'Tilde' });
    assert.ok(exists(home, 'inbox', '2', 'card.json'), '~ expands to the home folder');
    assert.ok(!exists(tilde.root, '~'), 'no literal ~ folder is created');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('write guards: JSON only, same origin', async () => {
  const { call } = boot();
  assert.equal((await call('POST', '/api/cards', { title: 'a' }, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await call('POST', '/api/cards', { title: 'a' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/cards/1/tasks', { title: 'a' }, { origin: 'http://evil.example' })).status, 403);
});

test('pages: reports get the shared channel and TODO column; the shell gets neither', async () => {
  const { call } = boot();
  const report = (await call('GET', '/content/1/')).body;
  assert.match(report, /static\/live\.js/);
  assert.match(report, /static\/tasks\.js/);
  const shell = (await call('GET', '/')).body;
  assert.doesNotMatch(shell, /live\.js|tasks\.js|EventSource/, 'the shell hosts the terminal and must never auto-reload');
  assert.equal((await call('GET', '/card/1')).status, 200);
});

test('files stay inside their folders', async () => {
  const { call } = boot();
  for (const url of ['/static/..%2fserver.js', '/content/1/..%2f..%2fserver.js', '/content/..%2f/x', '/content/1/../../server.js', '/content/999/']) {
    const r = await call('GET', url);
    assert.ok([403, 404].includes(r.status), `${url} -> ${r.status}`);
    assert.doesNotMatch(r.body, /createServer/, 'server source must never be served');
  }
});

test('home.html: only a real change reloads the page (a read-triggered fs.watch event must not)', async () => {
  const { root, watchers, events } = boot();
  const got = events();
  const home = watchers.find((w) => w.path === root && w.cb.length >= 1);
  assert.ok(home, 'the folder is watched');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 5; i++) home.cb('change', 'home.html'); // what macOS does every ~2s, with the file untouched
  home.cb('change', 'server.js');
  await wait(200);
  assert.equal(got.filter((c) => c.startsWith('event: reload')).length, 0, 'no reload without a modification');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'home.html'), later, later);
  home.cb('change', 'home.html');
  await wait(200);
  assert.equal(got.filter((c) => c.startsWith('event: reload')).length, 1, 'one reload after a real change');
  home.cb('change', 'home.html'); // same mtime again
  await wait(200);
  assert.equal(got.filter((c) => c.startsWith('event: reload')).length, 1, 'and not again');
});

test('terminal.sh: no "Leave site?" popup unless asked, and the theme and close signal stay', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-ttyd-'));
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ttyd'), '#!/bin/sh\nfor a in "$@"; do echo "ARG=$a"; done\n', { mode: 0o755 }); // a stand-in: the real ttyd is never started
  const run = (extra) => spawnSync('bash', [path.join(REPO, 'terminal.sh')], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TTYD_LEAVE_ALERT: '', ...extra }, encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('ARG=')).map((l) => l.slice(4));
  let args = run({});
  assert.ok(args.includes('disableLeaveAlert=true'), 'off by default');
  assert.equal(args.indexOf('-t') > -1 && args.filter((a) => a === '-t').length, 2, 'next to the theme option, not instead of it');
  assert.ok(args.some((a) => a.startsWith('theme=')) && args.includes('-s') && args.includes('./card-terminal.sh'));
  args = run({ TTYD_LEAVE_ALERT: '1' });
  assert.equal(args.includes('disableLeaveAlert=true'), false, 'TTYD_LEAVE_ALERT=1 brings the popup back');
  assert.ok(args.some((a) => a.startsWith('theme=')) && args.includes('./card-terminal.sh'));
});

test('card-terminal.sh: starts a card session, resumes it, and resumes an adopted session from its own directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-term-'));
  const data = path.join(tmp, 'data'), elsewhere = path.join(tmp, 'other-project');
  fs.mkdirSync(path.join(data, 'topics', '7'), { recursive: true });
  fs.mkdirSync(path.join(data, 'topics', 'done', '8'), { recursive: true });
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(data, 'topics', '7', 'card.json'), '{}');
  fs.writeFileSync(path.join(data, 'topics', 'done', '8', 'card.json'), '{}');
  const fake = path.join(tmp, 'fake-claude'); // prints where and how it was launched; the real claude is never run
  fs.writeFileSync(fake, '#!/bin/sh\necho "PWD=$(pwd)"\necho "ARGS=$*"\n', { mode: 0o755 });
  const run = (id) => spawnSync('bash', [path.join(REPO, 'card-terminal.sh'), id], { env: { ...process.env, DATA_DIR: data, CLAUDE_BIN: fake, PORT: '8080' }, encoding: 'utf8' });
  const real = (p) => fs.realpathSync(p);

  let r = run('7'); // a new card session: --session-id, scoped prompt, the card's own folder, run from the repo
  assert.match(r.stdout, /ARGS=.*--add-dir .*--session-id [0-9a-f-]{36} This session is dedicated to card 7/);
  assert.ok(r.stdout.includes(path.join(data, 'topics', '7')), 'the prompt names the card folder');
  assert.equal(real(r.stdout.match(/PWD=(.*)/)[1]), real(REPO));
  const id = fs.readFileSync(path.join(data, '.sessions', '7'), 'utf8').trim();
  r = run('7');
  assert.match(r.stdout, new RegExp(`--resume ${id}`), 'the stored session is resumed');
  assert.doesNotMatch(r.stdout, /--session-id/);
  fs.writeFileSync(path.join(data, 'topics', 'done', '8', 'tabs.json'), '[]');
  r = run('8');
  assert.match(r.stdout, /Its folder is .*topics\/done\/8/, 'a done card is found in done/');
  assert.match(r.stdout, /This card has tabs: .*tabs\/scoping\.html.*tabs\/findings\.html.*POST .*\/api\/cards\/8\/tabs/, 'a tabbed card tells its session where to write');
  assert.match(r.stdout, /do not create an artifact unless the user asks; when the user asks for one, publish it and attach it to this card in the same turn/, 'artifacts are created and attached together');
  assert.match(r.stdout, /"Extra instructions" section, follow it/, 'the session is told to follow extra instructions in the description');
  assert.doesNotMatch(r.stdout, /on your own/, 'the old "never attach" wording is gone');
  assert.doesNotMatch(run('7').stdout, /This card has tabs/, 'a card without tabs.json gets no tab instructions');

  // adopt an existing session started somewhere else: resume it from that directory
  fs.writeFileSync(path.join(data, '.sessions', '7'), 'aaaaaaaa-0000-4000-8000-000000000000\n');
  fs.writeFileSync(path.join(data, '.sessions', '7.cwd'), elsewhere + '\n');
  r = run('7');
  assert.equal(real(r.stdout.match(/PWD=(.*)/)[1]), real(elsewhere), 'resumed from the directory the session was started in');
  assert.match(r.stdout, /--resume aaaaaaaa-0000-4000-8000-000000000000/);
  assert.match(r.stdout, /--add-dir/, 'the data folder is outside that directory, so it is added');

  // the default data folder is relative (./data): it must still work after the script changes directory
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'data', 'topics', '9'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data', '.sessions'), { recursive: true });
  for (const f of ['card-terminal.sh', 'load-env.sh']) fs.copyFileSync(path.join(REPO, f), path.join(repo, f));
  fs.writeFileSync(path.join(repo, 'data', 'topics', '9', 'card.json'), '{}');
  fs.writeFileSync(path.join(repo, 'data', '.sessions', '9'), 'bbbbbbbb-0000-4000-8000-000000000000\n');
  fs.writeFileSync(path.join(repo, 'data', '.sessions', '9.cwd'), elsewhere + '\n');
  const envNoData = { ...process.env, CLAUDE_BIN: fake }; delete envNoData.DATA_DIR;
  r = spawnSync('bash', [path.join(repo, 'card-terminal.sh'), '9'], { env: envNoData, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--resume bbbbbbbb-0000-4000-8000-000000000000/);
  assert.equal(real(r.stdout.match(/PWD=(.*)/)[1]), real(elsewhere));

  for (const bad of ['', '../x', 'abc', '99']) assert.notEqual(spawnSync('bash', ['-c', `timeout 1 true; DATA_DIR=${data} CLAUDE_BIN=${fake} bash ${path.join(REPO, 'card-terminal.sh')} '${bad}' </dev/null & p=$!; sleep 0.3; kill $p 2>/dev/null; wait $p 2>/dev/null; echo done`], { encoding: 'utf8' }).stdout.includes('PWD='), true, `invalid id '${bad}' must not start claude`);
});

test('tabs: new cards start with Scoping and Findings, more can be added, older cards have none', async () => {
  const { call, data, watchers, events } = boot();
  const created = (await call('POST', '/api/cards', { title: 'Tabbed' })).json; // card #2
  const T = `/api/cards/${created.id}/tabs`;
  assert.deepEqual((await call('GET', T)).json, [{ id: 'scoping', title: 'Scoping' }, { id: 'findings', title: 'Findings' }]);
  const dir = path.join(data, 'inbox', created.id);
  assert.ok(exists(dir, 'tabs.json') && exists(dir, 'tabs', 'scoping.html') && exists(dir, 'tabs', 'findings.html'));
  assert.equal((await call('GET', `${T}/scoping`)).body, '', 'an empty tab is empty');

  let r = await call('POST', T, { title: '  What we are fixing  ' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.at(-1), { id: 'what-we-are-fixing', title: 'What we are fixing' });
  assert.ok(exists(dir, 'tabs', 'what-we-are-fixing.html'));
  // reorder: a permutation of the existing ids is saved, anything else is refused
  const ids = (await call('GET', T)).json.map((t) => t.id);
  const flipped = [...ids].reverse();
  assert.deepEqual((await call('POST', T, { order: flipped })).json.map((t) => t.id), flipped);
  assert.deepEqual((await call('GET', T)).json.map((t) => t.id), flipped, 'order is kept');
  for (const bad of [{ order: ids.slice(1) }, { order: [...ids, 'nope'] }, { order: [ids[0], ids[0], ...ids.slice(2)] }, { order: 'x' }]) {
    assert.equal((await call('POST', T, bad)).status, 400, JSON.stringify(bad));
  }
  r = await call('POST', T, { title: 'What we are fixing' });
  assert.equal(r.json.at(-1).id, 'what-we-are-fixing-2', 'same title gets a distinct tab');
  for (const bad of [{ title: ' ' }, { title: 'x'.repeat(41) }, {}]) assert.equal((await call('POST', T, bad)).status, 400);
  assert.equal((await call('POST', T, { title: 'a' }, { origin: 'http://evil.example' })).status, 403);

  fs.writeFileSync(path.join(dir, 'tabs', 'findings.html'), '<h2>RESULT: found it</h2><script>alert(1)</script>');
  r = await call('GET', `${T}/findings`);
  assert.match(r.body, /<h2>RESULT: found it<\/h2>/);
  assert.doesNotMatch(r.body, /live\.js|EventSource/, 'a tab is served as-is, with nothing injected');
  assert.equal((await call('GET', `${T}/nope`)).status, 404);
  assert.equal((await call('GET', `${T}/..%2fcard`)).status, 404, 'tab ids cannot point outside tabs/');
  assert.equal((await call('GET', '/api/cards/abc/tabs')).status, 404);

  // the seeded example card shows what a tabbed card looks like; a card without tabs.json has none
  assert.equal((await call('GET', '/api/cards/1/tabs')).json.length, 2);
  fs.rmSync(path.join(data, 'topics', '1', 'tabs.json'));
  assert.deepEqual((await call('GET', '/api/cards/1/tabs')).json, []);

  // editing a tab file refreshes only that card's open tab
  const got = events();
  const inbox = watchers.find((w) => w.path === path.join(data, 'inbox'));
  inbox.cb('change', `${created.id}/tabs/findings.html`);
  inbox.cb('change', `${created.id}/tabs.json`);
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(got.some((c) => c.startsWith('event: tabs') && c.includes(`data: ${created.id}`)));
  assert.equal(got.filter((c) => c.startsWith('event: reload')).length, 0, 'no page reload for a tab edit');
});

test('terminal.sh ends a session when its tab closes (ttyd close signal), and ttyd accepts the signal', () => {
  const script = fs.readFileSync(path.join(REPO, 'terminal.sh'), 'utf8');
  assert.match(script, /-s "\$\{TTYD_CLOSE_SIGNAL:-SIGKILL\}"/, 'the close signal is passed to ttyd, SIGKILL by default');
  assert.match(fs.readFileSync(path.join(REPO, 'example.env'), 'utf8'), /^TTYD_CLOSE_SIGNAL=SIGKILL$/m);
  const ok = spawnSync('ttyd', ['-s', 'SIGKILL', '--version'], { encoding: 'utf8' });
  if (ok.error) return; // ttyd is not installed here (CI): the script check above is enough
  assert.equal(ok.status, 0, 'ttyd accepts -s SIGKILL');
  assert.notEqual(spawnSync('ttyd', ['-s', 'NOPE', '--version'], { encoding: 'utf8' }).status, 0, 'and rejects a bogus signal name');
});

test('artifact: optional, never created by the server, attached through the API, rendered sandboxed', async () => {
  const { call, data, watchers, events } = boot();
  const card = (await call('POST', '/api/cards', { title: 'With artifact' })).json; // #2, a new tabbed card
  const A = `/api/cards/${card.id}/artifact`;
  const dir = path.join(data, 'inbox', card.id);

  // nothing is attached by default: not for new cards, not for the example card
  assert.equal((await call('GET', A)).body, 'null');
  assert.equal((await call('GET', '/api/cards/1/artifact')).body, 'null');
  assert.ok(!exists(dir, 'artifact.json') && !exists(dir, 'artifact'), 'creating a card creates no artifact');
  assert.equal((await call('GET', `${A}/page`)).status, 404);

  // attach on request
  const page = '<!doctype html><title>Demo</title><h1>Hello</h1><script>1</script>';
  const url = 'https://claude.ai/artifact/AbC123xyz?sk=token_-1';
  let r = await call('POST', A, { url, title: '  Demo artifact  ', html: page });
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.url, r.json.title, !!r.json.savedAt], [url, 'Demo artifact', true]);
  assert.equal(fs.readFileSync(path.join(dir, 'artifact', 'index.html'), 'utf8'), page);
  assert.equal((await call('GET', A)).json.title, 'Demo artifact');

  // the saved copy is served as it is, inside a sandbox: scripts may run, but with no access to this app
  r = await call('GET', `${A}/page`);
  assert.equal(r.body, page, 'nothing is injected into it');
  assert.match(r.headers['Content-Security-Policy'], /^sandbox allow-scripts allow-popups$/);
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');

  // only claude.ai artifact links, a real page, and same-origin JSON writes
  for (const bad of [{ url: 'http://claude.ai/artifact/abc', html: page }, { url: 'https://evil.example/artifact/abc', html: page },
    { url: 'https://claude.ai/artifact/abc/../x', html: page }, { url: 'javascript:alert(1)', html: page }, { url, html: ' ' }, { url }, { url, html: 5 }]) {
    assert.equal((await call('POST', A, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await call('POST', A, { url, html: 'x'.repeat(6 * 1024 * 1024 + 1) })).status, 400, 'a page over 6 MB is refused');
  assert.equal((await call('POST', A, { url, html: page }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', A, { url, html: page }, { origin: 'null' })).status, 403, 'a sandboxed frame (Origin: null) cannot write, and does not crash the server');
  assert.equal((await call('GET', '/api/cards')).status, 200, 'the server is still answering');

  // attaching refreshes the open page's tabs; detaching removes everything and the tab greys out again
  const got = events();
  const inbox = watchers.find((w) => w.path === path.join(data, 'inbox'));
  inbox.cb('change', `${card.id}/artifact.json`);
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(got.some((c) => c.startsWith('event: tabs') && c.includes(`data: ${card.id}`)));
  assert.equal((await call('POST', A, { remove: true })).body, 'null');
  assert.ok(!exists(dir, 'artifact.json') && !exists(dir, 'artifact'));
  assert.equal((await call('GET', A)).body, 'null');

  // "artifact" is reserved for the built-in first tab
  const tabs = (await call('POST', `/api/cards/${card.id}/tabs`, { title: 'Artifact' })).json;
  assert.equal(tabs.at(-1).id, 'artifact-2');
});

test('config exposes only browser-safe settings', async () => {
  const { json } = await boot().call('GET', '/api/config');
  assert.deepEqual(Object.keys(json).sort(), ['appName', 'linearBaseUrl', 'ttydPort']);
});

// ---- card templates ----
// A fake `gh` (like the fake claude): `gh pr view <n> ...` prints <dir>/<n>.json, or exits 1 with <dir>/<n>.json.err, and every call is logged.
function fakeGh(prs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-gh-'));
  const bin = path.join(dir, 'gh'), log = path.join(dir, 'calls.log');
  fs.writeFileSync(bin, '#!/bin/sh\necho "$@" >> "$FAKE_GH_LOG"\n[ "$1 $2" = "pr view" ] || { echo "unexpected: $*" >&2; exit 2; }\n'
    + 'f="$FAKE_GH_DIR/$3.json"\n[ -f "$f.err" ] && { cat "$f.err" >&2; exit 1; }\ncat "$f"\n', { mode: 0o755 });
  for (const [n, v] of Object.entries(prs)) fs.writeFileSync(path.join(dir, `${n}.json`) + (typeof v === 'string' ? '.err' : ''), typeof v === 'string' ? v : JSON.stringify(v));
  return { env: { GH_BIN: bin, FAKE_GH_DIR: dir, FAKE_GH_LOG: log }, dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}
const PR = (over) => ({ title: 'feat(entry): ABC-123: tidy the thing', isDraft: false, changedFiles: 3, additions: 10, deletions: 2, headRefName: 'feature/abc-123', state: 'OPEN', ...over });
const REVIEW = (url) => ({ template: 'code-review', values: { pr: url } });
const LINK = 'https://github.com/example-org/my-service/pull/7';

test('templates: the default Code review template is seeded once and an edited copy is never overwritten', async () => {
  const { call, data } = boot();
  const list = (await call('GET', '/api/templates')).json;
  assert.deepEqual(list.map((t) => [t.id, t.name, t.place, t.status]), [['code-review', 'Code review', 'Inbox', 'Code Review']]);
  assert.deepEqual(list[0].blanks.map((b) => [b.key, b.kind]), [['pr', 'github-pr']], 'the user is asked for the pull request link only');
  assert.ok(exists(data, 'templates', 'code-review', 'template.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(REPO, 'examples', 'templates', 'code-review', 'template.json'), 'utf8')).defaults, { review_skill: 'your code review skill' }, 'the shipped template names no team-specific skill');
  const shipped = fs.readFileSync(path.join(REPO, 'examples', 'templates', 'code-review', 'template.json'), 'utf8');
  assert.doesNotMatch(shipped, /[A-Z]{2,}-\d{3,}|@[a-z]|https:\/\/(?!github\.com\/<org>\/)/, 'the shipped template is generic: no ticket keys, emails or real links');
  // an existing templates folder is left alone: an edited copy stays, and a deleted default is not put back
  const edited = boot({ prepare: (root) => {
    fs.mkdirSync(path.join(root, 'data', 'templates', 'code-review'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'templates', 'code-review', 'template.json'), JSON.stringify({ name: 'My review', title: 'R {{repo}}', description: 'd {{pr}}', blanks: [{ key: 'pr', label: 'PR', kind: 'github-pr' }] }));
  } });
  assert.deepEqual((await edited.call('GET', '/api/templates')).json.map((t) => t.name), ['My review']);
  const emptied = boot({ prepare: (root) => fs.mkdirSync(path.join(root, 'data', 'templates'), { recursive: true }) });
  assert.deepEqual((await emptied.call('GET', '/api/templates')).json, []);
  // broken templates are skipped, not fatal
  const broken = boot({ prepare: (root) => { fs.mkdirSync(path.join(root, 'data', 'templates', 'bad'), { recursive: true }); fs.writeFileSync(path.join(root, 'data', 'templates', 'bad', 'template.json'), '{not json'); } });
  assert.deepEqual((await broken.call('GET', '/api/templates')).json, []);
});

test('new session: archives only that tab\'s session, keeps the id, and refuses anything else', async () => {
  const { call, data } = boot();
  const S = path.join(data, '.sessions');
  fs.mkdirSync(S, { recursive: true });
  fs.writeFileSync(path.join(S, 'main'), 'aaaaaaaa-0000-4000-8000-000000000001\n');
  fs.writeFileSync(path.join(S, '1'), 'bbbbbbbb-0000-4000-8000-000000000002\n');
  fs.writeFileSync(path.join(S, '1.cwd'), '/some/other/dir\n'); // card 1 adopted a session started elsewhere
  assert.deepEqual((await call('GET', '/api/sessions/main')).json, { id: 'main', exists: true, adopted: false });
  assert.deepEqual((await call('GET', '/api/sessions/1')).json, { id: '1', exists: true, adopted: true });
  // main: archived under .sessions/archive/, the card sessions are untouched
  let r = await call('POST', '/api/sessions/main/reset', {});
  assert.equal(r.status, 200);
  assert.match(r.json.archived, /^main-\d{8}T\d{6}Z$/);
  assert.equal(fs.existsSync(path.join(S, 'main')), false);
  assert.equal(fs.readFileSync(path.join(S, 'archive', r.json.archived), 'utf8').trim(), 'aaaaaaaa-0000-4000-8000-000000000001', 'the old id is kept');
  assert.equal(fs.readFileSync(path.join(S, '1'), 'utf8').trim(), 'bbbbbbbb-0000-4000-8000-000000000002', 'another tab\'s session is not touched');
  // a card: its adopted directory moves with it, and the reply says so
  r = await call('POST', '/api/sessions/1/reset', {});
  assert.deepEqual([r.status, r.json.adopted], [200, true]);
  assert.equal(fs.existsSync(path.join(S, '1')) || fs.existsSync(path.join(S, '1.cwd')), false);
  assert.equal(fs.readFileSync(path.join(S, 'archive', r.json.archived + '.cwd'), 'utf8').trim(), '/some/other/dir');
  // nothing stored yet: fine, nothing archived. Twice in the same second never overwrites an archive.
  assert.deepEqual([(await call('POST', '/api/sessions/main/reset', {})).json.archived], [null]);
  const seen = new Set();
  for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(S, 'main'), `cccccccc-0000-4000-8000-00000000000${i}\n`); seen.add((await call('POST', '/api/sessions/main/reset', {})).json.archived); }
  assert.equal(seen.size, 3);
  assert.equal(fs.readdirSync(path.join(S, 'archive')).filter((f) => f.startsWith('main-')).length, 4, 'every archive is kept');
  // only main and a card that exists; GET and POST guards like the other write routes
  for (const bad of ['999', 'abc', '..%2Fmain', 'main.old', 'archive']) assert.equal((await call('POST', `/api/sessions/${bad}/reset`, {})).status, 404, bad);
  assert.equal((await call('GET', '/api/sessions/main/reset')).status, 405);
  assert.equal((await call('POST', '/api/sessions/main', {})).status, 405);
  assert.equal((await call('POST', '/api/sessions/main/reset', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/sessions/main/reset', {}, { 'content-type': 'text/plain' })).status, 403);
});

test('the app has its own dialogs: no browser popups, and the dialog confirms, cancels, prompts and stays single', async () => {
  // no native alert / confirm / prompt anywhere in the pages and shared scripts
  const files = ['shell.html', 'home.html', ...fs.readdirSync(path.join(REPO, 'static')).filter((f) => f.endsWith('.js')).map((f) => 'static/' + f)];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\/\/.*$/gm, ''), /(^|[^.\w])(alert|confirm|prompt)\(/m, `${f} must use baradDialog, not a browser popup`);
  // every page that can show one loads it: the shell, the main page, and card reports (before blocked.js, which uses it)
  const { call } = boot();
  assert.match(fs.readFileSync(path.join(REPO, 'shell.html'), 'utf8'), /<script src="\/static\/dialog\.js"><\/script>/);
  const home = (await call('GET', '/content/home')).body, report = (await call('GET', '/content/1/')).body;
  assert.match(home, /\/static\/dialog\.js/);
  assert.ok(report.indexOf('/static/dialog.js') > -1 && report.indexOf('/static/dialog.js') < report.indexOf('/static/blocked.js'));

  // run the dialog against a tiny fake DOM
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.l = {}; this.className = ''; this.style = {}; this.attrs = {}; this.value = ''; this.text = ''; }
    set textContent(v) { this.text = v; } get textContent() { return this.text; }
    appendChild(c) { this.children.push(c); c.parent = this; return c; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
    focus() { doc.activeElement = this; } select() {}
    all(p, out = []) { for (const c of this.children) { if (p(c)) out.push(c); c.all(p, out); } return out; }
    querySelectorAll() { return this.all((c) => c.tag === 'input' || c.tag === 'button'); }
    fire(t, e = {}) { (this.l[t] || []).forEach((f) => f({ target: this, ...e })); }
  }
  const body = new El('body'), keys = [];
  const doc = { activeElement: null, head: new El('head'), body, createElement: (t) => new El(t), contains: () => true,
    addEventListener: (t, f) => { if (t === 'keydown') keys.push(f); }, removeEventListener: (t, f) => { const i = keys.indexOf(f); if (i > -1) keys.splice(i, 1); } };
  const win = {}; new Function('window', 'document', fs.readFileSync(path.join(REPO, 'static', 'dialog.js'), 'utf8'))(win, doc);
  const D = win.baradDialog;
  const find = (cls) => body.all((c) => c.className.split(' ').includes(cls))[0];
  const press = (key) => keys.slice().forEach((f) => f({ key, preventDefault() {}, stopPropagation() {}, target: doc.activeElement }));
  const open = () => body.children.length;

  let p = D.confirm({ title: '<b>Start?</b>', who: 'Main session', items: ['one', 'two'], confirmText: 'Go' });
  assert.equal(open(), 1);
  assert.equal(find('bd-ok').text, 'Go'); assert.equal(doc.activeElement, find('bd-ok'), 'focus starts on the confirm button');
  assert.equal(body.all((c) => c.tag === 'h3')[0].text, '<b>Start?</b>', 'text is set as text, never as markup');
  assert.equal(body.all((c) => c.tag === 'li').length, 2);
  assert.equal(await D.confirm({ title: 'second' }), false, 'a second dialog while one is open is refused');
  find('bd-ok').fire('click'); assert.equal(await p, true); assert.equal(open(), 0, 'the dialog is removed when closed');
  p = D.confirm({ title: 'x' }); press('Escape'); assert.equal(await p, false);
  p = D.confirm({ title: 'x' }); body.all((c) => c.tag === 'button' && c.text === 'Cancel')[0].fire('click'); assert.equal(await p, false);
  p = D.confirm({ title: 'x' }); const overlay = find('bd-overlay');
  overlay.fire('mousedown', { target: find('bd-dlg') }); assert.equal(open(), 1, 'a click inside the dialog keeps it open');
  overlay.fire('mousedown', { target: overlay }); assert.equal(await p, false, 'a click outside cancels');
  p = D.notice({ title: 'Oops', items: ['Try again.'] }); assert.equal(body.all((c) => c.tag === 'button').length, 1, 'a notice has only OK');
  find('bd-ok').fire('click'); assert.equal(await p, undefined);
  p = D.prompt({ title: 'Ticket', value: ' abc ' }); const input = body.all((c) => c.tag === 'input')[0];
  assert.equal(doc.activeElement, input, 'a prompt starts in its field'); input.value = '  https://x.example/1  ';
  press('Enter'); assert.equal(await p, 'https://x.example/1', 'Enter accepts, and the text is trimmed');
  p = D.prompt({ title: 'Ticket' }); press('Escape'); assert.equal(await p, null);
  p = D.prompt({ title: 'Ticket', value: 'old' }); body.all((c) => c.tag === 'input')[0].value = ''; find('bd-ok').fire('click'); assert.equal(await p, '', 'an empty answer is allowed (it removes a ticket)');
  assert.equal(keys.length, 0, 'no key handler is left behind');
});

test('/api/version: the shell can tell when the server restarted or shell.html changed', async () => {
  const a = boot(), b = boot();
  const v1 = (await a.call('GET', '/api/version')).json;
  assert.ok(v1.server && Number.isFinite(v1.shell) && v1.shell > 0);
  assert.deepEqual((await a.call('GET', '/api/version')).json, v1, 'stable while nothing changes');
  assert.notEqual((await b.call('GET', '/api/version')).json.server, v1.server, 'a new server process has a new id');
  const later = new Date(Date.now() + 60000); fs.utimesSync(path.join(a.root, 'shell.html'), later, later);
  const v2 = (await a.call('GET', '/api/version')).json;
  assert.deepEqual([v2.server === v1.server, v2.shell !== v1.shell], [true, true], 'touching shell.html changes only its value');
});

test('session history and switch: labels from the transcripts, newest first, and a swap that archives the current one', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-claude-'));
  const proj = path.join(cfg, 'projects', '-some-project'); fs.mkdirSync(proj, { recursive: true });
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a', B = 'bbbbbbbb-0000-4000-8000-00000000000b', C = 'cccccccc-0000-4000-8000-00000000000c';
  const line = (o) => JSON.stringify(o) + '\n';
  // A: no title, so its first real message is the label (the launcher prompt, a system note and a command are skipped)
  fs.writeFileSync(path.join(proj, A + '.jsonl'), line({ type: 'user', message: { content: 'This is the main workspace session for this command center. Read CLAUDE.md first.' } })
    + line({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>ignore</system-reminder>' }] } }) + line({ type: 'user', message: { content: [{ type: 'text', text: 'fix the   terminal\ncolors' }] } }));
  // B: a long session whose generated title is near the end, beyond the part read from the start
  fs.writeFileSync(path.join(proj, B + '.jsonl'), line({ type: 'user', message: { content: 'first words' } }) + line({ type: 'junk', pad: 'x'.repeat(300000) }) + line({ type: 'ai-title', aiTitle: 'Ticket links for every tracker' }));
  fs.writeFileSync(path.join(proj, C + '.jsonl'), line({ type: 'ai-title', aiTitle: 'Current work' }));
  const { call, data } = boot({ env: { CLAUDE_CONFIG_DIR: cfg } });
  const S = path.join(data, '.sessions'); fs.mkdirSync(S, { recursive: true });
  const first = async (id) => { fs.writeFileSync(path.join(S, 'main'), id + '\n'); return (await call('POST', '/api/sessions/main/reset', {})).json.archived; };
  const nameA = await first(A), nameB = await first(B); // B is archived after A, in the same second or later
  fs.writeFileSync(path.join(S, 'main'), C + '\n');
  let h = (await call('GET', '/api/sessions/main/history')).json;
  assert.deepEqual([h.current.resumeId, h.current.label], [C, 'Current work']);
  assert.deepEqual(h.archived.map((x) => x.name), [nameB, nameA], 'newest first');
  assert.deepEqual(h.archived.map((x) => x.label), ['Ticket links for every tracker', 'fix the terminal colors']);
  assert.ok(h.archived.every((x) => /^\d{4}-\d\d-\d\dT/.test(x.at) && x.updated), 'each has an archive time and a last-activity time');
  assert.deepEqual((await call('GET', '/api/sessions/1/history')).json.archived, [], 'another tab has its own history');
  // switch to A: the current session (C) is archived, A is the stored session again
  const r = await call('POST', '/api/sessions/main/switch', { name: nameA });
  assert.deepEqual([r.status, r.json.restored], [200, nameA]);
  assert.equal(fs.readFileSync(path.join(S, 'main'), 'utf8').trim(), A);
  assert.equal(fs.readFileSync(path.join(S, 'archive', r.json.archived), 'utf8').trim(), C, 'the session we left is kept');
  assert.equal(fs.existsSync(path.join(S, 'archive', nameA)), false, 'a restored one leaves the archive');
  h = (await call('GET', '/api/sessions/main/history')).json;
  assert.deepEqual([h.current.resumeId, h.archived.length], [A, 2]);
  // with nothing stored, a switch just restores
  fs.rmSync(path.join(S, 'main'));
  assert.equal((await call('POST', '/api/sessions/main/switch', { name: nameB })).json.archived, null);
  assert.equal(fs.readFileSync(path.join(S, 'main'), 'utf8').trim(), B);
  // only a name from this id's own archive, never a path; same guards as the other writes
  for (const bad of [undefined, 5, '../main', 'main', 'archive/' + nameA, nameA.replace('main', '1'), 'main-20000101T000000Z', nameA + '/../x']) {
    assert.equal((await call('POST', '/api/sessions/main/switch', { name: bad })).status, 404, String(bad));
  }
  assert.equal((await call('POST', '/api/sessions/1/switch', { name: nameA })).status, 404, "another id cannot take main's archive");
  assert.equal((await call('POST', '/api/sessions/main/switch', { name: nameA }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/sessions/main/switch')).status, 405);
  assert.equal((await call('POST', '/api/sessions/main/history', {})).status, 405);
});

test('session summary: one line about the last reply, written when a session is archived, cached, and dropped when it runs again', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-claude-'));
  const proj = path.join(cfg, 'projects', '-some-project'); fs.mkdirSync(proj, { recursive: true });
  const U1 = 'aaaaaaaa-0000-4000-8000-0000000000a1', U2 = 'bbbbbbbb-0000-4000-8000-0000000000b2', U3 = 'cccccccc-0000-4000-8000-0000000000c3';
  const line = (o) => JSON.stringify(o) + '\n', say = (type, text, extra) => line({ type, message: { content: [{ type: 'text', text }] }, ...extra });
  // U1: a reply, then work that has no reply text, a sub-agent note, and megabytes of request blobs at the very end (the scan reads backward past them)
  fs.writeFileSync(path.join(proj, U1 + '.jsonl'), say('user', 'build the bar') + say('assistant', '**Done.** The terminal bar is built and tested, but it is not committed yet.\n\n- more detail\n- and more')
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }) + line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
    + say('assistant', 'sub-agent noise that is not the session', { isSidechain: true }) + ('{"type":"api-request-blob","blob":"' + 'x'.repeat(700000) + '"}\n').repeat(3));
  // U2: never answered: the launcher prompt is skipped and the last real question is used
  fs.writeFileSync(path.join(proj, U2 + '.jsonl'), say('user', 'This is the main workspace session for this command center. Read CLAUDE.md first.') + say('user', 'please fix the failing test in the billing module'));
  const { call, data } = boot({ env: { CLAUDE_CONFIG_DIR: cfg } });
  const S = path.join(data, '.sessions'); fs.mkdirSync(S, { recursive: true });
  const archive = async (uuid) => { fs.writeFileSync(path.join(S, 'main'), uuid + '\n'); return (await call('POST', '/api/sessions/main/reset', {})).json.archived; };
  const sidecar = (name) => path.join(S, 'archive', name + '.summary');
  // archiving writes the summary next to the stored id
  const n1 = await archive(U1);
  assert.equal(fs.readFileSync(sidecar(n1), 'utf8').trim(), 'Done. The terminal bar is built and tested, but it is not committed yet.');
  const n2 = await archive(U2);
  assert.equal(fs.readFileSync(sidecar(n2), 'utf8').trim(), 'You asked: please fix the failing test in the billing module');
  const n3 = await archive(U3); // no transcript on disk: nothing is written, nothing breaks
  assert.equal(fs.existsSync(sidecar(n3)), false);
  fs.writeFileSync(path.join(S, 'main'), U1 + '\n');
  let h = (await call('GET', '/api/sessions/main/history')).json;
  assert.deepEqual(h.archived.map((x) => x.summary).sort(), ['', 'Done. The terminal bar is built and tested, but it is not committed yet.', 'You asked: please fix the failing test in the billing module'].sort());
  assert.equal(h.current.summary, undefined, 'the session that is running has no stored summary');
  // an older archive without a note gets one the first time the list is opened, and keeps it
  const old = 'main-20200101T000000Z'; fs.writeFileSync(path.join(S, 'archive', old), U2 + '\n');
  h = (await call('GET', '/api/sessions/main/history')).json;
  assert.equal(h.archived.find((x) => x.name === old).summary, 'You asked: please fix the failing test in the billing module');
  assert.equal(fs.existsSync(sidecar(old)), true);
  // switching back to an archived session removes its note (it runs again, so it is rewritten when it is archived next); the one left gets its own
  fs.rmSync(path.join(S, 'main'));
  assert.equal((await call('POST', '/api/sessions/main/switch', { name: n1 })).status, 200);
  assert.equal(fs.existsSync(sidecar(n1)), false);
  const left = (await call('POST', '/api/sessions/main/reset', {})).json.archived;
  assert.equal(fs.readFileSync(sidecar(left), 'utf8').trim(), 'Done. The terminal bar is built and tested, but it is not committed yet.');
  // the note is a sidecar: it never shows up as a session of its own
  assert.ok((await call('GET', '/api/sessions/main/history')).json.archived.every((x) => !x.name.endsWith('.summary') && !x.name.endsWith('.cwd')));
});

test('delete for good: erases one session everywhere Claude keeps it, and nothing else', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-claude-')); // always a scratch config folder: this test must never touch the real ~/.claude
  const U1 = 'aaaaaaaa-0000-4000-8000-0000000000a1', U2 = 'bbbbbbbb-0000-4000-8000-0000000000b2', U3 = 'cccccccc-0000-4000-8000-0000000000c3';
  const put = (rel, text = 'x') => { const f = path.join(cfg, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  const mine = (u) => [`projects/-p1/${u}.jsonl`, `projects/-p1/${u}/subagents/a.jsonl`, `file-history/${u}/snap`, `session-env/${u}/env`, `debug/${u}.txt`, `todos/${u}-agent-${u}.json`];
  for (const u of [U1, U2, U3]) mine(u).forEach((r) => put(r));
  const index = put('projects/-p1/sessions-index.json', JSON.stringify({ version: 1, entries: [{ sessionId: U1, firstPrompt: 'one' }, { sessionId: U2, firstPrompt: 'two' }], originalPath: '/p1' }, null, 2) + '\n');
  fs.chmodSync(index, 0o600);
  const hist = (extra) => [JSON.stringify({ display: 'a prompt', sessionId: U1 }), JSON.stringify({ display: 'other', sessionId: U2 }), '{"broken', JSON.stringify({ display: 'third', sessionId: U3 })].join('\n') + '\n';
  const history = put('history.jsonl', hist());
  const registry = put('sessions/4242.json', JSON.stringify({ pid: 4242, sessionId: U1 })); // the running-process registry is not ours to touch
  const keep = put('keepme', 'untouched');
  const { call, data } = boot({ env: { CLAUDE_CONFIG_DIR: cfg } });
  const S = path.join(data, '.sessions'), A = path.join(S, 'archive'); fs.mkdirSync(A, { recursive: true });
  const n1 = 'main-20260101T000000Z', n2 = 'main-20260102T000000Z';
  fs.writeFileSync(path.join(A, n1), U1 + '\n'); fs.writeFileSync(path.join(A, n1 + '.cwd'), '/elsewhere\n'); fs.writeFileSync(path.join(A, n1 + '.summary'), 'old note\n');
  fs.writeFileSync(path.join(A, n2), U2 + '\n'); fs.writeFileSync(path.join(S, 'main'), U3 + '\n');
  const exists = (rel) => fs.existsSync(path.join(cfg, rel));
  // an archived session: our files and all of Claude's files for that id go; the other sessions stay
  let r = await call('POST', '/api/sessions/main/delete', { name: n1 });
  assert.deepEqual([r.status, r.json.current, r.json.adopted], [200, false, true]);
  assert.ok(r.json.erased >= 6);
  for (const rel of mine(U1)) assert.equal(exists(rel), false, rel);
  assert.deepEqual([n1, n1 + '.cwd', n1 + '.summary'].map((f) => fs.existsSync(path.join(A, f))), [false, false, false]);
  for (const u of [U2, U3]) for (const rel of mine(u)) assert.equal(exists(rel), true, 'another session is untouched: ' + rel);
  assert.deepEqual(JSON.parse(fs.readFileSync(index, 'utf8')).entries.map((e) => e.sessionId), [U2], 'only its entry leaves the project index');
  assert.equal(fs.statSync(index).mode & 0o777, 0o600, 'and the index keeps its permissions');
  assert.equal(fs.readFileSync(history, 'utf8'), hist().split('\n').filter((l) => !l.includes('"a prompt"')).join('\n'), 'only its prompts leave the history; every other line is byte for byte');
  assert.equal(fs.existsSync(registry) && fs.existsSync(keep), true);
  assert.deepEqual((await call('GET', '/api/sessions/main/history')).json.archived.map((x) => x.name), [n2], 'it no longer shows in the list');
  // the current session: its stored id goes too, and a late write from a process that was still closing is swept shortly after
  r = await call('POST', '/api/sessions/main/delete', {});
  assert.deepEqual([r.status, r.json.current], [200, true]);
  assert.equal(fs.existsSync(path.join(S, 'main')), false);
  for (const rel of mine(U3)) assert.equal(exists(rel), false, rel);
  put(`projects/-p1/${U3}.jsonl`, 'late write');
  await new Promise((resolve) => setTimeout(resolve, 3200));
  assert.equal(exists(`projects/-p1/${U3}.jsonl`), false, 'the second sweep removes it');
  assert.equal((await call('GET', '/api/sessions/main/history')).json.current, null);
  // nothing to delete, names that are not this id's archive, and an id that is not a real session id: 404 or nothing outside our files
  for (const bad of [{}, { name: '../main' }, { name: n1 }, { name: 'main' }, { name: 5 }, { name: 'main-20260102T000000Z/../x' }]) assert.equal((await call('POST', '/api/sessions/main/delete', bad)).status, 404, JSON.stringify(bad));
  assert.equal((await call('POST', '/api/sessions/1/delete', { name: n2 })).status, 404, "another id cannot delete main's archive");
  fs.writeFileSync(path.join(A, 'main-20260103T000000Z'), '../../keepme\n');
  r = await call('POST', '/api/sessions/main/delete', { name: 'main-20260103T000000Z' });
  assert.deepEqual([r.status, r.json.erased, fs.existsSync(keep)], [200, 0, true], 'a stored value that is not a session id erases nothing of Claude\'s');
  assert.equal((await call('POST', '/api/sessions/main/delete', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/sessions/main/delete', {}, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await call('GET', '/api/sessions/main/delete')).status, 405);
  assert.equal(fs.existsSync(path.join(A, n2)), true, 'the other archived session survived all of that');
});

test('session lock and archive: two independent marks; a locked session cannot be deleted; marks follow the session', async () => {
  const { call, data } = boot();
  const S = path.join(data, '.sessions'), A = path.join(S, 'archive'); fs.mkdirSync(A, { recursive: true });
  const n1 = 'main-20260101T000000Z';
  fs.writeFileSync(path.join(A, n1), 'x\n'); fs.writeFileSync(path.join(S, 'main'), 'y\n');
  const hist = async () => (await call('GET', '/api/sessions/main/history')).json;
  // archive and lock are independent
  assert.equal((await call('POST', '/api/sessions/main/keep', { name: n1, kept: true })).status, 200);
  let h = await hist(); assert.deepEqual([h.archived[0].kept, h.archived[0].locked], [true, false]);
  assert.equal((await call('POST', '/api/sessions/main/lock', { name: n1, locked: true })).status, 200);
  h = await hist(); assert.deepEqual([h.archived[0].kept, h.archived[0].locked], [true, true]);
  // locked: delete is refused (423) and nothing is removed; unlocked: it goes
  assert.equal((await call('POST', '/api/sessions/main/delete', { name: n1 })).status, 423);
  assert.equal(fs.existsSync(path.join(A, n1)), true);
  await call('POST', '/api/sessions/main/lock', { name: n1, locked: false });
  assert.equal((await hist()).archived[0].locked, false);
  // the current session can be locked, and the lock follows it into the archive on New session
  assert.equal((await call('POST', '/api/sessions/main/lock', { locked: true })).status, 200);
  assert.equal((await hist()).current.locked, true);
  assert.equal((await call('POST', '/api/sessions/main/delete', {})).status, 423);
  const reset = await call('POST', '/api/sessions/main/reset', {});
  h = await hist(); const moved = h.archived.find((x) => x.name === reset.json.archived);
  assert.deepEqual([moved.locked, moved.kept], [true, false]);
  // archiving the current one files it straight into Archived
  fs.writeFileSync(path.join(S, 'main'), 'z\n');
  const k = await call('POST', '/api/sessions/main/keep', {});
  assert.deepEqual([k.status, k.json.kept], [200, true]);
  assert.equal((await hist()).archived.find((x) => x.name === k.json.archived).kept, true);
  // switching one back makes it the current session again (no longer archived), keeping its lock
  await call('POST', '/api/sessions/main/switch', { name: reset.json.archived });
  h = await hist(); assert.equal(h.current.locked, true);
  assert.equal(h.archived.some((x) => x.name === reset.json.archived), false);
  // bad input
  assert.equal((await call('POST', '/api/sessions/main/lock', { name: n1, locked: 'yes' })).status, 400);
  assert.equal((await call('POST', '/api/sessions/main/lock', { name: '../main', locked: true })).status, 404);
  assert.equal((await call('POST', '/api/sessions/main/keep', { name: n1, kept: 1 })).status, 400);
  assert.equal((await call('POST', '/api/sessions/1/lock', { name: n1, locked: true })).status, 404);
  assert.equal((await call('POST', '/api/sessions/main/lock', { locked: true }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/sessions/main/lock')).status, 405);
});

test('session rename: your own title wins, follows the session, and an empty one restores the generated label', async () => {
  const { call, data } = boot();
  const S = path.join(data, '.sessions'), A = path.join(S, 'archive'); fs.mkdirSync(A, { recursive: true });
  const n1 = 'main-20260101T000000Z';
  fs.writeFileSync(path.join(A, n1), 'x\n'); fs.writeFileSync(path.join(S, 'main'), 'y\n');
  const hist = async () => (await call('GET', '/api/sessions/main/history')).json;
  assert.equal((await call('POST', '/api/sessions/main/rename', { name: n1, title: '  Fix   the\nlogin  ' })).json.title, 'Fix the login');
  let h = await hist(); assert.deepEqual([h.archived[0].label, h.archived[0].renamed], ['Fix the login', true]);
  assert.equal((await call('POST', '/api/sessions/main/rename', { title: 'Main work' })).status, 200);
  assert.equal((await hist()).current.label, 'Main work');
  const reset = await call('POST', '/api/sessions/main/reset', {});
  assert.equal((await hist()).archived.find((x) => x.name === reset.json.archived).label, 'Main work', 'the name follows the session into the archive');
  await call('POST', '/api/sessions/main/switch', { name: reset.json.archived });
  assert.equal((await hist()).current.label, 'Main work', 'and back');
  await call('POST', '/api/sessions/main/rename', { name: n1, title: '' });
  h = await hist(); assert.equal(h.archived.find((x) => x.name === n1).renamed, false);
  assert.equal((await call('POST', '/api/sessions/main/rename', { name: n1, title: 5 })).status, 400);
  assert.equal((await call('POST', '/api/sessions/main/rename', { name: '../main', title: 'a' })).status, 404);
  assert.equal((await call('POST', '/api/sessions/main/rename', { title: 'a' }, { origin: 'http://evil.example' })).status, 403);
  await call('POST', '/api/sessions/main/rename', { name: n1, title: 'gone soon' });
  await call('POST', '/api/sessions/main/delete', { name: n1 });
  assert.equal(fs.existsSync(path.join(A, n1 + '.title')), false, 'deleting removes the name too');
});

test('new session end to end: after a reset the launcher starts a fresh session, keeps the old id, and leaves other tabs alone', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-newsess-'));
  const data = path.join(tmp, 'data');
  fs.mkdirSync(path.join(data, 'topics', '7'), { recursive: true });
  fs.writeFileSync(path.join(data, 'topics', '7', 'card.json'), '{}');
  const fake = path.join(tmp, 'fake-claude'); // the real claude is never run
  fs.writeFileSync(fake, '#!/bin/sh\necho "ARGS=$*"\n', { mode: 0o755 });
  const run = (id) => spawnSync('bash', [path.join(REPO, 'card-terminal.sh'), id], { env: { ...process.env, DATA_DIR: data, CLAUDE_BIN: fake, PORT: '8080' }, encoding: 'utf8' }).stdout;
  const stored = (id) => fs.readFileSync(path.join(data, '.sessions', id), 'utf8').trim();
  const { call } = boot({ dataDir: data });
  assert.match(run('main'), /--session-id [0-9a-f-]{36} This is the main workspace session/);
  const first = stored('main');
  assert.match(run('main'), new RegExp(`--resume ${first}`), 'before the reset the same session is resumed');
  run('7'); const card = stored('7');
  assert.equal((await call('POST', '/api/sessions/main/reset', {})).status, 200);
  const out = run('main');
  assert.match(out, /--session-id [0-9a-f-]{36} This is the main workspace session/, 'after the reset a new session starts');
  assert.doesNotMatch(out, /--resume/);
  assert.notEqual(stored('main'), first);
  assert.ok(fs.readdirSync(path.join(data, '.sessions', 'archive')).some((f) => fs.readFileSync(path.join(data, '.sessions', 'archive', f), 'utf8').trim() === first), 'the old id is kept');
  assert.match(run('7'), new RegExp(`--resume ${card}`), "the card's session was not touched");
});

test('live reload waits while the user has unsaved typed text, then reloads', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = src.match(/const LIVE_RELOAD = `<script>([\s\S]*?)<\/script>`;/)[1];
  const make = (fields) => {
    const handlers = {}, doc = { activeElement: null, body: { appendChild() {} }, createElement: () => ({ style: {} }), querySelectorAll: () => fields, addEventListener: (t, f) => { if (t === 'input') doc.onInput = f; } };
    const timers = []; let reloads = 0;
    const win = { __live: { on: (e, f) => { handlers[e] = f; } } }; win.parent = win;
    new Function('window', 'document', 'location', 'setInterval', 'clearInterval', code)(win, doc, { reload: () => { reloads++; } }, (f) => { timers.push(f); return timers.length; }, () => {});
    return { handlers, doc, timers, win, reloads: () => reloads };
  };
  const field = (o = {}) => ({ value: '', type: 'text', hasAttribute: (n) => !!o.auto && n === 'data-autosave', ...o });
  // nothing typed: reload at once
  let s = make([field()]); s.handlers.reload(); assert.equal(s.reloads(), 1);
  // typed text that was not posted: wait, and reload only after it is gone
  const draft = field({ value: 'half a sentence' }); s = make([draft]); s.doc.onInput({ target: draft });
  s.handlers.reload(); assert.equal(s.reloads(), 0); assert.equal(s.timers.length, 1);
  s.timers[0](); assert.equal(s.reloads(), 0, 'still typing');
  draft.value = ''; s.timers[0](); assert.equal(s.reloads(), 1, 'posted or cleared');
  // a field that saves when you leave it: waits only while it has focus
  const auto = field({ value: 'description', auto: true }); s = make([auto]); s.doc.onInput({ target: auto });
  s.doc.activeElement = auto; s.handlers.reload(); assert.equal(s.reloads(), 0, 'focused');
  s.doc.activeElement = null; s.timers[0](); assert.equal(s.reloads(), 1, 'left the field, so it was saved');
  // text that was set by the page (not typed) never blocks a reload
  s = make([field({ value: 'filled in by the page' })]); s.handlers.card(); assert.equal(s.reloads(), 1);
  // pages that refresh their own fields never reload on a card event
  s = make([field()]); s.win.__cardLive = true; s.handlers.card(); assert.equal(s.reloads(), 0);
});

test('a card description and a task update have no character limit (a long paste is stored whole)', async () => {
  const { call } = boot();
  const long = 'x'.repeat(100000); // well past the old 4000 characters and the old 16 KB request cap
  let r = await call('POST', '/api/cards', { title: 'Long', description: long });
  assert.equal(r.status, 201);
  assert.equal(r.json.description.length, 100000);
  assert.equal((await call('POST', `/api/cards/${r.json.id}`, { description: long + 'y' })).status, 200, 'editing it keeps working');
  assert.equal((await call('POST', '/api/cards', { title: 'y'.repeat(201) })).status, 400, 'the title limit stays');
  const task = (await call('POST', `/api/cards/${r.json.id}/tasks`, { title: 'T' })).json.find((x) => x.title === 'T');
  r = await call('POST', `/api/cards/${r.json.id}/tasks`, { id: task.id, update: long, by: 'me' });
  assert.equal(r.status, 200);
  assert.equal(r.json.find((x) => x.id === task.id).updates[0].text.length, 100000);
});

test('templates: the "Files changed" tab link (/changes) and a #diff fragment are accepted and stored as the canonical link', async () => {
  const gh = fakeGh({ 7: PR({ title: 'feat(entry): ABC-123: tab link' }) });
  const { call } = boot({ env: gh.env });
  for (const tail of ['/changes', '/changes#diff-9038818a3db9d36051ee2e43b2d8d2d6e3eee03adcde8ae9ebcb2ae0b3cc3ea1', '/files?w=1#diff-abc']) {
    const r = await call('POST', '/api/cards', REVIEW(LINK + tail));
    assert.deepEqual([r.status, r.json.pr], [201, LINK], tail);
  }
  assert.equal((await call('POST', '/api/cards', REVIEW(LINK + '/changes/extra'))).status, 400, 'other sub-pages are still refused');
});

test('templates: a card from the Code review template is filled in from the pull request, read-only', async () => {
  const gh = fakeGh({ 7: PR({ title: 'feat(entry): ABC-123: do $(touch pwned) `x` "quoted" thing' }), 8: PR({ title: 'chore: no key here', headRefName: 'feature/xyz-45-more', isDraft: true }), 9: PR({ title: 'fix: merged one', state: 'MERGED', headRefName: 'cleanup' }) });
  const { call, data } = boot({ env: gh.env });
  let r = await call('POST', '/api/cards', REVIEW(LINK + '/files'));
  assert.equal(r.status, 201);
  const c = r.json;
  assert.equal(c.warning, undefined);
  assert.equal(c.title, 'Code review: my-service PR 7 (do $(touch pwned) `x` "quoted" thing)');
  assert.deepEqual([c.status, c.inbox, c.ticket, c.pr], ['Code Review', true, 'ABC-123', LINK], 'default place is the Inbox; the link is stored as a canonical pr link');
  assert.match(c.description, /^Code review of my-service PR #7 \(ABC-123, "feat\(entry\): ABC-123: do \$\(touch pwned\) `x` "quoted" thing", 3 files, \+10 -2, ready for review\): https:\/\/github\.com\/example-org\/my-service\/pull\/7\n/);
  assert.match(c.description, /7\. Comments: .*Do not post anything to GitHub unless I ask\.$/);
  assert.doesNotMatch(c.description + c.title, /\{\{/, 'every blank was filled');
  assert.ok(exists(data, 'inbox', c.id, 'tabs', 'scoping.html') && exists(data, 'inbox', c.id, 'tabs', 'findings.html'), 'a normal new card: page and tabs');
  assert.equal(fs.existsSync(path.join(gh.dir, 'pwned')) || fs.existsSync(path.join(process.cwd(), 'pwned')), false, 'the title never reached a shell');
  // a draft, and a ticket taken from the branch name when the title has none
  r = await call('POST', '/api/cards', REVIEW('https://github.com/example-org/my-service/pull/8'));
  assert.deepEqual([r.json.ticket, r.json.title, /, draft\)/.test(r.json.description)], ['XYZ-45', 'Code review: my-service PR 8 (no key here)', true]);
  r = await call('POST', '/api/cards', REVIEW('https://github.com/example-org/my-service/pull/9'));
  assert.match(r.json.description, /, merged\)/);
  assert.equal(r.json.ticket, undefined, 'no ticket key anywhere: the field is left empty');
  assert.match(r.json.description, /\(no ticket, /);
  // gh was only ever asked to read, with fixed arguments
  const calls = gh.calls();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((l) => /^pr view \d+ --repo example-org\/my-service --json title,isDraft,changedFiles,additions,deletions,headRefName,state$/.test(l)), calls.join('\n'));
  assert.equal((await call('GET', '/api/cards')).json.filter((x) => x.pr).length, 3);
});

test('task progress bar: only cards built from a template that asks for it carry the flag', async () => {
  const gh = fakeGh({ 7: PR() });
  const { call, root } = boot({ env: gh.env, prepare: (r) => {
    const d = path.join(r, 'data', 'templates');
    fs.cpSync(path.join(REPO, 'examples', 'templates', 'code-review'), path.join(d, 'code-review'), { recursive: true }); // the folder exists, so nothing is seeded
    fs.mkdirSync(path.join(d, 'plain'), { recursive: true });
    fs.writeFileSync(path.join(d, 'plain', 'template.json'), JSON.stringify({ name: 'Plain', title: 'P {{pr}}', description: 'd', blanks: [{ key: 'pr', label: 'PR', kind: 'github-pr' }] }));
    fs.mkdirSync(path.join(d, 'with'), { recursive: true });
    fs.writeFileSync(path.join(d, 'with', 'template.json'), JSON.stringify({ name: 'With', title: 'W {{pr}}', description: 'd', progress: true, blanks: [{ key: 'pr', label: 'PR', kind: 'github-pr' }] }));
    fs.mkdirSync(path.join(d, 'weird'), { recursive: true });
    fs.writeFileSync(path.join(d, 'weird', 'template.json'), JSON.stringify({ name: 'Weird', title: 'x {{pr}}', description: 'd', progress: 'yes', blanks: [{ key: 'pr', label: 'PR', kind: 'github-pr' }] }));
  } });
  const shipped = JSON.parse(fs.readFileSync(path.join(REPO, 'examples', 'templates', 'code-review', 'template.json'), 'utf8'));
  assert.equal(shipped.progress, true, 'the shipped Code review template turns the progress bar on');
  const make = async (tpl) => (await call('POST', '/api/cards', { template: tpl, values: { pr: LINK } })).json;
  assert.equal((await make('code-review')).taskProgress, true);
  assert.equal((await make('with')).taskProgress, true);
  assert.equal((await make('plain')).taskProgress, undefined, 'a template without progress: no flag');
  assert.equal((await make('weird')).taskProgress, undefined, 'only a real true counts');
  assert.equal((await call('POST', '/api/cards', { title: 'Plain card' })).json.taskProgress, undefined, 'normal cards never carry it');
  const flagged = (await make('code-review')).id;
  assert.equal((await call('GET', '/api/cards')).json.find((c) => c.id === flagged).taskProgress, true);
  // switch it on or off for an existing card with a real boolean only
  assert.equal((await call('POST', '/api/cards/1', { taskProgress: true })).json.taskProgress, true);
  assert.equal((await call('POST', '/api/cards/1', { taskProgress: false })).json.taskProgress, undefined);
  for (const bad of ['yes', 1, null]) assert.equal((await call('POST', '/api/cards/1', { taskProgress: bad })).status, 400, JSON.stringify(bad));
  // the injected script knows the flag and draws the page bar; the shell itself has no progress bar
  assert.match((await call('GET', '/static/tasks.js')).body, /taskProgress/);
  assert.match((await call('GET', '/static/tasks.js')).body, /td-pagebar/);
  assert.doesNotMatch((await call('GET', '/')).body, /progress/i);
});

test('templates: defaults fill blanks the user is not asked for, from the local (gitignored) template file', async () => {
  const gh = fakeGh({ 7: PR() });
  // the shipped template: a generic skill name
  const shipped = boot({ env: gh.env });
  assert.match((await shipped.call('POST', '/api/cards', REVIEW(LINK))).json.description, /How to review \(use your code review skill\):/);
  // the local copy sets its own value; the shipped repo files never need to name it
  const local = boot({ env: gh.env, prepare: (root) => {
    const d = path.join(root, 'data', 'templates', 'mine'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'template.json'), JSON.stringify({ name: 'Mine', title: 'T {{repo}}', description: 'Use {{review_skill}} on {{pr}} ({{other}}) {{asked}}',
      blanks: [{ key: 'pr', label: 'PR', kind: 'github-pr' }, { key: 'asked', label: 'Asked', kind: 'text' }], defaults: { review_skill: 'my-team skill', asked: 'default value', 'bad key': 'x', num: 5, other_long: 'x'.repeat(201) } }));
  } });
  const r = (await local.call('POST', '/api/cards', { template: 'mine', values: { pr: LINK, asked: 'typed value' } })).json;
  assert.equal(r.description, `Use my-team skill on ${LINK} ({{other}}) typed value`, 'defaults fill blanks, a typed value wins, an unknown blank stays visible');
  assert.deepEqual(Object.keys((await local.call('GET', '/api/templates')).json[0]).sort(), ['blanks', 'id', 'name', 'place', 'status'], 'the template list does not expose defaults');
  // the committed examples never name a skill of their own
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'examples', 'templates', 'code-review', 'template.json'), 'utf8'), /code-review skill/i);
});

test('templates: extra instructions typed in the dialog are added to the description for the card session', async () => {
  const gh = fakeGh({ 7: PR(), 404: 'GraphQL: Could not resolve to a PullRequest with the number of 404.' });
  const { call } = boot({ env: gh.env });
  const base = (await call('POST', '/api/cards', REVIEW(LINK))).json.description;
  const note = 'Also look closely at the migrations\nand say if they are safe to run.';
  let r = await call('POST', '/api/cards', { ...REVIEW(LINK), instructions: `  ${note}  ` });
  assert.equal(r.status, 201);
  assert.equal(r.json.description, base + '\n\nExtra instructions (follow these as well as the steps above):\n' + note, 'the template text is unchanged and the instructions are added after it');
  for (const none of [undefined, null, '', '   ']) { // nothing typed: the description is exactly the template's
    const body = { ...REVIEW(LINK) }; if (none !== undefined) body.instructions = none;
    assert.equal((await call('POST', '/api/cards', body)).json.description, base, JSON.stringify(none));
  }
  r = await call('POST', '/api/cards', { ...REVIEW('https://github.com/example-org/my-service/pull/404'), instructions: note });
  assert.ok(r.json.warning && r.json.description.endsWith(note), 'still added when gh could not read the pull request');
  const big = (await call('POST', '/api/cards', { ...REVIEW(LINK), instructions: 'x'.repeat(1500) })).json;
  assert.ok(big.description.length <= 4000 && big.description.endsWith('x'.repeat(1500)));
  const before = (await call('GET', '/api/cards')).json.length;
  for (const bad of ['x'.repeat(1501), 5, ['a'], {}]) assert.equal((await call('POST', '/api/cards', { ...REVIEW(LINK), instructions: bad })).status, 400, JSON.stringify(bad).slice(0, 30));
  assert.equal((await call('GET', '/api/cards')).json.length, before, 'a bad request creates no card');
});

test('a new card can be filed straight in Topics with the topics flag (templates and plain cards)', async () => {
  const gh = fakeGh({ 7: PR() });
  const { call, data } = boot({ env: gh.env });
  let r = (await call('POST', '/api/cards', { ...REVIEW(LINK), topics: true })).json;
  assert.equal(r.inbox, false);
  assert.ok(exists(data, 'topics', r.id, 'card.json') && !exists(data, 'inbox', r.id), 'the folder is in topics/');
  assert.equal(r.status, 'Code Review');
  r = (await call('POST', '/api/cards', { title: 'Plain one', topics: true })).json;
  assert.ok(r.inbox === false && exists(data, 'topics', r.id, 'tabs.json'), 'a plain card too, with its tabs');
  for (const body of [REVIEW(LINK), { ...REVIEW(LINK), topics: false }, { title: 'Plain two' }, { title: 'Plain three', topics: false }]) {
    const c = (await call('POST', '/api/cards', body)).json;
    assert.ok(c.inbox === true && exists(data, 'inbox', c.id, 'card.json'), 'without the flag (or false) the card goes to the Inbox');
  }
  const before = (await call('GET', '/api/cards')).json.length;
  for (const bad of ['yes', 1, null, []]) {
    assert.equal((await call('POST', '/api/cards', { ...REVIEW(LINK), topics: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await call('POST', '/api/cards', { title: 'x', topics: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('GET', '/api/cards')).json.length, before);
});

test('templates: if gh cannot read the pull request the card is still created, with the blanks visible and a warning', async () => {
  const gh = fakeGh({ 404: 'GraphQL: Could not resolve to a PullRequest with the number of 404.', 401: 'To get started with GitHub CLI, please run:  gh auth login', 500: 'something odd happened' });
  const cases = [
    [gh.env, 404, /not found/i], [gh.env, 401, /not signed in/i], [gh.env, 500, /Could not read the pull request/],
    [{ ...gh.env, GH_BIN: path.join(gh.dir, 'no-such-gh') }, 7, /not installed/i],
  ];
  for (const [env, n, warn] of cases) {
    const { call, data } = boot({ env });
    const r = await call('POST', '/api/cards', REVIEW(`https://github.com/example-org/my-service/pull/${n}`));
    assert.equal(r.status, 201, `PR ${n}`);
    assert.match(r.json.warning, warn);
    assert.equal(r.json.pr, `https://github.com/example-org/my-service/pull/${n}`, 'the link is kept');
    assert.equal(r.json.title, `Code review: my-service PR ${n} ({{short_title}})`, 'blanks gh would have filled stay visible');
    assert.match(r.json.description, /\(\{\{ticket\}\}, "\{\{title\}\}", \{\{files\}\} files, \+\{\{added\}\} -\{\{removed\}\}, \{\{draft\}\}\)/);
    assert.ok(exists(data, 'inbox', r.json.id, 'card.json'));
  }
});

test('templates: only github.com pull request links are accepted, and nothing is created or run for a bad request', async () => {
  const gh = fakeGh({ 7: PR() });
  const { call } = boot({ env: gh.env });
  const before = (await call('GET', '/api/cards')).json.length;
  const bad = ['http://github.com/o/r/pull/7', 'https://evil.example/o/r/pull/7', 'https://github.com/o/r/issues/7', 'https://github.com/o/r/pull/abc', 'https://github.com/o/r/pull/7/../../x',
    'https://user@github.com/o/r/pull/7', 'https://github.com:8443/o/r/pull/7', 'https://github.com.evil.example/o/r/pull/7', 'https://github.com/o/r/pull/7;rm', 'javascript:alert(1)', 'not a url', ''];
  for (const link of bad) assert.equal((await call('POST', '/api/cards', REVIEW(link))).status, 400, link);
  for (const body of [{ template: 'nope', values: { pr: LINK } }, { template: '../x', values: { pr: LINK } }, { template: 5, values: {} }, { template: 'code-review' },
    { template: 'code-review', values: [] }, { template: 'code-review', values: { pr: 5 } }, { template: 'code-review', values: { pr: LINK + 'x'.repeat(600) } }]) {
    assert.equal((await call('POST', '/api/cards', body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await call('POST', '/api/cards', REVIEW(LINK), { origin: 'https://evil.example' })).status, 403, 'same write guards as every card write');
  assert.equal((await call('GET', '/api/cards')).json.length, before, 'no card was created');
  assert.deepEqual(gh.calls(), [], 'gh was never run for a bad request');
});

test('templates: a template can put its card in Topics with another status; Done, Blocked and Cancelled are not allowed', async () => {
  const gh = fakeGh({ 7: PR() });
  const make = (extra) => boot({ env: gh.env, prepare: (root) => {
    const d = path.join(root, 'data', 'templates');
    fs.mkdirSync(path.join(d, 'a'), { recursive: true }); fs.mkdirSync(path.join(d, 'b'), { recursive: true });
    const base = { title: 'T {{repo}} {{number}}', description: 'D {{pr}}', blanks: [{ key: 'pr', label: 'Pull request link', kind: 'github-pr' }] };
    fs.writeFileSync(path.join(d, 'a', 'template.json'), JSON.stringify({ name: 'A', place: 'Topics', status: 'Testing', ...base }));
    fs.writeFileSync(path.join(d, 'b', 'template.json'), JSON.stringify({ name: 'B', status: 'Done', ...base, ...extra }));
  } });
  const { call, data } = make({});
  const r = await call('POST', '/api/cards', { template: 'a', values: { pr: LINK } });
  assert.deepEqual([r.json.title, r.json.status, r.json.inbox], ['T my-service 7', 'Testing', false]);
  assert.ok(exists(data, 'topics', r.json.id, 'card.json'));
  const b = await call('POST', '/api/cards', { template: 'b', values: { pr: LINK } });
  assert.deepEqual([b.json.status, b.json.inbox], ['Pending', true], 'a status that needs a folder move or a reason falls back to Pending');
  // a text blank is just copied into the blanks
  const t = boot({ prepare: (root) => { fs.mkdirSync(path.join(root, 'data', 'templates', 'note'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'templates', 'note', 'template.json'), JSON.stringify({ name: 'Note', title: 'Note: {{what}}', description: '{{what}} {{{{what}}}} {{unknown}}', blanks: [{ key: 'what', label: 'What', kind: 'text' }] })); } });
  const n = (await t.call('POST', '/api/cards', { template: 'note', values: { what: 'a $& b' } })).json;
  assert.deepEqual([n.title, n.description], ['Note: a $& b', 'a $& b {{a $& b}} {{unknown}}'], 'one pass: values and unknown blanks are never re-expanded or treated as patterns');
});

test('Settings > Open in VS Code: runs the code command on this project folder and nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-code-'));
  const bin = path.join(dir, 'code'), log = path.join(dir, 'calls.log');
  fs.writeFileSync(bin, '#!/bin/sh\necho "$@" >> "$FAKE_CODE_LOG"\n[ -n "$FAKE_CODE_FAIL" ] && exit 1\nexit 0\n', { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const { call, root } = boot({ env: { CODE_BIN: bin, FAKE_CODE_LOG: log } });
  const real = fs.realpathSync(root);
  let r = await call('POST', '/api/open-vscode', {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.folder], [true, path.basename(root)], 'the answer names the folder, not its full path');
  assert.deepEqual(calls().map((l) => fs.realpathSync(l)), [real], 'one call, with the project folder as its only argument');
  // the request cannot change what runs
  r = await call('POST', '/api/open-vscode', { path: '/etc', folder: '/tmp', args: ['--evil'], bin: 'rm' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls().map((l) => fs.realpathSync(l)), [real, real], 'the folder and the command are fixed');
  // the same write guards as the card API
  assert.equal((await call('GET', '/api/open-vscode')).status, 405);
  assert.equal((await call('POST', '/api/open-vscode', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/open-vscode', {}, { origin: 'null' })).status, 403);
  assert.equal((await call('POST', '/api/open-vscode', {}, { 'content-type': 'text/plain' })).status, 403);
  assert.equal(calls().length, 2, 'refused requests ran nothing');
  // the command is missing, or it fails: a readable error, never a crash
  const missing = boot({ env: { CODE_BIN: path.join(dir, 'no-such-code') } });
  r = await missing.call('POST', '/api/open-vscode', {});
  assert.equal(r.status, 500);
  assert.match(r.json.error, /command was not found.*Install 'code' command in PATH.*CODE_BIN/);
  const failing = boot({ env: { CODE_BIN: bin, FAKE_CODE_LOG: log, FAKE_CODE_FAIL: '1' } });
  r = await failing.call('POST', '/api/open-vscode', {});
  assert.deepEqual([r.status, r.json.error], [500, 'VS Code did not start.']);
  // the shell has the menu item
  assert.match((await call('GET', '/')).body, /id="open-vscode"/);
});

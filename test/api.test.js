// API and storage tests: load server.js in-process with a stubbed http module (no ports) in a throwaway folder, and
// call its request handler directly. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const REPO = path.join(__dirname, '..');
const exists = (...p) => fs.existsSync(path.join(...p));

// Build a throwaway "repo" (with the real examples/ and static/), let `prepare` set up files first, then load the server.
function boot({ dataDir, prepare } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-root-'));
  fs.cpSync(path.join(REPO, 'examples'), path.join(root, 'examples'), { recursive: true });
  fs.cpSync(path.join(REPO, 'static'), path.join(root, 'static'), { recursive: true });
  for (const f of ['home.html', 'shell.html']) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  if (prepare) prepare(root);
  const env = { ...process.env };
  delete env.DATA_DIR;
  if (dataDir !== undefined) env.DATA_DIR = dataDir;
  let handler;
  const fakeHttp = { createServer: (h) => { handler = h; return { listen() {} }; } };
  // Like the real fs.watch, refuse a folder that does not exist (a server that watches before creating it must fail here).
  const watchers = [];
  const fakeFs = { ...fs, watch: (p, ...rest) => { if (!fs.existsSync(p)) throw new Error(`ENOENT: cannot watch ${p}`); watchers.push({ path: p, cb: rest.at(-1) }); return {}; } };
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
    const res = { writeHead(s) { this.status = s; }, end(b) { let json; try { json = JSON.parse(b); } catch { /* not json */ } resolve({ status: this.status, body: String(b), json }); } };
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

test('card fields: dropdowns, ticket, text', async () => {
  const { call } = boot();
  const U = '/api/cards/1';
  assert.equal((await call('POST', U, { status: 'Testing', priority: 'Urgent' })).json.status, 'Testing');
  assert.equal((await call('POST', U, { ticket: ' abc-123 ' })).json.ticket, 'ABC-123');
  assert.equal((await call('POST', U, { ticket: '' })).json.ticket, undefined);
  const t = (await call('POST', U, { title: '  New  ', description: ' d ', notes: 'a\nb ' })).json;
  assert.deepEqual([t.title, t.description, t.notes], ['New', 'd', 'a\nb ']);
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
  const { call, data, root, logs } = boot({ prepare });
  assert.ok(exists(data, 'topics', '1', 'index.html'), 'the report moved untouched');
  assert.ok(exists(data, 'inbox', '2', 'card.json'));
  assert.ok(exists(data, 'topics', 'done', '3', 'card.json'), 'a Done card lands in done/');
  const cards = (await call('GET', '/api/cards')).json;
  assert.equal(cards.length, 4);
  assert.equal(cards.find((c) => c.title === 'Same number as Idea').number, 4);
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

test('config exposes only browser-safe settings', async () => {
  const { json } = await boot().call('GET', '/api/config');
  assert.deepEqual(Object.keys(json).sort(), ['appName', 'linearBaseUrl', 'ttydPort']);
});

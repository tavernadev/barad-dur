// API tests: load server.js in-process with stubbed http/fs.watch (no ports, no real data) and call the handler.
// Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const REPO = path.join(__dirname, '..');

// Build a throwaway "repo" (with the real examples/ and static/) and an external data folder, then load the server.
function boot({ dataInRepo = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barad-root-'));
  fs.cpSync(path.join(REPO, 'examples'), path.join(root, 'examples'), { recursive: true });
  fs.cpSync(path.join(REPO, 'static'), path.join(root, 'static'), { recursive: true });
  for (const f of ['home.html', 'shell.html']) fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  const data = dataInRepo ? root : fs.mkdtempSync(path.join(os.tmpdir(), 'barad-data-'));
  const env = { ...process.env, DATA_DIR: dataInRepo ? '' : data };
  let handler;
  const fakeHttp = { createServer: (h) => { handler = h; return { listen() {} }; } };
  const fakeFs = { ...fs, watch: () => ({}) };
  const fakeProcess = new Proxy(process, { get: (t, k) => (k === 'env' ? env : k === 'loadEnvFile' ? () => { throw new Error('no .env'); } : t[k]) });
  const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  const req = (id) => (id === 'http' ? fakeHttp : id === 'fs' ? fakeFs : require(id));
  // like Module.wrap, plus a `process` parameter so each boot() gets its own environment variables
  const wrapped = vm.runInThisContext('(function (exports, require, module, __filename, __dirname, process) {' + src + '\n})');
  wrapped({}, req, { exports: {} }, path.join(root, 'server.js'), root, fakeProcess);
  const call = (method, url, body, headers = {}) => new Promise((resolve) => {
    const r = new EventEmitter();
    r.method = method; r.url = url;
    r.headers = { host: '127.0.0.1:8080', 'content-type': 'application/json', ...headers };
    const res = { writeHead(s) { this.status = s; }, end(b) { let json; try { json = JSON.parse(b); } catch { /* not json */ } resolve({ status: this.status, body: String(b), json }); } };
    handler(r, res);
    if (body !== undefined) r.emit('data', JSON.stringify(body));
    r.emit('end');
  });
  return { root, data, call };
}

test('first run seeds the example card and numbers it', async () => {
  const { call, data } = boot();
  assert.ok(fs.existsSync(path.join(data, 'cards', 'example', 'card.json')));
  const { json } = await call('GET', '/api/cards');
  assert.equal(json.length, 1);
  assert.equal(json[0].number, 1);
});

test('DATA_DIR keeps cards outside the repo folder', async () => {
  const { call, root, data } = boot({ dataInRepo: false });
  await call('POST', '/api/cards', { title: 'Outside' });
  assert.ok(fs.readdirSync(path.join(data, 'cards')).some((d) => d.endsWith('outside')));
  assert.ok(!fs.existsSync(path.join(root, 'cards')), 'nothing is written into the repo folder');
});

test('inbox cards: create, number, validate', async () => {
  const { call } = boot();
  const a = await call('POST', '/api/cards', { title: '  First  ', description: 'd' });
  const b = await call('POST', '/api/cards', { title: 'First' });
  assert.equal(a.status, 201);
  assert.equal(a.json.title, 'First');
  assert.equal(a.json.inbox, true);
  assert.ok(b.json.number > a.json.number, 'numbers only go up');
  assert.notEqual(a.json.id, b.json.id, 'same title gets a distinct folder');
  assert.equal((await call('POST', '/api/cards', { title: ' ' })).status, 400);
  assert.equal((await call('POST', '/api/cards', { title: 'x'.repeat(201) })).status, 400);
});

test('card fields: dropdowns, ticket, inbox, text', async () => {
  const { call } = boot();
  const U = '/api/cards/example';
  assert.equal((await call('POST', U, { status: 'Testing', priority: 'Urgent' })).json.status, 'Testing');
  assert.equal((await call('POST', U, { ticket: ' abc-123 ' })).json.ticket, 'ABC-123');
  assert.equal((await call('POST', U, { ticket: '' })).json.ticket, undefined);
  assert.equal((await call('POST', U, { inbox: true })).json.inbox, true);
  const t = (await call('POST', U, { title: '  New  ', description: ' d ', notes: 'a\nb ' })).json;
  assert.deepEqual([t.title, t.description, t.notes], ['New', 'd', 'a\nb ']);
  for (const bad of [{ status: 'Nope' }, { priority: 'Nope' }, { inbox: 'yes' }, { ticket: 'not a key' }, { title: ' ' }, { notes: 5 }, { nope: 1 }]) {
    assert.equal((await call('POST', U, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('POST', '/api/cards/missing', { status: 'Done' })).status, 404);
});

test('tasks: add, update, log, reorder, remove', async () => {
  const { call } = boot();
  const T = '/api/cards/example/tasks';
  const before = (await call('GET', T)).json.length;
  const added = (await call('POST', T, { title: '  Third  ', priority: 'High' })).json;
  assert.equal(added.length, before + 1);
  const mine = added[added.length - 1];
  assert.deepEqual([mine.title, mine.status, mine.priority], ['Third', 'Pending', 'High']);
  let list = (await call('POST', T, { id: mine.id, status: 'Done', title: 'Renamed' })).json;
  assert.deepEqual([list.at(-1).status, list.at(-1).title], ['Done', 'Renamed']);
  list = (await call('POST', T, { id: mine.id, update: 'checked logs', by: 'claude' })).json;
  assert.deepEqual([list.at(-1).updates[0].by, !!list.at(-1).updates[0].at], ['claude', true]);
  assert.equal((await call('POST', T, { id: mine.id, update: 'hi' })).json.at(-1).updates[1].by, 'me', 'default author is me');
  list = (await call('POST', T, { id: mine.id, move: 'up' })).json;
  assert.equal(list.at(-2).id, mine.id);
  assert.deepEqual(list.map((t) => t.order), list.map((_, i) => i + 1));
  list = (await call('POST', T, { id: mine.id, remove: true })).json;
  assert.equal(list.length, before);
  for (const bad of [{ title: ' ' }, { id: 'zzz', status: 'Done' }, { id: 't1', status: 'Nope' }, { id: 't1', update: ' ' }]) {
    assert.ok([400, 404].includes((await call('POST', T, bad)).status), JSON.stringify(bad));
  }
});

test('tasks.json written by hand is normalized (legacy text, missing ids, order)', async () => {
  const { call, data } = boot();
  fs.writeFileSync(path.join(data, 'cards', 'example', 'tasks.json'),
    JSON.stringify([{ text: 'legacy', done: true }, { id: 'x', title: 'second', order: 1, status: 'Testing', updates: [{ text: 'edit' }] }, { nope: 1 }]));
  const list = (await call('GET', '/api/cards/example/tasks')).json;
  // ties on `order` keep file order; items without a usable shape are dropped; order is renumbered 1..n
  assert.deepEqual(list.map((t) => [t.order, t.title, t.status]), [[1, 'legacy', 'Done'], [2, 'second', 'Testing']]);
  assert.equal(list[1].updates[0].by, 'claude');
});

test('write guards: JSON only, same origin', async () => {
  const { call } = boot();
  assert.equal((await call('POST', '/api/cards', { title: 'a' }, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await call('POST', '/api/cards', { title: 'a' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/cards/example/tasks', { title: 'a' }, { origin: 'http://evil.example' })).status, 403);
});

test('pages: reports get the shared channel and TODO column; the shell gets neither', async () => {
  const { call } = boot();
  const report = (await call('GET', '/content/example/')).body;
  assert.match(report, /static\/live\.js/);
  assert.match(report, /static\/tasks\.js/);
  const shell = (await call('GET', '/')).body;
  assert.doesNotMatch(shell, /live\.js|tasks\.js|EventSource/, 'the shell hosts the terminal and must never auto-reload');
  assert.equal((await call('GET', '/card/example')).status, 200);
});

test('files stay inside their folders', async () => {
  const { call } = boot();
  for (const url of ['/static/..%2fserver.js', '/content/example/..%2f..%2fserver.js', '/content/..%2f/x', '/content/example/../../server.js']) {
    const r = await call('GET', url);
    assert.ok(r.status === 403 || r.status === 404, `${url} -> ${r.status}`);
    assert.doesNotMatch(r.body, /createServer/, 'server source must never be served');
  }
});

test('config exposes only browser-safe settings', async () => {
  const { json } = await boot().call('GET', '/api/config');
  assert.deepEqual(Object.keys(json).sort(), ['appName', 'linearBaseUrl', 'ttydPort']);
});

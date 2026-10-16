// TODO column injected by the server into every card's report page (cards/<id>/index.html).
// A task belongs to the card and has an order, title, status, priority and a log of updates.
// Tasks live in cards/<id>/tasks.json; the card's own Claude session and you both write to them.
// Clicking a task opens its detail as a card layered over the report (same page, not a popup/dialog).
(function () {
  // Inside the shell, the permanent header's logo and app name go home, so remove the page's own link back to "/" (and its nav bar
  // when nothing else is left in it). Hand-written reports keep their other nav links.
  if (window.parent !== window) {
    document.querySelectorAll('nav a[href="/"]').forEach(function (a) {
      var nav = a.closest('nav'); a.remove();
      if (nav && !nav.children.length) nav.remove();
    });
  }
  var id = (location.pathname.match(/^\/content\/([^/]+)\//) || [])[1];
  if (!id) return;
  var API = '/api/cards/' + encodeURIComponent(id) + '/tasks';
  var DEFAULT_W = 360, MIN_W = 240, KEY = 'workspace.tasksCollapsed', WKEY = 'workspace.tasksWidthPx';
  var STATUS = ['Pending', 'Scoping', 'In Progress', 'Code Review', 'Testing', 'Done', 'Cancelled'];
  var PRIORITY = ['Low', 'Medium', 'High', 'Urgent'];
  var tasks = [], openId = null, built = false;

  // ---------- styles ----------
  var css = document.createElement('style');
  css.textContent = [
    'body.tasks-open { margin-right:var(--tw,' + DEFAULT_W + 'px); }',
    '#tasks-col, #task-card { font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; color:var(--fg,#1f2328); box-sizing:border-box; }',
    '#tasks-col *, #task-card * { box-sizing:border-box; }',
    '#tasks-col { position:fixed; top:0; right:0; bottom:0; width:var(--tw,' + DEFAULT_W + 'px); z-index:20; overflow:auto; padding:16px; background:var(--card,#f6f8fa); border-left:1px solid var(--line,#d1d9e0); }',
    '#tasks-col h2 { all:unset; display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:700; letter-spacing:.08em; margin-bottom:12px; }',
    '#tasks-col .count, .muted { color:var(--muted,#59636e); font-weight:600; letter-spacing:0; }',
    '#tasks-col .err { color:#f85149; font-size:12px; margin-bottom:8px; }',
    '#tasks-col ul { list-style:none; margin:0 0 12px; padding:0; display:flex; flex-direction:column; gap:6px; }',
    '#tasks-col li { display:grid; grid-template-columns:auto 1fr; gap:2px 8px; background:var(--bg,#fff); border:1px solid var(--line,#d1d9e0); border-radius:8px; padding:8px 10px; cursor:pointer; }',
    '#tasks-col li:hover, #tasks-col li.sel { border-color:var(--accent,#0969da); }',
    '#tasks-col li:focus-visible { outline:2px solid var(--accent,#0969da); }',
    '#tasks-col .n { color:var(--muted,#59636e); font-weight:700; }',
    '#tasks-col .t { overflow-wrap:anywhere; font-weight:600; }',
    '#tasks-col li.done .t { color:var(--muted,#59636e); text-decoration:line-through; }',
    '#tasks-col .chips { grid-column:2; display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:12px; }',
    '#tasks-col .empty { color:var(--muted,#59636e); font-size:13px; margin-bottom:12px; }',
    '#tasks-col form input { width:100%; font:inherit; color:inherit; background:var(--bg,#fff); border:1px solid var(--line,#d1d9e0); border-radius:8px; padding:6px 10px; }',
    /* resize gutter on the column's left edge (same idea as the terminal split) + middle collapse/expand button */
    '#tasks-gutter { position:fixed; top:0; bottom:0; right:var(--tw,' + DEFAULT_W + 'px); width:8px; margin-right:-4px; z-index:22; cursor:col-resize; touch-action:none; background:transparent; transition:background .15s; }',
    '#tasks-gutter:hover, body.tasks-dragging #tasks-gutter { background:var(--accent,#0969da); }',
    'body.tasks-dragging { cursor:col-resize; user-select:none; }',
    '#tasks-collapse { position:fixed; top:50%; right:var(--tw,' + DEFAULT_W + 'px); transform:translate(50%,-50%); z-index:23; width:22px; height:48px; padding:0; font:inherit; font-size:16px; line-height:1; cursor:pointer;',
    '  color:var(--fg,#1f2328); background:var(--card,#f6f8fa); border:1px solid var(--line,#d1d9e0); border-radius:999px; }',
    '#tasks-collapse:hover { border-color:var(--accent,#0969da); color:var(--accent,#0969da); }',
    'body:not(.tasks-open) #tasks-collapse { right:0; transform:translate(0,-50%); border-right:0; border-radius:999px 0 0 999px; }',
    'body:not(.tasks-open) #tasks-gutter { display:none; }',
    'body:not(.tasks-open) #tasks-col { display:none; }',

    /* status / priority colors: --c is the hue, tinted background keeps it readable in light and dark */
    '.tk-chip, #task-card select { --c:#8b949e; font:inherit; font-weight:600; background:color-mix(in srgb, var(--c) 16%, var(--bg,#fff)); color:color-mix(in srgb, var(--c) 70%, var(--fg,#1f2328)); border:1px solid color-mix(in srgb, var(--c) 55%, var(--line,#d1d9e0)); border-radius:999px; }',
    '.tk-chip { padding:0 9px; font-size:12px; }',
    '[data-value="Pending"] { --c:#8b949e; } [data-value="Scoping"] { --c:#a371f7; } [data-value="In Progress"] { --c:#4493f8; }',
    '[data-value="Code Review"] { --c:#d29922; } [data-value="Testing"] { --c:#f0883e; } [data-value="Done"] { --c:#3fb950; } [data-value="Cancelled"] { --c:#6e7681; }',
    '[data-value="Low"] { --c:#3fb950; } [data-value="Medium"] { --c:#d29922; } [data-value="High"] { --c:#f0883e; } [data-value="Urgent"] { --c:#f85149; }',

    /* the task card: layered over the report, left of the column; not modal, the page stays usable */
    '#task-card { position:fixed; z-index:30; top:16px; right:' + 16 + 'px; width:min(620px, calc(100vw - 32px)); max-height:calc(100vh - 32px); overflow:auto; display:flex; flex-direction:column; gap:12px; padding:16px;',
    '  background:var(--bg,#fff); border:1px solid var(--accent,#0969da); border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,.35); }',
    'body.tasks-open #task-card { right:calc(var(--tw,' + DEFAULT_W + 'px) + 16px); width:min(620px, calc(100vw - var(--tw,' + DEFAULT_W + 'px) - 32px)); }',
    '#task-card[hidden] { display:none; }',
    '#task-card header { display:flex; justify-content:space-between; align-items:center; }',
    '#task-card .x { border:0; background:none; color:var(--muted,#59636e); font-size:22px; line-height:1; cursor:pointer; }',
    '#task-card .x:hover { color:var(--fg,#1f2328); }',
    '#task-card .ttl { width:100%; font:inherit; font-size:18px; font-weight:700; color:inherit; background:var(--card,#f6f8fa); border:1px solid var(--line,#d1d9e0); border-radius:8px; padding:6px 10px; }',
    '#task-card .props { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; }',
    '#task-card label { display:flex; flex-direction:column; gap:2px; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted,#59636e); }',
    '#task-card select { padding:3px 10px; cursor:pointer; text-transform:none; letter-spacing:0; font-size:14px; }',
    '#task-card .mv { display:flex; gap:6px; margin-left:auto; }',
    '#task-card button.sm { font:inherit; color:inherit; background:var(--card,#f6f8fa); border:1px solid var(--line,#d1d9e0); border-radius:8px; padding:3px 10px; cursor:pointer; }',
    '#task-card button.sm:hover { border-color:var(--accent,#0969da); }',
    '#task-card h3 { all:unset; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted,#59636e); }',
    '#task-card .ups { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; max-height:40vh; overflow:auto; }',
    '#task-card .ups li { background:var(--card,#f6f8fa); border:1px solid var(--line,#d1d9e0); border-radius:8px; padding:8px 10px; }',
    '#task-card .ups .by { font-size:12px; font-weight:700; margin-right:6px; }',
    '#task-card .ups .by.claude { color:var(--accent,#0969da); }',
    '#task-card .ups .at { font-size:12px; color:var(--muted,#59636e); }',
    '#task-card .ups .tx { white-space:pre-wrap; overflow-wrap:anywhere; margin-top:2px; }',
    '#task-card .upin { width:100%; min-height:80px; resize:vertical; font:inherit; color:inherit; background:var(--card,#f6f8fa); border:1px solid var(--line,#d1d9e0); border-radius:8px; padding:8px 10px; }',
    '#task-card .foot { display:flex; justify-content:space-between; align-items:center; gap:8px; }',
    '#task-card .post { background:var(--accent,#0969da) !important; border-color:var(--accent,#0969da) !important; color:#fff !important; font-weight:700; }',
    '#task-card .del:hover { border-color:#f85149 !important; color:#f85149; }',
    '#task-card :focus-visible, #tasks-col form input:focus-visible { outline:2px solid var(--accent,#0969da); }',
    /* narrow pane: the column drops below the report and the task card spans the width */
    '@media (max-width:899px) {',
    '  body.tasks-open { margin-right:0; }',
    '  #tasks-col { position:static; width:auto; border-left:0; border-top:1px solid var(--line,#d1d9e0); }',
    '  #tasks-gutter { display:none; }',
    '  #tasks-collapse, body:not(.tasks-open) #tasks-collapse { top:auto; bottom:12px; right:8px; transform:none; width:44px; height:28px; border:1px solid var(--line,#d1d9e0); border-radius:999px; }',
    '  #task-card, body.tasks-open #task-card { left:8px; right:8px; top:8px; width:auto; }',
    '}'
  ].join('\n');
  document.head.appendChild(css);

  // ---------- column ----------
  var col = document.createElement('aside');
  col.id = 'tasks-col';
  col.setAttribute('aria-label', 'TODO');
  col.innerHTML = '<h2><span>TODO</span><span class="count"></span></h2><div class="err" hidden></div>' +
    '<div class="empty" hidden>No tasks yet. This card\'s Claude session adds them here as it works.</div><ul></ul>' +
    '<form autocomplete="off"><input placeholder="Add a task" maxlength="300" aria-label="Add a task"></form>';
  var gutter = document.createElement('div');
  gutter.id = 'tasks-gutter'; gutter.setAttribute('role', 'separator'); gutter.setAttribute('aria-orientation', 'vertical');
  gutter.title = 'Drag to resize, double-click to reset';
  var collapseBtn = document.createElement('button');
  collapseBtn.id = 'tasks-collapse'; collapseBtn.type = 'button';
  var card = document.createElement('section');
  card.id = 'task-card'; card.hidden = true; card.setAttribute('aria-label', 'Task');
  document.body.append(col, gutter, collapseBtn, card);

  var ul = col.querySelector('ul'), empty = col.querySelector('.empty'), count = col.querySelector('.count'), err = col.querySelector('.err');
  var setOpen = function (open) {
    document.body.classList.toggle('tasks-open', open);
    collapseBtn.textContent = open ? '\u203a' : '\u2039';
    collapseBtn.title = open ? 'Collapse TODO' : 'Expand TODO';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
    collapseBtn.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(KEY, open ? '' : '1'); } catch (_) {}
  };
  var collapsed = false;
  try { collapsed = !!localStorage.getItem(KEY); } catch (_) {}
  setOpen(!collapsed);
  collapseBtn.addEventListener('click', function () { setOpen(!document.body.classList.contains('tasks-open')); });

  // Resizable like the terminal split: drag the gutter; width is remembered.
  var clampW = function (px) { return Math.round(Math.min(Math.max(MIN_W, window.innerWidth * 0.7), Math.max(MIN_W, px))); };
  var applyW = function (px) { document.documentElement.style.setProperty('--tw', clampW(px) + 'px'); };
  var savedW = DEFAULT_W;
  try { savedW = parseFloat(localStorage.getItem(WKEY)) || DEFAULT_W; } catch (_) {}
  applyW(savedW);
  window.addEventListener('resize', function () { applyW(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tw')) || DEFAULT_W); });
  var dragging = false;
  gutter.addEventListener('pointerdown', function (e) { dragging = true; gutter.setPointerCapture(e.pointerId); document.body.classList.add('tasks-dragging'); });
  gutter.addEventListener('pointermove', function (e) { if (dragging) applyW(window.innerWidth - e.clientX); });
  var stopDrag = function () {
    if (!dragging) return;
    dragging = false; document.body.classList.remove('tasks-dragging');
    try { localStorage.setItem(WKEY, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tw'))); } catch (_) {}
  };
  gutter.addEventListener('pointerup', stopDrag);
  gutter.addEventListener('pointercancel', stopDrag);
  gutter.addEventListener('dblclick', function () { applyW(DEFAULT_W); try { localStorage.setItem(WKEY, DEFAULT_W); } catch (_) {} });

  // ---------- api ----------
  var flashTimer;
  function flash(msg) {
    err.textContent = msg; err.hidden = !msg;
    clearTimeout(flashTimer);
    if (msg) flashTimer = setTimeout(function () { flash(''); }, 4000);
  }
  function post(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(render)
      .catch(function () { flash('Could not save, reloading'); load(); });
  }
  function load() {
    return fetch(API).then(function (r) { return r.json(); }).then(render).catch(function () {});
  }

  // ---------- list ----------
  function chip(text) {
    var s = document.createElement('span');
    s.className = 'tk-chip'; s.textContent = text; s.dataset.value = text;
    return s;
  }
  function renderList() {
    ul.textContent = '';
    tasks.forEach(function (t) {
      var li = document.createElement('li');
      li.tabIndex = 0; li.setAttribute('role', 'button'); li.dataset.id = t.id;
      if (t.status === 'Done' || t.status === 'Cancelled') li.className = 'done'; // crossed out; the progress count below counts only Done
      if (t.id === openId) li.classList.add('sel');
      var n = document.createElement('span'); n.className = 'n'; n.textContent = '#' + (t.number || t.order); // the permanent task number, not the position
      var title = document.createElement('span'); title.className = 't'; title.textContent = t.title;
      var chips = document.createElement('span'); chips.className = 'chips';
      chips.appendChild(chip(t.status));
      if (t.priority) chips.appendChild(chip(t.priority));
      if (t.updates.length) {
        var u = document.createElement('span'); u.className = 'muted';
        u.textContent = t.updates.length + (t.updates.length === 1 ? ' update' : ' updates');
        chips.appendChild(u);
      }
      li.append(n, title, chips);
      var open = function () { openId === t.id ? closeCard() : openTask(t.id); };
      li.addEventListener('click', open);
      li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      ul.appendChild(li);
    });
    var done = tasks.filter(function (t) { return t.status === 'Done'; }).length;
    count.textContent = tasks.length ? done + '/' + tasks.length : '';
    empty.hidden = tasks.length > 0;
  }

  function render(list) {
    tasks = list;
    renderList();
    if (openId) {
      var t = find(openId);
      if (t) updateCard(t); else closeCard();
    }
  }
  var find = function (tid) { return tasks.filter(function (t) { return t.id === tid; })[0]; };

  col.querySelector('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = e.target.querySelector('input'), title = input.value.trim();
    if (!title) return;
    input.value = '';
    post({ title: title });
  });

  // ---------- task card (layered over the report) ----------
  var ref = {};
  function buildCard() {
    card.innerHTML =
      '<header><strong class="ct"></strong><button type="button" class="x" aria-label="Close" title="Close (Esc)">×</button></header>' +
      '<input class="ttl" maxlength="300" aria-label="Title">' +
      '<div class="props">' +
      '<label>Status<select data-k="status"></select></label>' +
      '<label>Priority<select data-k="priority"></select></label>' +
      '<span class="mv"><button type="button" class="sm" data-mv="up" title="Move up">↑</button><button type="button" class="sm" data-mv="down" title="Move down">↓</button></span>' +
      '</div>' +
      '<h3>Updates</h3><ul class="ups"></ul>' +
      '<textarea class="upin" maxlength="4000" placeholder="Write an update on this task (Cmd/Ctrl+Enter to post)" aria-label="Write an update"></textarea>' +
      '<div class="foot"><button type="button" class="sm del">Delete task</button><button type="button" class="sm post">Post update</button></div>';
    ['ct', 'ttl', 'ups', 'upin', 'del', 'post'].forEach(function (k) { ref[k] = card.querySelector('.' + k); });
    ref.status = card.querySelector('[data-k=status]');
    ref.priority = card.querySelector('[data-k=priority]');
    STATUS.forEach(function (v) { ref.status.add(new Option(v, v)); });
    var ph = new Option('Not set', ''); ph.disabled = true; ref.priority.add(ph);
    PRIORITY.forEach(function (v) { ref.priority.add(new Option(v, v)); });

    card.querySelector('.x').addEventListener('click', closeCard);
    ref.ttl.addEventListener('change', function () {
      var v = ref.ttl.value.trim(), t = find(openId);
      if (v && t && v !== t.title) post({ id: openId, title: v }); else if (t) ref.ttl.value = t.title;
    });
    ref.ttl.addEventListener('keydown', function (e) { if (e.key === 'Enter') ref.ttl.blur(); });
    [ref.status, ref.priority].forEach(function (sel) {
      sel.addEventListener('change', function () {
        sel.dataset.value = sel.value;
        var b = { id: openId }; b[sel.dataset.k] = sel.value; post(b);
      });
    });
    card.querySelectorAll('[data-mv]').forEach(function (b) {
      b.addEventListener('click', function () { post({ id: openId, move: b.dataset.mv }); });
    });
    var send = function () {
      var text = ref.upin.value.trim();
      if (!text) return;
      ref.upin.value = '';
      post({ id: openId, update: text, by: 'me' });
    };
    ref.post.addEventListener('click', send);
    ref.upin.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
    var delTimer;
    ref.del.addEventListener('click', function () { // two-step delete, no confirm dialog
      if (ref.del.dataset.armed) { clearTimeout(delTimer); post({ id: openId, remove: true }); return; }
      ref.del.dataset.armed = '1'; ref.del.textContent = 'Click again to delete';
      delTimer = setTimeout(function () { delete ref.del.dataset.armed; ref.del.textContent = 'Delete task'; }, 3000);
    });
    built = true;
  }

  function fmt(at) {
    var d = new Date(at);
    return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function updateCard(t) {
    ref.ct.textContent = 'Task #' + (t.number || t.order) + ' \u00b7 position ' + t.order + ' of ' + tasks.length;
    if (document.activeElement !== ref.ttl) ref.ttl.value = t.title;
    ref.status.value = t.status; ref.status.dataset.value = t.status;
    ref.priority.value = t.priority; ref.priority.dataset.value = t.priority;
    card.querySelector('[data-mv=up]').disabled = t.order === 1;
    card.querySelector('[data-mv=down]').disabled = t.order === tasks.length;
    var prev = ref.ups.children.length;
    ref.ups.textContent = '';
    if (!t.updates.length) {
      var none = document.createElement('li'); none.className = 'muted'; none.textContent = 'No updates yet.';
      ref.ups.appendChild(none);
    }
    t.updates.forEach(function (u) {
      var li = document.createElement('li');
      var by = document.createElement('span'); by.className = 'by ' + u.by; by.textContent = u.by === 'claude' ? 'Claude' : 'Me';
      var at = document.createElement('span'); at.className = 'at'; at.textContent = fmt(u.at);
      var tx = document.createElement('div'); tx.className = 'tx'; tx.textContent = u.text;
      li.append(by, at, tx);
      ref.ups.appendChild(li);
    });
    if (t.updates.length > prev) ref.ups.scrollTop = ref.ups.scrollHeight;
  }

  function openTask(tid) {
    if (!built) buildCard();
    openId = tid;
    card.hidden = false;
    updateCard(find(tid));
    renderList();
  }
  function closeCard() {
    openId = null;
    card.hidden = true;
    renderList();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openId) closeCard(); });

  // Edits made to tasks.json by the card's Claude session show up here without reloading the page.
  window.__live.on('tasks', function (d) { if (d === id) load(); });
  fetch('/api/options').then(function (r) { return r.json(); }).then(function (o) {
    STATUS = o.status || STATUS; PRIORITY = o.priority || PRIORITY;
  }).catch(function () {}).then(load);
})();

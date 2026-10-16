// Blocked and Cancelled statuses, shared by the main page and every card page (the server injects it into card reports).
// Choosing either in any status dropdown opens a popup that asks for the reason; the reason is saved with the status
// (card.json "blockedReason" / "cancelledReason") and shown as a banner on the card page. Leaving the status clears it on the server.
(function () {
  var REASON = {
    Blocked: { field: 'blockedReason', title: 'Why is this blocked?', hint: 'For example: waiting for a decision, an answer, or access. The reason is shown on the card.', button: 'Mark as Blocked', color: '#db61a2' },
    Cancelled: { field: 'cancelledReason', title: 'Why is this cancelled?', hint: 'For example: no longer needed, replaced by another ticket, or decided against. The reason is shown on the card.', button: 'Mark as Cancelled', color: '#8b949e' }
  };
  var css = document.createElement('style');
  css.textContent = [
    'select[data-value="Blocked"] { --c:#db61a2; } select[data-value="Cancelled"] { --c:#6e7681; }',
    '.blk-overlay { position:fixed; inset:0; background:rgba(1,4,9,.6); display:flex; align-items:center; justify-content:center; z-index:2147483000; }',
    '.blk-dialog { width:min(440px,92vw); background:var(--card,#161b22); color:var(--fg,#e6edf3); border:1px solid var(--line,#3d444d); border-radius:12px; padding:18px; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; box-shadow:0 12px 40px rgba(0,0,0,.5); }',
    '.blk-dialog h3 { margin:0 0 4px; font-size:16px; }',
    '.blk-dialog p { margin:0 0 10px; color:var(--muted,#8b949e); font-size:13px; }',
    '.blk-dialog textarea { width:100%; min-height:90px; resize:vertical; box-sizing:border-box; font:inherit; color:inherit; background:var(--bg,#0d1117); border:1px solid var(--line,#3d444d); border-radius:8px; padding:8px; }',
    '.blk-dialog .blk-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }',
    '.blk-dialog button { font:inherit; color:inherit; background:none; border:1px solid var(--line,#3d444d); border-radius:8px; padding:5px 14px; cursor:pointer; }',
    '.blk-dialog button.blk-ok { background:var(--blk,#db61a2); border-color:var(--blk,#db61a2); color:#fff; font-weight:600; }',
    '.blk-dialog button.blk-ok:disabled { opacity:.45; cursor:default; }',
    '.blk-banner { --blk:#db61a2; margin:0 0 14px; padding:10px 14px; border:1px solid var(--blk); border-left-width:4px; border-radius:8px; background:color-mix(in srgb, var(--blk) 14%, transparent); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; white-space:pre-wrap; }',
    '.blk-banner b { display:block; font-size:12px; letter-spacing:.05em; text-transform:uppercase; color:var(--blk); }'
  ].join('\n');
  document.head.appendChild(css);

  // Ask for the reason. Resolves to the trimmed text, or null when cancelled.
  function ask(status, current) {
    var R = REASON[status];
    return new Promise(function (resolve) {
      var o = document.createElement('div');
      o.className = 'blk-overlay';
      o.innerHTML = '<div class="blk-dialog" role="dialog" aria-modal="true" aria-label="' + R.title + '"><h3>' + R.title + '</h3>' +
        '<p>' + R.hint + '</p>' +
        '<textarea maxlength="1000" placeholder="Reason"></textarea>' +
        '<div class="blk-actions"><button type="button" class="blk-cancel">Cancel</button><button type="button" class="blk-ok" disabled>' + R.button + '</button></div></div>';
      var ta = o.querySelector('textarea'), ok = o.querySelector('.blk-ok');
      o.style.setProperty('--blk', R.color);
      ta.value = current || '';
      function done(v) { o.remove(); resolve(v); }
      function sync() { ok.disabled = !ta.value.trim(); }
      ta.addEventListener('input', sync);
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') done(null);
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ta.value.trim()) done(ta.value.trim());
      });
      o.querySelector('.blk-cancel').addEventListener('click', function () { done(null); });
      ok.addEventListener('click', function () { done(ta.value.trim()); });
      o.addEventListener('mousedown', function (e) { if (e.target === o) done(null); });
      document.body.appendChild(o);
      sync(); ta.focus();
    });
  }
  window.__blocked = { ask: ask };

  // Capture phase, so this runs before a page's own change handler (which would save the status without a reason).
  document.addEventListener('change', function (e) {
    var sel = e.target;
    if (!sel || sel.tagName !== 'SELECT' || sel.dataset.field !== 'status' || !REASON[sel.value]) return;
    var status = sel.value, R = REASON[status];
    var card = sel.closest('[data-id]');
    var id = card ? card.dataset.id : (location.pathname.match(/^\/content\/([^/]+)\//) || [])[1];
    if (!id) return;
    e.stopImmediatePropagation();
    var before = sel.dataset.value || '';
    ask(status, '').then(function (reason) {
      if (!reason) { sel.value = before; return; }
      sel.disabled = true;
      return fetch('/api/cards/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ status: status }, (function () { var b = {}; b[R.field] = reason; return b; })())) })
        .then(function (r) { if (!r.ok) throw new Error(r.status); sel.dataset.value = status; })
        .catch(function () { alert('Could not save'); sel.value = before; })
        .then(function () { sel.disabled = false; });
    });
  }, true);

  // Card pages: a banner with the reason, kept fresh through the shared live connection.
  var id = (location.pathname.match(/^\/content\/([^/]+)\//) || [])[1];
  if (!id) return;
  var banner = document.createElement('div');
  function render() {
    fetch('/api/cards').then(function (r) { return r.json(); }).then(function (list) {
      var c = list.filter(function (x) { return x.id === id; })[0];
      var R = c && REASON[c.status];
      if (!R) { banner.remove(); return; }
      banner.className = 'blk-banner';
      banner.style.setProperty('--blk', R.color);
      banner.innerHTML = '<b>' + c.status + '</b>';
      banner.appendChild(document.createTextNode(c[R.field] || 'No reason given.'));
      if (!banner.parentNode) document.body.insertBefore(banner, document.body.firstChild);
    }).catch(function () {});
  }
  render();
  if (window.__live) window.__live.on('card', function (d) { if (d === id) render(); });
})();

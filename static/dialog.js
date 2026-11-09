// The app's own dialogs, used instead of the browser's alert / confirm / prompt boxes. Shared by the shell, the main page and the card pages.
//   baradDialog.confirm({ title, who, quote: { title, text, meta }, items: [text], confirmText, cancelText, tone })  -> Promise<boolean>
//   baradDialog.notice({ title, items: [text], okText })                                                      -> Promise<void>
//   baradDialog.prompt({ title, message, value, placeholder, confirmText, maxLength })                        -> Promise<string | null>
// All text is set with textContent, so a title or label that came from somewhere else can never inject markup.
// Escape or a click outside cancels; Tab stays inside the dialog; focus goes back to what opened it. One dialog at a time.
(function () {
  if (window.baradDialog) return;
  var css = document.createElement('style');
  css.textContent = [
    '.bd-overlay { position:fixed; inset:0; z-index:2147483200; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(1,4,9,.62); animation:bd-fade .12s ease-out; }',
    '@keyframes bd-fade { from { opacity:0; } to { opacity:1; } }',
    '@media (prefers-reduced-motion: reduce) { .bd-overlay { animation:none; } }',
    '.bd-dlg { width:min(460px,100%); max-height:calc(100vh - 32px); overflow:auto; box-sizing:border-box; padding:20px 22px 18px; background:var(--card,#161b22); color:var(--fg,#e6edf3); border:1px solid var(--line,#3d444d); border-radius:14px; box-shadow:0 16px 48px rgba(1,4,9,.55); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }',
    '.bd-dlg h3 { margin:0; font-size:17px; font-weight:600; line-height:1.3; }',
    '.bd-who { display:inline-block; margin:8px 0 0; padding:1px 10px; border-radius:999px; border:1px solid var(--accent,#4493f8); color:var(--accent,#4493f8); font-size:12px; font-weight:600; }',
    '.bd-msg { margin:10px 0 0; color:var(--muted,#9198a1); font-size:13px; }',
    '.bd-quote { margin:14px 0 0; padding:8px 12px; border-left:3px solid var(--accent,#4493f8); border-radius:6px; background:color-mix(in srgb, var(--accent,#4493f8) 10%, transparent); }',
    '.bd-quote .t { display:block; font-weight:600; overflow-wrap:anywhere; }',
    '.bd-quote .x { display:block; margin-top:4px; overflow-wrap:anywhere; }',
    '.bd-quote .m { display:block; margin-top:2px; color:var(--muted,#9198a1); font-size:12px; }',
    '.bd-items { margin:14px 0 0; padding:0; list-style:none; }',
    '.bd-items li { display:flex; gap:10px; margin:0 0 7px; }',
    '.bd-items li::before { content:""; flex:none; width:6px; height:6px; margin-top:8px; border-radius:50%; background:var(--muted,#9198a1); }',
    '.bd-input { display:block; width:100%; box-sizing:border-box; margin:12px 0 0; padding:8px 10px; font:inherit; color:inherit; background:var(--bg,#0d1117); border:1px solid var(--line,#3d444d); border-radius:8px; }',
    '.bd-input:focus-visible { outline:2px solid var(--accent,#4493f8); outline-offset:1px; }',
    '.bd-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }',
    '.bd-actions button { font:inherit; color:inherit; background:none; border:1px solid var(--line,#3d444d); border-radius:8px; padding:6px 16px; cursor:pointer; }',
    '.bd-actions button:hover { background:color-mix(in srgb, var(--fg,#e6edf3) 8%, transparent); }',
    '.bd-actions button:focus-visible { outline:2px solid var(--accent,#4493f8); outline-offset:2px; }',
    '.bd-actions button.bd-ok { background:#1f6feb; border-color:#1f6feb; color:#fff; font-weight:600; }',
    '.bd-actions button.bd-ok:hover { background:#388bfd; border-color:#388bfd; }',
    '.bd-actions button.bd-ok.danger { background:#da3633; border-color:#da3633; }',
    '.bd-actions button.bd-ok.danger:hover { background:#f85149; border-color:#f85149; }'
  ].join('\n');
  document.head.appendChild(css);

  var busy = false, seq = 0;
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // kind: 'confirm' | 'notice' | 'prompt'. cancelValue is what Escape or a click outside resolves to.
  function show(kind, o) {
    o = o || {};
    var cancelValue = kind === 'prompt' ? null : kind === 'confirm' ? false : undefined;
    return new Promise(function (resolve) {
      if (busy) { resolve(cancelValue); return; } // one dialog at a time
      busy = true;
      var opener = document.activeElement;
      var id = 'bd-title-' + (++seq);
      var overlay = el('div', 'bd-overlay');
      var dlg = el('div', 'bd-dlg');
      dlg.setAttribute('role', kind === 'notice' ? 'alertdialog' : 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-labelledby', id);
      var h = el('h3', null, o.title || ''); h.id = id; dlg.appendChild(h);
      if (o.who) dlg.appendChild(el('span', 'bd-who', o.who));
      if (o.message) dlg.appendChild(el('p', 'bd-msg', o.message));
      if (o.quote) {
        var q = el('div', 'bd-quote');
        q.appendChild(el('span', 't', o.quote.title || ''));
        if (o.quote.text) q.appendChild(el('span', 'x', o.quote.text));
        if (o.quote.meta) q.appendChild(el('span', 'm', o.quote.meta));
        dlg.appendChild(q);
      }
      if (o.items && o.items.length) {
        var ul = el('ul', 'bd-items');
        o.items.forEach(function (t) { ul.appendChild(el('li', null, t)); });
        dlg.appendChild(ul);
      }
      var input = null;
      if (kind === 'prompt') {
        input = el('input', 'bd-input');
        input.type = 'text'; input.value = o.value || ''; input.placeholder = o.placeholder || ''; input.maxLength = o.maxLength || 500;
        input.setAttribute('aria-labelledby', id);
        dlg.appendChild(input);
      }
      var actions = el('div', 'bd-actions');
      var cancel = null;
      if (kind !== 'notice') { cancel = el('button', null, o.cancelText || 'Cancel'); cancel.type = 'button'; actions.appendChild(cancel); }
      var ok = el('button', 'bd-ok' + (o.tone === 'danger' ? ' danger' : ''), o.confirmText || o.okText || (kind === 'prompt' ? 'Save' : 'OK'));
      ok.type = 'button'; actions.appendChild(ok);
      dlg.appendChild(actions);
      overlay.appendChild(dlg);

      function close(value) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        busy = false;
        try { if (opener && opener.focus && document.contains(opener)) opener.focus(); } catch (e) { /* the opener is gone */ }
        resolve(value);
      }
      var accept = function () { close(kind === 'prompt' ? input.value.trim() : kind === 'confirm' ? true : undefined); };
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelValue); return; }
        if (e.key === 'Enter' && input && e.target === input) { e.preventDefault(); accept(); return; }
        if (e.key !== 'Tab') return;
        var f = Array.prototype.slice.call(dlg.querySelectorAll('input, button')); // stay inside the dialog
        if (!f.length) return;
        var i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
      }
      ok.addEventListener('click', accept);
      if (cancel) cancel.addEventListener('click', function () { close(cancelValue); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(cancelValue); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      var first = input || ok;
      first.focus();
      if (input) input.select();
    });
  }

  window.baradDialog = {
    confirm: function (o) { return show('confirm', o); },
    notice: function (o) { return show('notice', o); },
    prompt: function (o) { return show('prompt', o); }
  };
})();

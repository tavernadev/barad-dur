// Generated card pages (Inbox items): status/priority dropdowns plus an editable title, description and
// notes. Everything lives in card.json; fields save automatically when you leave them (blur).
(function () {
  var id = (location.pathname.match(/^\/content\/([^/]+)\//) || [])[1];
  var selects = document.querySelectorAll('select[data-field]');
  if (!id) { selects.forEach(function (s) { s.disabled = true; }); return; }
  window.__cardLive = true; // this page refreshes itself from card.json, so the live-reload snippet must not reload it
  var API = '/api/cards/' + encodeURIComponent(id);
  var inputs = {}, last = {}, card = {};

  // ---------- helpers ----------
  var toast = document.createElement('div');
  toast.className = 'toast';
  document.body.appendChild(toast);
  var toastTimer;
  function say(msg, bad) {
    toast.textContent = msg; toast.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.className = 'toast'; }, 1400);
  }
  function save(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (c) { card = c; say('Saved'); return c; })
      .catch(function () { say('Could not save', true); });
  }
  function grow(el) { if (el.tagName === 'TEXTAREA') { el.style.height = 'auto'; el.style.height = el.scrollHeight + 4 + 'px'; } }

  // ---------- editable text fields ----------
  function bind(name, el) {
    inputs[name] = el;
    el.classList.add('edit');
    el.addEventListener('input', function () { grow(el); });
    el.addEventListener('blur', function () {
      var v = name === 'notes' ? el.value : el.value.trim();
      if (v === (last[name] || '')) return;
      if (name === 'title' && !v) { el.value = last.title || ''; return; } // a card needs a title
      last[name] = v;
      save((function () { var b = {}; b[name] = v; return b; })()).then(function (c) { if (c && name === 'title') document.title = c.title; });
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { el.value = last[name] || ''; grow(el); el.blur(); }
      else if (e.key === 'Enter' && (name === 'title' || e.metaKey || e.ctrlKey)) { e.preventDefault(); el.blur(); }
    });
  }

  function buildFields(c) {
    var h1 = document.querySelector('h1');
    if (h1) {
      h1.textContent = '';
      if (c.number) { var n = document.createElement('span'); n.className = 'muted'; n.textContent = '#' + c.number; h1.appendChild(n); }
      var t = document.createElement('input');
      t.maxLength = 200; t.setAttribute('aria-label', 'Title'); t.className = 'edit-title';
      h1.appendChild(t); bind('title', t);
    }
    var desc = document.querySelector('p.desc');
    if (desc) {
      var d = document.createElement('textarea');
      d.maxLength = 4000; d.placeholder = 'Add a description'; d.setAttribute('aria-label', 'Description');
      desc.replaceWith(d); bind('description', d);
    }
    var notesH = Array.prototype.filter.call(document.querySelectorAll('h2'), function (h) { return h.textContent.trim() === 'Notes'; })[0];
    var notesP = notesH && notesH.nextElementSibling;
    if (notesP) {
      var n2 = document.createElement('textarea');
      n2.maxLength = 20000; n2.placeholder = 'Working notes for this card go here'; n2.setAttribute('aria-label', 'Notes');
      n2.className = 'notes'; notesP.replaceWith(n2); bind('notes', n2);
    }
  }

  // ---------- Linear ticket (optional; the main page shows and sets it the same way) ----------
  var linearBase = '', ticketBox = null;
  function buildTicket() {
    var meta = document.querySelector('.meta');
    if (!meta || ticketBox) return;
    ticketBox = document.createElement('div');
    ticketBox.innerHTML = '<b>Ticket</b><span class="tk-slot"></span>';
    meta.appendChild(ticketBox);
  }
  // Inline editor shared by the "+ Linear ticket" chip and the pencil: Enter or leaving the field saves, Escape cancels.
  // On a card that has a ticket, saving an empty field removes it; on one without, empty just cancels.
  function editTicket(slot, current) {
    var input = document.createElement('input');
    input.className = 'tk-input'; input.placeholder = 'ABC-123'; input.maxLength = 30; input.value = current || '';
    input.setAttribute('aria-label', 'Linear ticket key');
    slot.textContent = ''; slot.appendChild(input); input.focus(); input.select();
    var done = false;
    var finish = function (commit) {
      if (done) return; done = true;
      var v = input.value.trim();
      slot.textContent = '';
      if (!commit || v === (current || '')) { renderTicket(card); return; }
      save({ ticket: v }).then(function (c2) {
        if (c2) renderTicket(c2); else { say('Not a valid ticket key (like ABC-123)', true); renderTicket(card); }
      });
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', function () { finish(true); });
  }
  function renderTicket(c) {
    if (!ticketBox) return;
    var slot = ticketBox.querySelector('.tk-slot');
    if (slot.querySelector('input')) return; // being edited: leave it alone
    slot.textContent = '';
    if (c.ticket) { // set: the link, and a pencil to change or clear it
      var el = document.createElement(linearBase ? 'a' : 'span');
      el.className = 'ticket'; el.textContent = c.ticket;
      if (linearBase) { el.href = linearBase + encodeURIComponent(c.ticket); el.target = '_blank'; el.rel = 'noopener'; el.title = 'Open in Linear'; }
      var pencil = document.createElement('button');
      pencil.type = 'button'; pencil.className = 'tk-edit'; pencil.textContent = '\u270e';
      pencil.title = 'Change ticket (empty removes it)'; pencil.setAttribute('aria-label', 'Change ticket');
      pencil.addEventListener('click', function () { editTicket(slot, c.ticket); });
      slot.appendChild(el); slot.appendChild(pencil);
      return;
    }
    var btn = document.createElement('button'); // not set: the same "+ Linear ticket" chip as the main page
    btn.type = 'button'; btn.className = 'tk'; btn.textContent = '+ Linear ticket';
    btn.addEventListener('click', function () { editTicket(slot, ''); });
    slot.appendChild(btn);
  }

  // ---------- dropdowns ----------
  function buildSelects(options) {
    selects.forEach(function (sel) {
      var field = sel.dataset.field, values = options[field] || [];
      var ph = new Option('Not set', ''); ph.disabled = true; sel.add(ph);
      values.forEach(function (v) { sel.add(new Option(v, v)); });
      sel.addEventListener('change', function () {
        sel.dataset.value = sel.value;
        var b = {}; b[field] = sel.value;
        sel.disabled = true;
        save(b).finally(function () { sel.disabled = false; });
      });
    });
  }

  // ---------- state from card.json ----------
  function apply(c) {
    card = c;
    document.title = c.title || document.title;
    ['title', 'description', 'notes'].forEach(function (name) {
      var el = inputs[name];
      if (!el) return;
      last[name] = c[name] || '';
      if (document.activeElement !== el) { el.value = last[name]; grow(el); }
    });
    renderTicket(c);
    selects.forEach(function (sel) {
      if (document.activeElement === sel) return;
      var v = c[sel.dataset.field];
      sel.value = Array.prototype.some.call(sel.options, function (o) { return o.value === v && v; }) ? v : '';
      sel.dataset.value = sel.value;
    });
  }
  function refresh() {
    return fetch('/api/cards').then(function (r) { return r.json(); }).then(function (cards) {
      var c = cards.filter(function (x) { return x.id === id; })[0];
      if (c) apply(c);
    }).catch(function () {});
  }

  Promise.all([fetch('/api/options').then(function (r) { return r.json(); }), fetch('/api/cards').then(function (r) { return r.json(); }),
               fetch('/api/config').then(function (r) { return r.json(); }).catch(function () { return {}; })])
    .then(function (res) {
      var c = res[1].filter(function (x) { return x.id === id; })[0] || {};
      linearBase = res[2].linearBaseUrl || '';
      buildTicket();
      buildSelects(res[0]);
      buildFields(c);
      apply(c);
    });

  // Other writers (the card's Claude session, the grid dropdowns) change card.json: refresh in place, no reload.
  window.__live.on('card', function (d) { if (d === id) refresh(); });
})();

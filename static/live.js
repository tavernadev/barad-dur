// One live-update channel per browser, shared by every tab and iframe (SharedWorker).
// Browsers allow only ~6 connections per host; one EventSource per script per tab used them all up and
// left requests (saving, page loads) queued forever. Falls back to a single EventSource per page.
(function () {
  if (window.__live) return;
  var handlers = {}, EVENTS = ['reload', 'card', 'tasks'];
  function dispatch(ev, data) { (handlers[ev] || []).forEach(function (f) { try { f(data); } catch (_) {} }); }
  window.__live = { on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); } };
  if (window.SharedWorker) {
    try {
      var w = new SharedWorker('/static/live-worker.js');
      w.port.onmessage = function (e) { dispatch(e.data.event, e.data.data); };
      w.port.start();
      return;
    } catch (_) { /* fall through */ }
  }
  var es = new EventSource('/events');
  EVENTS.forEach(function (ev) { es.addEventListener(ev, function (e) { dispatch(ev, e.data); }); });
})();

// Shared worker: owns the single /events stream and fans every event out to all connected pages.
var ports = [], es = null, EVENTS = ['reload', 'card', 'tasks', 'tabs'];
function start() {
  es = new EventSource('/events');
  EVENTS.forEach(function (ev) {
    es.addEventListener(ev, function (e) {
      ports = ports.filter(function (p) {
        try { p.postMessage({ event: ev, data: e.data }); return true; } catch (_) { return false; }
      });
    });
  });
}
onconnect = function (e) {
  ports.push(e.ports[0]);
  e.ports[0].start();
  if (!es) start();
};

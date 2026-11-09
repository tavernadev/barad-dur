// Ticket links, shared by the main page and every card page (the server injects it into card pages).
// A card's "ticket" is either a link (ClickUp, Linear, Jira, Trello, GitHub, Asana, Shortcut or anything else) or a bare
// key such as ABC-123, which is linked through LINEAR_BASE_URL when that is set. ticketInfo() works out the label from the link.
(function () {
  var KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
  function seg(path, i) { try { return decodeURIComponent(path.split('/').filter(Boolean)[i] || ''); } catch (e) { return ''; } }
  function last(path) { var p = path.split('/').filter(Boolean); try { return decodeURIComponent(p[p.length - 1] || ''); } catch (e) { return ''; } }
  function from(url) {
    var h = url.hostname.toLowerCase().replace(/^www\./, ''), p = url.pathname, m;
    if (h === 'clickup.com' || /\.clickup\.com$/.test(h)) { // https://app.clickup.com/t/<workspace>/<task id>
      var i = p.split('/').filter(Boolean).indexOf('t');
      return { provider: 'ClickUp', id: i === -1 ? '' : last(p) };
    }
    if (h === 'linear.app') return { provider: 'Linear', id: (m = p.match(/\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/)) ? m[1].toUpperCase() : '' };
    if (/\.atlassian\.net$/.test(h) || /(^|\.)jira\./.test(h)) {
      m = p.match(/\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)/) || (url.search || '').match(/selectedIssue=([A-Za-z][A-Za-z0-9]*-\d+)/);
      return { provider: 'Jira', id: m ? m[1].toUpperCase() : '' };
    }
    if (h === 'trello.com') return { provider: 'Trello', id: (m = p.match(/^\/c\/([A-Za-z0-9]+)/)) ? m[1] : '' };
    if (h === 'github.com') return { provider: 'GitHub', id: (m = p.match(/^\/[^/]+\/([^/]+)\/(?:issues|pull)\/(\d+)/)) ? m[1] + '#' + m[2] : '' };
    if (h === 'app.asana.com') { var nums = p.split('/').filter(function (x) { return /^\d+$/.test(x); }); return { provider: 'Asana', id: nums[nums.length - 1] || '' }; }
    if (h === 'app.shortcut.com') return { provider: 'Shortcut', id: (m = p.match(/\/story\/(\d+)/)) ? m[1] : '' };
    return { provider: h, id: last(p).length <= 24 ? last(p) : '' }; // anything else: the site's name
  }
  // Returns null for no ticket, else { label, href, title }. href is empty when the value cannot be linked.
  window.ticketInfo = function (value, linearBase) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) {
      var url; try { url = new URL(v); } catch (e) { return { label: v, href: '', title: '' }; }
      var f = from(url);
      return { label: f.provider + (f.id ? ' ' + f.id : ''), href: url.href, title: 'Open in ' + f.provider };
    }
    if (KEY.test(v)) {
      var k = v.toUpperCase();
      return { label: k, href: linearBase ? linearBase + encodeURIComponent(k) : '', title: linearBase ? 'Open in Linear' : '' };
    }
    return { label: v, href: '', title: '' };
  };
})();

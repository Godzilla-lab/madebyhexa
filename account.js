/* Account library page. Depends on window.HexaAuth (auth.js). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LIST_URL = '/.netlify/functions/account-creations';

  function firstName(name) {
    if (!name) return null;
    if (name.indexOf('@') !== -1) return name.split('@')[0];
    return name.split(' ')[0];
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function cardHtml(c) {
    var completed = c.status === 'completed' && c.result_urls && c.result_urls.length;
    var thumb = c.thumb_url || (c.result_urls && c.result_urls[0]) || '';
    var isVideo = c.type === 'video';
    var href = c.job_ids && c.job_ids.length
      ? '/render.html?jobs=' + encodeURIComponent(c.job_ids.join(','))
      : (completed ? c.result_urls[0] : '#');
    var badge = isVideo ? 'Film' : 'Photos';
    var title = c.title || (isVideo ? 'Your film' : 'Your photoshoot');
    var meta = (completed ? '' : (c.status === 'failed' ? 'Did not finish · ' : 'Rendering · ')) + fmtDate(c.created_at);

    var thumbInner;
    if (!completed) {
      thumbInner = '<span class="cr-pending-dot">' + (c.status === 'failed' ? 'Retry in studio' : 'Rendering') + '</span>';
    } else if (thumb && /\.(mp4|webm|mov)(\?|$)/i.test(thumb)) {
      thumbInner = '<video src="' + escapeHtml(thumb) + '#t=0.1" muted playsinline preload="metadata"></video>';
    } else if (thumb) {
      thumbInner = '<img src="' + escapeHtml(thumb) + '" alt="" loading="lazy" />';
    } else {
      thumbInner = '';
    }

    return '<a class="cr-card ' + (completed ? '' : 'pending') + '" href="' + escapeHtml(href) + '">' +
      '<div class="cr-thumb">' + thumbInner + '<span class="cr-badge">' + badge + '</span></div>' +
      '<div class="cr-body"><p class="cr-name">' + escapeHtml(title) + '</p>' +
      '<p class="cr-meta">' + escapeHtml(meta) + '</p></div></a>';
  }

  function render(creations) {
    $('acct-loading').hidden = true;
    if (!creations.length) { $('acct-empty').hidden = false; return; }
    var grid = $('acct-grid');
    grid.innerHTML = creations.map(cardHtml).join('');
    grid.hidden = false;
  }

  function loadLibrary() {
    var token = window.HexaAuth.accessToken();
    fetch(LIST_URL, { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) { render(d.creations || []); })
      .catch(function () {
        $('acct-loading').textContent = 'Could not load your library. Refresh to try again.';
      });
  }

  window.HexaAuth.ready().then(function () {
    var user = window.HexaAuth.user();
    if (!user) { window.HexaAuth.requireAuth('/account.html'); return; }

    var fn = firstName(window.HexaAuth.name());
    $('acct-greeting').textContent = fn ? 'Everything you have made, ' + fn : 'Everything you have made';
    $('acct-user').textContent = window.HexaAuth.email() || '';
    loadLibrary();
  });

  $('acct-signout').addEventListener('click', function () {
    window.HexaAuth.signOut().then(function () { location.href = '/'; });
  });
})();

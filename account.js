/* Account library page. Depends on window.HexaAuth (auth.js). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LIST_URL = '/.netlify/functions/account-creations';
  // Fresh signup lands here with ?welcome=1: show the onboarding panel
  // instead of a bare empty library.
  var WELCOME = new URLSearchParams(location.search).get('welcome') === '1';

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
    if (!creations.length) {
      if (WELCOME) {
        var fn = firstName(window.HexaAuth.name());
        if (fn) $('welcome-title').textContent = 'You are in, ' + fn + ". Let's make your first film.";
        $('acct-head').hidden = true;
        $('acct-welcome').hidden = false;
      } else {
        $('acct-empty').hidden = false;
      }
      return;
    }
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

  /* ── Tabs ── */

  function initTabs() {
    var tabL = $('tab-library');
    var tabS = $('tab-settings');
    function show(which) {
      var lib = which === 'library';
      $('panel-library').hidden = !lib;
      $('acct-settings').hidden = lib;
      tabL.classList.toggle('is-active', lib);
      tabS.classList.toggle('is-active', !lib);
      tabL.setAttribute('aria-selected', String(lib));
      tabS.setAttribute('aria-selected', String(!lib));
      if (!lib) location.hash = 'settings';
      else if (location.hash === '#settings') history.replaceState(null, '', location.pathname + location.search);
    }
    tabL.addEventListener('click', function () { show('library'); });
    tabS.addEventListener('click', function () { show('settings'); });
    // Deep link: /account.html#settings (privacy page points here)
    if (location.hash === '#settings') show('settings');
  }

  /* ── Settings ── */

  function note(id, msg, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'acct-note' + (kind ? ' is-' + kind : '');
  }

  function initSettings() {
    $('set-name').value = window.HexaAuth.name() || '';
    $('set-email').value = window.HexaAuth.email() || '';

    $('set-profile-save').addEventListener('click', function () {
      var name = $('set-name').value.trim();
      var email = $('set-email').value.trim();
      var oldEmail = window.HexaAuth.email() || '';
      note('set-profile-note', 'Saving…');
      var work = [];
      if (name && name !== (window.HexaAuth.name() || '')) work.push(window.HexaAuth.updateName(name));
      var emailChanged = email && email.toLowerCase() !== oldEmail.toLowerCase();
      if (emailChanged) work.push(window.HexaAuth.updateEmail(email));
      if (!work.length) { note('set-profile-note', 'Nothing to save.'); return; }
      Promise.all(work).then(function (results) {
        var err = results.map(function (r) { return r && r.error; }).filter(Boolean)[0];
        if (err) { note('set-profile-note', err.message || 'Could not save.', 'err'); return; }
        note('set-profile-note', emailChanged
          ? 'Saved. Check ' + email + ' for a confirmation link to finish the email change.'
          : 'Saved.', 'ok');
      }).catch(function () { note('set-profile-note', 'Could not save. Try again.', 'err'); });
    });

    $('set-pass-save').addEventListener('click', function () {
      var p1 = $('set-pass').value, p2 = $('set-pass2').value;
      if (p1.length < 8) { note('set-security-note', 'Password needs at least 8 characters.', 'err'); return; }
      if (p1 !== p2) { note('set-security-note', 'The two passwords do not match.', 'err'); return; }
      note('set-security-note', 'Changing…');
      window.HexaAuth.updatePassword(p1).then(function (r) {
        if (r && r.error) {
          var m = /Password should contain/i.test(r.error.message || '')
            ? 'Make it stronger: at least one lowercase letter, one capital letter and one number.'
            : (r.error.message || 'Could not change password.');
          note('set-security-note', m, 'err');
          return;
        }
        $('set-pass').value = ''; $('set-pass2').value = '';
        note('set-security-note', 'Password changed.', 'ok');
      }).catch(function () { note('set-security-note', 'Could not change password. Try again.', 'err'); });
    });

    $('set-signout-all').addEventListener('click', function () {
      note('set-security-note', 'Signing out everywhere…');
      window.HexaAuth.signOutEverywhere().then(function () { location.href = '/login.html'; });
    });

    $('set-export').addEventListener('click', function () {
      note('set-export-note', 'Preparing your export…');
      fetch('/.netlify/functions/account-export', {
        headers: { Authorization: 'Bearer ' + window.HexaAuth.accessToken() },
      })
        .then(function (r) { if (!r.ok) throw new Error('export failed'); return r.blob(); })
        .then(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'hexa-account-export.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
          note('set-export-note', 'Downloaded.', 'ok');
        })
        .catch(function () { note('set-export-note', 'Export failed. Try again.', 'err'); });
    });

    var delInput = $('set-del-confirm');
    var delBtn = $('set-delete');
    delInput.addEventListener('input', function () {
      var match = delInput.value.trim().toLowerCase() === (window.HexaAuth.email() || '').toLowerCase();
      delBtn.disabled = !match;
    });
    delBtn.addEventListener('click', function () {
      delBtn.disabled = true;
      note('set-delete-note', 'Deleting your account…');
      fetch('/.netlify/functions/account-delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + window.HexaAuth.accessToken(),
        },
        body: JSON.stringify({ confirm: delInput.value.trim() }),
      })
        .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
        .then(function () {
          note('set-delete-note', 'Account deleted. Goodbye.', 'ok');
          window.HexaAuth.signOut().finally(function () { location.href = '/'; });
        })
        .catch(function (d) {
          delBtn.disabled = false;
          note('set-delete-note', (d && d.error) || 'Deletion failed. Try again.', 'err');
        });
    });
  }

  window.HexaAuth.ready().then(function () {
    var user = window.HexaAuth.user();
    if (!user) { window.HexaAuth.requireAuth('/account.html'); return; }

    var fn = firstName(window.HexaAuth.name());
    $('acct-greeting').textContent = fn ? 'Everything you have made, ' + fn : 'Everything you have made';
    $('acct-user').textContent = window.HexaAuth.email() || '';
    loadLibrary();
    initTabs();
    initSettings();
  });

  $('acct-signout').addEventListener('click', function () {
    window.HexaAuth.signOut().then(function () { location.href = '/'; });
  });
})();

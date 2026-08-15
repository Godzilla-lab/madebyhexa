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
    // an email prefix is not a name; the greeting reads better without one
    if (name.indexOf('@') !== -1) return null;
    var fn = name.trim().split(/\s+/)[0];
    if (!fn) return null;
    return fn.charAt(0).toUpperCase() + fn.slice(1);
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

  /* Post-render actions on a finished video.
   *
   * The price is NOT written here. It used to be, under a comment claiming it
   * mirrored catalog/pricing.json; measured 2026-08-15 the chips said $4/$9/$4
   * while the server charged $3/$7/$3. A number typed in a second place drifts
   * from the one that decides the charge, which is the same failure the home
   * page had with "+$12". It now comes from catalog/credit-packs.json, which
   * tools/build-credit-packs.mjs generates from pricing.json.
   *
   * Until that lands the chip shows the label alone. A missing price is a
   * smaller lie than a wrong one, and the server reprices at checkout either
   * way, so nobody is ever charged what a stale label said. */
  var ACTIONS = [
    { product: 'action:revoice', key: 'revoice', label: 'New voice', price: '', pick: 'voice' },
    { product: 'action:translate', key: 'translate', label: 'Translate', price: '', pick: 'language' },
    { product: 'action:upscale', key: 'upscale', label: 'Upscale', price: '', pick: null },
  ];

  /* Fetched once on load, not lazily with the pack chooser: the action chips
   * are drawn with every finished card, long before anyone opens top-up. */
  function loadActionPrices() {
    return fetch('/catalog/credit-packs.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var usd = (d && d.action_usd) || {};
        ACTIONS.forEach(function (a) {
          if (typeof usd[a.key] === 'number') a.price = '$' + usd[a.key];
        });
      })
      .catch(function () { /* labels stay priceless; checkout still prices it */ });
  }
  /* Higgsfield preset voice roster (ids verified via the platform 2026-07-09). */
  var VOICES = [
    ['f32c8f51-449e-4ddf-bdf7-1527e11df917', 'Tallulah'], ['7e63ac18-5fcd-4aba-8078-a86d4e11c127', 'Roman'],
    ['fa64fba4-ad02-405e-99d0-1f085d87c706', 'Mabel'], ['dc382508-c8bd-443c-8cb2-46e57b8d2e6f', 'Sterling'],
    ['80914268-dfae-4f76-8306-36f2d55f58f8', 'Quinn'], ['73a45c18-0c56-4642-a61e-f6b303f8ded1', 'Leo'],
    ['530df032-c311-483b-a750-cb3c9e1bcdfd', 'Gia'], ['95429266-c0ac-4137-a209-63b8812b0f23', 'Julian'],
    ['c3204739-4084-41a3-9dc5-c805b307ec18', 'Vesper'], ['f1e8226e-2248-4d5f-b43c-0a79e9949dbf', 'Andre'],
    ['f6448975-768e-4327-b932-1b7c973d58e9', 'Roxie'], ['c2acff45-84b2-4974-892d-89fa2d4e5598', 'Brooks'],
    ['e0d40568-8c85-4c9b-bdb2-b638b253a24f', 'Tasha'], ['30fc8796-ceb6-4a66-b3a7-4a145ef7f346', 'Arthur'],
    ['c25f78a0-714e-42af-8da3-a399cef94968', 'Hana'], ['1fb253b8-928b-4d29-a349-f242a71eaddf', 'Skye'],
    ['b0f766b7-8703-4bd1-b973-f857c36837b6', 'Maya'], ['573e5163-59b3-4926-aab1-951ef2985f81', 'Harrison'],
    ['3811e986-0891-47cf-a1f5-78a1d62a547a', 'Imogen'], ['b57b22a0-f287-405b-bc82-6f08f5e6bb1f', 'Sloane'],
    ['9ddbff06-a984-4c0d-b641-4d8ca846bf60', 'Zane'], ['e9cfbbf0-4476-46be-b396-596eb774b165', 'Chloe'],
    ['43173c95-3ec8-446a-a162-6504332c578b', 'Xavier'], ['ca83ca7f-c186-493d-bd69-0d765fa861b2', 'Elena'],
    ['41023a48-71ab-478a-bea7-c7b5a78f6b36', 'Sienna'], ['7888649a-b139-4295-a57b-4e103079d817', 'Hugo'],
    ['d0374db1-44b9-4f05-939e-0a9ae9dbbe6a', 'Zoe'], ['47fb207f-63fe-449e-915b-27b3d8098fd1', 'Harper'],
    ['375a3398-e3b4-4f91-845d-42181e352899', 'Luna'], ['4af0ac8b-b5ad-4d12-8f6b-c48b9c369f87', 'Ava'],
    ['80924413-1ea8-4e64-9719-e00b86796f05', 'Isabella'], ['d081b915-6623-4a44-bacf-80d0f1c90a03', 'Nora'],
  ];
  var LANGUAGES = [
    ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'],
    ['por', 'Portuguese'], ['pol', 'Polish'], ['swe', 'Swedish'], ['fin', 'Finnish'],
    ['rus', 'Russian'], ['tur', 'Turkish'], ['ara', 'Arabic'], ['hin', 'Hindi'],
    ['cmn', 'Mandarin'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['ind', 'Indonesian'],
    ['fil', 'Filipino'], ['eng', 'English'],
  ];

  function cardHtml(c, i) {
    var completed = c.status === 'completed' && c.result_urls && c.result_urls.length;
    var thumb = c.thumb_url || (c.result_urls && c.result_urls[0]) || '';
    var isVideo = c.type === 'video';
    var href = c.job_ids && c.job_ids.length
      ? '/render.html?jobs=' + encodeURIComponent(c.job_ids.join(','))
      : (completed ? c.result_urls[0] : '#');
    var badge = isVideo ? 'Video' : 'Photos';
    var title = c.title || (isVideo ? 'Your ad' : 'Your photoshoot');
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

    var actions = '';
    if (completed && isVideo) {
      actions = '<div class="cr-actions" data-idx="' + i + '">' + ACTIONS.map(function (a) {
        return '<button type="button" class="cr-act" data-product="' + a.product + '">' +
          a.label + (a.price ? ' <em>' + a.price + '</em>' : '') + '</button>';
      }).join('') + '</div>';
    }

    return '<div class="cr-card ' + (completed ? '' : 'pending') + '">' +
      '<a class="cr-link" href="' + escapeHtml(href) + '">' +
      '<div class="cr-thumb">' + thumbInner + '<span class="cr-badge">' + badge + '</span></div>' +
      '<div class="cr-body"><p class="cr-name">' + escapeHtml(title) + '</p>' +
      '<p class="cr-meta">' + escapeHtml(meta) + '</p></div></a>' +
      actions + '</div>';
  }

  /* Action chip -> (optional picker) -> Stripe checkout. The server verifies
   * ownership of the source film and reprices; this only shapes the order. */
  function startAction(creation, product, extra) {
    var sel = {
      creationId: creation.id,
      clipIndex: 0,
      productName: creation.title || '',
    };
    if (extra) { for (var k in extra) sel[k] = extra[k]; }
    var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.HexaAuth.accessToken() };
    fetch('/.netlify/functions/create-checkout', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ order: { product: product, title: 'Film touch-up', selections: sel } }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (d && d.url) { location.href = d.url; return; }
        return Promise.reject(d);
      })
      .catch(function (d) { alert((d && d.error) || 'Could not start checkout. Please try again.'); });
  }

  function showPicker(row, creation, action) {
    var list = action.pick === 'voice' ? VOICES : LANGUAGES;
    var pick = document.createElement('div');
    pick.className = 'cr-pick';
    var select = document.createElement('select');
    list.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v[0];
      o.textContent = v[1];
      select.appendChild(o);
    });
    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = action.price ? 'Go ' + action.price : 'Go';
    go.addEventListener('click', function () {
      go.disabled = true;
      go.textContent = 'Opening checkout…';
      var extra = action.pick === 'voice' ? { voiceId: select.value } : { language: select.value };
      startAction(creation, action.product, extra);
    });
    pick.appendChild(select);
    pick.appendChild(go);
    row.replaceWith(pick);
  }

  function initActions(creations) {
    var grid = $('acct-grid');
    grid.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.cr-act') : null;
      if (!btn) return;
      e.preventDefault();
      var row = btn.parentElement;
      var creation = creations[parseInt(row.getAttribute('data-idx'), 10)];
      if (!creation) return;
      var action = null;
      ACTIONS.forEach(function (a) { if (a.product === btn.getAttribute('data-product')) action = a; });
      if (!action) return;
      if (!action.pick) {
        btn.disabled = true;
        btn.textContent = 'Opening checkout…';
        startAction(creation, action.product, null);
        return;
      }
      showPicker(row, creation, action);
    });
  }

  function render(creations) {
    $('acct-loading').hidden = true;
    if (!creations.length) {
      if (WELCOME) {
        var fn = firstName(window.HexaAuth.name());
        if (fn) $('welcome-title').textContent = 'You are in, ' + fn + ". Let's make your first ad.";
        $('acct-head').hidden = true;
        $('acct-welcome').hidden = false;
        // One path only: while onboarding, the checklist CTA is the way in.
        // The nav button and tabs return once they own a creation.
        document.body.classList.add('acct-onboarding');
      } else {
        $('acct-empty').hidden = false;
      }
      return;
    }
    var grid = $('acct-grid');
    grid.innerHTML = creations.map(cardHtml).join('');
    grid.hidden = false;
    initActions(creations);
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

  /* ── Credits ───────────────────────────────────────────────────
   *
   * Balance, statement and top-up. All three read through functions that are
   * SECURITY INVOKER and filter on auth.uid(), so the browser is only ever able
   * to see its own rows: there is no account id in any of these calls to
   * tamper with.
   * ───────────────────────────────────────────────────────────── */

  var CREDITS_PER_DOLLAR = 500;

  /* What the balance can actually buy, which is the only thing that makes a
   * five figure number meaningful. Each divisor is a real catalogue price at
   * 500 credits to the dollar: adsingle $1, a deep read 1,000 (matches
   * DEEP_REPORT_CREDITS in report-create.js), cheapest video ad $9.
   *
   * The video divisor was 7,000, a price no product has had for some time. A
   * balance of 7,000 to 7,499 promised a video the customer could not order.
   * Anything here that drifts from catalog/pricing.json overclaims to someone
   * who has already paid us, so check it when prices move. */
  function creditsMeaning(balance) {
    if (balance <= 0) return 'Top up to make your next ad.';
    var ads = Math.floor(balance / 500);
    var videos = Math.floor(balance / 4500);
    var reads = Math.floor(balance / 1000);
    var parts = [];
    if (ads) parts.push(ads.toLocaleString() + (ads === 1 ? ' ad creative' : ' ad creatives'));
    if (reads) parts.push(reads.toLocaleString() + (reads === 1 ? ' market read' : ' market reads'));
    if (videos) parts.push(videos.toLocaleString() + (videos === 1 ? ' video ad' : ' video ads'));
    return parts.length ? 'Enough for ' + parts.join(', or ') + '.' : 'Top up to make your next ad.';
  }

  var LEDGER_LABEL = {
    grant: 'Welcome credits',
    purchase: 'Credits purchased',
    spend: 'Spent',
    refund: 'Refunded, not delivered',
    adjust: 'Adjustment',
  };

  function renderLedger(rows) {
    var box = $('acct-ledger-rows');
    if (!box) return;
    box.textContent = '';
    if (!rows || !rows.length) {
      box.appendChild(elx('p', 'acct-note', 'Nothing yet.'));
      return;
    }
    rows.forEach(function (r) {
      var row = elx('div', 'acct-ledger-row');
      var left = elx('div');
      left.appendChild(elx('span', 'acct-ledger-kind', LEDGER_LABEL[r.kind] || r.kind));
      if (r.note) left.appendChild(elx('span', 'acct-ledger-note', r.note));
      row.appendChild(left);
      var right = elx('div', 'acct-ledger-right');
      var d = Number(r.delta) || 0;
      right.appendChild(elx('span', 'acct-ledger-delta' + (d > 0 ? ' is-up' : ''),
        (d > 0 ? '+' : '') + d.toLocaleString()));
      right.appendChild(elx('span', 'acct-ledger-when',
        new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      row.appendChild(right);
      box.appendChild(row);
    });
  }

  function elx(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function initCredits() {
    var sec = $('acct-credits');
    if (!sec || !window.HexaAuth.client) return;
    sec.hidden = false;

    window.HexaAuth.client.rpc('my_credit_balance').then(function (r) {
      var bal = r && !r.error ? Number(r.data || 0) : 0;
      $('acct-credits-value').textContent = bal.toLocaleString();
      $('acct-credits-sub').textContent = creditsMeaning(bal);
    });

    window.HexaAuth.client.rpc('my_credit_history', { p_limit: 40 }).then(function (r) {
      renderLedger(r && !r.error ? r.data : null);
    });

    /* Packs are fetched rather than hardcoded, so a price change in
     * catalog/pricing.json reaches the page without a code edit. */
    var packsBox = $('acct-packs');
    var topBtn = $('acct-topup');
    topBtn.addEventListener('click', function () {
      if (!packsBox.hidden) { packsBox.hidden = true; return; }
      packsBox.hidden = false;
      if (packsBox.dataset.filled) return;
      // The public, generated half of pricing.json. pricing.json itself carries
      // our costs and margins and is blocked from the site.
      fetch('/catalog/credit-packs.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          packsBox.dataset.filled = '1';
          (d.credit_packs || []).forEach(function (p) {
            var card = elx('button', 'acct-pack');
            card.type = 'button';
            card.appendChild(elx('span', 'acct-pack-credits', p.credits.toLocaleString()));
            card.appendChild(elx('span', 'acct-pack-unit', 'credits'));
            card.appendChild(elx('span', 'acct-pack-usd', '$' + p.usd));
            if (p.bonus_pct) card.appendChild(elx('span', 'acct-pack-bonus', p.bonus_pct + '% extra'));
            card.addEventListener('click', function () { buyPack(p.id, card); });
            packsBox.appendChild(card);
          });
        })
        .catch(function () {
          packsBox.appendChild(elx('p', 'acct-note', 'Could not load the packs. Try again in a moment.'));
        });
    });

    // Arriving back from Stripe. The credits are granted by the webhook, which
    // can land a second after the redirect, so this refreshes shortly after.
    var topup = new URLSearchParams(location.search).get('topup');
    if (topup) {
      $('acct-credits-sub').textContent = 'Thanks. ' + Number(topup).toLocaleString()
        + ' credits are being added and will appear here in a moment.';
      setTimeout(initCredits, 4000);
      history.replaceState({}, '', '/account.html');
    }
  }

  function buyPack(id, btn) {
    btn.disabled = true;
    fetch('/.netlify/functions/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.HexaAuth.accessToken() },
      body: JSON.stringify({ creditPack: id }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (d && d.url) { location.href = d.url; return; }
        return Promise.reject(d);
      })
      .catch(function (d) {
        btn.disabled = false;
        alert((d && d.error) || 'Could not start checkout. Please try again.');
      });
  }

  /* ── Shopify ───────────────────────────────────────────────────
   *
   * The connection state is read from my_store_connections, a view that exists
   * precisely so the browser can see WHETHER a store is connected without ever
   * being able to see the token that makes it work.
   * ───────────────────────────────────────────────────────────── */

  /* What came back from the callback, turned into something a person can act
   * on. Deliberately specific: "it failed" teaches nobody what to do next. */
  var SHOPIFY_MSG = {
    connected: ['ok', 'Store connected. Your products are ready to pick.'],
    signin: ['err', 'You were signed out while approving on Shopify. Sign in and connect again.'],
    expired: ['err', 'That connection attempt expired. Start it again from here.'],
    'bad-shop': ['err', 'That store address did not look right. It should end in myshopify.com'],
    'bad-signature': ['err', 'We could not verify that response came from Shopify, so nothing was saved.'],
    scope: ['err', 'Hexa needs permission to read products. Connect again and approve that one.'],
    unconfigured: ['err', 'Shopify is not switched on yet. Nothing was saved.'],
    busy: ['err', 'Too many attempts just now. Try again shortly.'],
    failed: ['err', 'That did not complete. Nothing was saved, so it is safe to try again.'],
  };

  function initShopify() {
    var sec = $('acct-shopify');
    if (!sec || !window.HexaAuth.client) return;
    sec.hidden = false;

    var form = $('acct-shop-form');
    var input = $('acct-shop-input');
    var state = $('acct-shop-state');
    var sub = $('acct-shop-sub');
    var dis = $('acct-shop-disconnect');

    function paint(store) {
      if (store) {
        state.textContent = store.store_name || store.store;
        state.classList.add('is-on');
        sub.textContent = 'Connected to ' + store.store + '. We read your product catalogue and nothing else.';
        form.hidden = true;
        dis.hidden = false;
        dis.onclick = function () {
          dis.disabled = true;
          /* A plain delete, not an RPC. The row-level policy is what enforces
           * ownership, so this can only ever remove the caller's own
           * connection, and there is no elevated function to get wrong. */
          window.HexaAuth.client.from('store_connections')
            .delete()
            .eq('platform', 'shopify')
            .eq('store', store.store)
            /* PostgREST reports failures in the response rather than by
             * rejecting, so a policy denial arrives here as r.error and would
             * otherwise be painted as success. */
            .then(function (r) {
              dis.disabled = false;
              if (r && r.error) {
                note('acct-shop-note', 'Could not disconnect. Try again.', 'err');
                return;
              }
              paint(null);
              note('acct-shop-note', 'Store disconnected.', 'ok');
            }, function () {
              dis.disabled = false;
              note('acct-shop-note', 'Could not disconnect. Try again.', 'err');
            });
        };
      } else {
        state.textContent = 'Not connected';
        state.classList.remove('is-on');
        sub.textContent = 'Connect Shopify and pick products instead of pasting links. We only ever read your product catalogue.';
        form.hidden = false;
        dis.hidden = true;
      }
    }

    window.HexaAuth.client.from('my_store_connections')
      .select('platform,store,store_name,installed_at')
      .eq('platform', 'shopify')
      .order('installed_at', { ascending: false })
      .limit(1)
      .then(function (r) { paint(r && !r.error && r.data && r.data[0] ? r.data[0] : null); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var shop = (input.value || '').trim();
      if (!shop) { input.focus(); return; }
      // The install leg validates and normalises properly; this only avoids a
      // pointless round trip on obvious nonsense.
      window.location.href = '/.netlify/functions/shopify-install?shop=' + encodeURIComponent(shop);
    });

    var flag = new URLSearchParams(location.search).get('shopify');
    if (flag) {
      var m = SHOPIFY_MSG[flag] || SHOPIFY_MSG.failed;
      note('acct-shop-note', m[1], m[0]);
      history.replaceState({}, '', '/account.html');
    }
  }

  /* ── Brand memory ──────────────────────────────────────────────
   *
   * Written straight from the browser, unlike everything else on this page,
   * because there is nothing secret in it: these are the customer's own words
   * about their own brand. RLS scopes every read and write to auth.uid(), and
   * the unique index keeps exactly one default profile per account.
   * ───────────────────────────────────────────────────────────── */

  var BRAND_FIELDS = [
    ['brand-name', 'brand_name'],
    ['brand-audience', 'audience'],
    ['brand-tone', 'tone'],
    ['brand-words-use', 'words_use'],
    ['brand-words-avoid', 'words_avoid'],
    ['brand-offer', 'offer'],
  ];

  function initBrand() {
    var save = $('brand-save');
    if (!save || !window.HexaAuth.client) return;
    var uid = window.HexaAuth.user().id;

    window.HexaAuth.client.from('brand_profiles')
      .select('brand_name,audience,tone,words_use,words_avoid,offer')
      .is('scope', null)
      .maybeSingle()
      .then(function (r) {
        if (!r || r.error || !r.data) return;
        BRAND_FIELDS.forEach(function (f) {
          if (r.data[f[1]]) $(f[0]).value = r.data[f[1]];
        });
      });

    save.addEventListener('click', function () {
      save.disabled = true;
      var row = { user_id: uid, scope: null };
      BRAND_FIELDS.forEach(function (f) {
        var v = ($(f[0]).value || '').trim();
        row[f[1]] = v || null;
      });
      // onConflict on the partial unique index, so saving twice updates rather
      // than failing or quietly creating a second brand.
      window.HexaAuth.client.from('brand_profiles')
        .upsert(row, { onConflict: 'user_id', ignoreDuplicates: false })
        .then(function (r) {
          save.disabled = false;
          if (r && r.error) { note('brand-note', r.error.message, 'err'); return; }
          note('brand-note', 'Saved. Every ad from here on uses this.', 'ok');
        });
    });
  }

  window.HexaAuth.ready().then(function () {
    var user = window.HexaAuth.user();
    if (!user) { window.HexaAuth.requireAuth('/account.html'); return; }

    var fn = firstName(window.HexaAuth.name());
    $('acct-greeting').textContent = fn ? 'Everything you have made, ' + fn : 'Everything you have made';
    $('acct-user').textContent = window.HexaAuth.email() || '';
    // Prices first, so the action chips are drawn priced rather than filled in
    // a beat later. A failed fetch resolves too, and the chips just go bare.
    loadActionPrices().then(loadLibrary);
    initTabs();
    initSettings();
    initCredits();
    initShopify();
    initBrand();
  });

  $('acct-signout').addEventListener('click', function () {
    window.HexaAuth.signOut().then(function () { location.href = '/'; });
  });
})();

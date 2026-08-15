/* ═════ Hexa Studio · Render / delivery screen ═════
 * Watches an order render and reveals the result in place.
 *
 * Live path: ?jobs= or ?paid= creates/polls real jobs and auto-reveals the
 * result the instant it completes.
 *
 * Composer path (no jobs yet): the order composition steps run to completion,
 * then the page lands on an order summary + delivery email confirmation.
 * Fulfillment goes out by email (order-intake form feeds the ops pipeline).
 */

(function () {
  'use strict';

  var STATUS_URL = '/.netlify/functions/render-status';
  var CREATE_URL = '/.netlify/functions/render-create';
  var REVISE_URL = '/.netlify/functions/render-revise';
  var RECOVER_URL = '/.netlify/functions/order-recover';
  var DELIVERY_WINDOW = 'within 24 hours';

  var STEPS = ['research', 'brief', 'generate', 'finish'];

  /* The delivered image set, once it exists: its urls, its tiles, which one is
   * selected, and the creation row it belongs to. Editing works off this. */
  var pack = null;

  function $(q) { return document.querySelector(q); }

  function readOrder() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('order') || params.get('studio');
    if (raw) { try { return JSON.parse(decodeURIComponent(raw)); } catch (e) {} }
    try { return JSON.parse(localStorage.getItem('hexa-studio-order')); } catch (e) {}
    return null;
  }

  function setStep(idx) {
    STEPS.forEach(function (s, i) {
      var li = document.querySelector('[data-step="' + s + '"]');
      if (!li) return;
      li.classList.remove('active', 'done');
      if (i < idx) li.classList.add('done');
      else if (i === idx) li.classList.add('active');
    });
  }

  function setPct(p) {
    var el = $('#stage-pct');
    if (el) el.textContent = Math.round(p) + '%';
  }

  /* `status` is the whole render-status body, not just its result. A pack that
   * delivers 19 of 20 comes back completed WITH a partial block and a message
   * naming the refund (render-status.js:308), and that message used to be
   * dropped on the floor: nothing in here read s.message or s.partial, so the
   * customer saw "20 creatives" over a set of 19 and a silent balance change.
   * Optional, because the sample path reveals a result with no status. */
  function reveal(order, result, status) {
    clearProductGhost();
    var frame = $('#stage-frame');
    frame.classList.add('done');
    setStep(STEPS.length);
    var isVideo = !result || /\.(mp4|webm|mov)(\?|$)/i.test(result.url || '') || (result && result.type === 'video');

    var urls = result && result.url
      ? (result.urls && result.urls.length ? result.urls : [result.url])
      : [];

    if (result && result.url) {
      var node = isVideo ? $('#stage-video') : $('#stage-image');
      node.classList.add('stage-reveal');
      if (isVideo) {
        var seg = 0;
        node.src = urls[0]; node.autoplay = true; node.muted = true;
        // one segment loops; a long-video order plays its segments as one film
        if (urls.length === 1) { node.loop = true; }
        else {
          node.loop = false;
          node.addEventListener('ended', function () {
            seg = (seg + 1) % urls.length;
            node.src = urls[seg];
            node.play().catch(function () {});
          });
        }
      }
      else {
        node.src = result.url;
        // a photoshoot delivers a set: click a frame to view it, download any
        if (urls.length > 1) {
          var setEl = $('#result-set');
          if (setEl) {
            setEl.innerHTML = '';
            pack = { order: order, urls: urls.slice(), tiles: [], stage: node, index: 0, headlines: [] };
            urls.forEach(function (u, i) {
              var a = document.createElement('a');
              a.className = 'result-set-item' + (i === 0 ? ' sel' : '');
              a.href = u;
              a.setAttribute('download', '');
              a.setAttribute('aria-label', 'Image ' + (i + 1));
              var im = document.createElement('img');
              im.src = u; im.alt = 'Result ' + (i + 1); im.loading = 'lazy';
              a.appendChild(im);
              a.addEventListener('click', function (e) {
                if (e.metaKey || e.ctrlKey) return;
                e.preventDefault();
                selectTile(i);
              });
              setEl.appendChild(a);
              pack.tiles.push(a);
            });
            setEl.hidden = false;
            mountAdEditor();
          }
        }
      }
      node.hidden = false;
      var dl = $('#btn-download');
      dl.href = result.url;
      $('#render-actions').hidden = false;
      $('#render-actions').classList.remove('no-download');

      // long films: per-segment downloads alongside the main button
      if (isVideo && urls.length > 1) {
        var segsEl = $('#result-set');
        if (segsEl) {
          segsEl.innerHTML = '';
          urls.forEach(function (u, i) {
            var a = document.createElement('a');
            a.className = 'result-seg-link';
            a.href = u;
            a.setAttribute('download', '');
            a.textContent = 'Seg ' + (i < 9 ? '0' : '') + (i + 1);
            segsEl.appendChild(a);
          });
          segsEl.hidden = false;
        }
      }
    }
    $('#render-kicker').textContent = 'Ready';
    $('#render-title').textContent = 'Your content is ready';
    var subMsg;
    if (isVideo && urls.length > 1) {
      subMsg = 'One video in ' + urls.length + ' segments, playing in order above. ' +
        'The single stitched master lands in your email shortly.';
    } else if (!isVideo && urls.length > 1) {
      subMsg = order.product === 'adpack'
        ? urls.length + ' creatives, ' + urls.length + ' different arguments for the same product. ' +
          'Click any one to view it, download it, or change it below.'
        : urls.length + ' images, all yours. Click any frame to view it, then download.';
    } else {
      subMsg = 'Made with the ' + (order.style ? styleLabel(order) + ' style' : order.title) + '. Download it and post.';
    }
    $('#render-sub').textContent = subMsg;

    /* A short pack is not a quiet event. The server already worked out how many
     * arrived, how many did not and what came back; say it in the note box
     * rather than under the headline, so it reads as the correction it is and
     * does not fight the delivery copy above it. */
    if (status && status.partial) {
      var p = status.partial;
      var note = $('#render-note');
      note.textContent = status.message ||
        (p.delivered + ' of ' + p.of + ' creatives arrived. You were not charged for the rest.');
      note.hidden = false;
      $('#render-title').textContent = 'Your content is ready, minus ' +
        (p.failed === 1 ? 'one' : p.failed) + ' that did not render';
    }

    /*
     * Grounding, said out loud when it failed.
     *
     * render-create tries to hand the engine the real product, either the
     * scraped page or the real photograph. When neither is available it
     * renders anyway, which is right, because an unreadable page should not
     * kill a paid render. But then the result is an ad for a product LIKE
     * theirs, and until now that looked identical to an ad for theirs. Anyone
     * about to run it as an ad should know which one they have.
     *
     * Only shown when the server actually said so; absence is not evidence.
     */
    if (order.ungrounded && !(status && status.partial)) {
      var gnote = $('#render-note');
      gnote.textContent = 'We could not read your product page, so this was made from your ' +
        'description rather than your actual product. Check it looks like the real thing before ' +
        'you run it, and add a product photo in the studio for an exact match.';
      gnote.hidden = false;
    }
  }

  /* The style's display name, preferring the one the studio already stored.
   *
   * selections.styleName is the preset's own `name` from catalog/presets.json
   * (studio.js sets it when a preset is picked, and pricing.js reads the same
   * field), so it is the only spelling the catalogue actually endorses.
   * Deriving from the id instead loses every acronym: measured 2026-08-15,
   * title-casing produced "Golden Hour Ugc" and "Unbox Asmr" for two of the
   * twelve presets, on the render headline and the delivered message.
   *
   * The id fallback still matters for orders saved before styleName existed
   * and for paths that carry a style with no preset behind it. */
  function styleLabel(order) {
    var stored = order.selections && order.selections.styleName;
    if (stored) return stored;
    return niceStyle(order.style);
  }

  /* Title-cases a style id. The acronym list is the set that actually appears
   * capitalised in catalog/presets.json names (UGC, ASMR); without it, plain
   * title casing renders them "Ugc" and "Asmr". */
  var STYLE_ACRONYMS = { ugc: 'UGC', asmr: 'ASMR' };

  function niceStyle(id) {
    return id.replace(/-/g, ' ').replace(/[^\s]+/g, function (w) {
      return STYLE_ACRONYMS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1);
    });
  }

  /* ══ Ad pack editing ══════════════════════════════════════════════
   * Twenty creatives arrive at once, which makes them a starting point rather
   * than a verdict. Every one is addressable on its own: pick a tile, change
   * the headline or the concept, and only that tile re-renders, in place, at
   * our cost. That is what keeps "no reject fees" honest.
   *
   * The server owns everything that matters here. It proves ownership from the
   * signed-in token, rebuilds the brief from the selections that were actually
   * paid for, counts the allowance on the row, and writes the replacement into
   * the buyer's library. This file only asks and swaps pixels. */
  function selectTile(i) {
    if (!pack || !pack.tiles[i]) return;
    pack.index = i;
    pack.stage.src = pack.urls[i];
    pack.tiles.forEach(function (x) { x.classList.remove('sel'); });
    pack.tiles[i].classList.add('sel');
    $('#btn-download').href = pack.urls[i];
    var which = $('#ad-edit-which');
    if (which) which.textContent = 'creative ' + (i + 1) + ' of ' + pack.urls.length;
    var hl = $('#ad-edit-headline');
    if (hl) hl.value = pack.headlines[i] || '';
  }

  function swapTile(i, url) {
    if (!pack || !pack.tiles[i]) return;
    pack.urls[i] = url;
    pack.tiles[i].href = url;
    var im = pack.tiles[i].querySelector('img');
    if (im) im.src = url;
    if (pack.index === i) { pack.stage.src = url; $('#btn-download').href = url; }
  }

  function editNote(msg, warn) {
    var n = $('#ad-edit-note');
    if (!n) return;
    n.textContent = msg;
    n.classList.toggle('warn', !!warn);
  }

  /* The creation id is what a revision addresses. The normal path has it from
   * render-create. A buyer returning on another device does not, so fall back
   * to matching this set against their library by its first image. */
  function findCreationId(order, token) {
    if (order.creation) return Promise.resolve(order.creation);
    if (!token) return Promise.resolve(null);
    return fetch('/.netlify/functions/account-creations', {
      headers: { Authorization: 'Bearer ' + token },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var rows = (d && (d.creations || d.rows || d)) || [];
        if (!Array.isArray(rows)) return null;
        var first = pack.urls[0];
        var hit = rows.find(function (c) {
          return c && Array.isArray(c.result_urls) && c.result_urls.indexOf(first) >= 0;
        });
        return hit ? hit.id : null;
      })
      .catch(function () { return null; });
  }

  function mountAdEditor() {
    var form = $('#ad-edit');
    if (!form || !pack || pack.order.product !== 'adpack') return;

    // Layout preview: show the editor, wire selection, refuse to spend.
    if (new URLSearchParams(window.location.search).get('preview') === 'adpack') {
      fillConcepts();
      selectTile(0);
      form.hidden = false;
      $('#ad-edit-left').textContent = 'preview';
      editNote('Preview only. On a real pack this re-renders just the selected creative, free.');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        editNote('Preview only, so nothing renders here. On your delivered pack this button re-rolls the selected creative.', true);
      });
      return;
    }

    var auth = window.HexaAuth;
    (auth ? auth.ready() : Promise.resolve()).then(function () {
      var token = auth && auth.accessToken();
      if (!token) return; // signed out: the set is still theirs to download
      return findCreationId(pack.order, token).then(function (creationId) {
        if (!creationId) return;
        pack.creation = creationId;
        fillConcepts();
        selectTile(0);
        form.hidden = false;
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          submitRevision(token);
        });
      });
    });
  }

  /* The concepts are the ones we actually render, read from the same catalog
   * the pack is built from, so the menu can never offer something the server
   * will refuse. */
  function fillConcepts() {
    var sel = $('#ad-edit-concept');
    if (!sel) return;
    fetch('catalog/higgsfield/ad-formats.json')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        var names = [];
        (list || []).forEach(function (f) {
          if (f && f.name && names.indexOf(f.name) < 0) names.push(f.name);
        });
        if (!names.length) { sel.hidden = true; return; }
        sel.innerHTML = '';
        var keep = document.createElement('option');
        keep.value = '';
        keep.textContent = 'Same concept';
        sel.appendChild(keep);
        names.forEach(function (n) {
          var o = document.createElement('option');
          o.value = n; o.textContent = n;
          sel.appendChild(o);
        });
      })
      .catch(function () { sel.hidden = true; });
  }

  function submitRevision(token) {
    var btn = $('#ad-edit-go');
    var hlEl = $('#ad-edit-headline');
    var cnEl = $('#ad-edit-concept');
    var i = pack.index;
    var headline = (hlEl && hlEl.value || '').trim();
    var concept = (cnEl && cnEl.value) || '';
    if (!headline && !concept) {
      editNote('Change the headline or pick a different concept first.', true);
      return;
    }

    btn.disabled = true;
    pack.headlines[i] = headline;
    pack.tiles[i].classList.add('busy');
    editNote('Re-rolling creative ' + (i + 1) + '. About a minute.');

    fetch(REVISE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ creation: pack.creation, index: i, concept: concept, headline: headline }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) { pollRevision(token, d.job.id, i, d.revisionsLeft, 0); })
      .catch(function (d) {
        btn.disabled = false;
        pack.tiles[i].classList.remove('busy');
        editNote((d && d.error) || 'That edit could not start. Nothing was spent; try again.', true);
      });
  }

  function pollRevision(token, jobId, i, left, tries) {
    if (tries > 60) { // ~3 minutes; a still image never legitimately takes that
      $('#ad-edit-go').disabled = false;
      pack.tiles[i].classList.remove('busy');
      editNote('That re-roll is taking unusually long. It will appear in your library when it lands.', true);
      return;
    }
    var qs = '?creation=' + encodeURIComponent(pack.creation) +
      '&index=' + i + '&job=' + encodeURIComponent(jobId);
    fetch(REVISE_URL + qs, { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.status === 'completed' && s.url) {
          swapTile(i, s.url);
          pack.tiles[i].classList.remove('busy');
          $('#ad-edit-go').disabled = false;
          editNote('Creative ' + (i + 1) + ' is updated, here and in your library.');
          var leftEl = $('#ad-edit-left');
          if (leftEl && typeof left === 'number') {
            leftEl.textContent = left + (left === 1 ? ' edit left' : ' edits left');
          }
          return;
        }
        if (s.status === 'failed') {
          pack.tiles[i].classList.remove('busy');
          $('#ad-edit-go').disabled = false;
          editNote(s.message || 'That re-roll did not render. Your edit is back in the bank.', true);
          return;
        }
        setTimeout(function () { pollRevision(token, jobId, i, left, tries + 1); }, 3000);
      })
      .catch(function () {
        setTimeout(function () { pollRevision(token, jobId, i, left, tries + 1); }, 4000);
      });
  }

  /* The peeked product image, faint behind the scan while the order builds.
   * Removed automatically when reveal() swaps the real result in. */
  function showProductGhost(order) {
    var src = order.selections && order.selections.productImage;
    if (!src) return;
    var img = $('#stage-image');
    if (!img || !img.hidden) return;
    img.src = src;
    img.classList.add('stage-ghost');
    img.onerror = function () { img.hidden = true; img.classList.remove('stage-ghost'); };
    img.hidden = false;
  }

  function clearProductGhost() {
    var img = $('#stage-image');
    if (img && img.classList.contains('stage-ghost')) {
      img.classList.remove('stage-ghost');
      img.hidden = true;
      img.removeAttribute('src');
    }
  }

  /* Composer path: the order composition steps run to a real 100% (the brief
   * IS written and saved), then hand off to the order-received state. */
  function runStaged(order, done) {
    var pct = 0, step = 0;
    setStep(0);
    var timer = setInterval(function () {
      pct += Math.random() * 5 + 3;
      // gate progress on step boundaries so steps light up in order
      var target = (step + 1) / STEPS.length * 100;
      if (pct >= target && step < STEPS.length - 1) { step++; setStep(step); }
      if (pct >= 100) { pct = 100; setPct(pct); setStep(STEPS.length); clearInterval(timer); done(); return; }
      setPct(pct);
    }, 200);
  }

  /*
   * Live: poll the backend until every segment job resolves.
   *
   * The poll is not read-only. render-status is where the library row gets
   * marked complete and where a dead render gets refunded, and it can only do
   * either for a render it can identify. A card order is identified by
   * ?paid=<Stripe session>; a credit order has no session, so the handle is
   * ?creation=<id> plus the bearer token that proves the row is the caller's
   * (render-status.js:82 loads the row and compares user_id against the JWT).
   *
   * Sending neither, which is what this did, makes ownedRows return a bare
   * { db }: refundFailed returns false, refundLostCreatives returns 0, and
   * recordCompleted never fires, so a credit render was never refunded when it
   * died and stayed 'rendering' in the library forever even when it succeeded.
   *
   * The token is read on every tick rather than captured once, because a long
   * render outlives the access token that started it.
   */

  /* Two ceilings, because a poll can end in two different ways and only one of
   * them is about the render.
   *
   * POLL_DEADLINE_MS is wall clock, not a tick count, because the honest
   * duration varies by two orders of magnitude: a 20 image pack settles in
   * minutes, a 32 segment video does not. Forty-five minutes is past anything
   * we have measured and still finite.
   *
   * POLL_ERROR_LIMIT counts CONSECUTIVE unreadable answers. A 502 from the
   * status endpoint returns an HTML body, so r.json() rejects and the old code
   * retried forever on a three second timer, spinning on the last percentage
   * with nothing on screen ever changing. One blip is not an outage, so the
   * counter resets on the first readable answer and the delay backs off. */
  var POLL_DEADLINE_MS = 45 * 60 * 1000;
  var POLL_ERROR_LIMIT = 8;

  function pollLive(order, jobsCsv, paidSession) {
    var pct = 4;
    var started = Date.now();
    var errors = 0;
    var qs = '?jobs=' + encodeURIComponent(jobsCsv) +
      (paidSession ? '&paid=' + encodeURIComponent(paidSession) : '') +
      (order.creation ? '&creation=' + encodeURIComponent(order.creation) : '');

    /* Losing the progress feed is not the render failing, and saying "we could
     * not finish this render" when the jobs are still running would be a lie
     * that also invites a second charge. The work continues server-side and
     * render-status writes the result to the library either way. */
    function lostFeed() {
      setStep(2);
      $('#render-kicker').textContent = 'Still rendering';
      $('#render-title').textContent = 'This is taking longer than the live view can wait';
      $('#render-sub').textContent = 'Your render is still running on our side. Nothing is lost and nothing else is charged.';
      var note = $('#render-note');
      note.hidden = false;
      note.textContent = 'It lands in your library the moment it finishes. Refresh this page to rejoin the live view, or open your account and it will be there.';
    }

    function retry(delay) {
      if (Date.now() - started > POLL_DEADLINE_MS) { lostFeed(); return; }
      setTimeout(tick, delay);
    }

    function onUnreadable() {
      errors += 1;
      if (errors >= POLL_ERROR_LIMIT) { lostFeed(); return; }
      retry(Math.min(15000, 3000 + errors * 2000));
    }

    function tick() {
      var headers = {};
      var token = window.HexaAuth && window.HexaAuth.accessToken && window.HexaAuth.accessToken();
      if (token) headers.Authorization = 'Bearer ' + token;
      fetch(STATUS_URL + qs, { headers: headers })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          /* An answer with no status is an error body, not progress. Without
           * this branch it fell straight through to the retry below and the
           * page span forever on whatever percentage it had reached. */
          if (!s || !s.status) { onUnreadable(); return; }
          errors = 0;
          if (s.step) setStep(STEPS.indexOf(s.step));
          if (typeof s.pct === 'number') { pct = s.pct; setPct(pct); }
          else { pct = Math.min(94, pct + 3); setPct(pct); }
          if (s.segmentsTotal > 1) {
            var filmName = order.selections && order.selections.productName
              ? order.selections.productName + ' video' : 'video';
            $('#render-sub').textContent = 'Rendering scene ' + Math.min(s.segmentsDone + 1, s.segmentsTotal) +
              ' of ' + s.segmentsTotal + ' of your ' + filmName + '.';
          }
          if (s.status === 'completed' && s.result) { setPct(100); reveal(order, s.result, s); return; }
          if (s.status === 'failed') { failState(s.message, s); return; }
          retry(3000);
        })
        // A 502 answers with an HTML body, so r.json() rejects and lands here.
        .catch(function () { onUnreadable(); });
    }
    tick();
  }

  /* Paid arrival: ask the backend to create the jobs, then watch them. The
   * customer's card is charged at this point, so a create failure never shows
   * a dead end; it lands on an honest "paid, rendering shortly" state. */
  function createPaid(order, sessionId) {
    fetch(CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: order, paid: sessionId }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (!d.jobs || !d.jobs.length) return Promise.reject(d);
        order.jobs = d.jobs;
        // The library row this render writes into. Kept so the delivered set
        // can be edited later without looking itself up again. A replayed
        // session does not return one, so never overwrite a known id with null.
        if (d.creation) order.creation = d.creation;
        if (d.grounded === false) order.ungrounded = true;
        try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
        pollLive(order, d.jobs.map(function (j) { return j.id; }).join(','), sessionId);
      })
      .catch(function (d) {
        console.error('paid create failed', d);
        paidQueuedState(order);
      });
  }

  /*
   * Credit arrival: the same create call, charged to the account balance.
   *
   * The bearer token is the whole payment instrument here, so unlike the Stripe
   * path this one waits for the session to resolve before it asks. Firing early
   * sends no Authorization header, and render-create answers 401 "Sign in to
   * spend credits" to somebody who is, in fact, signed in.
   */
  function createWithCredits(order) {
    var go = function () {
      var token = window.HexaAuth && window.HexaAuth.accessToken && window.HexaAuth.accessToken();
      if (!token) {
        try { localStorage.setItem('hexa-pending-order', JSON.stringify(order)); } catch (e) {}
        window.location.href = '/login.html?next=' + encodeURIComponent('/render.html?credits=1');
        return;
      }
      /*
       * The key is minted and saved BEFORE the request, which is the whole
       * point. Saving the jobs afterwards, which is all this used to do,
       * leaves a window: refresh while the create is in flight and the page
       * came back with no jobs, called again, and charged the balance twice.
       * Minted first, a refresh in that window sends the same key and the
       * server hands back the render already running.
       */
      if (!order.idem) {
        order.idem = (window.crypto && window.crypto.randomUUID)
          ? window.crypto.randomUUID()
          : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
        try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
      }
      fetch(CREATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ order: order, idempotencyKey: order.idem }),
      })
        .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
        .then(function (d) {
          if (!d.jobs || !d.jobs.length) return Promise.reject(d);
          order.jobs = d.jobs;
          if (d.creation) order.creation = d.creation;
          if (d.grounded === false) order.ungrounded = true;
          // Saved before the poll starts: from here a refresh finds the jobs
          // and rejoins the render instead of spending the balance again.
          try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
          pollLive(order, d.jobs.map(function (j) { return j.id; }).join(','), null);
        })
        .catch(function (d) {
          // Out of credits is the one failure with a real answer, so it says the
          // number rather than a generic apology. Nothing was charged: the spend
          // is refused before any job is created.
          if (d && d.creditsNeeded) {
            $('#render-kicker').textContent = 'Not enough credits';
            $('#render-title').textContent = 'This one needs ' + Number(d.creditsNeeded).toLocaleString() + ' credits';
            $('#render-sub').textContent = 'Nothing was charged. Top up and your order is still here, exactly as you built it.';
            return;
          }
          console.error('credit create failed', d);
          paidQueuedState(order);
        });
    };
    if (window.HexaAuth && !window.HexaAuth.loaded()) window.HexaAuth.ready().then(go);
    else go();
  }

  /* Free sample: no sign-in wall at the door. A signed-out visitor gets the
   * whole creation experience first (their product on the stage, the steps
   * running); the account is only asked for at the collect moment, when the
   * clip is staged and they want it rendered and kept. Sign-in bounces back
   * here and the claim picks up where it left off. 409 = already spent. */
  function sampleGate(order) {
    showProductGhost(order);
    var name = order.selections && order.selections.productName;
    $('#render-kicker').textContent = 'Free sample';
    $('#render-title').textContent = 'Staging your free clip';
    $('#render-sub').textContent = 'Reading ' + (name || 'the product page') + ' and planning the shoot. A few seconds.';
    // the honest staging pass: reading the product (the peek is real work),
    // planning the shoot. It stops where money starts: the render itself.
    var pct = 0, step = 0;
    setStep(0);
    var timer = setInterval(function () {
      pct += Math.random() * 3 + 2;
      if (pct >= 30 && step < 1) { step = 1; setStep(1); }
      if (pct >= 62) {
        clearInterval(timer);
        pct = 62;
        setPct(pct);
        setStep(2);
        $('#render-title').textContent = 'Your free clip is staged';
        $('#render-sub').textContent = (name ? name + ' is read and the shoot is planned. ' : 'Product read, shoot planned. ') +
          'Create your free account and the render starts; the clip appears right here and saves to your library.';
        $('#render-gate').hidden = false;
        if (window.hexaTrack) window.hexaTrack('sample-gate', 'sample', 0);
        return;
      }
      setPct(pct);
    }, 180);
  }

  function createSample(order) {
    var auth = window.HexaAuth;
    var loginNext = '/login.html?next=' + encodeURIComponent('/render.html?sample=1');
    (auth ? auth.ready() : Promise.resolve()).then(function () {
      if (auth && !auth.user()) { sampleGate(order); return; }
      $('#render-gate').hidden = true;
      var headers = { 'Content-Type': 'application/json' };
      if (auth && auth.accessToken()) headers.Authorization = 'Bearer ' + auth.accessToken();
      fetch(CREATE_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ order: order }),
      })
        .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject({ status: r.status, body: d }); }); })
        .then(function (d) {
          if (!d.jobs || !d.jobs.length) return Promise.reject(d);
          order.jobs = d.jobs;
          if (d.creation) order.creation = d.creation;
          try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
          pollLive(order, d.jobs.map(function (j) { return j.id; }).join(','), null);
        })
        .catch(function (e) {
          if (e && e.status === 401) { window.location.href = loginNext; return; }
          if (e && e.status === 409) { sampleClaimedState(); return; }
          console.error('sample create failed', e);
          failState((e && e.body && e.body.error) || 'The sample could not start. Nothing was charged; try again in a minute.');
        });
    });
  }

  function sampleClaimedState() {
    setStep(STEPS.length);
    setPct(100);
    $('#render-kicker').textContent = 'Free sample';
    $('#render-title').textContent = 'Your free sample is already made';
    /* No price in this sentence on purpose. It read "starts at $12", which was
     * the ad pack's price, not a video's: the cheapest video in
     * catalog/pricing.json is $9. index.html binds every number to data-price
     * attributes for exactly this reason, but pricing.json is not public (see
     * _redirects), so there is nothing here to bind to and a typed number just
     * drifts again. The studio quotes the real price one click away. */
    $('#render-sub').textContent = 'One per account, and yours lives in your library. The full video runs to any length, in the same look.';
    var note = $('#render-note');
    note.hidden = false;
    note.innerHTML = '<a href="/account.html">Open your library</a> · <a href="/#styles">Make the full video</a>';
  }

  function paidQueuedState(order) {
    setStep(1);
    setPct(8);
    $('#render-kicker').textContent = 'Payment received';
    $('#render-title').textContent = 'Your order is in production';
    $('#render-sub').textContent = 'Your ' + (order.title || 'order') +
      ' is rendering now. It appears right here, and lands in your inbox, the moment it is ready.';
    var note = $('#render-note');
    note.hidden = false;
    note.textContent = 'Your order is saved. Close this page and come back any time. Questions? Reply to your receipt and we take care of it.';
  }

  /*
   * A dead render, said the way it actually happened.
   *
   * `retryable` comes from the server (lib/failure.js) and decides the advice,
   * because the two cases want opposite instructions. A tripped safety filter
   * is deterministic: the same brief refuses again, so "run it again" spends
   * the refund we just issued and lands the customer in the same place. An
   * engine fault is the opposite, and another go is the right answer.
   *
   * Defaults to retryable, since every caller that passes nothing is a local
   * failure to start the render, where trying again is sound.
   */
  function failState(msg, status) {
    var declined = status && status.retryable === false;
    $('#render-kicker').textContent = declined ? 'Not rendered' : 'Render interrupted';
    // The server sends the headline it classified, so the title and the
    // paragraph beneath it cannot end up saying the same sentence twice.
    $('#render-title').textContent = (status && status.headline) || 'We could not finish this render';
    $('#render-sub').textContent = msg || 'Something interrupted this render. You are never charged for work we do not deliver.';
    $('#render-note').hidden = false;
    $('#render-note').textContent = declined
      ? 'Adjust the brief or the product photo in the studio and run it again. Reply to your confirmation email if you want a hand with the wording.'
      : 'Run it again from the studio, or reply to your confirmation email and we will make it right.';
  }

  /* Preview the delivered ad pack without buying one.
   *
   * The editor only exists on a finished set, which normally means a paid
   * order, so there is otherwise no way to look at it, review it or change it.
   * ?preview=adpack stages a set from the real ad format thumbnails and mounts
   * the editor read-only. Nothing renders and nothing is spent. */
  function previewAdPack() {
    var order = { product: 'adpack', title: 'DTC Ad Pack', style: null, selections: { aspect: '4:5' } };
    $('#render-stage').setAttribute('data-aspect', '4:5');
    fetch('catalog/studio-data.json')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var urls = (d.ad_formats || [])
          .map(function (f) { return f.preview; })
          .filter(Boolean)
          .slice(0, 20);
        if (!urls.length) { failState('No preview thumbnails in the catalog.'); return; }
        setPct(100);
        reveal(order, { url: urls[0], urls: urls, type: 'image' });
        $('#render-kicker').textContent = 'Preview';
        $('#render-title').textContent = 'What a delivered ad pack looks like';
        $('#render-sub').textContent =
          'Twenty creatives, twenty different arguments for the same product. ' +
          'Click any one to select it, then use the editor below. This is a layout preview: ' +
          'the images are format samples and nothing here renders or charges.';
      })
      .catch(function () { failState('Could not load the preview.'); });
  }

  /* No order in the browser, and no payment to recover one from. */
  function noOrderState() {
    $('#render-kicker').textContent = 'Hexa Studio';
    $('#render-title').textContent = 'No order in progress';
    $('#render-sub').textContent = 'Start a creation in the studio and it appears here.';
    $('#render-steps').hidden = true;
    $('#render-actions').hidden = false;
    $('#render-actions').classList.add('no-download');
  }

  /*
   * Arriving from Stripe with nothing in localStorage.
   *
   * This used to be a dead end: the no-order branch ran before the ?paid=
   * branch, so a paying customer whose storage was empty read "No order in
   * progress. Start a creation in the studio." with their card already charged.
   * A different browser finishing the payment, private mode, a cleared site or
   * an in-app browser handing off to Safari all land there.
   *
   * order-recover hands back the order the server itself wrote at checkout, so
   * the page carries on as though nothing was lost. It is also the more trusted
   * copy: server-written, never round-tripped through the client.
   */
  function recoverPaidOrder(sessionId) {
    $('#render-kicker').textContent = 'Payment received';
    $('#render-title').textContent = 'Finding your order';
    $('#render-sub').textContent = 'One moment while we pick your order back up.';
    fetch(RECOVER_URL + '?paid=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (!d.order || !d.order.product) return Promise.reject(d);
        try { localStorage.setItem('hexa-studio-order', JSON.stringify(d.order)); } catch (e) {}
        startOrder(d.order);
      })
      .catch(function (d) {
        console.error('order recovery failed', d);
        /* Still never a dead end. The payment is real whatever happened here,
         * so this says so and points at the two places the order will appear
         * without asking anyone to pay again. */
        $('#render-kicker').textContent = 'Payment received';
        $('#render-title').textContent = 'Your order is safe';
        $('#render-sub').textContent = 'We could not pick your order back up in this browser, but the payment went through and the order is on our side.';
        $('#render-steps').hidden = true;
        var note = $('#render-note');
        note.hidden = false;
        note.textContent = 'It lands in your library and in your inbox. Sign in to your account to watch it, or reply to your receipt and we will pick it up from there. Do not pay again.';
      });
  }

  function boot() {
    var y = $('#y'); if (y) y.textContent = String(new Date().getFullYear());

    var bootParams = new URLSearchParams(window.location.search);
    if (bootParams.get('preview') === 'adpack') {
      previewAdPack();
      return;
    }

    var order = readOrder();
    if (!order) {
      // The paid check comes FIRST now. Ordering was the whole bug.
      var lostPaid = bootParams.get('paid');
      if (lostPaid) { recoverPaidOrder(lostPaid); return; }
      noOrderState();
      return;
    }
    startOrder(order);
  }

  function startOrder(order) {
    // shape the stage to the chosen aspect ratio
    var aspect = (order.selections && order.selections.aspect) || '9:16';
    $('#render-stage').setAttribute('data-aspect', aspect);

    // their product, faintly on the stage while it composes/renders
    showProductGhost(order);

    var label = order.style ? styleLabel(order) : order.title;
    $('#render-title').textContent = 'Rendering your ' + label;
    $('#render-kicker').textContent = order.title || 'Rendering';

    if (window.hexaTrack) window.hexaTrack('studio-render', order.product, order.price);

    // Live mode: the page arrives with the segment job ids in the URL
    // (render-create returns them and the studio redirects here).
    var params = new URLSearchParams(window.location.search);
    var jobsCsv = params.get('jobs') ||
      (order.jobs && order.jobs.map(function (j) { return j.id; }).join(','));
    if (jobsCsv) {
      pollLive(order, jobsCsv, params.get('paid'));
      return;
    }

    // Free sample arrival (?sample=1). A refresh mid-render carries jobs and
    // is caught above; otherwise stage the claim. Sign-in is asked at the
    // collect moment inside createSample, never at the door.
    if (params.get('sample') && order.product === 'sample') {
      setStep(0);
      createSample(order);
      return;
    }

    // Paid arrival from Stripe: create the jobs now. render-create verifies the
    // session server-side and returns the SAME jobs on a refresh, so this is
    // safe to re-enter.
    var paid = params.get('paid');
    if (paid) {
      setStep(0);
      createPaid(order, paid);
      return;
    }

    /*
     * Credit arrival: paid from the balance on the account instead of a card.
     *
     * Unlike the Stripe path this is NOT safe to re-enter. A Stripe session id
     * is a receipt the server can recognise a second time, so a refresh returns
     * the same jobs; credits have no equivalent, so a refresh here would charge
     * the balance twice. The jobs are written into the saved order the moment
     * they come back, and the branch above catches them on any later load,
     * which is what makes a refresh land on the running render rather than on
     * a second charge.
     */
    if (params.get('credits')) {
      setStep(0);
      createWithCredits(order);
      return;
    }

    // Composer path: relabel the steps as order composition (all of them
    // truthfully complete), run to 100%, land on the order-received state.
    var COMPOSE_LABELS = {
      research: order.selections && order.selections.productName
        ? 'Reading ' + order.selections.productName
        : 'Reading your product',
      brief: 'Writing the creative brief',
      generate: 'Locking your selections',
      finish: 'Order received',
    };
    STEPS.forEach(function (s) {
      var li = document.querySelector('[data-step="' + s + '"] .lbl');
      if (li) li.textContent = COMPOSE_LABELS[s];
    });
    $('#render-kicker').textContent = order.title || 'Hexa Studio';
    $('#render-title').textContent = 'Preparing your ' + label;

    runStaged(order, function () { orderReceived(order, label); });
  }

  /* Order-received state: summary card in the stage + delivery email form. */
  function orderReceived(order, label) {
    clearProductGhost(); // the card carries the product thumb from here
    $('#stage-frame').classList.add('done');
    $('#render-kicker').textContent = 'Order received';
    $('#render-title').textContent = 'Your ' + label + ' is in production';
    $('#render-sub').textContent = 'Your brief is locked and your order is in the production queue. We deliver the finished file to your email.';

    // summary card replaces the percentage inside the stage frame
    var s = order.selections || {};
    var chips = [];
    if (s.styleName) chips.push(s.styleName + ' style');
    if (s.duration) chips.push(s.duration + 's');
    if (s.aspect) chips.push(s.aspect);
    var card = document.createElement('div');
    card.className = 'stage-card';
    var cardTitle = s.productName ? (order.title || label) + ' for ' + s.productName : (order.title || label);
    card.innerHTML =
      (s.productImage ? '<img class="stage-card-img" src="' + s.productImage.replace(/"/g, '&quot;') + '" alt="" />' : '') +
      '<span class="stage-card-check" aria-hidden="true">✓</span>' +
      '<span class="stage-card-title">' + cardTitle + '</span>' +
      (chips.length ? '<span class="stage-card-meta">' + chips.join(' · ') + '</span>' : '') +
      (order.price ? '<span class="stage-card-price">$' + order.price + '</span>' : '');
    var pct = $('#stage-pct');
    pct.textContent = '';
    pct.appendChild(card);
    pct.style.opacity = '1';

    // delivery email confirmation
    var form = $('#delivery-form');
    if (form) {
      form.hidden = false;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = ($('#delivery-email').value || '').trim();
        if (!email) return;
        var btn = $('#delivery-confirm');
        btn.disabled = true;
        btn.textContent = 'Confirming…';
        var payload = new URLSearchParams();
        payload.set('form-name', 'order-intake');
        payload.set('email', email);
        payload.set('brand', order.title || 'Hexa Studio order');
        payload.set('links', s.link || '');
        payload.set('notes', 'STUDIO ORDER ' + JSON.stringify(order).slice(0, 4000));
        fetch('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: payload.toString(),
        })
          .then(function () {
            form.hidden = true;
            $('#render-sub').textContent = 'Confirmed. Your ' + label + ' will arrive at ' + email + ' ' + DELIVERY_WINDOW + '.';
            var note = $('#render-note');
            note.hidden = false;
            note.textContent = 'Every order gets a quality review before delivery, so the first file you receive is the final one. Need a change? Reply to the delivery email and we handle it.';
          })
          .catch(function () {
            btn.disabled = false;
            btn.textContent = 'Confirm delivery';
          });
      });
    }

    $('#render-actions').hidden = false;
    $('#render-actions').classList.add('no-download');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

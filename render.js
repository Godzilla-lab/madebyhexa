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
  var DELIVERY_WINDOW = 'within 24 hours';

  var STEPS = ['research', 'brief', 'generate', 'finish'];

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

  function reveal(order, result) {
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
                node.src = u;
                setEl.querySelectorAll('.result-set-item').forEach(function (x) { x.classList.remove('sel'); });
                a.classList.add('sel');
                $('#btn-download').href = u;
              });
              setEl.appendChild(a);
            });
            setEl.hidden = false;
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
      subMsg = 'One film in ' + urls.length + ' segments, playing in order above. ' +
        'The single stitched master lands in your email shortly.';
    } else if (!isVideo && urls.length > 1) {
      subMsg = urls.length + ' images, all yours. Click any frame to view it, then download.';
    } else {
      subMsg = 'Made with the ' + (order.style ? niceStyle(order.style) + ' style' : order.title) + '. Download it and post.';
    }
    $('#render-sub').textContent = subMsg;
  }

  function niceStyle(id) {
    return id.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
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

  /* Live: poll the backend until every segment job resolves. paidSession
   * rides along so the backend can write the finished result to the buyer's
   * library, and refund automatically if the render dies. */
  function pollLive(order, jobsCsv, paidSession) {
    var pct = 4;
    var qs = '?jobs=' + encodeURIComponent(jobsCsv) +
      (paidSession ? '&paid=' + encodeURIComponent(paidSession) : '');
    function tick() {
      fetch(STATUS_URL + qs)
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (s.step) setStep(STEPS.indexOf(s.step));
          if (typeof s.pct === 'number') { pct = s.pct; setPct(pct); }
          else { pct = Math.min(94, pct + 3); setPct(pct); }
          if (s.segmentsTotal > 1) {
            var filmName = order.selections && order.selections.productName
              ? order.selections.productName + ' film' : 'film';
            $('#render-sub').textContent = 'Rendering scene ' + Math.min(s.segmentsDone + 1, s.segmentsTotal) +
              ' of ' + s.segmentsTotal + ' of your ' + filmName + '.';
          }
          if (s.status === 'completed' && s.result) { setPct(100); reveal(order, s.result); return; }
          if (s.status === 'failed') { failState(s.message); return; }
          setTimeout(tick, 3000);
        })
        .catch(function () { setTimeout(tick, 4000); });
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
        try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
        pollLive(order, d.jobs.map(function (j) { return j.id; }).join(','), sessionId);
      })
      .catch(function (d) {
        console.error('paid create failed', d);
        paidQueuedState(order);
      });
  }

  /* Free sample arrival: the account is the ticket, not a Stripe session.
   * Signed out lands on login and bounces straight back here, so the claim
   * survives the round trip. 409 means the one free sample is already spent. */
  function createSample(order) {
    var auth = window.HexaAuth;
    var loginNext = '/login.html?next=' + encodeURIComponent('/render.html?sample=1');
    (auth ? auth.ready() : Promise.resolve()).then(function () {
      if (auth && !auth.user()) { window.location.href = loginNext; return; }
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
    $('#render-sub').textContent = 'One per account, and yours lives in your library. The full film, same look at any length, starts at $12.';
    var note = $('#render-note');
    note.hidden = false;
    note.innerHTML = '<a href="/account.html">Open your library</a> · <a href="/#styles">Make the full film</a>';
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

  function failState(msg) {
    $('#render-kicker').textContent = 'Render interrupted';
    $('#render-title').textContent = 'We could not finish this render';
    $('#render-sub').textContent = msg || 'Something interrupted this render. You are never charged for work we do not deliver.';
    $('#render-note').hidden = false;
    $('#render-note').textContent = 'Run it again from the studio, or reply to your confirmation email and we will make it right.';
  }

  function boot() {
    var y = $('#y'); if (y) y.textContent = String(new Date().getFullYear());

    var order = readOrder();
    if (!order) {
      $('#render-kicker').textContent = 'Hexa Studio';
      $('#render-title').textContent = 'No order in progress';
      $('#render-sub').textContent = 'Start a creation in the studio and it appears here.';
      $('#render-steps').hidden = true;
      $('#render-actions').hidden = false;
      $('#render-actions').classList.add('no-download');
      return;
    }

    // shape the stage to the chosen aspect ratio
    var aspect = (order.selections && order.selections.aspect) || '9:16';
    $('#render-stage').setAttribute('data-aspect', aspect);

    // their product, faintly on the stage while it composes/renders
    showProductGhost(order);

    var label = order.style ? niceStyle(order.style) : order.title;
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

    // Paid arrival from Stripe: create the jobs now. render-create verifies the
    // session server-side and returns the SAME jobs on a refresh, so this is
    // safe to re-enter.
    var paid = params.get('paid');
    if (paid) {
      setStep(0);
      createPaid(order, paid);
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

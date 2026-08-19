/* ─────────────────────────────────────────────────────────────
   Hexa Validate: the research surface.

   Renders a report produced by research/validate.mjs. The renderer is the
   place two rules are enforced, exactly as they are in the CLI:

     no receipt, no claim        a finding with no surviving evidence is not
                                 drawn at all
     no corroboration,           a claim carried by fewer than MIN_RECEIPTS
     no conclusion               people is drawn as a weak signal, never as a
                                 finding

   Enforcing them here as well as in the CLI is deliberate. This file is what
   the customer actually reads, so it must not be possible for a malformed or
   over-confident payload to put an unsupported claim on the page.

   The report-create / report-status functions do not exist yet, so `run()`
   currently loads a sample payload. Everything below the fetch is the real
   renderer and does not change when the backend lands.
   ───────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var MIN_RECEIPTS = 3;
  var form = document.getElementById('vd-form');
  var input = document.getElementById('vd-url');
  var button = document.getElementById('vd-go');
  var progress = document.getElementById('vd-progress');
  var stepsEl = document.getElementById('vd-steps');
  var out = document.getElementById('vd-out');
  if (!form) return;

  /* ── small helpers ───────────────────────────────────────── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;      // textContent, never innerHTML
    return n;
  }
  function pct(n) { return n == null ? '?' : Math.round(n * 100) + '%'; }

  /* Capitalisation belongs to the string, not to a stylesheet. These labels
   * used to arrive lowercase and were shouted into shape by
   * `text-transform: uppercase`, so removing that treatment left "high
   * confidence" sitting in a pill looking like a bug. */
  function cap(s) {
    s = String(s == null ? '' : s);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /*
   * Said once, then referred to.
   *
   * 486 comments used to read like five, because the same sentence appeared
   * three times on one page: "Cleaning it takes longer than using it" was the
   * headline finding, then the first row of "What customers are saying", then
   * the first row of "What competitors are missing". A reader scrolling past
   * the same words three times does not conclude that we read 486 comments.
   *
   * So the answer tier and the abstract claim a finding, and the working
   * papers below show what has NOT been said yet. Nothing is deleted: a
   * section that would empty itself keeps its full list, because showing less
   * evidence to avoid a repeat is a worse trade than the repeat.
   */
  var SHOWN = {};

  function claimKey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function claimSeen(s) {
    var k = claimKey(s);
    return !!(k && SHOWN[k]);
  }
  function claimShown(s) {
    var k = claimKey(s);
    if (k) SHOWN[k] = 1;
    return s;
  }

  /*
   * One icon family, drawn from paths. Same reasoning as the account rail:
   * an emoji is not an icon. 🔥 and ⚠️ render as a different picture on every
   * platform, they carry the vendor's colour into a palette that did not ask
   * for it, and at 16px on Windows they are a different weight from the text
   * beside them. On a page whose whole argument is "we measured this", a row
   * of holiday stickers is the wrong voice.
   */
  var ICONS = {
    pain:    'M12 3c0 4-4 4-4 8a4 4 0 0 0 8 0c0-2-1-3-1-3M9 21h6',
    worry:   'M12 9v4M12 17h.01M10.3 4.3 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z',
    covered: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    open:    'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z',
    persona: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0M17 11a4 4 0 0 0 0-8M18 21a7 7 0 0 0-2-5',
    problem: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM8 16s1.5-2 4-2 4 2 4 2M9 9h.01M15 9h.01',
    angle:   'M6 4h12v6a6 6 0 0 1-12 0V4ZM6 6H4a2 2 0 0 0 2 4M18 6h2a2 2 0 0 1-2 4M9 21h6M12 16v5',
  };

  function svgIcon(id, cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    (ICONS[id] || ICONS.open).split(' M').forEach(function (seg, i) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', (i ? 'M' : '') + seg.trim());
      svg.appendChild(p);
    });
    return svg;
  }

  /* Auth loads asynchronously, so both of these are only trustworthy after
   * HexaAuth.ready(). Asked before that, a signed-in visitor reads as anonymous
   * and silently gets the free report instead of the deep one they are owed. */
  function isSignedIn() {
    return !!(window.HexaAuth && window.HexaAuth.user && window.HexaAuth.user());
  }
  function authReady() {
    return (window.HexaAuth && window.HexaAuth.ready())
      || Promise.resolve();          // page loaded without the auth bundle
  }
  function authHeaders() {
    var token = window.HexaAuth && window.HexaAuth.accessToken && window.HexaAuth.accessToken();
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  /*
   * Where every gate on this page sends people, in one place because three of
   * them exist and they used to disagree.
   *
   * Both parameters do work. `mode=signup` puts login.html in its create-an
   * account state rather than its sign-in state, which is what somebody who
   * has never been here needs to see. `next` brings them back HERE rather than
   * to the account page, because the report is on this screen and the payoff
   * for signing up unlocks in place: no celebration interstitial between a
   * visitor and the thing they just signed up for.
   *
   * The claim token is deliberately absent. It is a bearer credential, and a
   * URL is the one place text ends up in history, referrers and screenshots.
   */
  function signupHref() {
    return '/login.html?mode=signup&next=' + encodeURIComponent('/validate');
  }

  /*
   * Funnel counters. Four of them across the flow, so "the free ad converts
   * better than the old clip did" can be settled with a number instead of a
   * conviction. Fired at most once per kind per page load: a gate that scrolls
   * in and out of view has still only been seen once.
   */
  var gatesSeen = {};
  function gateSeen(kind) {
    if (gatesSeen[kind]) return;
    gatesSeen[kind] = true;
    if (window.hexaTrack) window.hexaTrack('gate-seen', kind);
  }
  function gateClicked(kind) {
    if (window.hexaTrack) window.hexaTrack('gate-clicked', kind);
  }

  /*
   * The angle a free ad would actually be built from, or null.
   *
   * Checked before the gate promises an ad, because a warm read can come back
   * with an empty `angles` array: it has happened on real data, when 698
   * records produced no angles at all because the format brief was missing.
   * Promising an ad we cannot make is worse than not offering one.
   *
   * The fallback is the strongest customer theme, which is a real finding with
   * its own receipts rather than an invention, and reads as a headline on its
   * own. Only when there is not even that does the offer come off the page.
   */
  function usableAngle(report) {
    var a = (report.angles || [])[0];
    if (a && (a.headline || a.claim)) return a;
    var top = byReceipts(report.pains)[0] || byReceipts(report.wishes)[0];
    if (!top) return null;
    return {
      claim: top.claim,
      headline: top.claim,
      hook: '',
      format: 'static',
      persona: '',
      evidence: top.evidence || [],
    };
  }

  /* House style: no em dashes or en dashes in copy we author. Models reach for
   * them constantly, so it is enforced at the render layer rather than asked
   * for in a prompt. Quoted evidence is never passed through here: a quote that
   * has been tidied is no longer a quote. */
  function voice(s) {
    return String(s == null ? '' : s)
      .replace(/(\d)\s*[—–]\s*(\$?\d)/g, '$1 to $2')
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/,\s*,/g, ',')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim();
  }

  /* ── progress, reusing the existing .render-steps component ─ */

  /*
   * These are the worker's real stages, in the order it runs them, keyed so the
   * bar advances on what is actually happening rather than on a timer.
   *
   * `harvesting` and `reading` share a row on purpose: a warm category reads
   * straight from the corpus and never harvests, and a step that lights only
   * sometimes teaches the reader that the bar is decorative.
   *
   * `ads` only ever lights for a signed-in report, which is the point: the
   * visitor watching the free version can see the leg they are not getting.
   */
  /* Named for what the merchant gets, not for what the worker runs. "Crawling
   * Reddit" and "pulling competitor ads and run dates" describe our plumbing;
   * nobody waiting on this cares which API is being called, only that the wait
   * is buying them something. */
  var STEPS = [
    { key: 'building',   label: 'Understanding your product' },
    { key: 'harvesting', label: 'Finding what customers care about' },
    { key: 'reading',    label: 'Checking competing products' },
    { key: 'ads',        label: 'Studying how similar products are advertised' },
    { key: 'angles',     label: 'Finding an angle worth testing' }
  ];
  var STEP_INDEX = STEPS.reduce(function (m, s, i) { m[s.key] = i; return m; }, {});
  STEP_INDEX.harvesting = 1;
  STEP_INDEX.reading = 2;

  /* The landing pitch and a running read are two different pages sharing one
     URL. Whichever is not happening should not be on screen. */
  function showLanding(on) {
    var w = document.getElementById('what');
    if (w) w.hidden = !on;
  }

  function startSteps() {
    showLanding(false);
    progress.hidden = false;
    stepsEl.textContent = '';
    reached = 0;
    STEPS.forEach(function (s, i) {
      var li = el('li', 'render-step' + (i === 0 ? ' active' : ''));
      li.appendChild(el('span', 'dot'));
      li.appendChild(el('span', 'render-step-label', s.label));
      stepsEl.appendChild(li);
    });
  }
  /* Monotonic. Two things drive this (the local ticker and the worker's own
   * stage) and they do not agree; a bar that jumps backwards looks broken even
   * when the run behind it is healthy. */
  var reached = 0;
  function advance(i) {
    if (i < reached) return;
    reached = i;
    var items = stepsEl.children;
    for (var k = 0; k < items.length; k++) {
      items[k].className = 'render-step' + (k < i ? ' done' : k === i ? ' active' : '');
    }
  }

  /* ── components ──────────────────────────────────────────── */

  /*
   * A receipt, attributed to where it actually came from.
   *
   * Reviews on the merchant's own product page and comments in a forum are
   * both real evidence and they are not the same kind of thing: one is a
   * verified buyer of this exact product, the other is a stranger discussing
   * the category. Drawing a review with "r/" in front of it would be a
   * fabrication in the one place this product cannot afford one, and the score
   * line means different things too, so neither is reused across sources.
   */
  function evidenceCard(rec) {
    var card = el('div', 'ev-card' + (rec.source === 'reviews' ? ' ev-card-review' : ''));
    card.appendChild(el('blockquote', null, rec.text));
    var meta = el('div', 'ev-meta');

    if (rec.source === 'reviews') {
      meta.appendChild(el('span', 'ev-badge', 'Your reviews'));
      var where = el('a', null, 'on your product page');
      where.href = rec.url || '#';
      where.target = '_blank';
      where.rel = 'noopener nofollow';
      meta.appendChild(where);
    } else {
      var a = el('a', null, rec.sub ? 'r/' + rec.sub : (rec.source || 'source'));
      a.href = rec.url || '#';
      a.target = '_blank';
      a.rel = 'noopener nofollow';
      meta.appendChild(a);
      if (rec.score != null) meta.appendChild(el('span', 'ev-score', rec.score + ' points'));
    }

    card.appendChild(meta);
    return card;
  }

  /* A finding only reaches the page with its receipts attached. */
  function findingBlock(f, n) {
    var cites = (f.evidence || []).filter(function (c) { return c && c.text; });
    if (!cites.length) return null;

    var wrap = el('div', 'vd-finding');
    wrap.appendChild(el('h3', null, n + '. ' + voice(f.claim)));

    var communities = {};
    cites.forEach(function (c) { if (c.sub) communities[c.sub] = 1; });
    var nComm = Object.keys(communities).length;

    var badge = el('p', 'vd-corrob');
    var strong = el('strong', null, String(cites.length));
    badge.appendChild(strong);
    badge.appendChild(document.createTextNode(
      ' people raised this independently' + (nComm > 1 ? ' across ' + nComm + ' communities' : '')
    ));
    wrap.appendChild(badge);

    if (f.why_it_works) wrap.appendChild(el('p', 'vd-lede', voice(f.why_it_works)));

    /*
     * Only three receipts are drawn, so which three matters.
     *
     * A finding backed by both forum comments and the merchant's own reviews
     * used to show whichever the model happened to cite first, which meant a
     * verified buyer of this exact product could be cut for a stranger
     * discussing the category. First-party evidence leads. The count above is
     * unchanged and still counts every receipt, so nothing is hidden by this,
     * it is only ordered.
     */
    var ordered = cites.slice().sort(function (a, b) {
      return (b.source === 'reviews' ? 1 : 0) - (a.source === 'reviews' ? 1 : 0);
    });
    ordered.slice(0, 3).forEach(function (c) { wrap.appendChild(evidenceCard(c)); });
    return wrap;
  }

  function section(title, findings, lede) {
    if (!findings || !findings.length) return null;

    var scored = findings.map(function (f) {
      return { f: f, n: ((f.evidence || []).filter(function (c) { return c && c.text; })).length };
    }).filter(function (x) { return x.n > 0; })
      .sort(function (a, b) { return b.n - a.n; });

    var strongOnes = scored.filter(function (x) { return x.n >= MIN_RECEIPTS; });
    var weak = scored.filter(function (x) { return x.n < MIN_RECEIPTS; });
    if (!strongOnes.length && !weak.length) return null;

    var sec = el('section', 'vd-section');
    sec.appendChild(el('h2', null, title));
    if (lede) sec.appendChild(el('p', 'vd-lede', lede));

    strongOnes.forEach(function (x, i) {
      var b = findingBlock(x.f, i + 1);
      if (b) sec.appendChild(b);
    });

    if (weak.length) {
      var note = el('div', 'vd-thin');
      note.appendChild(el('strong', null, 'Weaker signals. '));
      note.appendChild(document.createTextNode(
        'Raised by fewer than ' + MIN_RECEIPTS + ' people each, so treat these as leads to watch rather than conclusions to act on: '
      ));
      note.appendChild(document.createTextNode(
        weak.map(function (x) { return voice(x.f.claim); }).join(' ')
      ));
      sec.appendChild(note);
    }
    return sec;
  }

  /* The format verdict. Numbers come from the deterministic calculation in
   * research/lib/ads.mjs; nothing here recomputes or softens them. */
  function formatSection(fv) {
    if (!fv || !fv.sample || !fv.sample.typed) return null;
    var sec = el('section', 'vd-section');
    sec.appendChild(el('h2', null, 'Should you run video or images?'));

    var card = el('div', 'fmt-card');

    if (!fv.verdict) {
      var thin = el('div', 'vd-thin');
      thin.appendChild(el('strong', null, 'Not enough competitor evidence to call a format yet. '));
      thin.appendChild(document.createTextNode(voice(fv.reason || '')));
      card.appendChild(thin);
      sec.appendChild(card);
      return sec;
    }

    var head = el('div', 'fmt-head');
    var v = el('div', 'fmt-verdict');
    v.appendChild(document.createTextNode('Run '));
    v.appendChild(el('em', null, fv.verdict));
    head.appendChild(v);
    head.appendChild(el('span', 'fmt-conf', cap(fv.confidence) + ' confidence'));
    card.appendChild(head);
    card.appendChild(el('p', 'fmt-why', voice(fv.reason) + '.'));

    var split = el('div', 'fmt-split');
    [
      { label: 'Winners (' + fv.longRunners.cohortDays + '+ days)', share: fv.longRunners.videoShare,
        n: fv.longRunners.total + ' ads', muted: false },
      { label: 'All ads', share: fv.raw.videoShare, n: fv.raw.total + ' ads', muted: true },
      { label: 'Days of spend', share: fv.durationWeighted.videoShare, n: 'weighted', muted: true }
    ].forEach(function (row) {
      var r = el('div', 'fmt-split-row' + (row.muted ? ' is-muted' : ''));
      r.appendChild(el('span', 'fmt-split-label', row.label));
      var track = el('div', 'fmt-split-track');
      var fill = el('span');
      fill.style.width = Math.round((row.share || 0) * 100) + '%';
      track.appendChild(fill);
      r.appendChild(track);
      r.appendChild(el('span', 'fmt-split-val', pct(row.share) + ' video'));
      split.appendChild(r);
    });
    card.appendChild(split);

    if (fv.sample.untyped) {
      card.appendChild(el('p', 'vd-lede',
        fv.sample.untyped + ' ad' + (fv.sample.untyped === 1 ? '' : 's') +
        ' had no readable creative type and are excluded from these ratios rather than guessed at.'));
    }
    sec.appendChild(card);
    return sec;
  }

  /*
   * The gap: what buyers complain about that competitors are not answering.
   *
   * Drawn immediately after the verdict because it is the only section here
   * that tells someone what to DO rather than what is true. Everything else
   * reports the market; this one subtracts one half from the other.
   *
   * A complaint with zero competitor coverage gets the emphasis, and a
   * well-covered one is still drawn rather than hidden: knowing a lane is
   * crowded is what stops someone spending on a message the market has already
   * heard from four other brands.
   */
  function whitespaceSection(ws) {
    if (!ws || !ws.themes || !ws.themes.length) return null;

    var sec = el('section', 'vd-section');
    sec.appendChild(el('h2', null, 'What competitors are missing'));
    sec.appendChild(el('p', 'vd-lede',
      'Your buyers raised these, and we checked every competitor ad we could read (' + ws.adsRead +
      ' of them) to see who answers them. An open lane is a complaint the market has and the advertising has not caught up with.'));

    ws.themes.forEach(function (t) {
      var open = t.adsAddressing === 0;
      var row = el('div', 'gap-row' + (open ? ' is-open' : ''));

      var head = el('div', 'gap-head');
      head.appendChild(el('span', 'gap-tag', open ? 'Open lane' : t.adsAddressing + ' already on it'));
      head.appendChild(el('span', 'gap-people', t.people + ' people raised this'));
      row.appendChild(head);

      row.appendChild(el('p', 'gap-claim', voice(t.claim)));

      /* The bar reads as coverage, so an empty one is the opportunity. */
      var track = el('div', 'gap-track');
      var fill = el('span');
      var share = ws.adsRead ? Math.min(1, t.adsAddressing / Math.max(1, ws.adsRead * 0.25)) : 0;
      fill.style.width = Math.round(share * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);

      row.appendChild(el('p', 'gap-note', open
        ? 'Not one competitor ad we read addresses this.'
        : t.adsAddressing + ' of ' + ws.adsRead + ' competitor ads address this.'));

      sec.appendChild(row);
    });
    return sec;
  }

  /* Competitor ads, longest-running first. A duration is drawn only when it is
   * evidenced; durationConfidence 'none' shows no number at all. */
  function adsSection(ads) {
    if (!ads || !ads.length) return null;
    var dated = ads.filter(function (a) { return a.durationConfidence !== 'none' && a.daysRunning != null; });
    if (!dated.length) return null;

    var longest = dated.reduce(function (m, a) { return Math.max(m, a.daysRunning); }, 1);
    var sec = el('section', 'vd-section');
    sec.appendChild(el('h2', null, 'What competitors are doing'));
    sec.appendChild(el('p', 'vd-lede',
      'Sorted by how long each ad has been running. Nobody keeps paying to run an ad that does not convert, so the top of this list is what the market has already proven.'));

    dated.slice(0, 10).forEach(function (ad) {
      var row = el('div', 'dur-row');
      row.setAttribute('data-confidence', ad.durationConfidence);

      var left = el('div');
      left.appendChild(el('div', 'dur-name', ad.advertiser || 'Unknown advertiser'));
      left.appendChild(el('div', 'dur-sub',
        (ad.creative || 'unknown') + (ad.landingDomain ? ' · ' + ad.landingDomain : '')));
      var bar = el('div', 'dur-bar');
      var fill = el('span');
      fill.style.width = Math.max(2, Math.round((ad.daysRunning / longest) * 100)) + '%';
      bar.appendChild(fill);
      left.appendChild(bar);
      row.appendChild(left);

      var days = el('div', 'dur-days', ad.daysRunning + 'd');
      if (ad.durationConfidence === 'observed') days.appendChild(el('em', null, ' still live'));
      row.appendChild(days);
      sec.appendChild(row);
    });
    return sec;
  }

  /*
   * The handoff from research to creative.
   *
   * An angle that ends in "go and use the composer" is a document, not a
   * product: the reader has to retype the hook we just proved and pick the
   * format we just measured. So the whole angle travels to the studio, which
   * prefills the link, opens the right product for the measured format, and
   * drops the hook straight into the creative direction.
   *
   * localStorage rather than a query string: hooks and headlines are the
   * customer's words and their competitors' weaknesses, and a URL is the one
   * place text ends up in browser history, shared screenshots and referrer
   * headers. Short-lived for the same reason.
   */
  var ANGLE_KEY = 'hexa-angle';
  var ANGLE_TTL_MS = 60 * 60 * 1000;

  function sendToStudio(angle, report, wantStatic) {
    try {
      localStorage.setItem(ANGLE_KEY, JSON.stringify({
        v: 1,
        ts: Date.now(),
        url: report.url || '',
        product: wantStatic ? 'adpack' : 'mode:ugc',
        claim: voice(angle.claim || ''),
        hook: voice(angle.hook || ''),
        headline: voice(angle.headline || ''),
        persona: voice(angle.persona || ''),
        format: angle.format || 'both',
        receipts: (angle.evidence || []).length,
      }));
    } catch (e) { /* private mode: the studio still opens, just without the brief */ }
    window.location.href = '/#composer';
  }

  /*
   * Render the recommended angle as a real ad, free.
   *
   * Posts the same order shape the studio would build, plus the report id and
   * its claim token, which is what buys the free render server side.
   *
   * Split in two because it now has two callers with opposite needs. A visitor
   * who presses the button wants to watch it being made, so that path hands
   * off to the render page. A visitor who has just come back from signing up
   * wants the report they came back for, so that path starts the same job and
   * says so in the band without moving them anywhere.
   */
  function freeAdOrder(angle, report) {
    var saved = stored();
    return {
      product: 'adsingle',
      title: 'Your first ad',
      freeReport: { id: report.id, claim: (saved && saved.claim) || '' },
      selections: {
        link: report.url || '',
        headline: voice(angle.headline || angle.claim || ''),
        directions: voice(angle.hook || ''),
        productName: report.product_title || '',
        aspect: '4:5',
      },
      ts: new Date().toISOString(),
    };
  }

  function startFreeAd(order) {
    return fetch('/.netlify/functions/render-create', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ order: order }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (!d.jobs || !d.jobs.length) return Promise.reject(d);
        // The render page reads the order back out of localStorage.
        try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
        return d.jobs.map(function (j) { return j.id; }).join(',');
      });
  }

  function makeFreeAd(angle, report, btn) {
    btn.disabled = true;
    btn.textContent = 'Making it…';

    startFreeAd(freeAdOrder(angle, report))
      .then(function (jobs) {
        window.location.href = '/render.html?jobs=' + encodeURIComponent(jobs);
      })
      .catch(function (d) {
        btn.disabled = false;
        btn.textContent = 'Make this ad, free';
        var msg = (d && d.error) || 'We could not start that one. Try again in a moment.';
        var note = el('p', 'vd-call-err', msg);
        var host = btn.parentNode;
        var old = host.parentNode.querySelector('.vd-call-err');
        if (old) old.remove();
        host.parentNode.appendChild(note);
      });
  }

  function angleCard(a, report) {
    var card = el('div', 'angle-card');
    card.appendChild(el('h3', null, voice(a.claim)));
    if (a.persona) card.appendChild(el('p', 'angle-persona', voice(a.persona)));

    if (a.hook) {
      var h = el('div', 'angle-line');
      h.appendChild(el('b', null, 'Opening line'));
      h.appendChild(el('q', null, voice(a.hook)));
      card.appendChild(h);
    }
    if (a.headline) {
      var s = el('div', 'angle-line');
      s.appendChild(el('b', null, 'Line on the image'));
      s.appendChild(el('q', null, voice(a.headline)));
      card.appendChild(s);
    }

    /* Every angle ends in something buyable, and which action leads is decided
     * by the measured format verdict rather than by preference. */
    var actions = el('div', 'angle-actions');
    var wantsStatic = a.format === 'static';
    var video = el('button', wantsStatic ? 'is-ghost' : 'is-primary', 'Make this video');
    video.type = 'button';
    video.addEventListener('click', function () { sendToStudio(a, report, false); });
    var stat = el('button', wantsStatic ? 'is-primary' : 'is-ghost', 'Make the static ads');
    stat.type = 'button';
    stat.addEventListener('click', function () { sendToStudio(a, report, true); });
    actions.appendChild(wantsStatic ? stat : video);
    actions.appendChild(wantsStatic ? video : stat);
    card.appendChild(actions);
    return card;
  }

  /* ── what sign-in buys ───────────────────────────────────── */

  /*
   * Not a paywall. An offer for work we have not done yet.
   *
   * This used to blur the bottom half of the report. That was wrong twice
   * over: it hid findings we had already computed and were giving away anyway,
   * and for an anonymous read the blurred sections were mostly empty, because
   * the competitor legs never ran. So the reader was shown a smudge over
   * nothing and asked to sign up for it.
   *
   * Now the free read shows everything it found, and this card names the one
   * thing it did not do: read the competition. That is a real, expensive leg
   * (the ads pull is $0.466 of a deep report) and it is worth an email in a way
   * that hiding our own conclusions never was.
   */
  function unlockCard(report) {
    var sec = el('section', 'vd-section vd-unlock');
    var angle = usableAngle(report);

    /*
     * Led by the ad, not by the credits.
     *
     * This card used to open on the competition read and close on "2,500
     * credits", and credits are the wrong currency for somebody who has never
     * bought anything here: nobody can price a credit until they have seen
     * what one buys. The ad is the same offer stated as an object. It costs us
     * about 2.6 cents, it is made from the angle already on their screen, and
     * it turns a signup from a promise into a delivery.
     */
    if (angle) {
      sec.appendChild(el('h2', null, 'Sign in free and we make this ad'));
      sec.appendChild(el('p', 'vd-lede',
        'We take the angle above and build you a real static ad from your own product. No card, ' +
        'nothing to cancel, and your report stays exactly where it is.'));
      var line = el('div', 'unlock-angle');
      line.appendChild(el('b', null, 'The line it runs'));
      line.appendChild(el('q', null, voice(angle.headline || angle.claim)));
      sec.appendChild(line);
      sec.appendChild(el('h3', 'unlock-more', 'And your welcome credits cover the competition read'));
    } else {
      sec.appendChild(el('h2', null, 'Now let us read your competition'));
      sec.appendChild(el('p', 'vd-lede',
        'Everything above came from your customers. What we have not done yet is look at what your ' +
        'competitors are already saying, which is what turns a good angle into an unclaimed one.'));
    }

    var list = el('ul', 'unlock-list');
    [
      ['Every ad running in your category', 'Pulled from the public ad library, with the date each one went live.'],
      ['Which of them are actually working', 'An ad still running after six months is proven. One that lasted four days was a guess.'],
      ['What nobody is saying', 'The complaints your customers keep raising that no competitor ad answers.'],
      ['Video or statics', 'Measured from what survives longest in your category, not from what we would rather sell you.'],
    ].forEach(function (row) {
      var li = el('li');
      li.appendChild(el('strong', null, row[0]));
      li.appendChild(el('span', null, row[1]));
      list.appendChild(li);
    });
    sec.appendChild(list);

    /*
     * The grant, said in what it buys and in the right order.
     *
     * Two corrections live in this sentence. The number: 2,500 credits is two
     * full reads at 1,000 each, not the five single ads the catalogue note
     * still claims. And the sequence: signing in does not retroactively add
     * the competitor legs to THIS report, because those legs never ran and a
     * finished row cannot grow them. A full read is a second run against the
     * welcome credits. Saying "unlock" would be a small lie, and the four
     * lines above would be the thing it was lying about.
     */
    sec.appendChild(el('p', 'unlock-credits',
      'A free account starts with 2,500 credits, which covers two full reads. This report is saved to ' +
      'the account either way, so nothing here has to be pasted twice.'));

    var cta = el('a', 'btn btn-primary', angle ? 'Make this ad, free' : 'Read my competition, free');
    cta.href = signupHref();
    cta.addEventListener('click', function () { gateClicked('report'); });
    sec.appendChild(cta);
    gateSeen('report');
    return sec;
  }

  /* ── the answers ─────────────────────────────────────────── */

  /* Findings arrive in the model's order; everywhere a single "top" one is
   * shown, weight of evidence decides which, exactly as the full sections do. */
  function byReceipts(list) {
    return (list || [])
      .filter(function (f) { return f && f.claim && (f.evidence || []).length; })
      .slice()
      .sort(function (a, b) { return (b.evidence || []).length - (a.evidence || []).length; });
  }

  function themes(ws, open) {
    return ((ws && ws.themes) || [])
      .filter(function (t) { return open ? t.adsAddressing === 0 : t.adsAddressing > 0; })
      .slice()
      .sort(function (a, b) {
        return open ? (b.people || 0) - (a.people || 0)
                    : (b.adsAddressing || 0) - (a.adsAddressing || 0);
      });
  }

  /*
   * What we found, in four lines.
   *
   * The report underneath holds every quote and every competitor ad, and a
   * merchant who has never run an ad does not want to be handed a research
   * dashboard and asked to draw the conclusion themselves. So the page answers
   * first and shows the working after. Nothing here is new analysis: each line
   * is the highest-evidence item from a section that already exists further
   * down, which is why "see research" is a scroll and not another request.
   */
  function summarySection(report) {
    var rows = [];
    var pain = byReceipts(report.pains)[0];
    var worry = byReceipts(report.objections)[0];
    var covered = themes(report.whitespace, false)[0];
    var open = themes(report.whitespace, true)[0];

    if (pain) rows.push(['pain', 'Customers care about', voice(pain.claim)]);
    if (worry) rows.push(['worry', 'Customers worry about', voice(worry.claim)]);
    if (covered) {
      rows.push(['covered', 'Competitors are mostly selling', voice(covered.claim)]);
    }

    /*
     * The opportunity is usually the loudest complaint, which is usually also
     * the pain on the first row. Printed straight, the summary says the same
     * sentence twice and reads like a bug. So a repeat becomes the sentence it
     * was always meant to be: the same finding, stated as the opening nobody
     * else has taken.
     */
    if (open) {
      var shown = rows.map(function (r) { return r[2].toLowerCase(); });
      var fresh = themes(report.whitespace, true).filter(function (t) {
        return shown.indexOf(voice(t.claim).toLowerCase()) < 0;
      })[0];
      rows.push(['open', 'Your opportunity', fresh
        ? voice(fresh.claim) + ' Not one competitor ad we read is saying it.'
        : 'Lead with that first complaint. Not one competitor ad we read answers it, so it is the opening nobody has taken.']);
    }
    /*
     * The angle card, directly above, has already named the biggest problem.
     * Printing it again here is what made 486 comments read like five. The
     * abstract yields rather than the answer, but only while it still has
     * enough left to be an abstract.
     */
    var fresh = rows.filter(function (r) { return !claimSeen(r[2]); });
    if (fresh.length >= 2) rows = fresh;

    if (rows.length < 2) return null;

    var sec = el('section', 'vd-section vd-found');
    sec.appendChild(el('h2', null, 'What we found'));
    var list = el('div', 'found-list');
    rows.forEach(function (r) {
      claimShown(r[2]);
      var row = el('div', 'found-row');
      row.appendChild(svgIcon(r[0], 'found-ico'));
      var body = el('div', 'found-body');
      body.appendChild(el('p', 'found-label', r[1]));
      body.appendChild(el('p', 'found-claim', r[2]));
      row.appendChild(body);
      list.appendChild(row);
    });
    sec.appendChild(list);

    var more = el('button', 'found-more', 'See research →');
    more.type = 'button';
    more.addEventListener('click', function () {
      var target = document.getElementById('vd-evidence');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    sec.appendChild(more);
    return sec;
  }

  /*
   * Demand, competition and opportunity as words.
   *
   * These were the obvious candidates for a row of 0 to 100 scores, and a
   * score is exactly the thing a non-marketer cannot act on: nobody knows
   * whether 63 saturation is a reason to run or a reason to stop. So the
   * banding is stated in words with the reason attached, and the counts the
   * band came from sit under "view details" for anyone who wants to argue with
   * the arithmetic. Every number here is measured, never modelled.
   */
  function band(n, strong, mid, words) {
    return n >= strong ? words[0] : n >= mid ? words[1] : words[2];
  }

  function strengthSection(report) {
    var comments = (report.stats && report.stats.comments) || 0;
    var subs = (report.stats && report.stats.subreddits) || 0;
    var ads = report.adsAnalysed || 0;
    var open = themes(report.whitespace, true).length;
    if (!comments && !ads) return null;

    var rows = [];
    if (comments) {
      rows.push({
        name: 'Demand',
        word: band(comments, 400, 120, ['Strong', 'Moderate', 'Quiet']),
        why: band(comments, 400, 120, [
          'Lots of people are actively discussing this problem.',
          'A steady amount of discussion, enough to read a pattern from.',
          'Not much public discussion, so treat the findings as leads rather than proof.',
        ]),
        detail: comments + ' comments read across ' + subs + ' communities.',
      });
    }
    if (ads) {
      rows.push({
        name: 'Competition',
        word: band(ads, 30, 10, ['High', 'Moderate', 'Low']),
        why: band(ads, 30, 10, [
          'Many brands are already advertising products like this.',
          'A handful of brands are advertising against you.',
          'Very few competitors are running ads we can find.',
        ]),
        detail: ads + ' live competitor ads read from the public ad library.',
      });
    }
    if (report.whitespace) {
      rows.push({
        name: 'Opportunity',
        word: band(open, 2, 1, ['Good', 'Fair', 'Tight']),
        why: open >= 2
          ? 'Several things your customers keep raising are not being answered by any competitor ad.'
          : open === 1
            ? 'One thing your customers keep raising is not being answered by any competitor ad.'
            : 'Competitors are already answering the things your customers raise, so the win has to come from doing it better.',
        detail: open + ' of ' + (((report.whitespace || {}).themes || []).length) +
          ' customer concerns have no competitor ad addressing them.',
      });
    }
    if (!rows.length) return null;

    var sec = el('section', 'vd-section');
    sec.appendChild(el('h2', null, 'Is this worth advertising?'));
    var grid = el('div', 'str-grid');
    rows.forEach(function (r) {
      var card = el('div', 'str-card');
      card.appendChild(el('p', 'str-name', r.name));
      card.appendChild(el('p', 'str-word', r.word));
      card.appendChild(el('p', 'str-why', r.why));
      var det = document.createElement('details');
      det.className = 'str-det';
      var sum = document.createElement('summary');
      sum.textContent = 'View details';
      det.appendChild(sum);
      det.appendChild(el('p', null, r.detail));
      card.appendChild(det);
      grid.appendChild(card);
    });
    sec.appendChild(grid);
    return sec;
  }

  /* ── the recommendation ──────────────────────────────────── */

  /*
   * One decision, at the top, before any of the research.
   *
   * The report underneath is complete and stays complete, but a shop owner who
   * has never run an ad does not want thirteen findings and thirty-nine quotes;
   * they want to know what to do. So the page now opens with a single call:
   * the angle we would run, the gap it exploits, the line to open with, and one
   * button that makes it. Everything that justifies the call is still one click
   * away for the person who wants to check our working.
   *
   * The angle is not re-ranked here. The engine already orders angles by weight
   * of evidence, so the first one is the recommendation, and the gap shown
   * beside it is the loudest complaint with the least competitor coverage,
   * which is the ordering findWhitespace already computed.
   */
  function recommendation(report) {
    var top = (report.angles || [])[0];
    if (!top) return null;

    var sec = el('section', 'vd-section vd-call');
    sec.appendChild(el('p', 'vd-call-kicker', "If we were advertising this product, we'd start here"));

    /*
     * The four answers, in the order a merchant asks them: who buys this, what
     * is wrong for them, what we would say about it, and what to open with.
     * The claim used to be the whole block; on its own it reads as a slogan
     * with no owner, and the persona and pain that justify it were buried in
     * sections most people never scrolled to.
     */
    var pain = byReceipts(report.pains)[0];
    var answers = [];
    if (top.persona) answers.push(['persona', 'Your likely customer', voice(top.persona)]);
    if (pain) answers.push(['problem', 'Their biggest problem', voice(pain.claim)]);
    answers.forEach(function (a) {
      claimShown(a[2]);
      var row = el('div', 'call-answer');
      row.appendChild(svgIcon(a[0], 'call-answer-ico'));
      var body = el('div');
      body.appendChild(el('p', 'call-answer-label', a[1]));
      body.appendChild(el('p', 'call-answer-text', a[2]));
      row.appendChild(body);
      sec.appendChild(row);
    });

    var claimLabel = el('p', 'call-answer-label call-claim-label');
    claimLabel.appendChild(svgIcon('angle', 'call-answer-ico'));
    claimLabel.appendChild(el('span', null, 'Your strongest angle'));
    sec.appendChild(claimLabel);
    sec.appendChild(el('h2', 'vd-call-claim', claimShown(voice(top.claim))));

    /* Why, in one line, from measured things rather than adjectives. */
    var reasons = [];
    if ((top.evidence || []).length) {
      reasons.push((top.evidence.length) + ' different people raised this');
    }
    var gap = themes(report.whitespace, true)[0];
    if (gap) reasons.push('and no competitor ad we read is saying it');
    if (report.format_verdict && report.format_verdict.verdict) {
      reasons.push('Your category runs ' + report.format_verdict.verdict);
    }
    if (reasons.length) {
      sec.appendChild(el('p', 'vd-call-why', reasons.join(', ').replace(', Your', '. Your') + '.'));
    }

    if (top.hook || top.headline) {
      var line = el('div', 'vd-call-line');
      line.appendChild(el('b', null, 'Open with'));
      line.appendChild(el('q', null, voice(top.hook || top.headline)));
      sec.appendChild(line);
    }

    /*
     * Explainability, folded away.
     *
     * A recommendation nobody can interrogate is a guess with confidence, and
     * a recommendation that shows its arithmetic up front is a research report
     * again. So the counts live one disclosure down, phrased as the question
     * an unconvinced merchant would actually ask.
     */
    var why = document.createElement('details');
    why.className = 'call-why';
    var sum = document.createElement('summary');
    sum.textContent = 'Why are you saying this?';
    why.appendChild(sum);
    var bullets = el('ul', 'call-why-list');
    if ((top.evidence || []).length) {
      bullets.appendChild(el('li', null,
        'We found ' + top.evidence.length + ' separate customer comments making this point.'));
    }
    if (report.stats && report.stats.comments) {
      bullets.appendChild(el('li', null,
        'They came out of ' + report.stats.comments + ' comments read across ' +
        (report.stats.subreddits || 1) + ' communities.'));
    }
    if (report.adsAnalysed) {
      bullets.appendChild(el('li', null,
        'We read ' + report.adsAnalysed + ' live competitor ads to see who already says it.'));
    }
    var covered = themes(report.whitespace, false)[0];
    if (covered) {
      bullets.appendChild(el('li', null,
        covered.adsAddressing + ' competitor ads lead on "' + voice(covered.claim).replace(/\.$/, '') + '" instead.'));
    }
    why.appendChild(bullets);
    var src = el('button', 'call-why-src', 'View sources →');
    src.type = 'button';
    src.addEventListener('click', function () {
      var target = document.getElementById('vd-evidence');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    why.appendChild(src);
    sec.appendChild(why);

    var act = el('div', 'vd-call-actions');
    var wantsStatic = top.format === 'static';

    /*
     * The free one, and what it costs depends only on whether they have an
     * account: nothing either way, but an anonymous visitor signs in first.
     *
     * The report itself is the free thing that needs nothing, and it is the
     * larger half: everything above this line was computed and given away
     * without an email. The ad is what the account buys, which is why this
     * button changes shape rather than disappearing. Same promise, same words,
     * one extra step, and the report is waiting when they come back.
     */
    if (isSignedIn()) {
      var free = el('button', 'is-primary', 'Make this ad, free →');
      free.type = 'button';
      free.addEventListener('click', function () { makeFreeAd(top, report, free); });
      act.appendChild(free);
    } else {
      var gate = el('a', 'is-primary', 'Make this ad, free →');
      gate.href = signupHref();
      gate.addEventListener('click', function () { gateClicked('recommendation'); });
      act.appendChild(gate);
      gateSeen('recommendation');
    }

    /* Not "make this as a video": the studio now asks what the ad should do
     * before it picks a format, so naming one here would answer that question
     * on the way in and make the two buttons read as the same offer twice. */
    var make = el('button', 'is-ghost', 'Choose how it gets made');
    make.type = 'button';
    make.addEventListener('click', function () { sendToStudio(top, report, wantsStatic); });
    act.appendChild(make);

    /* One primary recommendation is the whole point, so the alternatives are
     * offered as a scroll rather than laid out beside it competing for the
     * decision. */
    if ((report.angles || []).length > 1) {
      var others = el('button', 'is-ghost', 'See other angles');
      others.type = 'button';
      others.addEventListener('click', function () {
        var target = document.getElementById('vd-angles');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      act.appendChild(others);
    }
    sec.appendChild(act);
    return sec;
  }

  /* ── render ──────────────────────────────────────────────── */

  function render(report) {
    var signedIn = isSignedIn();
    out.textContent = '';
    out.hidden = false;
    SHOWN = {};

    /*
     * Three tiers, and a rail.
     *
     * The page used to be eleven sections of identical weight, stacked, with
     * no way to jump: a heading over a dark rounded box, eleven times, 7,000px
     * tall. The format verdict, the one thing on the page a merchant can act
     * on this afternoon, was the fourth of them, sitting between "The short
     * version" and "What customers are saying" as a small bar chart in a box.
     *
     * So: the answer opens the page, the reasoning follows it, and the raw
     * material goes last where working papers belong. The rail is built from
     * the sections that actually rendered, never from a fixed list, so it can
     * not offer a jump to a section a thin report never produced.
     */
    var rail = el('nav', 'vd-rail');
    rail.setAttribute('aria-label', 'Report sections');
    var railList = el('ol', 'vd-rail-list');
    rail.appendChild(railList);

    var body = el('div', 'vd-body');
    var tier = null;

    function openTier(cls, label) {
      tier = el('div', 'vd-tier ' + cls);
      if (label) tier.appendChild(el('p', 'vd-tier-label', label));
      body.appendChild(tier);
    }

    /* Adding a section and adding its rail entry is one action, because doing
     * them separately is how a rail ends up pointing at nothing. */
    function add(node, id, railName) {
      if (!node) return null;
      (tier || body).appendChild(node);
      if (!id) return node;
      node.id = id;
      if (railName) {
        var li = el('li');
        var a = el('a', 'vd-rail-link', railName);
        a.href = '#' + id;
        li.appendChild(a);
        railList.appendChild(li);
      }
      return node;
    }

    var head = el('section', 'vd-section vd-head');
    head.appendChild(el('h2', null, report.product_title || 'Your market'));
    if (report.category) head.appendChild(el('p', 'vd-lede', 'Category: ' + report.category));

    var bar = el('div', 'proof-bar');
    [
      [report.stats && report.stats.comments, 'Comments read'],
      [report.stats && report.stats.reviews, 'Of your reviews'],
      [report.stats && report.stats.subreddits, 'Communities'],
      [report.adsAnalysed || 0, 'Competitor ads']
    ].forEach(function (s) {
      if (!s[0]) return;
      var item = el('div', 'proof-bar-item');
      var num = el('div', 'proof-bar-num');
      num.appendChild(el('em', null, String(s[0])));
      item.appendChild(num);
      item.appendChild(el('div', 'proof-bar-label', s[1]));
      bar.appendChild(item);
    });
    head.appendChild(bar);
    body.appendChild(head);

    /* ── Tier 1: the answer ──
     * The format verdict, the angle it produces, and whether the category is
     * worth advertising in at all. Nothing above this line, nothing competing
     * with it. */
    openTier('vd-tier-answer');
    add(formatSection(report.format_verdict), 'vd-verdict', 'Verdict');
    add(recommendation(report), 'vd-angle', 'Angle');
    add(strengthSection(report), 'vd-strength', 'Worth it?');

    /* ── Tier 2: why we say so ──
     * The abstract, the one-line read, and what the competition is actually
     * running. `#vd-evidence` is where "see research" and "view sources" land,
     * so it keeps its id. */
    openTier('vd-tier-working', 'The evidence');
    var evidenceAnchor = el('div');
    evidenceAnchor.id = 'vd-evidence';
    body.appendChild(evidenceAnchor);

    add(summarySection(report), 'vd-found', 'What we found');

    if (report.verdict) {
      var vsec = el('section', 'vd-section');
      vsec.appendChild(el('h2', null, 'The short version'));
      vsec.appendChild(el('p', 'vd-lede', voice(report.verdict)));
      add(vsec, 'vd-short', 'The short version');
    }
    add(adsSection(report.ads), 'vd-ads', 'What rivals run');

    /* ── Tier 3: the raw material ──
     * Working papers. Everything we computed is still shown to everybody, and
     * a free read that hides its own conclusions is not a free read, but it
     * reads as source material rather than as findings of equal weight. */
    openTier('vd-tier-papers', 'The raw material');
    add(fold(section('What customers are saying', report.pains)), 'vd-pains', 'Customers');
    add(fold(whitespaceSection(report.whitespace)), 'vd-gap', 'Gaps');
    add(fold(section('What customers wish existed', report.wishes)), 'vd-wishes', 'Wishes');
    add(fold(section("Why people don't buy", report.objections,
      'The reasons people give for not buying. Your ad has to answer these.')),
      'vd-objections', 'Objections');

    if ((report.angles || []).length > 1) {
      var asec = el('section', 'vd-section');
      asec.appendChild(el('h2', null, 'Other angles you could try'));
      asec.appendChild(el('p', 'vd-lede',
        'Every one of these came from what real customers said, ordered by how many people said it.'));
      report.angles.slice(1).forEach(function (a) { asec.appendChild(angleCard(a, report)); });
      add(fold(asec), 'vd-angles', 'Other angles');
    }

    tier = null;

    /*
     * A tier that received nothing must not announce itself.
     *
     * openTier() writes its label the moment the tier opens, before anything
     * is added to it, so a gated free read drew "The evidence" and "The raw
     * material" as headings over empty space: two promises with nothing under
     * them, directly above the card asking for a sign-in. Found on the live
     * site rather than locally, because it only appears when the payload comes
     * back gated.
     */
    [].slice.call(body.querySelectorAll('.vd-tier')).forEach(function (t) {
      if (!t.querySelector('.vd-section')) t.remove();
    });

    if (!signedIn) body.appendChild(unlockCard(report));

    /* A rail with one entry is a rail pointing at the thing you are looking
     * at. Thin reports simply do not get one. */
    if (railList.children.length > 2) out.appendChild(rail);
    out.appendChild(body);

    if (signedIn && resumed) welcomeBand(report);
    spyRail(rail);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /*
   * The rail marks where you are, not merely where you can go.
   *
   * IntersectionObserver rather than a scroll handler: the callback fires only
   * when a section crosses the line, so a 7,000px page does not run layout
   * maths on every frame of a flick scroll. The top-third rootMargin means the
   * highlight changes when a section reaches reading position rather than when
   * its last pixel leaves the viewport.
   */
  /*
   * Tier 3 folds.
   *
   * These sections are the working papers: every quote behind every finding.
   * Open, they are most of the 7,000px, and a reader who wanted the answer has
   * to scroll past all of it. Closed, the page is an argument with its sources
   * one click away, which is how a research document has always worked.
   *
   * The count goes on the summary line, so folding never hides HOW MUCH we
   * read. "6 findings, 41 quotes" closed says more about the depth of the work
   * than six open cards the reader scrolls past.
   */
  function fold(sec) {
    if (!sec) return sec;
    var h2 = sec.querySelector(':scope > h2');
    if (!h2) return sec;

    var findings = sec.querySelectorAll('.vd-finding, .gap-row').length;
    var quotes = sec.querySelectorAll('.vd-cite, blockquote, q').length;

    var d = el('details', 'vd-fold');
    var sum = el('summary', 'vd-fold-head');
    sum.appendChild(el('span', 'vd-fold-title', h2.textContent));

    var bits = [];
    if (findings) bits.push(findings + (findings === 1 ? ' finding' : ' findings'));
    if (quotes) bits.push(quotes + (quotes === 1 ? ' quote' : ' quotes'));
    if (bits.length) sum.appendChild(el('span', 'vd-fold-n', bits.join(', ')));

    d.appendChild(sum);
    h2.remove();
    while (sec.firstChild) d.appendChild(sec.firstChild);
    sec.appendChild(d);
    return sec;
  }

  function spyRail(rail) {
    var links = [].slice.call(rail.querySelectorAll('.vd-rail-link'));
    if (!links.length || typeof IntersectionObserver !== 'function') return;

    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });

    rail.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('.vd-rail-link') : null;
      if (!a) return;
      var target = document.getElementById(a.getAttribute('href').slice(1));
      var d = target && target.querySelector('.vd-fold');
      if (d) d.open = true;
    });

    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible[e.target.id] = 1;
        else delete visible[e.target.id];
      });
      /* Several sections can be on screen at once; the topmost one in document
       * order is the one being read. */
      var current = null;
      links.forEach(function (a) {
        var id = a.getAttribute('href').slice(1);
        if (!current && visible[id]) current = id;
      });
      links.forEach(function (a) {
        a.classList.toggle('is-here', a.getAttribute('href').slice(1) === current);
      });
    }, { rootMargin: '-80px 0px -66% 0px' });

    Object.keys(byId).forEach(function (id) {
      var node = document.getElementById(id);
      if (node) io.observe(node);
    });
  }

  /* ── the stored payload, in the shape this renderer reads ──── */

  /*
   * The worker stores findings that cite evidence by id, plus the index those
   * ids point into. Resolving happens here rather than server-side for the same
   * reason the corroboration gate lives here: a claim and its receipts must be
   * joined in the place that draws them, so a claim whose receipts did not
   * survive cannot be drawn at all.
   *
   * Ids the index does not know are dropped silently. That is the anti
   * hallucination check, and it is the reason a model inventing "c999" costs it
   * a receipt instead of putting a fabricated quote on the page.
   */
  function resolve(ids, index) {
    var out = [];
    (ids || []).forEach(function (id) {
      var rec = index[String(id).trim()];
      if (rec && rec.text) out.push(rec);
    });
    return out;
  }

  function hydrate(findings, index) {
    return (findings || []).map(function (f) {
      return {
        claim: f.claim,
        why_it_works: f.why_it_works,
        evidence: resolve(f.evidence_ids, index),
      };
    });
  }

  function adapt(res) {
    var p = res.payload || {};
    var index = p.evidence || {};
    var read = p.read || {};
    var saved = stored();
    return {
      // From the poll where possible, from the handle we stored at creation
      // otherwise, because a resumed page may render before anything else knows
      // which report this is.
      id: res.id || (saved && saved.id) || '',
      product_title: (p.product && p.product.title) || res.title || 'Your market',
      url: (p.product && p.product.url) || res.url || '',
      category: p.category || null,
      verdict: read.verdict || res.verdict || null,
      stats: {
        comments: (p.stats && p.stats.records) || res.evidenceCount || 0,
        subreddits: (p.stats && p.stats.subreddits) || 0,
        reviews: (p.stats && p.stats.reviews) || 0,
      },
      pains: hydrate(read.pains, index),
      wishes: hydrate(read.wishes, index),
      objections: hydrate(read.objections, index),
      format_verdict: p.formats || null,
      whitespace: p.whitespace || null,
      ads: p.ads || [],
      // How many were read, not how many are drawn. The ladder keeps the twelve
      // longest-running; the verdict was computed over all of them, and the
      // proof bar is a claim about the work.
      adsAnalysed: p.adsAnalysed || (p.ads || []).length,
      angles: ((p.angles && p.angles.angles) || []).map(function (a) {
        return {
          claim: a.claim, hook: a.hook, headline: a.headline,
          format: a.format, persona: a.persona,
          evidence: resolve(a.evidence_ids, index),
        };
      }),
    };
  }

  /* ── states that are answers, not failures ─────────────────── */

  /*
   * A market nobody has studied with us yet is a real result, and it is the
   * best moment in the funnel: the visitor has just learned something true
   * about their category and we are offering to go and do the work. Drawn as
   * an invitation, never as an error.
   */
  function notice(strongText, bodyText, cta) {
    out.textContent = '';
    out.hidden = false;
    var box = el('section', 'vd-section');
    var card = el('div', 'vd-thin');
    card.appendChild(el('strong', null, strongText + ' '));
    card.appendChild(document.createTextNode(bodyText));
    if (cta) {
      var a = el('a', 'btn btn-primary vd-notice-cta', cta.label);
      a.href = cta.href;
      if (cta.track) {
        a.addEventListener('click', function () { gateClicked(cta.track); });
      }
      card.appendChild(a);
    }
    box.appendChild(card);
    out.appendChild(box);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ── run ─────────────────────────────────────────────────── */

  /*
   * A report id plus its claim token is the only way an anonymous visitor gets
   * back to work we already paid to do. Kept so a refresh, or a sign-in that
   * reloads the page, does not silently start the whole thing again.
   *
   * The title rides along because the signup screen needs a name to put in
   * its context band, and the report row is not readable from there. `ts`
   * rides along because this used to have no expiry at all: opening /validate
   * hours later in the same tab silently re-attached to whatever was last
   * read, so the page filled with a report the visitor had not asked for and
   * could not explain. Six hours is long enough to cover a sign-in round trip
   * and a distraction, short enough that it never surprises anybody.
   *
   * Since report-claim.js landed, this is the fast path rather than the only
   * copy: a claimed report is on the account, so losing this costs a lookup.
   */
  var RESUME_TTL_MS = 6 * 60 * 60 * 1000;

  function remember(id, claim, title) {
    try {
      sessionStorage.setItem('hexa.report', JSON.stringify({
        id: id, claim: claim || '', title: title || '', ts: Date.now(),
      }));
    } catch (e) { /* private mode: the report still works, it just will not resume */ }
  }

  /* The one reader. Entries written before this had a ts are dropped rather
   * than trusted, which is the same call as expiry: an unexplained report is
   * the bug being fixed. */
  function stored() {
    var s;
    try { s = JSON.parse(sessionStorage.getItem('hexa.report') || 'null'); }
    catch (e) { return null; }
    if (!s || !s.id) return null;
    if (!s.ts || Date.now() - s.ts > RESUME_TTL_MS) { forget(); return null; }
    return s;
  }

  function forget() {
    try { sessionStorage.removeItem('hexa.report'); } catch (e) {}
  }

  /* The title only exists once the worker has read the page, which is after
   * the handle was stored. Folded in rather than rewritten so the claim token
   * is never touched by a code path that does not have it. */
  function rememberTitle(title) {
    var s = stored();
    if (!s || !title || s.title === title) return;
    remember(s.id, s.claim, title);
  }

  var POLL_MS = 2500;
  var POLL_CEILING_MS = 6 * 60 * 1000;   // a cold harvest runs minutes, not seconds

  /* Which read this page is currently watching. A poll belonging to an
   * abandoned run answers into a page that has moved on, so it checks its
   * generation before drawing anything. Without this, dismissing a resumed
   * report clears the screen and then the in-flight poll paints it back. */
  var runId = 0;

  function finish(tick) {
    clearInterval(tick);
    progress.hidden = true;
    button.disabled = false;
  }

  function poll(id, claim, tick, startedAt, gen) {
    if (gen !== runId) return;
    var qs = '?id=' + encodeURIComponent(id) + (claim ? '&claim=' + encodeURIComponent(claim) : '');
    // Signed-in reports carry no claim token, so ownership is proved by the
    // bearer token instead. Sent on every poll because a session can refresh
    // mid-build and the header has to be current, not captured at the start.
    fetch('/.netlify/functions/report-status' + qs, { cache: 'no-store', headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (gen !== runId) return;
        if (res.status === 'building') {
          // The worker names its own stage, so the bar tracks work rather than
          // time. The local ticker below is only a fallback for the seconds
          // before the first step is written.
          var at = STEP_INDEX[res.stepKey];
          if (at != null) advance(at);
          if (res.title) rememberTitle(res.title);
          if (Date.now() - startedAt > POLL_CEILING_MS) {
            finish(tick);
            notice('This one is taking longer than it should.',
              'Your report is still building and it is saved. Reload this page in a few minutes and it will be here.');
            return;
          }
          setTimeout(function () { poll(id, claim, tick, startedAt, gen); }, POLL_MS);
          return;
        }

        finish(tick);
        if (res.title) rememberTitle(res.title);

        if (res.status === 'failed') {
          /* A market refused for want of credits is not a failure to read the
           * page, and telling somebody their product page is thin when the real
           * answer is "top up" sends them to fix the wrong thing. */
          if (res.creditsNeeded) {
            notice('Nobody has studied this market with us yet.', res.message || '',
              { label: 'Add credits', href: '/account.html#settings', track: 'credits' });
            return;
          }
          notice('We could not read enough about this product to say anything honest.',
            (res.message || '') + ' Nothing was charged. A product page with a real description works best.');
          return;
        }

        var p = res.payload || {};
        if (p.unreadable) {
          notice('We could not read that page.',
            p.message || 'Check the link opens in a private window, and paste the page for a single product.');
          return;
        }
        if (p.gated) {
          gateSeen('cold');
          /* The heading is the first half of the sentence, so the body has to
           * be the second half and nothing else. The server used to send a
           * message that opened by repeating the heading verbatim, and because
           * a message is always sent the `||` fallback below never ran, so the
           * card read the same sentence twice every single time. */
          notice('Nobody has studied this market with us yet.',
            p.message || 'Create a free account and we will go and read it properly, then save the report to your library. ' +
              'A free account also makes your first static ad, from whichever angle the read lands on.',
            { label: 'Read my market free', href: signupHref(), track: 'cold' });
          return;
        }
        if (p.pending_harvest) {
          /* Not "your report will fill in shortly": the worker has already been
           * and come back empty by the time this renders, so a heading that
           * promises more is coming leaves somebody waiting on nothing. */
          notice('We went looking, and there was not enough to read.',
            p.message || 'That is usually a sign this market talks about the product in words we have '
              + 'not matched yet. Nothing was charged.');
          return;
        }
        render(adapt(res));
      })
      .catch(function (e) {
        /* Logged, because this catch covers the render as well as the fetch:
         * a throw anywhere in adapt() or render() lands here and gets reported
         * to the reader as a lost connection, which is the wrong story and the
         * hardest kind of bug to find from the page. */
        console.error('[validate] report failed to draw:', e);
        finish(tick);
        notice('We lost the connection while your report was building.',
          'It is saved on our side. Reload this page and it will pick up where it left off.');
      });
  }

  function run(url) {
    var gen = ++runId;
    button.disabled = true;
    out.hidden = true;
    hideBand();
    startSteps();

    // Fallback ticker only. Real stage names arrive from report-status and
    // take over as soon as the worker writes its first step.
    var step = 0;
    var tick = setInterval(function () {
      step = Math.min(step + 1, STEPS.length - 1);
      advance(step);
    }, 4000);

    /* Waited on, not raced. Whether this call carries a bearer token decides
     * whether the worker builds the free read or the deep report with angles
     * and competitor ads, so asking before the session has loaded would quietly
     * downgrade every signed-in visitor who pastes a link quickly. */
    authReady()
      .then(function () {
        return fetch('/.netlify/functions/report-create', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ url: url }),
        });
      })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (r) {
        if (gen !== runId) return;
        if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'could not start');
        remember(r.body.id, r.body.claimToken, r.body.title);
        poll(r.body.id, r.body.claimToken, tick, Date.now(), gen);
      })
      .catch(function (e) {
        finish(tick);
        notice('We could not start that one.',
          /that does not look like/.test(e.message)
            ? 'That link did not look like a product page we can read. Paste the page for a single product.'
            : 'Give it another go in a moment.');
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var url = (input.value || '').trim();
    if (!url) return;
    run(url);
  });

  /* ── the band that says why a report is on screen ──────────── */

  /*
   * A report used to appear here with no explanation at all.
   *
   * The resume below reattaches to whatever this tab last read, so opening
   * /validate could fill with a progress bar and then a finished report for a
   * product the visitor had not typed, in a session they did not remember
   * starting. The report was correct. The page simply never said where it came
   * from, which reads as the site making things up.
   *
   * So a resumed report always arrives with a sentence naming it and a way
   * out, and a signed-in visitor gets the version that names the account.
   */
  var activeBand = null;

  function showBand(cls, strongText, restText, action) {
    hideBand();
    var b = el('div', 'vd-band ' + cls);
    // Its text changes under the reader while an ad renders, so it announces.
    b.setAttribute('aria-live', 'polite');
    var p = el('p', 'vd-band-txt');
    p.appendChild(el('strong', null, strongText));
    if (restText) p.appendChild(document.createTextNode(' ' + restText));
    b.appendChild(p);
    if (action) {
      var btn = el('button', 'vd-band-act', action.label);
      btn.type = 'button';
      btn.addEventListener('click', action.onClick);
      b.appendChild(btn);
    }
    progress.parentNode.insertBefore(b, progress);
    activeBand = b;
    return b;
  }

  function hideBand() {
    if (activeBand) { activeBand.remove(); activeBand = null; }
  }

  /* Back to an empty page. Bumping the generation matters: without it the
   * in-flight poll for the report they just dismissed answers a second later
   * and paints it straight back. */
  function startOver() {
    runId++;
    forget();
    hideBand();
    /* ?report= would reopen the same read on the next refresh, which is the
     * "why is this here" bug again with a different cause. */
    try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}
    progress.hidden = true;
    out.hidden = true;
    out.textContent = '';
    showLanding(true);
    button.disabled = false;
    input.value = '';
    input.focus();
  }

  /*
   * The returning band: what somebody sees on the first load after signing up
   * from the gate.
   *
   * This is the whole post-signup screen, and it is deliberately not a separate
   * page. They signed up to get an ad made from the angle on this report, so
   * the payoff belongs on the report, with nothing between them and it.
   *
   * The ad starts here rather than on a click. It is the thing that was
   * promised, it costs us about 2.6 cents, and a visitor who has just handed
   * over an email should not have to ask twice for what they were told they
   * had already earned.
   */
  function welcomeBand(report) {
    var angle = usableAngle(report);
    if (!angle) {
      showBand('vd-band-welcome', 'Your report is right where you left it.',
        'It is saved to your account now, so you can close this tab.');
      return;
    }

    /* The client half of "once per report". The server half is the real one,
     * a Netlify Blob keyed on the report id that render-create checks before
     * any engine call; this only saves the round trip on a refresh. */
    var already = false;
    try { already = !!localStorage.getItem('hexa.freead.' + report.id); } catch (e) {}
    if (already) {
      showBand('vd-band-welcome', 'Your report is right where you left it.',
        'This report already had its free ad, and it is in your library.');
      return;
    }
    try { localStorage.setItem('hexa.freead.' + report.id, String(Date.now())); } catch (e) {}

    var b = showBand('vd-band-welcome', 'Your report is right where you left it.',
      'Making your free ad now.');

    startFreeAd(freeAdOrder(angle, report))
      .then(function (jobs) {
        bandSays(b, 'Your free ad is being made.',
          'It takes about a minute. The report stays here while it renders.',
          { label: 'Watch it', href: '/render.html?jobs=' + encodeURIComponent(jobs) });
      })
      .catch(function (d) {
        /* Already spent is a success from the visitor's side: the ad exists,
         * it is just not new. Anything else is said plainly and does not
         * promise an email, because the sender is behind a master switch that
         * is currently off and a promise it would swallow is worse than
         * silence. */
        try { localStorage.removeItem('hexa.freead.' + report.id); } catch (e) {}
        if (d && /already had its free ad/i.test(d.error || '')) {
          bandSays(b, 'Your report is right where you left it.',
            'This report already had its free ad. It is in your library.',
            { label: 'Open my library', href: '/account.html' });
          return;
        }
        bandSays(b, 'Your report is right where you left it.',
          'The ad hit a snag on the way out. It is back in the queue and it will appear in your ' +
          'library when it lands.');
      });
  }

  /* Rewrite a band in place. The band is one line that changes three times in
   * ten seconds, so replacing the node would move the page under the reader. */
  function bandSays(b, strongText, restText, link) {
    b.textContent = '';
    var p = el('p', 'vd-band-txt');
    p.appendChild(el('strong', null, strongText));
    if (restText) p.appendChild(document.createTextNode(' ' + restText));
    b.appendChild(p);
    if (link) {
      var a = el('a', 'vd-band-act', link.label);
      a.href = link.href;
      b.appendChild(a);
    }
  }

  /*
   * Resume. Someone who signs in from the gate comes back on a fresh page load
   * with a finished report already sitting in the database; making them paste
   * the link again would be asking them to pay for the same work twice.
   */
  /* An explicit id in the URL is an instruction; a resume is a guess. Read
   * before either runs so they cannot both start a poll. */
  var OPEN_ID = (function () {
    try { return new URLSearchParams(window.location.search).get('report') || ''; }
    catch (e) { return ''; }
  })();

  /*
   * A link handed over by the composer, read at the same moment as OPEN_ID and
   * for the same reason: both are instructions, and a resume is a guess.
   *
   * This was read inside fromLink() instead, which ran last and gave up the
   * moment a resume had already started. The effect was the exact thing the
   * composer exists to prevent: paste a product on the home page, watch the
   * peek identify it, arrive here, and get somebody else's half-finished read
   * from up to six hours ago with an empty form above it. The link was thrown
   * away in silence, so the only way forward was to paste it a second time.
   */
  var FROM_URL = (function () {
    var u = '';
    try { u = (new URLSearchParams(window.location.search).get('url') || '').trim(); }
    catch (e) { return ''; }
    return /^https?:\/\//i.test(u) ? u : '';
  })();

  var resumed = (function resume() {
    if (OPEN_ID || FROM_URL) return false;
    var saved = stored();
    if (!saved) return false;
    var gen = ++runId;
    button.disabled = true;
    startSteps();
    showBand('vd-band-resume', 'Picking up where you left off.',
      saved.title ? 'Your read of ' + saved.title + ' is still here.'
                  : 'The read you started is still here.',
      { label: 'Read something else', onClick: startOver });
    var tick = setInterval(function () {}, 60000);
    authReady().then(function () {
      if (gen !== runId) return;
      poll(saved.id, saved.claim, tick, Date.now(), gen);
    });
    return true;
  })();

  /*
   * Opened from the Reports tab: /validate?report=<id>.
   *
   * The id alone, with no claim token, which is the point. The row belongs to
   * an account by then, so report-status authorises it off the bearer token
   * instead, and the link stays safe to paste anywhere. A share link carrying
   * a claim token would let whoever received it take the report into their own
   * account, so no URL on this site ever carries one.
   *
   * This wins over the tab's stored report, because an explicit id is an
   * instruction and a resume is a guess.
   */
  var opened = (function fromId() {
    if (!OPEN_ID) return false;
    var gen = ++runId;
    button.disabled = true;
    startSteps();
    showBand('vd-band-resume', 'Opened from your reports.', 'Nothing is being re-read, and nothing is charged.',
      { label: 'Read something else', onClick: startOver });
    var tick = setInterval(function () {}, 60000);
    authReady().then(function () {
      if (gen !== runId) return;
      poll(OPEN_ID, '', tick, Date.now(), gen);
    });
    return true;
  })();

  /*
   * Handed a link. The composer on the home page peeks the product, shows it,
   * then sends the visitor here rather than to the style picker, so the read
   * has to start on arrival: asking someone to paste the same link twice is
   * how a single flow turns back into two separate tools.
   *
   * This wins over a resume, for the same reason ?report= does: a link the
   * visitor just handed us is an instruction about what they want NOW, and a
   * stored report is a guess about what they wanted earlier. Nothing is lost
   * by preferring it, because the stored report is claimed to the account and
   * still sitting in Reports.
   */
  (function fromLink() {
    if (resumed || opened || !FROM_URL) return;
    var url = FROM_URL;
    input.value = url;
    // The link is in the address bar and does not belong there once it is in
    // the form: a reload should not silently re-run a paid read.
    try { window.history.replaceState(null, '', window.location.pathname); }
    catch (e) { /* older browsers just keep the query string */ }
    run(url);
  })();
})();

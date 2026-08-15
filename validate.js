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

  function startSteps() {
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
    head.appendChild(el('span', 'fmt-conf', fv.confidence + ' confidence'));
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
   * Render the recommended angle as a real ad, free, right here.
   *
   * Posts the same order shape the studio would build, plus the report id and
   * its claim token, which is what buys the free render server side. On success
   * it hands off to the render page with the job id, so the visitor watches it
   * being made rather than waiting on a spinner with no explanation.
   */
  function makeFreeAd(angle, report, btn) {
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem('hexa.report') || 'null'); }
    catch (e) { saved = null; }

    var order = {
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

    btn.disabled = true;
    btn.textContent = 'Making it…';

    fetch('/.netlify/functions/render-create', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ order: order }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (!d.jobs || !d.jobs.length) return Promise.reject(d);
        // The render page reads the order back out of localStorage.
        try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
        window.location.href = '/render.html?jobs='
          + encodeURIComponent(d.jobs.map(function (j) { return j.id; }).join(','));
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
    sec.appendChild(el('h2', null, 'Now let us read your competition'));
    sec.appendChild(el('p', 'vd-lede',
      'Everything above came from your customers. What we have not done yet is look at what your ' +
      'competitors are already saying, which is what turns a good angle into an unclaimed one.'));

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

    /* The grant, in what it buys. "2,500 credits" is a number nobody can price
     * until they have seen what one costs. */
    sec.appendChild(el('p', 'unlock-credits',
      'A free account also starts with 2,500 credits, which is two more of these reports or five ' +
      'static ad creatives. Your report is saved, so signing in picks it up exactly where you left it.'));

    var cta = el('a', 'btn btn-primary', 'Read my competition, free');
    cta.href = '/login.html';
    sec.appendChild(cta);
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

    if (pain) rows.push(['🔥', 'Customers care about', voice(pain.claim)]);
    if (worry) rows.push(['⚠️', 'Customers worry about', voice(worry.claim)]);
    if (covered) {
      rows.push(['👀', 'Competitors are mostly selling', voice(covered.claim)]);
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
      rows.push(['💡', 'Your opportunity', fresh
        ? voice(fresh.claim) + ' Not one competitor ad we read is saying it.'
        : 'Lead with that first complaint. Not one competitor ad we read answers it, so it is the opening nobody has taken.']);
    }
    if (rows.length < 2) return null;

    var sec = el('section', 'vd-section vd-found');
    sec.appendChild(el('h2', null, 'What we found'));
    var list = el('div', 'found-list');
    rows.forEach(function (r) {
      var row = el('div', 'found-row');
      row.appendChild(el('span', 'found-ico', r[0]));
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
    if (top.persona) answers.push(['👥', 'Your likely customer', voice(top.persona)]);
    if (pain) answers.push(['😣', 'Their biggest problem', voice(pain.claim)]);
    answers.forEach(function (a) {
      var row = el('div', 'call-answer');
      row.appendChild(el('span', 'call-answer-ico', a[0]));
      var body = el('div');
      body.appendChild(el('p', 'call-answer-label', a[1]));
      body.appendChild(el('p', 'call-answer-text', a[2]));
      row.appendChild(body);
      sec.appendChild(row);
    });

    sec.appendChild(el('p', 'call-answer-label call-claim-label', '🏆 Your strongest angle'));
    sec.appendChild(el('h2', 'vd-call-claim', voice(top.claim)));

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
     * The free one. Offered to everybody, because the point is to end the
     * report with the thing itself rather than with a price: they have just
     * been told what to say, and the next click shows it made. One per report,
     * enforced server side.
     */
    var free = el('button', 'is-primary', 'Make this ad, free →');
    free.type = 'button';
    free.addEventListener('click', function () { makeFreeAd(top, report, free); });
    act.appendChild(free);

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

    var head = el('section', 'vd-section vd-head');
    head.appendChild(el('h2', null, report.product_title || 'Your market'));
    if (report.category) head.appendChild(el('p', 'vd-lede', 'Category: ' + report.category));

    var bar = el('div', 'proof-bar');
    [
      [report.stats && report.stats.comments, 'comments read'],
      [report.stats && report.stats.reviews, 'of your reviews'],
      [report.stats && report.stats.subreddits, 'communities'],
      [report.adsAnalysed || 0, 'competitor ads']
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
    out.appendChild(head);

    /* The answers first. Everything below this is the working. */
    var found = summarySection(report);
    if (found) out.appendChild(found);

    var call = recommendation(report);
    if (call) out.appendChild(call);

    var strength = strengthSection(report);
    if (strength) out.appendChild(strength);

    if (report.verdict) {
      var vsec = el('section', 'vd-section');
      vsec.appendChild(el('h2', null, 'The short version'));
      vsec.appendChild(el('p', 'vd-lede', voice(report.verdict)));
      out.appendChild(vsec);
    }

    /* Where "see research" and "view sources" land, and where the working
     * proper begins. */
    var evidenceAnchor = el('div');
    evidenceAnchor.id = 'vd-evidence';
    out.appendChild(evidenceAnchor);

    var fmt = formatSection(report.format_verdict);
    if (fmt) out.appendChild(fmt);

    // Free above the line: what people say. Gated below: the parts that tell
    // you what to do about it.
    var pains = section('What customers are saying', report.pains);
    if (pains) out.appendChild(pains);

    /* Everything we computed is shown, to everybody. A free read that hides its
     * own conclusions is not a free read. */
    var gap = whitespaceSection(report.whitespace);
    if (gap) out.appendChild(gap);
    var wishes = section('What customers wish existed', report.wishes);
    if (wishes) out.appendChild(wishes);
    var objections = section("Why people don't buy",
      report.objections,
      'The reasons people give for not buying. Your ad has to answer these.');
    if (objections) out.appendChild(objections);
    var adsSec = adsSection(report.ads);
    if (adsSec) out.appendChild(adsSec);

    if ((report.angles || []).length > 1) {
      var asec = el('section', 'vd-section');
      asec.id = 'vd-angles';
      asec.appendChild(el('h2', null, 'Other angles you could try'));
      asec.appendChild(el('p', 'vd-lede',
        'Every one of these came from what real customers said, ordered by how many people said it.'));
      report.angles.slice(1).forEach(function (a) { asec.appendChild(angleCard(a, report)); });
      out.appendChild(asec);
    }

    if (!signedIn) out.appendChild(unlockCard(report));
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem('hexa.report') || 'null'); }
    catch (e) { saved = null; }
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
      card.appendChild(a);
    }
    box.appendChild(card);
    out.appendChild(box);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ── run ─────────────────────────────────────────────────── */

  /* A report id plus its claim token is the only way an anonymous visitor gets
   * back to work we already paid to do. Kept so a refresh, or a sign-in that
   * reloads the page, does not silently start the whole thing again. */
  function remember(id, claim) {
    try { sessionStorage.setItem('hexa.report', JSON.stringify({ id: id, claim: claim || '' })); }
    catch (e) { /* private mode: the report still works, it just will not resume */ }
  }

  var POLL_MS = 2500;
  var POLL_CEILING_MS = 6 * 60 * 1000;   // a cold harvest runs minutes, not seconds

  function finish(tick) {
    clearInterval(tick);
    progress.hidden = true;
    button.disabled = false;
  }

  function poll(id, claim, tick, startedAt) {
    var qs = '?id=' + encodeURIComponent(id) + (claim ? '&claim=' + encodeURIComponent(claim) : '');
    // Signed-in reports carry no claim token, so ownership is proved by the
    // bearer token instead. Sent on every poll because a session can refresh
    // mid-build and the header has to be current, not captured at the start.
    fetch('/.netlify/functions/report-status' + qs, { cache: 'no-store', headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.status === 'building') {
          // The worker names its own stage, so the bar tracks work rather than
          // time. The local ticker below is only a fallback for the seconds
          // before the first step is written.
          var at = STEP_INDEX[res.stepKey];
          if (at != null) advance(at);
          if (Date.now() - startedAt > POLL_CEILING_MS) {
            finish(tick);
            notice('This one is taking longer than it should.',
              'Your report is still building and it is saved. Reload this page in a few minutes and it will be here.');
            return;
          }
          setTimeout(function () { poll(id, claim, tick, startedAt); }, POLL_MS);
          return;
        }

        finish(tick);

        if (res.status === 'failed') {
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
          notice('Nobody has studied this market with us yet.',
            p.message || 'Create a free account and we will go and read it properly, then save the report to your library. ' +
              'New accounts start with 2,500 credits, so the angles we find come out as real ads without you paying anything.',
            { label: 'Read my market free', href: '/login.html' });
          return;
        }
        if (p.pending_harvest) {
          notice('This market is new to us.',
            p.message || 'We are gathering the discussion now and your report will fill in shortly.');
          return;
        }
        render(adapt(res));
      })
      .catch(function () {
        finish(tick);
        notice('We lost the connection while your report was building.',
          'It is saved on our side. Reload this page and it will pick up where it left off.');
      });
  }

  function run(url) {
    button.disabled = true;
    out.hidden = true;
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
        if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'could not start');
        remember(r.body.id, r.body.claimToken);
        poll(r.body.id, r.body.claimToken, tick, Date.now());
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

  /*
   * Resume. Someone who signs in from the gate comes back on a fresh page load
   * with a finished report already sitting in the database; making them paste
   * the link again would be asking them to pay for the same work twice.
   */
  var resumed = (function resume() {
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem('hexa.report') || 'null'); }
    catch (e) { saved = null; }
    if (!saved || !saved.id) return false;
    button.disabled = true;
    startSteps();
    var tick = setInterval(function () {}, 60000);
    authReady().then(function () { poll(saved.id, saved.claim, tick, Date.now()); });
    return true;
  })();

  /*
   * Handed a link. The composer on the home page peeks the product, shows it,
   * then sends the visitor here rather than to the style picker, so the read
   * has to start on arrival: asking someone to paste the same link twice is
   * how a single flow turns back into two separate tools.
   *
   * A report already resuming wins, because that one is paid for and finished.
   */
  (function fromLink() {
    if (resumed) return;
    var url = '';
    try { url = new URLSearchParams(window.location.search).get('url') || ''; }
    catch (e) { return; }
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) return;
    input.value = url;
    // The link is in the address bar and does not belong there once it is in
    // the form: a reload should not silently re-run a paid read.
    try { window.history.replaceState(null, '', window.location.pathname); }
    catch (e) { /* older browsers just keep the query string */ }
    run(url);
  })();
})();

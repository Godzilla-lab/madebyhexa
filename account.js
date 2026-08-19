/* ═════ The Hexa workspace ═════
 *
 * Depends on window.HexaAuth (auth.js).
 *
 * The page this replaced was a settings screen with a library bolted under it:
 * a balance in 48px type, a Shopify form, then the work. This one is shaped
 * the way a creative tool is actually used, and four rules did the reshaping:
 *
 *   the product surface is screen one   the feed loads first, and the dock
 *                                       that starts the next piece is always
 *                                       on screen
 *   the work is the interface           a card is the media at its own aspect
 *                                       ratio; the title and the actions live
 *                                       in the detail view, not around it
 *   the cost lives in the button        "Read my market ✦ 1,000", never a
 *                                       separate line beside the control
 *   detail opens in place               inspecting a piece keeps the feed, the
 *                                       filter and the scroll position
 *
 * Everything drawn here is a column that exists. Nothing is scored, ranked or
 * estimated on the page's own authority.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LIST_URL = '/.netlify/functions/account-creations';
  var WELCOME = new URLSearchParams(location.search).get('welcome') === '1';

  /*
   * What a market read costs.
   *
   * Overwritten from catalog/credit-packs.json, which build-credit-packs.mjs
   * generates out of pricing.json, so the number in the button and the number
   * the server charges cannot drift. Measured 2026-08-15, the action chips
   * advertised $4/$9/$4 against a $3/$7/$3 charge for exactly this reason.
   * The literal matches DEEP_REPORT_CREDITS in report-create.js and only
   * applies if that fetch fails.
   */
  var REPORT_CREDITS = 1000;
  var CREDITS_PER_DOLLAR = 500;

  var state = {
    view: 'all',
    creations: null,     // null while loading
    reports: null,
    balance: null,
    query: '',
    open: -1,            // index into the current filtered list, -1 = closed
  };

  /* ── small helpers ───────────────────────────────────────── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent, never innerHTML
    return n;
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  /* Date headings the way a person says them, not the way a database stores
   * them. Intl does the month name so this is not a hardcoded English list. */
  function dayLabel(iso) {
    var d = new Date(iso);
    var today = new Date();
    var y = new Date(today.getTime() - 86400000);
    var same = function (a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    };
    if (same(d, today)) return 'Today';
    if (same(d, y)) return 'Yesterday';
    try { return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); }
    catch (e) { return iso.slice(0, 10); }
  }

  function isVideoUrl(u) { return /\.(mp4|webm|mov)(\?|$)/i.test(u || ''); }

  function note(id, msg, kind) {
    var n = $(id);
    if (!n) return;
    n.textContent = msg || '';
    n.className = 'ws-note' + (kind ? ' is-' + kind : '');
  }

  /* ── post-render actions, which live in the detail view ──── */

  /* Prices come from the generated catalogue for the same reason the read
   * price does: a number typed in a second place drifts from the one that
   * decides the charge. A missing price shows no price rather than a wrong
   * one, and the server reprices at checkout either way. */
  var ACTIONS = [
    { product: 'action:revoice', key: 'revoice', label: 'New voice', price: '', pick: 'voice' },
    { product: 'action:translate', key: 'translate', label: 'Translate', price: '', pick: 'language' },
    { product: 'action:upscale', key: 'upscale', label: 'Upscale', price: '', pick: null },
  ];

  function loadCatalogue() {
    return fetch('/catalog/credit-packs.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var usd = (d && d.action_usd) || {};
        ACTIONS.forEach(function (a) {
          if (typeof usd[a.key] === 'number') a.price = '$' + usd[a.key];
        });
        var cr = (d && d.product_credits) || {};
        if (typeof cr.report === 'number') REPORT_CREDITS = cr.report;
        paintDock();
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

  /* The server verifies ownership of the source film and reprices; this only
   * shapes the order. */
  function startAction(creation, product, extra) {
    var sel = { creationId: creation.id, clipIndex: 0, productName: creation.title || '' };
    if (extra) { for (var k in extra) sel[k] = extra[k]; }
    return fetch('/.netlify/functions/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.HexaAuth.accessToken() },
      body: JSON.stringify({ order: { product: product, title: 'Film touch-up', selections: sel } }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (d && d.url) { location.href = d.url; return; }
        return Promise.reject(d);
      });
  }

  /* ── the rail ────────────────────────────────────────────── */

  /*
   * The categories, loaded from the catalogue rather than typed here.
   *
   * "Video" and "image" are storage types, not kinds of work: a product
   * photoshoot, a static ad and a poster are all "image", and a creator
   * talking to camera, a cinematic spot and a hyper-motion burst are all
   * "video". Somebody looking for the try-on they made on Tuesday is not
   * looking for "an image".
   *
   * catalog/studio-data.json owns the product -> category map so this page and
   * the studio cannot disagree about what a photoshoot is. Until it loads the
   * rail shows what it can, which is everything.
   */
  var CATEGORIES = [];
  var CAT_OF = {};      // product id -> category id

  function loadCategories() {
    return fetch('/catalog/studio-data.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        CATEGORIES = (d && d.categories) || [];
        CATEGORIES.forEach(function (c) {
          (c.products || []).forEach(function (p) { CAT_OF[p] = c.id; });
        });
        buildRail();
      })
      .catch(function () { /* the rail keeps All work and Reports, which need no map */ });
  }

  function catOf(c) { return c && c.product ? (CAT_OF[c.product] || null) : null; }

  function catName(id) {
    var hit = CATEGORIES.filter(function (c) { return c.id === id; })[0];
    return hit ? hit.name : null;
  }

  /* Fixed destinations, plus one per category once the catalogue lands. */
  var VIEWS = [
    ['all', 'nav-all', 'All work'],
    ['reports', 'nav-reports', 'Reports'],
    ['settings', 'nav-settings', 'Settings'],
  ];

  function buildRail() {
    var host = $('ws-made');
    if (!host) return;
    host.textContent = '';

    /* A category with nothing in it is not drawn. An empty "Posters" in the
     * rail is a promise the product does not keep, and the point of counts is
     * that they are answers rather than labels. */
    var made = state.creations || [];
    CATEGORIES.forEach(function (c) {
      var n = made.filter(function (x) { return catOf(x) === c.id; }).length;
      if (!n) return;
      var id = 'nav-' + c.id;
      var btn = el('button', 'ws-nav');
      btn.type = 'button';
      btn.id = id;
      btn.appendChild(icon(c.id));
      btn.appendChild(el('span', 'ws-nav-label', c.name));
      btn.appendChild(el('span', 'ws-nav-n', n.toLocaleString()));
      btn.title = c.sub || '';
      btn.addEventListener('click', function () { show(c.id); });
      host.appendChild(btn);
      if (!VIEWS.some(function (v) { return v[0] === c.id; })) VIEWS.push([c.id, id, c.name]);
    });
    $('ws-made-group').hidden = !host.children.length;
    markRail();
  }

  /* One family, drawn from paths, so the rail never mixes an icon set or falls
   * back to an emoji. */
  var ICONS = {
    product_shot: 'M3 7h18v13H3zM8 7V4h8v3M8 20V13h8v7',
    ads: 'M3 3h18v18H3zM3 9h18M9 9v12',
    ugc: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
    motion: 'M3 5h14v14H3zM17 10l4-3v10l-4-3',
  };

  function icon(id) {
    var svg = svgPath(ICONS[id] || 'M4 6h16M4 12h16M4 18h16');
    svg.setAttribute('class', 'ws-nav-ico');
    return svg;
  }

  function markRail() {
    VIEWS.forEach(function (v) {
      var btn = $(v[1]);
      if (!btn) return;
      var on = v[0] === state.view;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-current', on ? 'page' : 'false');
    });
  }

  function paintCounts() {
    var set = function (id, n) {
      var node = $(id);
      if (node) node.textContent = n == null ? '' : n.toLocaleString();
    };
    set('n-all', state.creations ? state.creations.length : null);
    set('n-reports', state.reports && state.reports !== 'error' ? state.reports.length : null);
    buildRail();
  }

  /* ── views ───────────────────────────────────────────────── */

  /* The list the current view is actually showing, after the search box. One
   * function, because the feed, the counts and the detail view's Previous/Next
   * must all agree on what "the current list" means. */
  function current() {
    var c = (state.creations || []).slice();
    /* A category view shows that category. "All work" shows everything,
     * including the pieces whose order is gone and which therefore have no
     * category at all: they are still your work, they just cannot be filed. */
    if (state.view !== 'all' && CAT_OF && catName(state.view)) {
      c = c.filter(function (x) { return catOf(x) === state.view; });
    }
    var q = state.query.trim().toLowerCase();
    if (q) c = c.filter(function (x) { return String(x.title || '').toLowerCase().indexOf(q) >= 0; });
    /*
     * Sorted here, not in the renderer, because three things index into this
     * list and they must agree: the cards, the detail view's Previous/Next,
     * and the count in the heading. Sorting in renderFeed alone meant a card
     * drawn third opened whatever was third in the UNSORTED array, so the
     * wrong image opened as soon as any row arrived out of order.
     *
     * account-creations does order by created_at desc; this is the guard
     * against that being the only thing standing between a click and the
     * wrong result.
     */
    return c.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
  }

  function show(view, push) {
    state.view = VIEWS.some(function (v) { return v[0] === view; }) ? view : 'all';
    markRail();

    var settings = state.view === 'settings';
    $('ws-settings').hidden = !settings;
    $('ws-view').hidden = settings;
    $('ws-dock').hidden = settings;          // nothing to generate from a form
    $('ws-density').hidden = settings || state.view === 'reports';
    var named = VIEWS.filter(function (v) { return v[0] === state.view; })[0];
    $('ws-heading').textContent = named ? named[2] : 'All work';

    if (state.view === 'reports') loadReports();
    if (settings) initSettingsOnce();
    render();

    if (push !== false) {
      var h = state.view === 'all' ? '' : '#' + state.view;
      if ((location.hash || '') !== h) history.replaceState(null, '', location.pathname + location.search + h);
    }
    /*
     * Jump, do not glide.
     *
     * `.ws-scroll` carries `scroll-behavior: smooth`, which is right for a
     * link within a view and wrong for a view change: assigning scrollTop
     * animates, and the panel is mid-animation while initSettingsOnce() drops
     * the credits balance and the ledger into it. Switching to Settings from a
     * scrolled feed therefore landed somewhere between the two, with the top of
     * the panel cut off. An explicit `behavior: 'auto'` overrides the
     * stylesheet for this one call and leaves in-view scrolling smooth.
     */
    $('ws-scroll').scrollTo({ top: 0, behavior: 'auto' });
  }

  function render() {
    if (state.view === 'settings') { $('ws-count').textContent = ''; return; }
    var host = $('ws-view');
    host.textContent = '';

    if (state.view === 'reports') { renderReports(host); return; }
    renderFeed(host);
  }

  /* ── the feed ────────────────────────────────────────────── */

  function renderFeed(host) {
    if (state.creations === null) { host.appendChild(skeleton()); $('ws-count').textContent = ''; return; }

    var list = current();
    $('ws-count').textContent = list.length ? list.length.toLocaleString() : '';

    if (!list.length) { host.appendChild(emptyFeed()); return; }

    /* Grouped by day. current() has already sorted, so this only has to break
     * the run when the date changes. */
    var day = null;
    var grid = null;
    list.forEach(function (c, i) {
      var label = dayLabel(c.created_at);
      if (label !== day) {
        day = label;
        var sec = el('section', 'ws-day');
        sec.appendChild(el('h2', 'ws-day-head', label));
        grid = el('div', 'ws-grid');
        sec.appendChild(grid);
        host.appendChild(sec);
      }
      grid.appendChild(card(c, i));
    });
  }

  function card(c, i) {
    var done = c.status === 'completed' && c.result_urls && c.result_urls.length;
    var failed = c.status === 'failed';
    var btn = el('button', 'ws-card' + (done ? '' : failed ? ' is-pending is-failed' : ' is-pending'));
    btn.type = 'button';
    btn.setAttribute('aria-label',
      (c.title || catName(catOf(c)) || 'Your work') + ', ' + fmtDate(c.created_at));

    if (!done) {
      btn.appendChild(el('span', 'ws-card-state', failed ? 'Did not finish' : 'Rendering'));
    } else {
      var url = c.thumb_url || c.result_urls[0];
      /* The box is reserved at 4:5 and released the moment the real ratio is
       * known, so the column does not jump as each result lands. See the note
       * on .is-sizing: we do not store dimensions, so this is a bound on the
       * shift rather than a claim about the shape. */
      if (isVideoUrl(url)) {
        var v = document.createElement('video');
        v.className = 'is-sizing';
        v.src = url + '#t=0.1';
        v.muted = true; v.playsInline = true; v.preload = 'metadata';
        v.setAttribute('playsinline', '');
        v.addEventListener('loadedmetadata', function () {
          if (v.videoWidth && v.videoHeight) { v.width = v.videoWidth; v.height = v.videoHeight; }
          v.classList.remove('is-sizing');
        });
        btn.appendChild(v);
      } else {
        var img = document.createElement('img');
        img.className = 'is-sizing';
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        /* The true box, recorded the moment it is knowable.
         *
         * Releasing the placeholder was only half of it: an <img> with no
         * width/height and no aspect-ratio can still shift the column on a
         * re-render or a warm cache, and the audit flagged exactly that on
         * every card at all three widths. naturalWidth/naturalHeight ARE the
         * dimensions we never stored, so writing them onto the element fixes
         * the box with the real ratio rather than a guessed one. */
        img.addEventListener('load', function () {
          if (img.naturalWidth && img.naturalHeight) {
            img.width = img.naturalWidth;
            img.height = img.naturalHeight;
          }
          img.classList.remove('is-sizing');
        });
        btn.appendChild(img);
      }
      /* The tag names the kind of work. Where the order is gone there is no
        * kind to name, so the tag is left off rather than filled with the
        * storage type, which would file a photoshoot as "Image". */
      var kind = catName(catOf(c));
      if (kind) btn.appendChild(el('span', 'ws-card-tag', kind));
      btn.appendChild(el('span', 'ws-card-meta', c.title || (c.type === 'video' ? 'Your ad' : 'Your creative')));
    }

    btn.addEventListener('click', function () { openDetail(i); });
    return btn;
  }

  function skeleton() {
    var box = el('div', 'ws-skeleton');
    /* Heights that vary, because the real feed does. A skeleton of identical
     * boxes promises a grid the content will not deliver. */
    [280, 200, 340, 240, 300, 190, 260, 320].forEach(function (h) {
      var s = el('span');
      s.style.height = h + 'px';
      box.appendChild(s);
    });
    return box;
  }

  function emptyFeed() {
    var box = el('div', 'ws-state');
    if (state.query) {
      box.appendChild(el('h2', null, 'Nothing matches "' + state.query.trim() + '"'));
      box.appendChild(el('p', null, 'Try a different word, or clear the search to see everything.'));
      return box;
    }
    if (WELCOME && !(state.creations || []).length) {
      box.appendChild(el('h2', null, 'Run your first read and the first ad is on us'));
      box.appendChild(el('p', null,
        'Paste a product link below. We read what your buyers say about products like yours, then build '
        + 'you a static ad from the angle that comes back. The ad costs you nothing.'));
      return box;
    }
    box.appendChild(el('h2', null, state.view === 'videos' ? 'No videos yet' : 'Nothing here yet'));
    box.appendChild(el('p', null,
      'Paste a product link below. Everything you make lands here, at full size.'));
    return box;
  }

  /* ── detail, opened in place ─────────────────────────────── */

  var detail = null;
  var lastFocus = null;

  function openDetail(i) {
    var list = current();
    if (!list[i]) return;
    state.open = i;
    lastFocus = document.activeElement;
    if (!detail) detail = buildDetail();
    document.body.appendChild(detail.root);
    paintDetail();
    detail.close.focus();
    document.addEventListener('keydown', onDetailKey);
  }

  function closeDetail() {
    if (!detail || !detail.root.parentNode) return;
    detail.root.remove();
    document.removeEventListener('keydown', onDetailKey);
    state.open = -1;
    /* Back exactly where they were: same view, same filter, same scroll, and
     * focus on the card they opened. */
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }

  function step(by) {
    var list = current();
    var next = state.open + by;
    if (next < 0 || next >= list.length) return;
    state.open = next;
    paintDetail();
  }

  function onDetailKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDetail(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); return; }
    /* A modal keeps focus. Without this, Tab walks into the feed behind it and
     * the keyboard user is editing a page they cannot see. */
    if (e.key !== 'Tab') return;
    var focusable = detail.root.querySelectorAll('button:not([disabled]), a[href], select');
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function buildDetail() {
    var root = el('div', 'ws-detail');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Preview');

    var bar = el('div', 'ws-detail-bar');
    var name = el('div', 'ws-detail-name');
    var h2 = el('h2');
    var meta = el('p');
    name.appendChild(h2); name.appendChild(meta);
    bar.appendChild(name);

    var acts = el('div', 'ws-detail-acts');
    var prev = iconBtn('Previous', 'M15 18l-6-6 6-6');
    var next = iconBtn('Next', 'M9 18l6-6-6-6');
    var dl = document.createElement('a');
    dl.className = 'ws-icon-btn';
    dl.setAttribute('aria-label', 'Download');
    dl.setAttribute('download', '');
    dl.innerHTML = '';
    dl.appendChild(svgPath('M12 3v12M7 11l5 5 5-5M5 21h14'));
    var close = iconBtn('Close', 'M18 6 6 18M6 6l12 12');
    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });
    close.addEventListener('click', closeDetail);
    acts.appendChild(prev); acts.appendChild(next); acts.appendChild(dl); acts.appendChild(close);
    bar.appendChild(acts);

    var stage = el('div', 'ws-detail-stage');
    root.appendChild(bar);
    root.appendChild(stage);

    /* Clicking the backdrop closes, the same as Esc. The stage swallows its
     * own clicks so dragging an image never dismisses it. */
    root.addEventListener('click', function (e) { if (e.target === root || e.target === stage) closeDetail(); });

    return { root: root, h2: h2, meta: meta, stage: stage, prev: prev, next: next, dl: dl, close: close };
  }

  function svgPath(d) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }

  function iconBtn(label, d) {
    var b = el('button', 'ws-icon-btn');
    b.type = 'button';
    b.setAttribute('aria-label', label);   // icon-only, so it carries its name
    b.appendChild(svgPath(d));
    return b;
  }

  function paintDetail() {
    var list = current();
    var c = list[state.open];
    if (!c) { closeDetail(); return; }

    detail.h2.textContent = c.title || catName(catOf(c)) || 'Your work';
    detail.meta.textContent = fmtDate(c.created_at) + ' · ' + (state.open + 1) + ' of ' + list.length;
    detail.prev.disabled = state.open === 0;
    detail.next.disabled = state.open === list.length - 1;

    detail.stage.textContent = '';
    var done = c.status === 'completed' && c.result_urls && c.result_urls.length;
    if (!done) {
      detail.dl.hidden = true;
      detail.stage.appendChild(el('p', 'ws-detail-empty', c.status === 'failed'
        ? 'This one did not finish rendering. You were not charged for it, and nothing about the report it '
          + 'came from has changed.'
        : 'Still rendering. It appears here the moment it lands.'));
      return;
    }

    var url = c.result_urls[0];
    detail.dl.hidden = false;
    detail.dl.href = url;
    if (isVideoUrl(url)) {
      var v = document.createElement('video');
      v.src = url; v.controls = true; v.playsInline = true; v.autoplay = true; v.muted = true;
      detail.stage.appendChild(v);
    } else {
      var img = document.createElement('img');
      img.src = url;
      img.alt = c.title || 'Your creative';
      /* Same reason as the feed card: the stage is centred, so an image that
       * arrives without a box jumps the whole view as it lands. The CSS keeps
       * max-width/max-height, so recording the true size fixes the ratio
       * without ever letting it overflow. */
      img.addEventListener('load', function () {
        if (img.naturalWidth && img.naturalHeight) {
          img.width = img.naturalWidth;
          img.height = img.naturalHeight;
        }
      });
      detail.stage.appendChild(img);
    }
  }

  /* ── reports ─────────────────────────────────────────────── */

  /*
   * Read straight through PostgREST. No new function is needed: the reports
   * table has carried product_title, verdict, demand_signal, evidence_count,
   * paid and status since it was created, it is indexed on
   * (user_id, created_at desc), and the policy "reports: owner can read" is
   * what scopes the query. There is no account id in this call to tamper with.
   *
   * A report only appears here because report-claim.js put a user_id on it, so
   * this list is also the visible proof that the claim worked.
   */
  var reportsAsked = false;

  function loadReports() {
    if (reportsAsked || !window.HexaAuth.client) return;
    reportsAsked = true;

    window.HexaAuth.client.from('reports')
      .select('id,product_title,product_url,verdict,demand_signal,evidence_count,paid,status,created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      /* PostgREST answers failures in the response rather than by rejecting,
       * so an unchecked r.error paints a policy denial as an empty library. */
      .then(function (r) {
        if (!r || r.error) { reportsAsked = false; state.reports = 'error'; }
        else state.reports = r.data || [];
        paintCounts();
        if (state.view === 'reports') render();
      }, function () {
        reportsAsked = false;
        state.reports = 'error';
        if (state.view === 'reports') render();
      });
  }

  function renderReports(host) {
    if (state.reports === null) { host.appendChild(skeleton()); $('ws-count').textContent = ''; return; }

    if (state.reports === 'error') {
      var err = el('div', 'ws-state');
      err.appendChild(el('h2', null, 'Could not load your reports'));
      err.appendChild(el('p', null, 'Nothing is lost. Refresh the page and they will be here.'));
      var retry = el('button', 'ws-btn', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', function () { state.reports = null; render(); loadReports(); });
      err.appendChild(retry);
      host.appendChild(err);
      return;
    }

    var q = state.query.trim().toLowerCase();
    var rows = q
      ? state.reports.filter(function (r) { return String(r.product_title || '').toLowerCase().indexOf(q) >= 0; })
      : state.reports;

    $('ws-count').textContent = rows.length ? rows.length.toLocaleString() : '';

    if (!rows.length) {
      var box = el('div', 'ws-state');
      box.appendChild(el('h2', null, q ? 'No reports match that' : 'No reads yet'));
      box.appendChild(el('p', null, q
        ? 'Try a different word, or clear the search.'
        : 'Every product link you paste becomes a report: what your buyers say, which competitor ads have '
          + 'run longest, and the angle to lead with. They all land here.'));
      host.appendChild(box);
      return;
    }

    var list = el('div', 'ws-reports');
    rows.forEach(function (r) {
      var a = el('a', 'ws-report');
      /* The id and nothing else. The claim token is a bearer credential and
       * never travels in a URL, so this link is safe to paste anywhere: the
       * row belongs to an account, and report-status authorises off the
       * bearer token instead. */
      a.href = '/validate?report=' + encodeURIComponent(r.id);

      var top = el('div', 'ws-report-top');
      top.appendChild(el('h3', 'ws-report-title', r.product_title || 'Untitled read'));
      top.appendChild(el('span', 'ws-report-when', fmtDate(r.created_at)));
      a.appendChild(top);

      /* Only columns that exist get drawn. demand_signal is a real column;
       * "competition high" and "opportunity good" are not, and inventing them
       * is how a research product stops being one. */
      var tags = el('div', 'ws-tags');
      if (r.status === 'building') tags.appendChild(el('span', 'ws-tag is-work', 'Still reading'));
      else if (r.status === 'failed') tags.appendChild(el('span', 'ws-tag', 'Did not finish'));
      if (r.demand_signal) tags.appendChild(el('span', 'ws-tag', 'Demand ' + r.demand_signal));
      if (r.evidence_count) tags.appendChild(el('span', 'ws-tag', r.evidence_count.toLocaleString() + ' comments read'));
      if (!r.paid && r.status === 'ready') tags.appendChild(el('span', 'ws-tag is-free', 'Free read'));
      if (tags.children.length) a.appendChild(tags);

      if (r.verdict) a.appendChild(el('p', 'ws-report-verdict', r.verdict));
      list.appendChild(a);
    });
    host.appendChild(list);
  }

  /* ── the dock ────────────────────────────────────────────── */

  /*
   * The cost is written into the button, next to the label, in the same paint
   * as the label. A separate "a read costs 1,000 credits" line beside the
   * control is read last and acted on first; inside, it cannot be missed and
   * it cannot go stale.
   *
   * When the balance will not cover it the button says so and becomes the way
   * to top up, rather than failing on press.
   */
  function paintDock() {
    var n = $('ws-go-n');
    if (n) n.textContent = REPORT_CREDITS.toLocaleString();
    var go = $('ws-go');
    if (!go || state.balance === null) return;
    var short = state.balance < REPORT_CREDITS;
    go.classList.toggle('is-short', short);
    go.firstChild.textContent = short ? 'Top up to read ' : 'Read my market ';
  }

  function initDock() {
    var form = $('ws-dock-form');
    var input = $('ws-link');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.balance !== null && state.balance < REPORT_CREDITS) {
        show('settings');
        $('ws-topup').click();
        return;
      }
      var url = (input.value || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        note('ws-dock-note', 'That does not look like a link. Paste the page for a single product.', 'err');
        input.focus();
        return;
      }
      note('ws-dock-note', '');
      /* Straight to the read. The studio is downstream of it: somebody who
       * pastes a link is asking what to say, not which style preset to use. */
      location.href = '/validate?url=' + encodeURIComponent(url);
    });
    input.addEventListener('input', function () { note('ws-dock-note', ''); });
  }

  /* ── search and density ──────────────────────────────────── */

  function initControls() {
    var q = $('ws-q');
    var t = null;
    q.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { state.query = q.value; render(); }, 140);
    });

    var size = $('ws-size');
    var apply = function () {
      document.documentElement.style.setProperty('--ws-col', size.value + 'px');
      try { localStorage.setItem('hexa.ws.col', size.value); } catch (e) {}
    };
    var saved = null;
    try { saved = localStorage.getItem('hexa.ws.col'); } catch (e) {}
    if (saved) size.value = saved;
    apply();
    size.addEventListener('input', apply);

    VIEWS.forEach(function (v) {
      $(v[1]).addEventListener('click', function () { show(v[0]); });
    });

    $('ws-balance').addEventListener('click', function () {
      show('settings');
      $('ws-credits-n').scrollIntoView({ block: 'start' });
    });

    $('ws-signout').addEventListener('click', function () {
      window.HexaAuth.signOut().then(function () { location.href = '/'; });
    });

    window.addEventListener('hashchange', function () {
      show((location.hash || '').replace('#', '') || 'all', false);
    });
  }

  /* ── library ─────────────────────────────────────────────── */

  function loadLibrary() {
    return fetch(LIST_URL, { headers: { Authorization: 'Bearer ' + window.HexaAuth.accessToken() } })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        state.creations = d.creations || [];
        paintCounts();
        render();
      })
      .catch(function () {
        state.creations = [];
        paintCounts();
        var host = $('ws-view');
        host.textContent = '';
        var box = el('div', 'ws-state');
        box.appendChild(el('h2', null, 'Could not load your work'));
        box.appendChild(el('p', null, 'Nothing is lost. Refresh the page and it will be here.'));
        host.appendChild(box);
      });
  }

  /* ── settings ────────────────────────────────────────────── */

  var settingsReady = false;
  function initSettingsOnce() {
    if (settingsReady) return;
    settingsReady = true;
    initCredits();
    initShopify();
    initBrand();
    initProfile();
  }

  /* What the balance can actually buy, which is the only thing that makes a
   * five figure number meaningful. Each divisor is a real catalogue price at
   * 500 credits to the dollar: adsingle $1, a market read from the generated
   * catalogue, cheapest video ad $9. */
  function creditsMeaning(balance) {
    if (balance <= 0) return 'Top up to make your next ad.';
    var ads = Math.floor(balance / 500);
    var videos = Math.floor(balance / 4500);
    var reads = Math.floor(balance / REPORT_CREDITS);
    var parts = [];
    if (ads) parts.push(ads.toLocaleString() + (ads === 1 ? ' ad creative' : ' ad creatives'));
    if (reads) parts.push(reads.toLocaleString() + (reads === 1 ? ' market read' : ' market reads'));
    if (videos) parts.push(videos.toLocaleString() + (videos === 1 ? ' video ad' : ' video ads'));
    return parts.length ? 'Enough for ' + parts.join(', or ') + '.' : 'Top up to make your next ad.';
  }

  var LEDGER_LABEL = {
    grant: 'Welcome credits', purchase: 'Credits purchased', spend: 'Spent',
    refund: 'Refunded, not delivered', adjust: 'Adjustment',
  };

  function renderLedger(rows) {
    var box = $('ws-ledger-rows');
    box.textContent = '';
    if (!rows || !rows.length) { box.appendChild(el('p', 'ws-note', 'Nothing yet.')); return; }
    rows.forEach(function (r) {
      var row = el('div', 'ws-ledger-row');
      var left = el('div');
      left.appendChild(el('span', 'ws-ledger-kind', LEDGER_LABEL[r.kind] || r.kind));
      if (r.note) left.appendChild(el('span', 'ws-ledger-note', r.note));
      row.appendChild(left);
      var right = el('div', 'ws-ledger-right');
      var d = Number(r.delta) || 0;
      right.appendChild(el('span', 'ws-ledger-delta' + (d > 0 ? ' is-up' : ''), (d > 0 ? '+' : '') + d.toLocaleString()));
      right.appendChild(el('span', 'ws-ledger-when',
        new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      row.appendChild(right);
      box.appendChild(row);
    });
  }

  function loadBalance() {
    if (!window.HexaAuth.client) return;
    window.HexaAuth.client.rpc('my_credit_balance').then(function (r) {
      state.balance = r && !r.error ? Number(r.data || 0) : 0;
      $('ws-balance-n').textContent = state.balance.toLocaleString();
      $('ws-balance').hidden = false;
      $('ws-balance').setAttribute('aria-label', state.balance.toLocaleString() + ' credits. Open credits and top up.');
      $('ws-credits-n').textContent = state.balance.toLocaleString();
      $('ws-credits-sub').textContent = creditsMeaning(state.balance);
      paintDock();
    });
  }

  function initCredits() {
    window.HexaAuth.client.rpc('my_credit_history', { p_limit: 40 }).then(function (r) {
      renderLedger(r && !r.error ? r.data : null);
    });

    /* Packs are fetched rather than hardcoded, so a price change in
     * catalog/pricing.json reaches the page without a code edit. */
    var packs = $('ws-packs');
    $('ws-topup').addEventListener('click', function () {
      if (!packs.hidden) { packs.hidden = true; return; }
      packs.hidden = false;
      if (packs.dataset.filled) return;
      fetch('/catalog/credit-packs.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          packs.dataset.filled = '1';
          (d.credit_packs || []).forEach(function (p) {
            var b = el('button', 'ws-pack');
            b.type = 'button';
            b.appendChild(el('span', 'ws-pack-n', p.credits.toLocaleString()));
            b.appendChild(el('span', 'ws-pack-u', 'credits'));
            b.appendChild(el('span', 'ws-pack-usd', '$' + p.usd));
            if (p.bonus_pct) b.appendChild(el('span', 'ws-pack-bonus', p.bonus_pct + '% extra'));
            b.addEventListener('click', function () { buyPack(p.id, b); });
            packs.appendChild(b);
          });
        })
        .catch(function () { packs.appendChild(el('p', 'ws-note', 'Could not load the packs. Try again in a moment.')); });
    });

    // Arriving back from Stripe. The credits are granted by the webhook, which
    // can land a second after the redirect, so this refreshes shortly after.
    var topup = new URLSearchParams(location.search).get('topup');
    if (topup) {
      $('ws-credits-sub').textContent = 'Thanks. ' + Number(topup).toLocaleString()
        + ' credits are being added and will appear here in a moment.';
      setTimeout(loadBalance, 4000);
      history.replaceState({}, '', '/account.html#settings');
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
        note('ws-credits-sub', (d && d.error) || 'Could not start checkout. Please try again.', 'err');
      });
  }

  /*
   * Shopify. The connection state is read from my_store_connections, a view
   * that exists precisely so the browser can see WHETHER a store is connected
   * without ever being able to see the token that makes it work.
   */
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
    var form = $('ws-shop-form');
    var input = $('ws-shop-input');
    var sub = $('ws-shop-sub');
    var dis = $('ws-shop-disconnect');

    function paint(store) {
      if (store) {
        sub.textContent = 'Connected to ' + store.store + '. We read your product catalogue and nothing else.';
        form.hidden = true;
        dis.hidden = false;
        dis.onclick = function () {
          dis.disabled = true;
          /* A plain delete, not an RPC. The row-level policy is what enforces
           * ownership, so this can only ever remove the caller's own
           * connection, and there is no elevated function to get wrong. */
          window.HexaAuth.client.from('store_connections')
            .delete().eq('platform', 'shopify').eq('store', store.store)
            /* PostgREST reports failures in the response rather than by
             * rejecting, so a policy denial arrives here as r.error and would
             * otherwise be painted as success. */
            .then(function (r) {
              dis.disabled = false;
              if (r && r.error) { note('ws-shop-note', 'Could not disconnect. Try again.', 'err'); return; }
              paint(null);
              note('ws-shop-note', 'Store disconnected.', 'ok');
            }, function () {
              dis.disabled = false;
              note('ws-shop-note', 'Could not disconnect. Try again.', 'err');
            });
        };
      } else {
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
      note('ws-shop-note', m[1], m[0]);
      history.replaceState({}, '', '/account.html#settings');
    }
  }

  /*
   * Brand memory. Written straight from the browser, unlike everything else on
   * this page, because there is nothing secret in it: these are the customer's
   * own words about their own brand. RLS scopes every read and write to
   * auth.uid(), and the unique index keeps exactly one default profile per
   * account.
   */
  var BRAND_FIELDS = [
    ['brand-name', 'brand_name'], ['brand-audience', 'audience'], ['brand-tone', 'tone'],
    ['brand-words-use', 'words_use'], ['brand-words-avoid', 'words_avoid'], ['brand-offer', 'offer'],
  ];

  function initBrand() {
    var save = $('brand-save');
    var uid = window.HexaAuth.user().id;

    window.HexaAuth.client.from('brand_profiles')
      .select('brand_name,audience,tone,words_use,words_avoid,offer')
      .is('scope', null)
      .maybeSingle()
      .then(function (r) {
        if (!r || r.error || !r.data) return;
        BRAND_FIELDS.forEach(function (f) { if (r.data[f[1]]) $(f[0]).value = r.data[f[1]]; });
      });

    save.addEventListener('click', function () {
      save.disabled = true;
      var row = { user_id: uid, scope: null };
      BRAND_FIELDS.forEach(function (f) { row[f[1]] = ($(f[0]).value || '').trim() || null; });
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

  function initProfile() {
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
          note('set-security-note', /Password should contain/i.test(r.error.message || '')
            ? 'Make it stronger: at least one lowercase letter, one capital letter and one number.'
            : (r.error.message || 'Could not change password.'), 'err');
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
        .then(function (r) { return r.ok ? r.blob() : Promise.reject(r); })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'hexa-account-export.json';
          a.click();
          URL.revokeObjectURL(url);
          note('set-export-note', 'Downloaded.', 'ok');
        })
        .catch(function () { note('set-export-note', 'Could not build the export. Try again.', 'err'); });
    });

    /* Deleting is gated on typing the account email, which is the standard
     * guard for a thing that cannot be undone. */
    var delBtn = $('set-delete');
    var delInput = $('set-del-confirm');
    delInput.addEventListener('input', function () {
      var want = (window.HexaAuth.email() || '').toLowerCase();
      delBtn.disabled = delInput.value.trim().toLowerCase() !== want;
    });
    delBtn.addEventListener('click', function () {
      delBtn.disabled = true;
      note('set-delete-note', 'Deleting your account…');
      fetch('/.netlify/functions/account-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.HexaAuth.accessToken() },
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

  /* ── boot ────────────────────────────────────────────────── */

  window.HexaAuth.ready().then(function () {
    if (!window.HexaAuth.user()) { window.HexaAuth.requireAuth('/account.html'); return; }

    $('ws-user').textContent = window.HexaAuth.email() || '';
    initControls();
    initDock();

    // The catalogue first, so the dock's button is priced on its first paint
    // rather than filled in a beat later. A failed fetch resolves too.
    loadCatalogue();
    loadCategories().then(loadLibrary);
    loadBalance();
    /* Counts are part of the rail, so reports load on arrival rather than on
     * the first visit to that tab: a rail that says "Reports" with no number
     * beside "Ads 37" reads as broken. */
    loadReports();

    show((location.hash || '').replace('#', '') || 'all', false);
  });
})();

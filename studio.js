/* ═════ Hexa Studio ═════
 * Composer-first studio. All rails render from catalog/studio-data.json
 * (live data exported from the generation backend). Every selection maps
 * 1:1 to a generation parameter. Checkout wiring lands next; until then
 * Continue hands the brief to the intake flow.
 */

(function () {
  'use strict';

  var DATA_URL = 'catalog/studio-data.json';
  var STUDIO_LIVE = true; // Stripe checkout live: create-checkout reprices server-side

  /* ── Product peek: read the pasted link server-side ── */
  var PEEK_URL = '/.netlify/functions/product-peek';
  var PEEK_SOFT_MS = 7000;  // stage gives up waiting and docks to the chooser
  var PEEK_HARD_MS = 9500;  // absolute cap on the stage, whatever is loading
  var PEEK_MIN_MS = 900;    // minimum stage time, so the beat never flashes
  var PEEK_IMG_MS = 1500;   // budget for preloading the product image
  var PEEK_HOLD_MS = 1400;  // how long the identified product holds the stage

  /* ── Video modes (rendered as tiles) ── */
  var MODE_CONFIG = {
    ugc:            { price: 19, eta: '~5 min', steps: ['link', 'avatar', 'hook', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Creator-style ad' },
    tv_spot:        { price: 29, eta: '~7 min', steps: ['link', 'duration', 'aspect', 'notes'], kicker: 'Broadcast-grade spot' },
    product_review: { price: 19, eta: '~5 min', steps: ['link', 'avatar', 'hook', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Honest-feeling review' },
    unboxing:       { price: 19, eta: '~5 min', steps: ['link', 'avatar', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'First-touch unboxing' },
    tutorial:       { price: 19, eta: '~5 min', steps: ['link', 'avatar', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'How-to walkthrough' },
    ugc_try_on:     { price: 19, eta: '~5 min', steps: ['link', 'avatar', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Casual try-on' },
    pro_try_on:     { price: 29, eta: '~7 min', steps: ['link', 'avatar', 'duration', 'aspect', 'notes'], kicker: 'Editorial try-on' },
    hyper_motion:   { price: 12, eta: '~3 min', steps: ['link', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Impossible camera moves' },
    wild_card:      { price: 12, eta: '~3 min', steps: ['link', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Something unexpected' },
  };

  /* One engine output caps at 15s. Longer runs render as chained 15s
   * segments (one storyboard, same avatar and scene) stitched into one film.
   * Nobody else in this lane sells that. */
  var SEGMENT_SECONDS = 15;
  var EXTRA_SEGMENT_PRICE = 12;
  var DURATIONS = [
    { sec: 15, name: '15 seconds' },
    { sec: 30, name: '30 seconds' },
    { sec: 45, name: '45 seconds' },
    { sec: 60, name: '60 seconds' },
    { sec: 90, name: '90 seconds' },
    { sec: 120, name: '2 minutes' },
  ];

  /* Quality: 720p included on standard modes, 1080p priced per segment
   * (rendering cost scales with every 15s). Premium products ship 1080p
   * included; they carry it in their base price. Mirrored in lib/pricing.js. */
  var QUALITY_1080_PER_SEGMENT = 4;
  var PREMIUM_1080 = { 'mode:tv_spot': 1, 'mode:pro_try_on': 1, cinematic: 1 };
  var QUALITIES = [
    { id: '720p', name: '720p HD' },
    { id: '1080p', name: '1080p Ultra' },
  ];

  /* ── Non-video products (More tiles) ── */
  var PRODUCTS = {
    photoshoot: { title: 'Product Photoshoot', kicker: 'Ten images, one pass', price: 15, eta: '~2 min', steps: ['link', 'mode', 'aspect', 'notes'] },
    adpack:     { title: 'DTC Ad Pack', kicker: 'Proven static formats', price: 19, eta: '~2 min', steps: ['link', 'formats', 'notes'] },
    soul:       { title: 'Soul Character', kicker: 'Train once, reuse forever', price: 29, eta: '~1 hr', steps: ['soulname', 'soulphotos'] },
    cinematic:  { title: 'Cinematic Spot', kicker: 'Director-grade look', price: 29, eta: '~7 min', steps: ['link', 'camera', 'grade', 'light', 'duration', 'aspect', 'notes'] },
    auto:       { title: 'Auto Mode', kicker: 'We pick the winning format', price: 19, eta: '~5 min', steps: ['link', 'duration', 'quality', 'aspect', 'notes'] },
  };

  /* Real backend photoshoot modes (each ships its own prompt enhancement). */
  var PHOTOSHOOT_MODES = [
    { id: 'product_shot', name: 'Product Shot', desc: 'Clean studio hero shots of the product itself.' },
    { id: 'lifestyle_scene', name: 'Lifestyle Scene', desc: 'Your product in someone\'s real day: kitchens, desks, streets.' },
    { id: 'hero_banner', name: 'Hero Banner', desc: 'Wide, art-directed images for the top of your site.' },
    { id: 'social_carousel', name: 'Social Carousel', desc: 'A matching set built to swipe through on Instagram.' },
    { id: 'ad_creative_pack', name: 'Ad Creative Pack', desc: 'Frames with space for headlines and offers, ready for text.' },
    { id: 'virtual_model_tryout', name: 'Virtual Model Try-Out', desc: 'Your product worn or used by an AI model.' },
    { id: 'closeup_product_with_person', name: 'Close-Up With Person', desc: 'Held in hand, macro detail, human touch.' },
    { id: 'moodboard_pin', name: 'Moodboard Pin', desc: 'Editorial, Pinterest-ready aesthetic shots.' },
    { id: 'conceptual_product', name: 'Conceptual', desc: 'One bold art-direction idea built around the product.' },
    { id: 'restyle', name: 'Restyle', desc: 'Your existing photo, dropped into a new scene.' },
  ];

  var state = {
    data: null,
    presets: [],
    product: null,  // 'mode:ugc' | 'photoshoot' | ...
    sel: {},
    style: null,    // active preset id, for the order payload
    composerLink: '',
    view: 'steps',  // 'steps' | 'ticket' (order review before pay)
    headKicker: '', // drawer header to restore when leaving the ticket
    headTitle: '',
    peek: null,     // latest product-peek result { ok, url, title, image, ... }
    peekJob: null,  // in-flight peek { link, promise }
    prefs: {},      // composer-chosen settings { duration, aspectId, quality }
  };

  /* ── Utilities ── */
  function $(q, el) { return (el || document).querySelector(q); }
  function $all(q, el) { return Array.prototype.slice.call((el || document).querySelectorAll(q)); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function label(s) {
    return s.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  /* Preview playback: hover on pointer devices; on touch, previews self-play
   * while mostly in view (no hover exists, and tap already means "open"). */
  var TOUCH_UI = window.matchMedia && window.matchMedia('(hover: none)').matches;
  var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var previewObserver = (TOUCH_UI && !REDUCED_MOTION && 'IntersectionObserver' in window)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var v = e.target.querySelector('video');
          if (!v) return;
          if (e.intersectionRatio >= 0.75) {
            e.target.classList.add('previewing');
            v.play().catch(function () {});
          } else {
            e.target.classList.remove('previewing');
            v.pause();
          }
        });
      }, { threshold: [0, 0.75] })
    : null;

  function hoverVideo(container, video) {
    if (previewObserver) { previewObserver.observe(container); return; }
    container.addEventListener('mouseenter', function () { video.play().catch(function () {}); });
    container.addEventListener('mouseleave', function () { video.pause(); });
  }

  /* Rails that should feel alive without a hover: local, small clips
   * self-play while mostly on screen (desktop included). */
  var railAutoplay = (!REDUCED_MOTION && 'IntersectionObserver' in window)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var v = e.target.querySelector('video');
          if (!v) return;
          if (e.intersectionRatio >= 0.55) {
            e.target.classList.add('previewing');
            v.play().catch(function () {});
          } else {
            e.target.classList.remove('previewing');
            v.pause();
          }
        });
      }, { threshold: [0, 0.55] })
    : null;

  /* ── Examples viewer ─────────────────────────────────────────────
   * Every tile press opens real footage first; ordering is the CTA
   * inside, not the click itself. Opened by styles, modes, hooks and
   * the reel (script.js reaches it via window.hexaViewer). */
  var VIEWER = null;

  function initViewer() {
    var ov = $('#viewer-overlay');
    if (!ov) return;
    var vid = $('#viewer-video');
    var img = $('#viewer-image');
    var spin = $('#viewer-spin');
    var strip = $('#viewer-strip');
    var ctaBtn = $('#viewer-cta');
    var prev = $('.viewer-prev', ov);
    var next = $('.viewer-next', ov);
    var items = [];
    var idx = 0;
    var ctaRun = null;

    function show(i) {
      idx = (i + items.length) % items.length;
      var it = items[idx];
      $all('.viewer-thumb', strip).forEach(function (t, j) {
        t.classList.toggle('sel', j === idx);
      });
      if (!it.video) {
        vid.pause();
        vid.removeAttribute('src');
        vid.hidden = true;
        spin.hidden = true;
        img.src = it.image || it.thumb;
        img.hidden = false;
        return;
      }
      img.hidden = true;
      vid.hidden = false;
      spin.hidden = false;
      if (it.thumb) vid.poster = it.thumb; else vid.removeAttribute('poster');
      vid.src = it.video;
      vid.muted = false;
      var p = vid.play();
      if (p && typeof p.catch === 'function') p.catch(function () { spin.hidden = true; });
    }
    vid.addEventListener('playing', function () { spin.hidden = true; });
    vid.addEventListener('canplay', function () { spin.hidden = true; });
    vid.addEventListener('waiting', function () { spin.hidden = false; });

    function open(cfg) {
      items = (cfg.items || []).filter(function (x) { return x && (x.video || x.image || x.thumb); });
      if (!items.length) return;
      $('#viewer-kicker').textContent = cfg.kicker || 'Examples';
      $('#viewer-title').textContent = cfg.title || '';
      var tag = $('#viewer-tag');
      tag.textContent = cfg.tag || '';
      tag.hidden = !cfg.tag;
      strip.innerHTML = '';
      items.forEach(function (it, j) {
        var b = el('button', 'viewer-thumb');
        b.type = 'button';
        if (it.thumb || it.image) {
          var im = el('img');
          im.src = it.thumb || it.image;
          im.alt = '';
          im.loading = 'lazy';
          b.appendChild(im);
        }
        if (it.label) b.appendChild(el('span', null, it.label));
        b.addEventListener('click', function () { show(j); });
        strip.appendChild(b);
      });
      strip.hidden = items.length < 2;
      prev.hidden = next.hidden = items.length < 2;
      ctaRun = cfg.cta ? cfg.cta.run : null;
      ctaBtn.textContent = cfg.cta ? cfg.cta.label : '';
      ctaBtn.hidden = !cfg.cta;
      ov.hidden = false;
      document.body.classList.add('viewer-open');
      show(cfg.start || 0);
    }

    function close() {
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
      img.removeAttribute('src');
      ov.hidden = true;
      document.body.classList.remove('viewer-open');
    }

    ctaBtn.addEventListener('click', function () {
      var run = ctaRun;
      close();
      if (run) run();
    });
    $('.viewer-close', ov).addEventListener('click', close);
    prev.addEventListener('click', function () { show(idx - 1); });
    next.addEventListener('click', function () { show(idx + 1); });
    ov.addEventListener('click', function (e) {
      if (e.target === ov) close();
    });
    document.addEventListener('keydown', function (e) {
      if (ov.hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });

    VIEWER = { open: open, close: close };
    window.hexaViewer = VIEWER;
  }

  /* ── Example sets: what plays when a tile is opened ── */
  function findById(list, id) {
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function presetExamples(p) {
    var out = [];
    var sd = state.data || {};
    var sel = p.sel || {};
    if (sel.setting) {
      var s = findById(sd.settings, sel.setting.id);
      if (s && s.video) out.push({ video: s.video, thumb: s.thumb, label: 'Scene · ' + s.name });
    }
    if (sel.hook) {
      var h = findById(sd.hooks, sel.hook.id);
      if (h && h.video) out.push({ video: h.video, thumb: h.thumb, label: 'Hook · ' + h.name });
    }
    if (p.product && p.product.indexOf('mode:') === 0) {
      var m = findById(sd.modes, p.product.slice(5));
      if (m && m.video) out.push({ video: m.video, thumb: m.poster, label: 'Format · ' + m.name });
    }
    /* previews that point at a scene thumb carry that scene's clip too */
    if (p.preview && p.preview.indexOf('assets/hf/settings/') === 0) {
      var clip = p.preview.replace('_thumb.webp', '.mp4');
      var already = out.some(function (x) { return x.video === clip; });
      if (!already) out.unshift({ video: clip, thumb: p.preview, label: 'Scene' });
    }
    if (!out.length && p.preview) out.push({ image: p.preview, label: p.name });
    return out;
  }

  function modeExamples(m) {
    var out = [];
    if (m.video) out.push({ video: m.video, thumb: m.poster, label: m.name });
    else if (m.poster) out.push({ image: m.poster, label: m.name });
    /* UGC shoots live in scenes: show a few so "UGC" means something */
    if (m.id === 'ugc') {
      var names = ['Bedroom', 'Street', 'Gym'];
      ((state.data || {}).settings || []).forEach(function (s) {
        if (names.indexOf(s.name) >= 0 && s.video) {
          out.push({ video: s.video, thumb: s.thumb, label: 'Scene · ' + s.name });
        }
      });
    }
    return out;
  }

  /* Downscale an image file to a compact JPEG data URL (keeps order payload small). */
  function shrinkImage(file, maxPx, cb) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      var scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      cb(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }

  /* The product step is satisfied by ANY of: link, photos, description. */
  function hasProduct(s) {
    return !!(s.link || (s.photos && s.photos.length) || s.desc);
  }

  /* ── Product peek plumbing ── */
  var peekCache = {};      // normalized link -> peek result
  var revealTimers = [];   // pending stage timers, cleared on close/dock

  function clearRevealTimers() {
    revealTimers.forEach(clearTimeout);
    revealTimers = [];
  }

  /* Normalize composer input to a fetchable URL, or null. */
  function looksLikeUrl(v) {
    if (!v) return null;
    var s = v.trim();
    if (/\s/.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) {
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|$)/i.test(s)) return null;
      s = 'https://' + s;
    }
    try {
      var u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (u.hostname.indexOf('.') < 0) return null;
      return u.href;
    } catch (e) { return null; }
  }

  function startPeek(link) {
    if (peekCache[link]) {
      state.peek = peekCache[link];
      return Promise.resolve(peekCache[link]);
    }
    if (state.peekJob && state.peekJob.link === link) return state.peekJob.promise;
    var p = fetch(PEEK_URL + '?url=' + encodeURIComponent(link))
      .then(function (r) { return r.json(); })
      .catch(function () { return null; })
      .then(function (d) {
        d = d && typeof d === 'object' ? d : { ok: false };
        d.url = link;
        peekCache[link] = d;
        state.peek = d;
        if (d.ok && !d.image && d.webProductId) pollWebProduct(d);
        return d;
      });
    state.peekJob = { link: link, promise: p };
    return p;
  }

  function formatPeekPrice(pk) {
    if (!pk || !pk.price) return '';
    var amount = String(pk.price).replace(/\.00$/, '');
    if (!pk.currency || pk.currency === 'USD') return '$' + amount;
    return amount + ' ' + pk.currency;
  }

  /* Peek fields matching the given link, or null. */
  function peekFor(link) {
    var pk = state.peek;
    return pk && pk.ok && pk.url === link ? pk : null;
  }

  /* Bot-walled stores refuse our direct read, but the engine's own scrape
   * still re-hosts the product image on its CDN. Poll for it and upgrade the
   * peek in place; every later render of the peek picks the image up for free. */
  var wpPolls = {}; // webProductId -> polling started

  function pollWebProduct(pk) {
    if (!pk || !pk.ok || pk.image || !pk.webProductId || wpPolls[pk.webProductId]) return;
    wpPolls[pk.webProductId] = true;
    // Simple stores scrape in seconds, but heavy SPA pages (Indiegogo,
    // Kickstarter) take the engine minutes. Poll with a growing interval
    // for ~3 minutes total; the upgrade applies whenever it lands.
    var tries = 0;
    var MAX_TRIES = 45;
    (function tick() {
      if (tries++ >= MAX_TRIES) return;
      var delay = Math.min(2500 + tries * 400, 8000);
      fetch(PEEK_URL + '?webProduct=' + encodeURIComponent(pk.webProductId))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.image) {
            pk.image = d.image;
            if (d.title && (!pk.title || pk.guessed)) pk.title = d.title;
            peekUpgraded(pk);
          } else if (!d || !d.ready) {
            setTimeout(tick, delay);
          }
        })
        .catch(function () { setTimeout(tick, delay + 2000); });
    })();
  }

  /* The peeked image URL exists but the store's CDN will not serve it to the
   * browser (hotlink protection): drop it and fall back to the scrape. */
  function peekImageFailed(pk) {
    if (!pk || !pk.webProductId) return;
    pk.image = null;
    pollWebProduct(pk);
  }

  /* A late image arrived: refresh whatever peek UI is on screen right now. */
  function peekUpgraded(pk) {
    if (pk.url !== (state.sel.link || state.composerLink)) return;
    // the composer's inline chip re-reads the peek on input events
    var linkInput = $('#composer-link');
    if (linkInput) linkInput.dispatchEvent(new Event('input', { bubbles: true }));
    var overlay = $('#config-overlay');
    if (!overlay || overlay.hidden) return;
    var stage = $('#peek-stage');
    if (stage && !stage.hidden) {
      var pre = new Image();
      pre.onload = function () {
        var imgEl = $('#peek-img');
        var mono = $('#peek-monogram');
        if (!imgEl) return;
        imgEl.src = pk.image;
        imgEl.hidden = false;
        if (mono) mono.hidden = true;
        var t = $('#peek-title');
        if (t && pk.title) { t.textContent = pk.title; t.hidden = false; }
      };
      pre.src = pk.image;
      return;
    }
    if (overlay.classList.contains('chooser')) {
      enhanceChooserWithPeek(pk);
      return;
    }
    productChip(true);
  }

  /* The product chip in the drawer header. */
  function productChip(show) {
    var chip = $('#product-chip');
    if (!chip) return;
    var pk = show ? peekFor(state.sel.link || state.composerLink) : null;
    chip.hidden = !pk;
    if (!pk) return;
    var img = $('#product-chip-img');
    if (pk.image) {
      img.src = pk.image;
      img.hidden = false;
      img.onerror = function () { img.hidden = true; peekImageFailed(pk); };
    } else {
      img.hidden = true;
    }
    $('#product-chip-name').textContent = pk.title || 'Your product';
    $('#product-chip-site').textContent = pk.siteName || '';

    // Guessed name (page refused to open): let the customer correct it in
    // place. The corrected name feeds the film title and the storyboard.
    var fix = $('#product-chip-fix');
    if (fix) {
      fix.hidden = !pk.guessed;
      fix.onclick = function () {
        var nameEl = $('#product-chip-name');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'product-chip-input';
        input.value = pk.title || '';
        input.maxLength = 90;
        nameEl.replaceWith(input);
        fix.hidden = true;
        input.focus();
        input.select();
        var commit = function () {
          var v = input.value.trim();
          if (v) pk.title = v;
          nameEl.textContent = pk.title || 'Your product';
          input.replaceWith(nameEl);
          fix.hidden = false;
          // ripple the corrected name into the composer bar chip
          var linkInput = $('#composer-link');
          if (linkInput) linkInput.dispatchEvent(new Event('input', { bubbles: true }));
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { input.value = pk.title || ''; input.blur(); }
        });
      };
    }
  }

  /* ── Rails ── */
  function renderStyles(presets) {
    var grid = $('#style-grid');
    if (!grid) return;
    presets.forEach(function (p, i) {
      var t = el('button', 'style-tile');
      t.type = 'button';
      if (p.preview) {
        var img = el('img');
        img.src = p.preview; img.alt = p.name; img.loading = 'lazy';
        t.appendChild(img);
      }
      t.appendChild(el('div', 'style-shade'));
      if (i < 2) {
        t.appendChild(el('span', 'style-badge', 'New'));
        t.classList.add('is-new');
      }
      if (p.product) t.appendChild(el('span', 'mode-price', formatPrice(p.product)));
      var meta = el('div', 'style-meta');
      meta.appendChild(el('span', 'style-name', p.name));
      meta.appendChild(el('span', 'style-tag', p.tag || ''));
      t.appendChild(meta);
      var chip = el('span', 'tile-open', 'Create →');
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        openPreset(p);
      });
      t.appendChild(chip);
      t.addEventListener('click', function () {
        var items = presetExamples(p);
        if (VIEWER && items.length) {
          VIEWER.open({
            kicker: 'Hexa Style',
            title: p.name,
            tag: p.tag || '',
            items: items,
            cta: { label: 'Create this style · ' + formatPrice(p.product), run: function () { openPreset(p); } },
          });
        } else {
          openPreset(p);
        }
      });
      grid.appendChild(t);
    });
  }

  function renderModes(data) {
    var rail = $('#mode-rail');

    // Auto leads the rail: it's a real product, not a chooser-only option.
    var auto = el('button', 'mode-tile mode-tile-auto');
    auto.type = 'button';
    auto.appendChild(el('div', 'mode-shade'));
    auto.appendChild(el('span', 'mode-price', formatPrice('auto')));
    var autoMeta = el('div', 'mode-meta');
    autoMeta.appendChild(el('span', 'mode-name', 'Auto'));
    autoMeta.appendChild(el('span', 'mode-kicker', 'We pick the format that sells your product best'));
    auto.appendChild(autoMeta);
    auto.addEventListener('click', function () { openConfig('auto'); });
    rail.appendChild(auto);

    data.modes.forEach(function (m) {
      var t = el('button', 'mode-tile');
      t.type = 'button';
      if (m.poster) {
        var img = el('img');
        img.src = m.poster; img.alt = m.name; img.loading = 'lazy';
        t.appendChild(img);
      }
      if (m.video) {
        var v = el('video');
        v.src = m.video; v.muted = true; v.loop = true;
        v.playsInline = true; v.setAttribute('playsinline', '');
        v.preload = 'none';
        hoverVideo(t, v);
        t.appendChild(v);
      }
      t.appendChild(el('div', 'mode-shade'));
      if (MODE_CONFIG[m.id]) t.appendChild(el('span', 'mode-price', formatPrice('mode:' + m.id)));
      var meta = el('div', 'mode-meta');
      meta.appendChild(el('span', 'mode-name', m.name));
      if (MODE_CONFIG[m.id]) meta.appendChild(el('span', 'mode-kicker', MODE_CONFIG[m.id].kicker));
      t.appendChild(meta);
      var chip = el('span', 'tile-open', 'Create →');
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        openMode(m.id);
      });
      t.appendChild(chip);
      t.addEventListener('click', function () {
        var items = modeExamples(m);
        if (VIEWER && items.length) {
          VIEWER.open({
            kicker: 'Format',
            title: m.name,
            tag: (MODE_CONFIG[m.id] && MODE_CONFIG[m.id].kicker) || '',
            items: items,
            cta: { label: 'Create · ' + (MODE_CONFIG[m.id] ? formatPrice('mode:' + m.id) : formatPrice('auto')), run: function () { openMode(m.id); } },
          });
        } else {
          openMode(m.id);
        }
      });
      rail.appendChild(t);
    });
  }

  function renderMarquee(data) {
    var half = Math.ceil(data.avatars.length / 2);
    [{ id: '#marquee-a', list: data.avatars.slice(0, half) },
     { id: '#marquee-b', list: data.avatars.slice(half) }].forEach(function (row) {
      var band = $(row.id);
      if (!band || !row.list.length) return;
      // duplicate for seamless -50% loop; every tile opens UGC with that creator
      row.list.concat(row.list).forEach(function (a) {
        var item = el('button', 'mq-item');
        item.type = 'button';
        item.setAttribute('aria-label', 'Create a UGC ad with ' + a.name);
        var img = el('img');
        img.src = a.local; img.alt = a.name; img.loading = 'lazy';
        item.appendChild(img);
        item.appendChild(el('span', null, a.name));
        item.addEventListener('click', function () {
          openMode('ugc', { avatar: { id: a.id, name: a.name } });
        });
        band.appendChild(item);
      });
    });
  }

  function renderHooks(data) {
    var rail = $('#hook-rail');
    data.hooks.forEach(function (h) {
      var c = el('button', 'hook-card');
      c.type = 'button';
      if (h.thumb) {
        var img = el('img');
        img.src = h.thumb; img.alt = h.name; img.loading = 'lazy';
        c.appendChild(img);
      }
      if (h.video) {
        var v = el('video');
        v.src = h.video; v.muted = true; v.loop = true;
        v.playsInline = true; v.setAttribute('playsinline', '');
        v.preload = 'metadata';
        if (railAutoplay) railAutoplay.observe(c);
        else hoverVideo(c, v);
        c.appendChild(v);
      }
      c.appendChild(el('div', 'hook-shade'));
      c.appendChild(el('span', 'hook-name', h.name));
      var chip = el('span', 'tile-open', 'Use →');
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        openMode('ugc', { hook: { id: h.id, name: h.name } });
      });
      c.appendChild(chip);
      c.addEventListener('click', function () {
        var use = function () { openMode('ugc', { hook: { id: h.id, name: h.name } }); };
        if (VIEWER && h.video) {
          VIEWER.open({
            kicker: 'Viral hook',
            title: h.name,
            tag: h.prompt || '',
            items: [{ video: h.video, thumb: h.thumb, label: h.name }],
            cta: { label: 'Use this hook · ' + formatPrice('mode:ugc'), run: use },
          });
        } else {
          use();
        }
      });
      rail.appendChild(c);
    });
  }

  /* ── Step renderers ── */
  var STEP_RENDERERS = {

    link: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Your product'));

      // three ways in: link, photos, description
      var tabs = el('div', 'ptabs');
      var panes = el('div', 'ptab-panes');
      var TABS = [
        { id: 'link', name: 'Paste a link' },
        { id: 'photos', name: 'Upload photos' },
        { id: 'text', name: 'Describe it' },
      ];
      var current = state.sel.productType || 'link';

      function setTab(id) {
        current = id;
        state.sel.productType = id;
        $all('.ptab', tabs).forEach(function (t) {
          t.classList.toggle('sel', t.getAttribute('data-tab') === id);
        });
        $all('.ptab-pane', panes).forEach(function (p) {
          p.style.display = p.getAttribute('data-pane') === id ? '' : 'none';
        });
        updatePrice();
      }

      TABS.forEach(function (t) {
        var b = el('button', 'ptab');
        b.type = 'button';
        b.textContent = t.name;
        b.setAttribute('data-tab', t.id);
        b.addEventListener('click', function () { setTab(t.id); });
        tabs.appendChild(b);
      });

      // pane: link
      var paneLink = el('div', 'ptab-pane field');
      paneLink.setAttribute('data-pane', 'link');
      var input = el('input');
      input.type = 'url';
      input.placeholder = 'https://yourstore.com/products/...';
      if (state.sel.link) input.value = state.sel.link;
      var linkHint = el('p', 'hint');
      var pk0 = peekFor(state.sel.link);
      linkHint.textContent = pk0 && pk0.title
        ? 'We read this page and found ' + pk0.title + '. Its images and details flow straight into your order.'
        : 'We pull the images and details from the page automatically.';
      input.addEventListener('input', function () {
        state.sel.link = input.value.trim();
        // the peek belongs to the link it was read from; editing the link voids it
        if (state.sel.productName && !peekFor(state.sel.link)) {
          delete state.sel.productName;
          delete state.sel.productImage;
          delete state.sel.productSiteName;
          delete state.sel.productPrice;
          delete state.sel.productCurrency;
          linkHint.textContent = 'We pull the images and details from the page automatically.';
          productChip(false);
        }
        updatePrice();
      });
      paneLink.appendChild(input);
      paneLink.appendChild(linkHint);

      // pane: photos
      var panePhotos = el('div', 'ptab-pane field');
      panePhotos.setAttribute('data-pane', 'photos');
      var drop = el('label', 'photo-drop');
      drop.innerHTML = '<span class="photo-drop-cta">Add product photos</span><span class="photo-drop-hint">Up to 3 photos. Phone shots are fine, we handle the rest.</span>';
      var fileInput = el('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      drop.appendChild(fileInput);
      var thumbs = el('div', 'photo-thumbs');
      state.sel.photos = state.sel.photos || [];

      function renderThumbs() {
        thumbs.innerHTML = '';
        state.sel.photos.forEach(function (src, i) {
          var w = el('div', 'photo-thumb');
          var img = el('img');
          img.src = src;
          var x = el('button', 'photo-x');
          x.type = 'button';
          x.innerHTML = '&times;';
          x.addEventListener('click', function (e) {
            e.preventDefault();
            state.sel.photos.splice(i, 1);
            renderThumbs();
            updatePrice();
          });
          w.appendChild(img); w.appendChild(x);
          thumbs.appendChild(w);
        });
      }
      renderThumbs();

      fileInput.addEventListener('change', function () {
        var files = Array.prototype.slice.call(fileInput.files || []).slice(0, 3 - state.sel.photos.length);
        files.forEach(function (f) {
          shrinkImage(f, 1024, function (dataUrl) {
            if (dataUrl && state.sel.photos.length < 3) {
              state.sel.photos.push(dataUrl);
              renderThumbs();
              updatePrice();
            }
          });
        });
        fileInput.value = '';
      });
      panePhotos.appendChild(drop);
      panePhotos.appendChild(thumbs);

      // pane: describe
      var paneText = el('div', 'ptab-pane field');
      paneText.setAttribute('data-pane', 'text');
      var ta = el('textarea', 'pdesc');
      ta.placeholder = 'e.g. Matte black insulated water bottle, 750ml, sits on a gym bench. Logo says VOLT.';
      ta.rows = 4;
      if (state.sel.desc) ta.value = state.sel.desc;
      ta.addEventListener('input', function () {
        state.sel.desc = ta.value.trim();
        updatePrice();
      });
      paneText.appendChild(ta);
      paneText.appendChild(el('p', 'hint', 'No link, no photos, no problem. Describe the product and we build it from words.'));

      panes.appendChild(paneLink);
      panes.appendChild(panePhotos);
      panes.appendChild(paneText);
      step.appendChild(tabs);
      step.appendChild(panes);
      body.appendChild(step);
      setTab(current);
    },

    avatar: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Pick your creator'));

      /* Big confirmation pane: whoever is clicked shows LARGE, by name, so
       * there is never a doubt about who fronts the film. */
      var preview = el('div', 'avatar-preview');
      preview.hidden = true;
      var pImg = el('img');
      pImg.alt = '';
      var pText = el('div', 'avatar-preview-text');
      var pName = el('strong');
      var pNote = el('span', null, 'Locked as your creator. Every segment uses this exact person.');
      pText.appendChild(pName);
      pText.appendChild(pNote);
      preview.appendChild(pImg);
      preview.appendChild(pText);
      step.appendChild(preview);

      function showPreview(src, name) {
        if (src) pImg.src = src;
        pImg.hidden = !src;
        pName.textContent = name;
        preview.hidden = false;
      }

      var grid = el('div', 'picker picker-avatars');

      // their own creator: they add the pictures, we match the person
      var uploadPane = el('div', 'avatar-upload');
      uploadPane.hidden = true;
      var drop = el('label', 'photo-drop');
      drop.innerHTML = '<span class="photo-drop-cta">Add 1 to 3 photos of your creator</span><span class="photo-drop-hint">You, your founder, your talent. Clear face, good light. We match the person.</span>';
      var fileInput = el('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      drop.appendChild(fileInput);
      var thumbs = el('div', 'photo-thumbs');
      uploadPane.appendChild(drop);
      uploadPane.appendChild(thumbs);

      function renderCustomThumbs() {
        thumbs.innerHTML = '';
        (state.sel.avatarPhotos || []).forEach(function (src, i) {
          var w = el('div', 'photo-thumb');
          var img = el('img');
          img.src = src;
          var x = el('button', 'photo-x');
          x.type = 'button';
          x.innerHTML = '&times;';
          x.addEventListener('click', function (e) {
            e.preventDefault();
            state.sel.avatarPhotos.splice(i, 1);
            renderCustomThumbs();
            updatePrice();
          });
          w.appendChild(img); w.appendChild(x);
          thumbs.appendChild(w);
        });
        if (state.sel.avatarPhotos && state.sel.avatarPhotos.length) {
          showPreview(state.sel.avatarPhotos[0], 'Your own creator');
        }
      }

      var custom = el('button', 'opt opt-avatar opt-avatar-custom');
      custom.type = 'button';
      custom.innerHTML =
        '<span class="opt-avatar-custom-ico" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' +
        '</span><span class="opt-name">Use your own</span>';
      custom.addEventListener('click', function () {
        selectOne(grid, custom);
        state.sel.avatar = { id: 'custom', name: 'Your own creator' };
        state.sel.avatarPhotos = state.sel.avatarPhotos || [];
        uploadPane.hidden = false;
        showPreview(state.sel.avatarPhotos[0] || null, 'Your own creator');
        renderCustomThumbs();
        updatePrice();
      });
      grid.appendChild(custom);

      fileInput.addEventListener('change', function () {
        var room = 3 - (state.sel.avatarPhotos || []).length;
        var files = Array.prototype.slice.call(fileInput.files || []).slice(0, Math.max(0, room));
        files.forEach(function (f) {
          shrinkImage(f, 1024, function (src) {
            if (!src) return;
            state.sel.avatarPhotos.push(src);
            renderCustomThumbs();
            updatePrice();
          });
        });
        fileInput.value = '';
      });

      state.data.avatars.forEach(function (a) {
        var b = el('button', 'opt opt-avatar');
        b.type = 'button';
        var img = el('img');
        img.src = a.local; img.alt = a.name; img.loading = 'lazy';
        b.appendChild(img);
        b.appendChild(el('span', 'opt-name', a.name));
        if (state.sel.avatar && state.sel.avatar.id === a.id) {
          b.classList.add('sel');
          showPreview(a.local, a.name);
        }
        b.addEventListener('click', function () {
          selectOne(grid, b);
          state.sel.avatar = { id: a.id, name: a.name };
          uploadPane.hidden = true;
          showPreview(a.local, a.name);
          updatePrice();
        });
        grid.appendChild(b);
      });

      // restore the custom state on re-render (ticket round trip)
      if (state.sel.avatar && state.sel.avatar.id === 'custom') {
        custom.classList.add('sel');
        uploadPane.hidden = false;
        renderCustomThumbs();
        showPreview((state.sel.avatarPhotos || [])[0] || null, 'Your own creator');
      }

      step.appendChild(grid);
      step.appendChild(uploadPane);
      body.appendChild(step);
    },

    hook: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Pick the hook'));
      var grid = el('div', 'picker picker-media');
      var promptBox = el('div', 'hook-prompt');
      promptBox.style.display = 'none';
      state.data.hooks.forEach(function (h) {
        var b = mediaOption(h);
        if (state.sel.hook && state.sel.hook.id === h.id) {
          b.classList.add('sel');
          promptBox.style.display = '';
          promptBox.innerHTML = '<strong>' + h.name + ':</strong> ' + (h.prompt || '');
        }
        b.addEventListener('click', function () {
          selectOne(grid, b);
          state.sel.hook = { id: h.id, name: h.name };
          promptBox.style.display = '';
          promptBox.innerHTML = '<strong>' + h.name + ':</strong> ' + (h.prompt || '');
          updatePrice();
        });
        grid.appendChild(b);
      });
      step.appendChild(grid);
      step.appendChild(el('p', 'picker-note', 'Every hook comes with its full script, written and tested.'));
      step.appendChild(promptBox);
      body.appendChild(step);
    },

    setting: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Pick the scene'));
      var grid = el('div', 'picker picker-media');
      state.data.settings.forEach(function (s) {
        var b = mediaOption(s);
        b.addEventListener('click', function () {
          selectOne(grid, b);
          state.sel.setting = { id: s.id, name: s.name };
          updatePrice();
        });
        grid.appendChild(b);
      });
      step.appendChild(grid);
      body.appendChild(step);
    },

    duration: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Length'));
      var wrap = el('div', 'picker picker-chips');
      if (!state.sel.duration) state.sel.duration = SEGMENT_SECONDS;
      DURATIONS.forEach(function (d) {
        var extra = (d.sec / SEGMENT_SECONDS - 1) * EXTRA_SEGMENT_PRICE;
        var c = el('button', 'chip');
        c.type = 'button';
        c.innerHTML = d.name + ' <span class="chip-price">' + (extra ? '+$' + extra : 'Included') + '</span>';
        if (d.sec === state.sel.duration) c.classList.add('sel');
        c.addEventListener('click', function () {
          selectOne(wrap, c);
          state.sel.duration = d.sec;
          updatePrice();
        });
        wrap.appendChild(c);
      });
      step.appendChild(wrap);
      step.appendChild(el('p', 'picker-note',
        'Longer lengths are delivered as one continuous film: same creator, same scene, one storyboard.'));
      body.appendChild(step);
    },

    quality: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Quality'));
      var wrap = el('div', 'picker picker-chips');
      if (!state.sel.quality) state.sel.quality = '720p';
      QUALITIES.forEach(function (q) {
        var c = el('button', 'chip');
        c.type = 'button';
        var priceLabel = q.id === '1080p'
          ? '+$' + QUALITY_1080_PER_SEGMENT + ' per 15s'
          : 'Included';
        c.innerHTML = q.name + ' <span class="chip-price">' + priceLabel + '</span>';
        if (q.id === state.sel.quality) c.classList.add('sel');
        c.addEventListener('click', function () {
          selectOne(wrap, c);
          state.sel.quality = q.id;
          updatePrice();
        });
        wrap.appendChild(c);
      });
      step.appendChild(wrap);
      body.appendChild(step);
    },

    notes: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Creative direction <span class="step-opt">(optional)</span>'));
      var box = el('textarea', 'pdesc');
      box.rows = 3;
      box.placeholder = 'Tell us exactly what you want: shots, lines to say, vibe, things to avoid. We follow it.';
      if (state.sel.directions) box.value = state.sel.directions;
      box.addEventListener('input', function () {
        state.sel.directions = box.value.trim().slice(0, 1200);
      });
      step.appendChild(box);
      step.appendChild(el('p', 'picker-note', 'Leave it empty and our storyboard takes over. Write anything and your words lead the brief.'));
      body.appendChild(step);
    },

    camera: function (body, n) { chipStep(body, n, 'Camera style', state.data.cinematic.camera_style, 'camera'); },
    grade:  function (body, n) { chipStep(body, n, 'Color grade', state.data.cinematic.color_grading, 'grade'); },
    light:  function (body, n) { chipStep(body, n, 'Lighting', state.data.cinematic.light_scheme, 'light'); },
    aspect: function (body, n) { chipStep(body, n, 'Format', state.data.aspect_ratios, 'aspect'); },
    mode:   function (body, n) { chipStep(body, n, 'Shoot style', PHOTOSHOOT_MODES, 'mode'); },

    formats: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Pick your formats <span style="text-transform:none;letter-spacing:0;font-weight:500;">(up to 10)</span>'));
      var wrap = el('div', 'picker picker-media');
      var chipRow = el('div', 'picker picker-chips');
      state.sel.formats = [];

      function toggle(f, node) {
        var i = state.sel.formats.findIndex(function (x) { return x.id === f.id; });
        if (i >= 0) {
          state.sel.formats.splice(i, 1);
          node.classList.remove('sel');
        } else if (state.sel.formats.length < 10) {
          state.sel.formats.push({ id: f.id, name: f.name });
          node.classList.add('sel');
        }
        updatePrice();
      }

      state.data.ad_formats.forEach(function (f) {
        if (f.preview) {
          var b = el('button', 'opt opt-media opt-format');
          b.type = 'button';
          var frame = el('div', 'opt-frame');
          var img = el('img');
          img.src = f.preview; img.alt = f.name; img.loading = 'lazy';
          frame.appendChild(img);
          b.appendChild(frame);
          b.appendChild(el('span', 'opt-name', f.name));
          b.addEventListener('click', function () { toggle(f, b); });
          wrap.appendChild(b);
        } else {
          var c = el('button', 'chip');
          c.type = 'button';
          c.textContent = f.name;
          c.addEventListener('click', function () { toggle(f, c); });
          chipRow.appendChild(c);
        }
      });
      step.appendChild(wrap);
      if (chipRow.children.length) step.appendChild(chipRow);
      step.appendChild(el('p', 'picker-note', 'First five formats included · +$2 each after that.'));
      body.appendChild(step);
    },

    soulname: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Name your character'));
      var field = el('div', 'field');
      var input = el('input');
      input.type = 'text';
      input.placeholder = 'e.g. Maya';
      input.addEventListener('input', function () {
        state.sel.soulname = input.value.trim();
        updatePrice();
      });
      field.appendChild(input);
      step.appendChild(field);
      body.appendChild(step);
    },

    soulphotos: function (body, n) {
      var step = el('section', 'config-step');
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Reference photos <span style="text-transform:none;letter-spacing:0;font-weight:500;">(5 to 20 of one person)</span>'));

      var drop = el('label', 'photo-drop');
      drop.innerHTML = '<span class="photo-drop-cta">Add reference photos</span><span class="photo-drop-hint">Different angles, outfits and lighting of the SAME person train the best character.</span>';
      var fileInput = el('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      drop.appendChild(fileInput);

      var thumbs = el('div', 'photo-thumbs');
      var counter = el('p', 'hint');
      state.sel.soulphotos = state.sel.soulphotos || [];

      function renderThumbs() {
        thumbs.innerHTML = '';
        state.sel.soulphotos.forEach(function (src, i) {
          var w = el('div', 'photo-thumb');
          var img = el('img');
          img.src = src;
          var x = el('button', 'photo-x');
          x.type = 'button';
          x.innerHTML = '&times;';
          x.addEventListener('click', function (e) {
            e.preventDefault();
            state.sel.soulphotos.splice(i, 1);
            renderThumbs();
            updatePrice();
          });
          w.appendChild(img); w.appendChild(x);
          thumbs.appendChild(w);
        });
        var c = state.sel.soulphotos.length;
        counter.textContent = c < 5
          ? c + ' of 5 minimum added. Training needs at least 5 photos.'
          : c + ' photos added. Training takes about an hour, then your character is reusable in every order.';
      }
      renderThumbs();

      fileInput.addEventListener('change', function () {
        var room = 20 - state.sel.soulphotos.length;
        var files = Array.prototype.slice.call(fileInput.files || []).slice(0, room);
        files.forEach(function (f) {
          shrinkImage(f, 768, function (dataUrl) {
            if (dataUrl && state.sel.soulphotos.length < 20) {
              state.sel.soulphotos.push(dataUrl);
              renderThumbs();
              updatePrice();
            }
          });
        });
        fileInput.value = '';
      });

      step.appendChild(drop);
      step.appendChild(thumbs);
      step.appendChild(counter);
      body.appendChild(step);
    },
  };

  function mediaOption(item) {
    var b = el('button', 'opt opt-media');
    b.type = 'button';
    var frame = el('div', 'opt-frame');
    if (item.thumb) {
      var img = el('img');
      img.src = item.thumb; img.alt = item.name; img.loading = 'lazy';
      frame.appendChild(img);
    }
    if (item.video) {
      var v = el('video');
      v.src = item.video; v.muted = true; v.loop = true;
      v.playsInline = true; v.setAttribute('playsinline', '');
      v.preload = 'none';
      hoverVideo(b, v);
      frame.appendChild(v);
    }
    b.appendChild(frame);
    b.appendChild(el('span', 'opt-name', item.name));
    return b;
  }

  function chipStep(body, n, title, options, key) {
    var step = el('section', 'config-step');
    step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>' + title));
    var wrap = el('div', 'picker picker-chips');
    var desc = el('p', 'picker-desc');
    desc.hidden = true;
    function describe(o) {
      var d = typeof o === 'object' && o.desc;
      desc.textContent = d || '';
      desc.hidden = !d;
    }
    options.forEach(function (o) {
      var isObj = typeof o === 'object';
      var c = el('button', 'chip');
      c.type = 'button';
      // format chips show their shape, not just the number
      if (key === 'aspect') {
        var id = isObj ? (o.id || o.name) : o;
        var m = String(id).match(/^(\d+):(\d+)$/);
        if (m) {
          var g = el('i', 'ratio-glyph');
          g.style.aspectRatio = m[1] + ' / ' + m[2];
          c.appendChild(g);
        }
      }
      c.appendChild(document.createTextNode(isObj ? o.name : label(o)));
      var current = state.sel[key];
      if (current && (isObj ? (current.id || current) === (o.id || o) : current === o)) {
        c.classList.add('sel');
        describe(o);
      }
      c.addEventListener('click', function () {
        selectOne(wrap, c);
        state.sel[key] = o;
        describe(o);
        updatePrice();
      });
      wrap.appendChild(c);
    });
    step.appendChild(wrap);
    step.appendChild(desc);
    body.appendChild(step);
  }

  function selectOne(container, chosen) {
    $all('.sel', container).forEach(function (x) { x.classList.remove('sel'); });
    chosen.classList.add('sel');
  }

  /* ── Pricing display ──
   * One convention everywhere: "$X" flat, "From $X" only when configuration
   * can raise the price (a duration step, or ad pack formats past five). */
  function priceInfo(productId) {
    var p = productDef(productId);
    var variable = p.steps.indexOf('duration') >= 0 || productId === 'adpack';
    return { base: p.price, from: variable };
  }
  function formatPrice(productId) {
    var i = priceInfo(productId);
    return (i.from ? 'From $' : '$') + i.base;
  }

  /* ── Product resolution ── */
  function productDef(productId) {
    if (productId.indexOf('mode:') === 0) {
      var modeId = productId.slice(5);
      var mode = null;
      state.data.modes.forEach(function (m) { if (m.id === modeId) mode = m; });
      var cfg = MODE_CONFIG[modeId];
      return { title: mode ? mode.name : label(modeId), kicker: cfg.kicker, price: cfg.price, eta: cfg.eta, steps: cfg.steps };
    }
    return PRODUCTS[productId];
  }

  /* ── Pricing + validation ── */
  function currentPrice() {
    var p = productDef(state.product);
    var total = p.price;
    if (state.product === 'adpack' && state.sel.formats && state.sel.formats.length > 5) {
      total += (state.sel.formats.length - 5) * 2;
    }
    if (state.sel.duration && state.sel.duration > SEGMENT_SECONDS) {
      total += (Math.ceil(state.sel.duration / SEGMENT_SECONDS) - 1) * EXTRA_SEGMENT_PRICE;
    }
    if (state.sel.quality === '1080p' && !PREMIUM_1080[state.product]) {
      total += segmentCount() * QUALITY_1080_PER_SEGMENT;
    }
    return total;
  }

  function isComplete() {
    return !firstMissingStep();
  }

  /* The first unmet step, mapped to a one-line hint next to the button. */
  var STEP_HINTS = {
    link: 'Add your product to continue',
    avatar: 'Pick a creator to continue',
    hook: 'Pick a hook to continue',
    setting: 'Pick a scene to continue',
    camera: 'Choose a camera style to continue',
    grade: 'Choose a color grade to continue',
    light: 'Choose a lighting scheme to continue',
    aspect: 'Choose a format to continue',
    mode: 'Pick a shoot style to continue',
    formats: 'Select at least one format',
    soulname: 'Name your character to continue',
    soulphotos: 'Add at least 5 reference photos',
  };
  function stepSatisfied(k) {
    var s = state.sel;
    switch (k) {
      case 'link':     return hasProduct(s);
      case 'avatar':   return !!s.avatar && (s.avatar.id !== 'custom' || !!(s.avatarPhotos && s.avatarPhotos.length));
      case 'hook':     return !!s.hook;
      case 'setting':  return !!s.setting;
      case 'camera':   return !!s.camera;
      case 'grade':    return !!s.grade;
      case 'light':    return !!s.light;
      case 'aspect':   return !!s.aspect;
      case 'mode':     return !!s.mode;
      case 'formats':  return !!(s.formats && s.formats.length);
      case 'soulname': return !!s.soulname;
      case 'soulphotos': return !!(s.soulphotos && s.soulphotos.length >= 5);
    }
    return true;
  }
  function firstMissingStep() {
    var p = productDef(state.product);
    for (var i = 0; i < p.steps.length; i++) {
      if (!stepSatisfied(p.steps[i])) return p.steps[i];
    }
    return null;
  }

  function updatePrice() {
    var total = currentPrice();
    $('#config-price').textContent = '$' + total;
    var p = productDef(state.product);
    var lbl = $('#config-total-label');
    if (lbl) lbl.textContent = 'Total';
    var etaEl = $('#config-eta');
    if (etaEl) etaEl.textContent = p.eta ? 'Delivery in ' + p.eta : '';
    var ready = isComplete();
    var btn = $('#config-submit');
    var hint = $('#config-hint');

    if (state.view === 'ticket') {
      btn.disabled = false;
      btn.textContent = STUDIO_LIVE ? 'Pay $' + total + ' securely' : 'Place order · $' + total;
      if (hint) {
        hint.hidden = false;
        hint.classList.add('config-hint-ok');
        hint.textContent = STUDIO_LIVE
          ? 'Secure Stripe checkout. You are never charged for work we do not deliver.'
          : 'Delivered on this page and to your email.';
      }
      return;
    }

    // Stays clickable when incomplete: pressing it walks you to the gap.
    btn.disabled = false;
    btn.classList.toggle('config-submit-ghost', !ready);
    var DELIVERABLES = { photoshoot: '10 photos', adpack: 'your ad pack', soul: 'your character' };
    var deliverable = DELIVERABLES[state.product] || 'your film';
    btn.textContent = ready ? 'Review order · $' + total : 'Create ' + deliverable + ' · $' + total;
    if (hint) {
      hint.classList.remove('config-hint-ok');
      var missing = ready ? null : firstMissingStep();
      hint.hidden = !missing;
      if (missing) {
        hint.textContent = (missing === 'avatar' && state.sel.avatar && state.sel.avatar.id === 'custom')
          ? 'Add a photo of your creator to continue'
          : (STEP_HINTS[missing] || 'Complete every step to continue');
      }
    }

    // per-step completion marks
    $all('#config-body [data-step]').forEach(function (sec) {
      var k = sec.getAttribute('data-step');
      var done = stepSatisfied(k);
      sec.classList.toggle('step-done', done);
      var badge = sec.querySelector('.step-n');
      if (badge) {
        if (!badge.dataset.n) badge.dataset.n = badge.textContent;
        badge.textContent = done ? '✓' : badge.dataset.n;
      }
    });

    // live order summary beside the total
    var sum = $('#config-summary');
    if (sum) {
      var s = state.sel;
      var parts = [];
      if (s.mode && s.mode.name) parts.push(s.mode.name);
      if (s.camera && s.camera.name) parts.push(s.camera.name);
      if (s.setting && s.setting.name) parts.push(s.setting.name);
      if (s.hook && s.hook.name) parts.push(s.hook.name);
      if (s.avatar && s.avatar.name) parts.push(s.avatar.name);
      if (s.duration) parts.push(typeof s.duration === 'object' ? s.duration.name : s.duration + 's');
      if (s.aspect) parts.push(s.aspect.id || s.aspect);
      if (s.quality) parts.push(s.quality.id || s.quality);
      if (s.formats && s.formats.length) parts.push(s.formats.length + ' format' + (s.formats.length > 1 ? 's' : ''));
      if (state.product === 'photoshoot') parts.push('10 images');
      sum.textContent = parts.slice(0, 4).join(' · ');
      sum.hidden = !parts.length;
    }
  }

  /* ── Order ticket: what you get, before you pay ── */

  var ASPECT_LABELS = { '9:16': '9:16 vertical', '1:1': '1:1 square', '16:9': '16:9 widescreen', '4:5': '4:5 portrait' };

  function aspectLabel(a) {
    var id = a && a.id ? a.id : a;
    return ASPECT_LABELS[id] || (a && a.name) || id || '';
  }

  function selName(v) { return v && v.name ? v.name : (typeof v === 'string' ? label(v) : null); }

  /* The image that stands in for "what you are buying": the preset preview,
   * else the chosen scene's thumb, else the mode poster. */
  function ticketImage() {
    var s = state.sel;
    if (s.stylePreview) return s.stylePreview;
    if (s.setting && s.setting.id && state.data.settings) {
      var st = state.data.settings.filter(function (x) { return x.id === s.setting.id; })[0];
      if (st && st.thumb) return st.thumb;
    }
    if (state.product && state.product.indexOf('mode:') === 0 && state.data.modes) {
      var m = state.data.modes.filter(function (x) { return 'mode:' + x.id === state.product; })[0];
      if (m && m.poster) return m.poster;
    }
    return null;
  }

  function segmentCount() {
    return Math.max(1, Math.ceil((state.sel.duration || SEGMENT_SECONDS) / SEGMENT_SECONDS));
  }

  function tcLabel(i) {
    var sec = i * SEGMENT_SECONDS;
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  function renderTicket() {
    var body = $('#config-body');
    body.innerHTML = '';
    var p = productDef(state.product);
    var s = state.sel;
    var isVideo = p.steps.indexOf('duration') >= 0;
    var segs = segmentCount();
    var wrap = el('div', 'ticket');

    // back to the steps
    var back = el('button', 'ticket-back', '&larr; Edit selections');
    back.type = 'button';
    back.addEventListener('click', function () { showSteps(); });
    wrap.appendChild(back);

    // hero: the deliverable, pictured
    var heroImg = ticketImage();
    var hero = el('div', 'ticket-hero');
    if (heroImg) {
      var hi = el('img');
      hi.src = heroImg; hi.alt = '';
      hero.appendChild(hi);
    }
    hero.appendChild(el('div', 'ticket-hero-shade'));
    var heroText = el('div', 'ticket-hero-text');
    heroText.appendChild(el('strong', null, s.styleName || p.title));
    var context = s.productName ? 'for ' + s.productName
      : s.link ? 'made from your link'
      : (s.photos && s.photos.length) ? 'made from your photos'
      : s.desc ? 'made from your description' : '';
    if (context) heroText.appendChild(el('span', null, context));
    hero.appendChild(heroText);
    if (s.productImage) {
      var pin = el('img', 'ticket-hero-product');
      pin.src = s.productImage; pin.alt = '';
      pin.onerror = function () { pin.remove(); };
      hero.appendChild(pin);
    }
    wrap.appendChild(hero);

    // the film, cell by cell
    if (isVideo) {
      var strip = el('div', 'ticket-strip');
      for (var i = 0; i < segs; i++) {
        var cell = el('figure', 'ticket-cell');
        if (heroImg) {
          var ci = el('img');
          ci.src = heroImg; ci.alt = '';
          cell.appendChild(ci);
        }
        cell.appendChild(el('figcaption', null, tcLabel(i)));
        if (i === segs - 1) cell.appendChild(el('span', 'ticket-cell-end', 'End'));
        strip.appendChild(cell);
      }
      wrap.appendChild(strip);
      wrap.appendChild(el('p', 'ticket-caption', segs > 1
        ? 'One continuous film. Same actor, same scene, one storyboard. Delivered as a single file.'
        : 'One 15 second film, delivered as a single file.'));
    } else if (state.product === 'photoshoot') {
      var grid = el('div', 'ticket-strip ticket-strip-photos');
      for (var j = 1; j <= 10; j++) grid.appendChild(el('figure', 'ticket-cell ticket-cell-n', '<figcaption>' + ('0' + j).slice(-2) + '</figcaption>'));
      wrap.appendChild(grid);
      wrap.appendChild(el('p', 'ticket-caption', 'Ten brand-quality images in one pass.'));
    } else if (state.product === 'adpack' && s.formats && s.formats.length) {
      var fgrid = el('div', 'ticket-strip ticket-strip-photos');
      s.formats.forEach(function (f) {
        fgrid.appendChild(el('figure', 'ticket-cell ticket-cell-n', '<figcaption>' + (f.name || f.id) + '</figcaption>'));
      });
      wrap.appendChild(fgrid);
      wrap.appendChild(el('p', 'ticket-caption', s.formats.length + ' static ad formats, ready to run.'));
    }

    // spec rows
    var rows = el('dl', 'ticket-rows');
    function row(k, v) {
      if (!v) return;
      var r = el('div', 'ticket-row');
      r.appendChild(el('dt', null, k));
      r.appendChild(el('dd', null, v));
      rows.appendChild(r);
    }
    if (isVideo) {
      row('Length', segs > 1
        ? (s.duration || SEGMENT_SECONDS) + ' seconds (' + segs + ' segments of 15s)'
        : '15 seconds');
    }
    if (isVideo) {
      row('Quality', PREMIUM_1080[state.product] ? '1080p Ultra, included'
        : s.quality === '1080p' ? '1080p Ultra' : '720p HD');
    }
    row('Format', s.aspect ? aspectLabel(s.aspect) : null);
    row('Style', s.styleName || null);
    row('Creator', s.avatar && s.avatar.id === 'custom'
      ? 'Your own creator, from ' + ((s.avatarPhotos || []).length || 'your') + ' photo' + ((s.avatarPhotos || []).length === 1 ? '' : 's')
      : selName(s.avatar));
    row('Hook', selName(s.hook));
    row('Scene', selName(s.setting));
    row('Your direction', s.directions ? '"' + (s.directions.length > 110 ? s.directions.slice(0, 110) + '...' : s.directions) + '"' : null);
    if (state.product === 'photoshoot') row('Shoot style', selName(s.mode));
    if (state.product === 'soul') row('Character', s.soulname || null);
    row('Delivery', p.eta ? 'about ' + p.eta.replace(/^~/, '') + ', on this page and by email' : null);
    wrap.appendChild(rows);

    // what you get
    var bullets = el('ul', 'ticket-bullets');
    var items = isVideo
      ? [
          segs > 1
            ? 'One continuous ' + (s.duration || SEGMENT_SECONDS) + ' second film, rendered as ' + segs + ' chained 15 second segments'
            : 'One 15 second film, rendered end to end',
          'Same actor, same scene and one storyboard across every frame',
          'Full commercial license for paid ads and organic, on every platform',
          'Delivered on this page and to your email, ready to post',
        ]
      : state.product === 'photoshoot'
      ? ['Ten finished images in your chosen style', 'Full commercial license for paid ads and organic', 'Delivered on this page and to your email']
      : state.product === 'adpack'
      ? ['Every format sized and finished for its platform', 'Full commercial license for paid ads and organic', 'Delivered on this page and to your email']
      : ['A reusable character trained from your photos', 'Use it in every video mode, forever', 'Delivered to your email when training completes'];
    items.forEach(function (t) { bullets.appendChild(el('li', null, t)); });
    wrap.appendChild(bullets);

    // itemized price, mirroring currentPrice() exactly
    var priceBox = el('div', 'ticket-price');
    function line(k, v, cls) {
      var r = el('div', 'ticket-line' + (cls ? ' ' + cls : ''));
      r.appendChild(el('span', null, k));
      r.appendChild(el('span', null, v));
      priceBox.appendChild(r);
    }
    line(p.title, '$' + p.price);
    if (isVideo && segs > 1) line('Extended length, ' + (segs - 1) + ' extra ' + (segs === 2 ? 'segment' : 'segments') + ' at $' + EXTRA_SEGMENT_PRICE, '$' + ((segs - 1) * EXTRA_SEGMENT_PRICE));
    if (isVideo && s.quality === '1080p' && !PREMIUM_1080[state.product]) {
      line('1080p Ultra, ' + segs + ' ' + (segs === 1 ? 'segment' : 'segments') + ' at $' + QUALITY_1080_PER_SEGMENT, '$' + (segs * QUALITY_1080_PER_SEGMENT));
    }
    if (state.product === 'adpack' && s.formats && s.formats.length > 5) {
      line('Extra formats, ' + (s.formats.length - 5) + ' at $2', '$' + ((s.formats.length - 5) * 2));
    }
    line('Total', '$' + currentPrice(), 'ticket-line-total');
    wrap.appendChild(priceBox);

    body.appendChild(wrap);
    body.scrollTop = 0;
  }

  function showTicket() {
    state.view = 'ticket';
    $('#config-kicker').textContent = 'Step 2 of 2';
    $('#config-title').textContent = 'Your order';
    renderTicket();
    updatePrice();
  }

  function showSteps() {
    state.view = 'steps';
    $('#config-kicker').textContent = state.headKicker;
    $('#config-title').textContent = state.headTitle;
    renderSteps();
    updatePrice();
  }

  /* ── Configurator open/close ── */
  function renderSteps() {
    var p = productDef(state.product);
    var body = $('#config-body');
    body.innerHTML = '';
    p.steps.forEach(function (stepKey, i) {
      var before = body.children.length;
      STEP_RENDERERS[stepKey](body, i + 1);
      // tag what the renderer appended so completion marks can find it
      for (var c = before; c < body.children.length; c++) {
        body.children[c].setAttribute('data-step', stepKey);
      }
    });
    body.scrollTop = 0;
  }

  function openConfig(productId, preset) {
    var p = productDef(productId);
    if (!p || !state.data) return;
    state.product = productId;
    state.sel = preset || {};
    state.style = null;
    state.view = 'steps';
    $('#config-overlay').classList.remove('chooser');
    if (!state.sel.link && state.composerLink) state.sel.link = state.composerLink;

    // composer-chosen settings lead; they were picked deliberately
    if (state.prefs.duration && p.steps.indexOf('duration') >= 0) state.sel.duration = state.prefs.duration;
    if (state.prefs.quality && p.steps.indexOf('quality') >= 0) state.sel.quality = state.prefs.quality;
    if (state.prefs.aspectId && p.steps.indexOf('aspect') >= 0 && state.data.aspect_ratios) {
      var prefAspect = state.data.aspect_ratios.filter(function (a) { return (a.id || a) === state.prefs.aspectId; })[0];
      if (prefAspect) state.sel.aspect = prefAspect;
    }

    // carry the peeked product identity into the order payload
    var pk = peekFor(state.sel.link);
    if (pk) {
      if (pk.title) state.sel.productName = pk.title;
      if (pk.image) state.sel.productImage = pk.image;
      if (pk.webProductId) state.sel.webProductId = pk.webProductId;
      if (pk.siteName) state.sel.productSiteName = pk.siteName;
      if (pk.price) {
        state.sel.productPrice = pk.price;
        if (pk.currency) state.sel.productCurrency = pk.currency;
      }
    }
    productChip(true);

    state.headKicker = p.kicker;
    state.headTitle = p.title;
    $('#config-kicker').textContent = p.kicker;
    $('#config-title').textContent = p.title;

    renderSteps();
    updatePrice();
    $('#config-overlay').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function openMode(modeId, preset) {
    openConfig('mode:' + modeId, preset);
  }

  /* Create-with-a-link path: never blind-generate. Show what we can make for
   * THIS product (styles + a "let us pick" option); the customer chooses, then
   * we build exactly that. When the peek identified their product, the whole
   * wall carries it: chip in the header, image inset on every tile. */

  var CHOOSER_GROUPS = [
    { name: 'Creator videos', products: ['mode:ugc', 'mode:product_review', 'mode:unboxing', 'mode:tutorial', 'mode:ugc_try_on'] },
    { name: 'Premium spots', products: ['mode:tv_spot', 'cinematic', 'mode:pro_try_on', 'mode:hyper_motion', 'mode:wild_card'] },
    { name: 'Photo sets', products: ['photoshoot', 'adpack'] },
  ];

  /* The live preview clip a preset would render with: its scene, else its hook. */
  function presetClip(p) {
    var s = p.sel || {};
    if (s.setting && s.setting.id && state.data.settings) {
      var st = state.data.settings.filter(function (x) { return x.id === s.setting.id; })[0];
      if (st && st.video) return st.video;
    }
    if (s.hook && s.hook.id && state.data.hooks) {
      var h = state.data.hooks.filter(function (x) { return x.id === s.hook.id; })[0];
      if (h && h.video) return h.video;
    }
    return null;
  }

  function productInset(pk) {
    var img = el('img', 'tile-product');
    img.src = pk.image;
    img.alt = '';
    img.onerror = function () { img.remove(); };
    return img;
  }

  function chooserIntroText(pk) {
    if (pk && pk.title) {
      return pk.title + ', styled ' + state.presets.length + ' ways. Pick one and we make it with your product in frame.';
    }
    return state.composerLink
      ? 'Here is what we can make for your product. Pick one and we build exactly that.'
      : 'Choose a format first. You add photos or a description on the next step.';
  }

  function openChooser(peek) {
    $('#config-kicker').textContent = 'Step 1 of 2';
    $('#config-title').textContent = 'What should we make?';
    var overlay = $('#config-overlay');
    overlay.classList.add('chooser');
    var pk = peek && peek.ok ? peek : null;
    productChip(!!pk);

    var body = $('#config-body');
    body.innerHTML = '';
    var head = el('div', 'chooser-head');
    head.appendChild(el('h3', 'chooser-headline', 'Pick the format.'));
    head.appendChild(el('p', 'chooser-intro', chooserIntroText(pk)));
    body.appendChild(head);

    var grid = el('div', 'chooser-grid');

    // "Auto" card first, full width, for people who want us to choose.
    // A strip of real formats behind it so "we pick" shows, not tells.
    var auto = el('button', 'style-tile chooser-auto chooser-auto-hero');
    auto.type = 'button';
    var collage = el('div', 'chooser-auto-collage');
    ((state.data || {}).modes || []).slice(0, 4).forEach(function (m) {
      if (!m.poster) return;
      var im = el('img');
      im.src = m.poster;
      im.alt = '';
      im.loading = 'lazy';
      collage.appendChild(im);
    });
    auto.appendChild(collage);
    auto.insertAdjacentHTML('beforeend',
      '<div class="style-shade"></div>' +
      '<span class="mode-price">' + formatPrice('auto') + '</span>' +
      '<div class="style-meta">' +
      '<span class="style-badge-auto">Recommended</span>' +
      '<span class="style-name">Auto</span>' +
      '<span class="style-tag">Not sure? We pick the format that sells your product best.</span>' +
      '</div>');
    if (pk && pk.image) auto.appendChild(productInset(pk));
    auto.addEventListener('click', function () { openConfig('auto'); });
    grid.appendChild(auto);

    var used = {};
    CHOOSER_GROUPS.forEach(function (group) {
      var members = state.presets.filter(function (p) {
        return group.products.indexOf(p.product) >= 0;
      });
      members.forEach(function (p) { used[p.id] = true; });
      renderChooserGroup(grid, group.name, members, pk);
    });
    // presets outside the group map still show, ungrouped
    var rest = state.presets.filter(function (p) { return !used[p.id]; });
    renderChooserGroup(grid, rest.length && Object.keys(used).length ? 'More styles' : null, rest, pk);

    body.appendChild(grid);
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    body.scrollTop = 0;
  }

  function renderChooserGroup(grid, name, presets, pk) {
    if (!presets.length) return;
    if (name) grid.appendChild(el('p', 'chooser-group', name));
    presets.forEach(function (p, i) {
      var t = el('button', 'style-tile');
      t.type = 'button';
      t.style.animationDelay = Math.min(60 + i * 40, 480) + 'ms';
      if (p.preview) {
        var img = el('img');
        img.src = p.preview; img.alt = p.name; img.loading = 'lazy';
        t.appendChild(img);
      }
      var clip = presetClip(p);
      if (clip) {
        var v = el('video');
        v.src = clip; v.muted = true; v.loop = true;
        v.playsInline = true; v.setAttribute('playsinline', '');
        v.preload = 'none';
        hoverVideo(t, v);
        t.appendChild(v);
      }
      t.appendChild(el('div', 'style-shade'));
      if (p.product) t.appendChild(el('span', 'mode-price', formatPrice(p.product)));
      var meta = el('div', 'style-meta');
      meta.appendChild(el('span', 'style-name', p.name));
      meta.appendChild(el('span', 'style-tag', p.tag || ''));
      t.appendChild(meta);
      t.addEventListener('click', function () { openPreset(p); });
      grid.appendChild(t);
    });
  }

  /* Late peek arrival: upgrade an already-open chooser in place. The product
   * shows in the header chip and on the Auto card only; repeating it on every
   * small tile reads as clutter (and worse with a plain white logo). */
  function enhanceChooserWithPeek(pk) {
    var overlay = $('#config-overlay');
    if (overlay.hidden || !overlay.classList.contains('chooser')) return;
    if (!pk || !pk.ok || pk.url !== state.composerLink) return;
    productChip(true);
    var intro = $('.chooser-intro');
    if (intro) intro.textContent = chooserIntroText(pk);
    var autoCard = $('.chooser-auto-hero');
    if (pk.image && autoCard && !autoCard.querySelector('.tile-product')) {
      autoCard.appendChild(productInset(pk));
    }
  }

  /* ── The post-link takeover: read the page, identify the product, dock ── */
  function openReveal(link) {
    if (REDUCED_MOTION) {
      var pr = startPeek(link);
      openChooser(peekFor(link));
      pr.then(enhanceChooserWithPeek);
      return;
    }

    var overlay = $('#config-overlay');
    var stage = $('#peek-stage');
    var card = $('#peek-card');
    var frame = $('.peek-frame');
    var imgEl = $('#peek-img');
    var mono = $('#peek-monogram');
    var host = $('#peek-host');
    var eyebrow = $('#peek-eyebrow');
    var lbl = $('#peek-label');
    var titleEl = $('#peek-title');
    var priceEl = $('#peek-price');

    // reset the stage
    clearRevealTimers();
    card.classList.remove('peek-in', 'peek-found', 'peek-out');
    imgEl.hidden = true; imgEl.removeAttribute('src');
    mono.hidden = true;
    titleEl.hidden = true;
    priceEl.hidden = true;
    eyebrow.textContent = 'Hexa Studio';
    lbl.textContent = 'Reading your page';
    lbl.style.opacity = '';
    try { host.textContent = new URL(link).hostname.replace(/^www\./, ''); } catch (e) { host.textContent = ''; }

    overlay.classList.add('revealing');
    overlay.hidden = false;
    stage.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { card.classList.add('peek-in'); });

    var t0 = Date.now();
    var docked = false;
    var identified = false;

    function dock(pk) {
      if (docked) return;
      docked = true;
      clearRevealTimers();
      card.classList.add('peek-out');
      revealTimers.push(setTimeout(function () {
        // the overlay may have been closed mid-exit
        if (overlay.hidden) return;
        overlay.classList.remove('revealing');
        stage.hidden = true;
        openChooser(pk);
      }, 380));
    }

    function identify(pk, withImage) {
      if (docked || identified) return;
      identified = true;
      frame.classList.add('peek-settle');
      if (withImage) {
        imgEl.hidden = false;
      } else if (pk.title) {
        mono.textContent = pk.title.charAt(0).toUpperCase();
        mono.hidden = false;
      }
      card.classList.add('peek-found');
      // Honest labeling: "found" only when the page actually answered. A
      // guessed peek is a name derived from the URL, and we say so.
      var kind = pk.guessed ? 'From your link' : 'Product found';
      eyebrow.textContent = pk.siteName ? kind + ' · ' + pk.siteName : kind;
      lbl.textContent = '';
      if (pk.title) { titleEl.textContent = pk.title; titleEl.hidden = false; }
      var priceStr = formatPeekPrice(pk);
      if (priceStr) { priceEl.textContent = priceStr + (pk.siteName ? ' at ' + pk.siteName : ''); priceEl.hidden = false; }
      else if (pk.guessed) {
        priceEl.textContent = 'That page would not let us read it, so check the name on the next step.';
        priceEl.hidden = false;
      }
      revealTimers.push(setTimeout(function () { dock(pk); }, PEEK_HOLD_MS));
    }

    // stage copy progression while we wait
    revealTimers.push(setTimeout(function () {
      if (!identified && !docked) lbl.textContent = 'Finding your product';
    }, 1200));
    // soft cap: nothing identified yet, fall through to the plain chooser
    revealTimers.push(setTimeout(function () {
      if (!identified) dock(peekFor(link));
    }, PEEK_SOFT_MS));
    // hard cap: whatever is still pending, the stage ends
    revealTimers.push(setTimeout(function () {
      if (!docked) dock(peekFor(link));
    }, PEEK_HARD_MS));

    startPeek(link).then(function (pk) {
      if (docked) {
        // stage already handed off: upgrade the chooser in place (8s grace)
        if (pk && pk.ok && Date.now() - t0 < 8000) enhanceChooserWithPeek(pk);
        return;
      }
      if (!pk || !pk.ok) {
        revealTimers.push(setTimeout(function () { dock(null); },
          Math.max(0, PEEK_MIN_MS - (Date.now() - t0))));
        return;
      }
      var reveal = function (withImage) {
        var wait = Math.max(0, PEEK_MIN_MS - (Date.now() - t0));
        revealTimers.push(setTimeout(function () { identify(pk, withImage); }, wait));
      };
      if (pk.image) {
        var pre = new Image();
        var settled = false;
        var imgTimer = setTimeout(function () {
          if (settled) return; settled = true; reveal(false);
        }, PEEK_IMG_MS);
        pre.onload = function () {
          if (settled) return; settled = true; clearTimeout(imgTimer);
          imgEl.src = pk.image;
          reveal(true);
        };
        pre.onerror = function () {
          if (settled) return; settled = true; clearTimeout(imgTimer);
          peekImageFailed(pk);
          reveal(false);
        };
        pre.src = pk.image;
        revealTimers.push(imgTimer);
      } else {
        reveal(false);
      }
    });
  }

  /* Open the drawer prefilled from a Hexa style preset. */
  function openPreset(preset) {
    var sel = {};
    Object.keys(preset.sel || {}).forEach(function (k) { sel[k] = preset.sel[k]; });
    if (state.composerLink) sel.link = state.composerLink;
    openConfig(preset.product, sel);
    state.style = preset.id;
    state.sel.styleSeed = preset.seed;
    state.sel.styleName = preset.name;
    state.sel.stylePreview = preset.preview || state.sel.stylePreview;
    // reflect the style in the drawer header
    state.headKicker = preset.name + ' style';
    var kicker = $('#config-kicker');
    if (kicker) kicker.textContent = state.headKicker;
  }

  function closeConfig() {
    var overlay = $('#config-overlay');
    overlay.hidden = true;
    overlay.classList.remove('revealing');
    clearRevealTimers();
    var stage = $('#peek-stage');
    if (stage) stage.hidden = true;
    document.body.style.overflow = '';
    state.product = null;
    state.view = 'steps';
  }

  /* Pressing the CTA with steps missing walks you to the first gap. */
  function nudgeToMissing() {
    var missing = firstMissingStep();
    var sec = $('#config-body [data-step="' + missing + '"]');
    if (sec) {
      sec.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sec.classList.remove('step-nudge');
      void sec.offsetWidth;
      sec.classList.add('step-nudge');
    }
    var hint = $('#config-hint');
    if (hint) {
      hint.classList.remove('hint-flash');
      void hint.offsetWidth;
      hint.classList.add('hint-flash');
    }
  }

  /* POST the order to Stripe (server reprices it) and hand off to checkout.
   * Sends the Supabase access token so the backend can tie the order to the
   * signed-in user. */
  function startCheckout(order) {
    var btn = $('#config-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening secure checkout…'; }
    var headers = { 'Content-Type': 'application/json' };
    var token = window.HexaAuth && window.HexaAuth.accessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    fetch('/.netlify/functions/create-checkout', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ order: order }),
    })
      .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
      .then(function (d) {
        if (d && d.url) { window.location.href = d.url; return; }
        return Promise.reject(d);
      })
      .catch(function (d) {
        updatePrice();
        alert((d && d.error) || 'Could not start checkout. Please try again.');
      });
  }

  /* ── Order submit ── */
  function submitOrder() {
    if (!isComplete()) { nudgeToMissing(); return; }
    var order = {
      product: state.product,
      title: productDef(state.product).title,
      style: state.style,
      price: currentPrice(),
      selections: state.sel,
      ts: new Date().toISOString(),
    };

    try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}

    if (window.hexaTrack) window.hexaTrack('studio-order', order.product, order.price);

    if (STUDIO_LIVE) {
      // Sign-in required to pay, render and save: guests build the order freely,
      // but every real creation is owned by an account. Wait for the session to
      // resolve first so a logged-in user is never bounced by a not-yet-loaded
      // state; if signed out, stash the order and resume after login.
      if (window.HexaAuth && !window.HexaAuth.loaded()) {
        window.HexaAuth.ready().then(submitOrder);
        return;
      }
      if (window.HexaAuth && !window.HexaAuth.user()) {
        try { localStorage.setItem('hexa-pending-order', JSON.stringify(order)); } catch (e) {}
        window.location.href = '/login.html?next=' + encodeURIComponent('/?resume=1');
        return;
      }
      // Server reprices the order from catalog/pricing.json; on success Stripe
      // sends them to render.html?paid=..., which reads the order saved above.
      startCheckout(order);
      return;
    }

    // Pre-launch: take them straight to the render screen so they watch it build.
    // Orders with uploaded photos are too large for a URL; render.html reads
    // them back from localStorage (saved above).
    var brief = encodeURIComponent(JSON.stringify(order));
    window.location.href = brief.length > 4000 ? 'render.html' : 'render.html?order=' + brief;
  }

  /* ── Boot ── */
  function boot(data, presetsDoc) {
    state.data = data;
    state.presets = (presetsDoc && presetsDoc.presets) || [];
    initViewer();

    // Resume a checkout interrupted by sign-in: submitOrder() stashed the order
    // and sent them to /login.html?next=/?resume=1; on return, pick it back up.
    if (window.HexaAuth && /[?&]resume=1\b/.test(location.search)) {
      window.HexaAuth.ready().then(function () {
        if (!window.HexaAuth.user()) return;
        var pending = null;
        try { pending = JSON.parse(localStorage.getItem('hexa-pending-order')); } catch (e) {}
        if (pending) { localStorage.removeItem('hexa-pending-order'); startCheckout(pending); }
      });
    }
    window.hexaCreateAuto = function () { openConfig('auto'); };

    // ── Quiz handoff hooks: the homepage quiz (quiz.js) reuses the real peek
    // and opens the grounded config for the product it collected. ──
    window.hexaPeek = function (link) { return startPeek(link); };
    window.hexaPeekData = function (link) { return peekFor(link); };
    window.hexaQuizHandoff = function (answers) {
      answers = answers || {};
      var product = answers.format === 'photoshoot' ? 'photoshoot' : 'auto';
      var preset = {};
      if (answers.category) preset.quizCategory = answers.category;
      if (answers.vibe) preset.quizVibe = answers.vibe;
      if (answers.productImage) preset.productImage = answers.productImage;
      var open = function () {
        if (answers.link) { state.composerLink = answers.link; preset.link = answers.link; }
        openConfig(product, preset);
        if (window.hexaTrack) window.hexaTrack('quiz-finish', product, answers.vibe || '');
      };
      if (answers.link) {
        var pr = startPeek(answers.link); // warms peekFor so the config is grounded
        if (pr && pr.then) pr.then(open, open); else open();
      } else { open(); }
    };
    renderStyles(state.presets);
    renderModes(data);
    renderMarquee(data);
    renderHooks(data);

    // rail counters (editorial heads)
    var counts = [
      ['#styles-count', state.presets.length, 'presets'],
      ['#modes-count', (data.modes || []).length + 1, 'modes'],
      ['#hooks-count', (data.hooks || []).length, 'hooks'],
    ];
    counts.forEach(function (c) {
      var n = $(c[0]);
      if (n && c[1]) n.textContent = String(c[1]).padStart(2, '0') + ' ' + c[2];
    });

    // composer
    var linkInput = $('#composer-link');
    linkInput.addEventListener('input', function () {
      state.composerLink = linkInput.value.trim();
    });
    // prefetch the peek on paste: by the time they click Create, it's home,
    // and the product chip appears right in the bar
    linkInput.addEventListener('paste', function () {
      setTimeout(function () {
        var link = looksLikeUrl(linkInput.value.trim());
        if (link) startPeek(link).then(function () { updateComposerProduct(); });
      }, 0);
    });
    $('#composer-go').addEventListener('click', function () {
      state.composerLink = linkInput.value.trim();
      // Never blind-generate: show examples for their product and let them choose.
      var link = looksLikeUrl(state.composerLink);
      if (!link) { openChooser(null); return; }
      state.composerLink = link;
      openReveal(link);
    });

    // one-click demo products: fill the bar and run the real flow.
    // Hovering ghost-types the URL into the bar first, so the "paste a link"
    // gesture is demonstrated before anything is clicked. The ghost never
    // touches state and clears itself; a real value in the bar wins.
    var ghostTimer = null;
    function clearGhost() {
      if (ghostTimer) { clearInterval(ghostTimer); ghostTimer = null; }
      if (linkInput.classList.contains('is-ghost')) {
        linkInput.value = '';
        linkInput.classList.remove('is-ghost');
      }
    }
    linkInput.addEventListener('focus', clearGhost);
    $all('.composer-try-chip').forEach(function (chip) {
      chip.addEventListener('mouseenter', function () {
        if (document.activeElement === linkInput) return;
        if (linkInput.value && !linkInput.classList.contains('is-ghost')) return;
        clearGhost();
        var url = chip.getAttribute('data-try') || '';
        var i = 0;
        linkInput.classList.add('is-ghost');
        ghostTimer = setInterval(function () {
          i += 2;
          linkInput.value = url.slice(0, i);
          if (i >= url.length) { clearInterval(ghostTimer); ghostTimer = null; }
        }, 12);
      });
      chip.addEventListener('mouseleave', clearGhost);
      chip.addEventListener('click', function () {
        clearGhost();
        linkInput.value = chip.getAttribute('data-try');
        linkInput.dispatchEvent(new Event('input', { bubbles: true }));
        $('#composer-go').click();
      });
    });

    // the read product, attached in the bar the moment the peek lands
    function updateComposerProduct() {
      var chipEl = $('#composer-product');
      if (!chipEl) return;
      var link = looksLikeUrl(state.composerLink);
      var pk = link ? peekFor(link) : null;
      chipEl.hidden = !(pk && (pk.image || pk.title));
      if (chipEl.hidden) return;
      var img = $('#composer-product-img');
      if (pk.image) {
        img.src = pk.image;
        img.hidden = false;
        img.onerror = function () { img.hidden = true; peekImageFailed(pk); };
      } else {
        img.hidden = true;
      }
      $('#composer-product-name').textContent = pk.title || pk.siteName || '';
    }
    linkInput.addEventListener('input', updateComposerProduct);

    // composer quick settings: length / format / quality, set before the drawer
    var tools = $('#composer-tools');
    if (tools) {
      var DUR_SHORT = { 15: '15s', 30: '30s', 45: '45s', 60: '1:00', 90: '1:30', 120: '2:00' };
      var TOOLS = [
        { key: 'duration', name: 'Length', def: '15s',
          options: DURATIONS.map(function (d) {
            var extra = (d.sec / SEGMENT_SECONDS - 1) * EXTRA_SEGMENT_PRICE;
            return { v: d.sec, label: d.name, short: DUR_SHORT[d.sec] || d.sec + 's', hint: extra ? '+$' + extra : 'Included' };
          }) },
        { key: 'aspectId', name: 'Format', def: '9:16',
          options: (state.data.aspect_ratios || []).map(function (a) {
            var id = a.id || a;
            return { v: id, label: aspectLabel(a), short: id, hint: '' };
          }) },
        { key: 'quality', name: 'Quality', def: '720p',
          options: QUALITIES.map(function (q) {
            return { v: q.id, label: q.name, short: q.id, hint: q.id === '1080p' ? '+$' + QUALITY_1080_PER_SEGMENT + ' per 15s' : 'Included' };
          }) },
      ];
      var openPop = null;
      document.addEventListener('click', function (e) {
        if (openPop && !openPop.parentNode.contains(e.target)) {
          openPop.classList.remove('open');
          openPop = null;
        }
      });
      TOOLS.forEach(function (tool) {
        var wrap = el('div', 'composer-tool');
        var btn = el('button', 'composer-tool-btn');
        btn.type = 'button';
        btn.innerHTML =
          '<span class="composer-tool-k">' + tool.name + '</span>' +
          '<span class="composer-tool-v">' + tool.def + '</span>' +
          '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
        var pop = el('div', 'composer-pop');
        tool.options.forEach(function (o) {
          var row = el('button', 'composer-pop-row');
          row.type = 'button';
          row.innerHTML = '<span>' + o.label + '</span>' + (o.hint ? '<em>' + o.hint + '</em>' : '');
          if (o.v === state.prefs[tool.key]) row.classList.add('sel');
          row.addEventListener('click', function (e) {
            e.stopPropagation();
            state.prefs[tool.key] = o.v;
            btn.querySelector('.composer-tool-v').textContent = o.short;
            wrap.classList.add('set');
            $all('.composer-pop-row', pop).forEach(function (r) { r.classList.remove('sel'); });
            row.classList.add('sel');
            pop.classList.remove('open');
            openPop = null;
          });
          pop.appendChild(row);
        });
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (openPop && openPop !== pop) openPop.classList.remove('open');
          pop.classList.toggle('open');
          openPop = pop.classList.contains('open') ? pop : null;
        });
        wrap.appendChild(btn);
        wrap.appendChild(pop);
        tools.appendChild(wrap);
      });
    }
    var noLink = $('#composer-nolink');
    if (noLink) {
      noLink.addEventListener('click', function () {
        state.composerLink = '';
        openChooser();
      });
    }
    linkInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#composer-go').click();
    });

    // more tiles: wire clicks and fill prices from PRODUCTS (one source of truth)
    $all('.more-tile').forEach(function (tile) {
      var id = tile.getAttribute('data-product');
      var priceEl = tile.querySelector('.more-price');
      if (priceEl && PRODUCTS[id]) priceEl.textContent = formatPrice(id);
      tile.addEventListener('click', function () {
        openConfig(id);
      });
    });

    // homepage pricing band: <span data-price="mode:ugc"> / <span data-price-extra>
    $all('[data-price]').forEach(function (n) {
      var id = n.getAttribute('data-price');
      try { n.textContent = formatPrice(id); } catch (e) {}
    });
    // pack cards split the price so the "$" reads as a superscript: fill just
    // the number in [data-price-base] and the "From" prefix in [data-price-from].
    $all('[data-price-base]').forEach(function (n) {
      var id = n.getAttribute('data-price-base');
      try { n.textContent = priceInfo(id).base; } catch (e) {}
    });
    $all('[data-price-from]').forEach(function (n) {
      var id = n.getAttribute('data-price-from');
      try { n.textContent = priceInfo(id).from ? 'From' : ''; } catch (e) {}
    });
    $all('[data-price-extra]').forEach(function (n) {
      n.textContent = '+$' + EXTRA_SEGMENT_PRICE;
    });
    $all('[data-price-extra-n]').forEach(function (n) {
      n.textContent = '$' + EXTRA_SEGMENT_PRICE;
    });

    // closer
    $('#closer-cta').addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(function () { linkInput.focus(); }, 600);
    });

    // drawer
    $('.config-close').addEventListener('click', closeConfig);
    $('#config-overlay').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeConfig();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#config-overlay').hidden) closeConfig();
    });
    $('#config-submit').addEventListener('click', function () {
      if (state.view === 'ticket') { submitOrder(); return; }
      if (isComplete()) showTicket();
      else nudgeToMissing();
    });

    // pricing band cards open the matching configurator
    $all('[data-open]').forEach(function (card) {
      card.addEventListener('click', function () {
        var id = card.getAttribute('data-open');
        if (PRODUCTS[id]) openConfig(id);
        else if (MODE_CONFIG[id]) openMode(id);
      });
    });

    var y = $('#y');
    if (y) y.textContent = String(new Date().getFullYear());

    // Deep link: /?open=ugc | ?open=mode:ugc | ?open=choose
    var open = new URLSearchParams(window.location.search).get('open');
    if (open) {
      if (open === 'choose') openChooser();
      else if (open.indexOf('mode:') === 0 || PRODUCTS[open]) openConfig(open);
      else if (MODE_CONFIG[open]) openMode(open);
    }
  }

  /* Skeleton tiles while the catalog loads; a real error state if it fails. */
  function showSkeletons() {
    var grid = $('#style-grid');
    var rail = $('#mode-rail');
    for (var i = 0; i < 4; i++) {
      if (grid) grid.appendChild(el('div', 'tile-skeleton tile-skeleton-style'));
      if (rail) rail.appendChild(el('div', 'tile-skeleton tile-skeleton-mode'));
    }
  }
  function clearSkeletons() {
    $all('.tile-skeleton').forEach(function (n) { n.parentNode.removeChild(n); });
  }
  function catalogError() {
    clearSkeletons();
    ['#style-grid', '#mode-rail'].forEach(function (sel) {
      var host = $(sel);
      if (!host) return;
      var box = el('div', 'rail-error');
      box.appendChild(el('p', null, 'The studio catalog did not load.'));
      var retry = el('button', 'chip', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { location.reload(); });
      box.appendChild(retry);
      host.appendChild(box);
    });
  }

  showSkeletons();
  Promise.all([
    fetch(DATA_URL).then(function (r) { return r.json(); }),
    fetch('catalog/presets.json').then(function (r) { return r.json(); }).catch(function () { return { presets: [] }; }),
  ])
    .then(function (res) { clearSkeletons(); boot(res[0], res[1]); })
    .catch(function (err) {
      console.error('studio-data load failed', err);
      catalogError();
    });
})();

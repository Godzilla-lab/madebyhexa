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
  var PEEK_SOFT_MS = 12000; // stage gives up waiting and docks to the chooser
  var PEEK_HARD_MS = 14000; // absolute cap on the stage, whatever is loading
  var PEEK_MIN_MS = 900;    // minimum stage time, so the beat never flashes
  var PEEK_IMG_MS = 2800;   // budget for preloading the product image (re-hosted scrapes run large)
  var PEEK_HOLD_MS = 1100;  // how long the identified product holds the stage
  var GUESS_HOLD_MS = 60000; // max stage time while the photo is fetched: seeing the product IS the payoff, so we wait for it (with a skip link)

  /* Where /validate leaves a chosen angle for us, and how long it stays valid.
   * Must match the writer in validate.js. */
  var ANGLE_KEY = 'hexa-angle';
  var ANGLE_TTL_MS = 60 * 60 * 1000;

  /* ── Video modes (rendered as tiles) ── */
  var MODE_CONFIG = {
    ugc:            { price: 15, eta: '~5 min', steps: ['link', 'avatar', 'hook', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Creator-style ad' },
    tv_spot:        { price: 25, eta: '~7 min', steps: ['link', 'duration', 'aspect', 'notes'], kicker: 'Broadcast-grade spot' },
    product_review: { price: 15, eta: '~5 min', steps: ['link', 'avatar', 'hook', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Honest-feeling review' },
    unboxing:       { price: 15, eta: '~5 min', steps: ['link', 'avatar', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'First-touch unboxing' },
    tutorial:       { price: 15, eta: '~5 min', steps: ['link', 'avatar', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'How-to walkthrough' },
    ugc_try_on:     { price: 15, eta: '~5 min', steps: ['link', 'avatar', 'setting', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Casual try-on' },
    pro_try_on:     { price: 25, eta: '~7 min', steps: ['link', 'avatar', 'duration', 'aspect', 'notes'], kicker: 'Editorial try-on' },
    hyper_motion:   { price: 9, eta: '~3 min', steps: ['link', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Impossible camera moves' },
    wild_card:      { price: 9, eta: '~3 min', steps: ['link', 'duration', 'quality', 'aspect', 'notes'], kicker: 'Something unexpected' },
  };

  /* One engine output caps at 15s. Longer runs render as chained 15s
   * segments (one storyboard, same avatar and scene) stitched into one film.
   * Nobody else in this lane sells that. */
  var SEGMENT_SECONDS = 15;
  var EXTRA_SEGMENT_PRICE = 8;
  var DURATIONS = [
    { sec: 15, name: '15 seconds' },
    { sec: 30, name: '30 seconds' },
  ];

  /* Quality: 720p included on standard modes, 1080p priced per segment
   * (rendering cost scales with every 15s). Premium products ship 1080p
   * included; they carry it in their base price. Mirrored in lib/pricing.js. */
  var QUALITY_1080_PER_SEGMENT = 3;
  var PREMIUM_1080 = { 'mode:tv_spot': 1, 'mode:pro_try_on': 1, cinematic: 1 };

  /* The ad pack ships twenty creatives; picking formats by hand is a way to
   * choose WHICH twenty, not to buy fewer. Past twenty each extra creative is
   * one more render. Mirrors ADPACK_INCLUDED_FORMATS / extra_format_usd. */
  var ADPACK_INCLUDED_FORMATS = 20;
  var EXTRA_FORMAT_PRICE = 1;
  var QUALITIES = [
    { id: '720p', name: '720p HD' },
    { id: '1080p', name: '1080p Ultra' },
  ];

  /* ── Non-video products (More tiles) ── */
  var PRODUCTS = {
    photoshoot: { title: 'Product Photoshoot', kicker: 'Ten images, one pass', price: 9, eta: '~2 min', steps: ['link', 'mode', 'aspect', 'notes'] },
    adpack:     { title: 'DTC Ad Pack', kicker: 'Twenty static ads, twenty angles', price: 12, eta: '~2 min', steps: ['link', 'formats', 'notes'] },
    soul:       { title: 'Soul Character', kicker: 'Train once, reuse forever', price: 22, eta: '~1 hr', steps: ['soulname', 'soulphotos'] },
    cinematic:  { title: 'Cinematic Spot', kicker: 'Director-grade look', price: 25, eta: '~7 min', steps: ['link', 'camera', 'grade', 'light', 'duration', 'aspect', 'notes'] },
    auto:       { title: 'Auto Mode', kicker: 'We pick the winning format', price: 15, eta: '~5 min', steps: ['link', 'duration', 'quality', 'aspect', 'notes'] },
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
    angleBrief: '', // creative direction carried over from a research report
    heroPhotos: [], // photos added in the hero, before any product exists
    creditBalance: null, // null = unknown or signed out, never treated as zero
    payWith: 'card',     // 'credits' when the balance covers the order
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

  /* The product step is satisfied by ANY of: link, photos, description.
   * A social link alone is not a product: the engine cannot read Facebook
   * or Instagram any more than we can, so those orders must carry the
   * customer's own photos or words for the film to stand on. */
  function hasProduct(s) {
    if ((s.photos && s.photos.length) || s.desc) return true;
    if (!s.link) return false;
    var pk = peekFor(s.link);
    return !(pk && pk.social);
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

  /* The free taste, from anywhere on the page: compose the sample order and
   * hand off to the render stage. No sign-in asked here; the render page
   * gates at the collect moment instead. */
  function startFreeSample(link) {
    var order = {
      product: 'sample',
      title: 'Free sample',
      price: 0,
      selections: { link: link, aspect: '9:16' },
      ts: new Date().toISOString(),
    };
    var pk = peekFor(link);
    if (pk && pk.ok) {
      if (pk.title) order.selections.productName = pk.title;
      if (pk.webProductId) order.selections.webProductId = pk.webProductId;
      if (pk.image) order.selections.productImage = pk.image;
    }
    try { localStorage.setItem('hexa-studio-order', JSON.stringify(order)); } catch (e) {}
    if (window.hexaTrack) window.hexaTrack('studio-sample', 'sample', 0);
    window.location.href = 'render.html?sample=1';
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
    // Measured 2026-08-13: the Bright Data read lands in 5 to 10 seconds, the
    // engine scrape in about 21 when it works at all. Neither returns partial
    // results, so the only thing polling cadence buys is not sitting on a
    // finished photo. Early polls are tight for Bright Data, then they spread
    // out for the slow engine tail.
    var tries = 0;
    var MAX_TRIES = 45;
    (function tick() {
      if (tries++ >= MAX_TRIES) return;
      var delay = Math.min(1500 + tries * 500, 8000);
      // The url rides along so the poll can check the Bright Data read, which
      // usually beats the engine scrape by a wide margin.
      fetch(PEEK_URL + '?webProduct=' + encodeURIComponent(pk.webProductId) +
            (pk.url ? '&url=' + encodeURIComponent(pk.url) : ''))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.image) {
            pk.image = d.image;
            if (d.title && (!pk.title || pk.guessed)) { pk.title = d.title; pk.guessed = false; }
            peekUpgraded(pk);
          } else if (d && d.failed) {
            // the scrape finished with nothing: ask the server for one fresh
            // attempt, then give up honestly so the UI stops promising a photo
            if (!pk.scrapeRetried) {
              pk.scrapeRetried = true;
              fetch(PEEK_URL + '?rescrape=1&url=' + encodeURIComponent(pk.url))
                .then(function (r) { return r.json(); })
                .then(function (f) {
                  if (f && f.webProductId && f.webProductId !== pk.webProductId) {
                    pk.webProductId = f.webProductId;
                    pk.image = f.image || null;
                    if (pk.image) { peekUpgraded(pk); return; }
                    pollWebProduct(pk);
                  } else {
                    pk.scrapeFailed = true;
                    peekScrapeFailed(pk);
                  }
                })
                .catch(function () { pk.scrapeFailed = true; peekScrapeFailed(pk); });
            } else {
              pk.scrapeFailed = true;
              peekScrapeFailed(pk);
            }
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

  /* The image proxy (/.netlify/images) keeps scraped photos small, but it is
   * one more moving part: when its transform chokes, the customer loses a
   * photo we actually have. Heal by swapping the peek to the raw source URL
   * so callers can retry once without the proxy. */
  function healProxyImage(pk) {
    if (!pk || !pk.image || pk.image.indexOf('/.netlify/images?') !== 0) return false;
    var m = pk.image.match(/[?&]url=([^&]+)/);
    if (!m) return false;
    var raw;
    try { raw = decodeURIComponent(m[1]); } catch (e) { return false; }
    if (!/^https:\/\//i.test(raw)) return false;
    pk.image = raw;
    return true;
  }

  /* Every product img wears a live skeleton while its photo is in flight and
   * goes white only UNDER a loaded photo (cutout PNGs need the white). An
   * error retries once with the proxy healed away; only then is the image
   * given up (gone() cleans up the element, default hides it). */
  function wireProductImg(img, pk, gone) {
    img.classList.remove('img-loaded');
    img.classList.add('img-loading');
    img.onload = function () {
      img.classList.remove('img-loading');
      img.classList.add('img-loaded');
    };
    img.onerror = function () {
      // a sibling img may have healed the shared peek already: follow it.
      // Bounded: once src matches pk.image, failure falls through to heal
      // or to giving up, never back here with the same URL.
      if (pk && pk.image && img.getAttribute('src') !== pk.image) { img.src = pk.image; return; }
      if (healProxyImage(pk)) { img.src = pk.image; return; }
      img.classList.remove('img-loading');
      if (gone) gone(); else img.hidden = true;
      peekImageFailed(pk);
    };
    img.src = pk.image;
  }

  /* The photo arrived after the reveal stage moved on: celebrate it where
   * the customer is now, instead of quietly swapping a 34px chip. */
  var peekToastTimer = null;
  function peekToast(pk) {
    if (!pk || !pk.image) return;
    var old = $('#peek-toast');
    if (old) old.remove();
    if (peekToastTimer) { clearTimeout(peekToastTimer); peekToastTimer = null; }
    var t = el('div', 'peek-toast');
    t.id = 'peek-toast';
    var img = el('img');
    img.alt = '';
    wireProductImg(img, pk, function () { t.remove(); });
    t.appendChild(img);
    var txt = el('div', 'peek-toast-text');
    txt.appendChild(el('strong', null, 'Product photo found'));
    txt.appendChild(el('span', null, pk.title || 'Straight from your page'));
    t.appendChild(txt);
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    peekToastTimer = setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 400);
    }, 5200);
  }

  /* The scrape gave up after the stage moved on: stop the chooser from
   * promising a photo that is not coming, and point at the fix. */
  function peekScrapeFailed(pk) {
    if (pk.url !== (state.sel.link || state.composerLink)) return;
    productChip(true);
    var overlay = $('#config-overlay');
    if (!overlay || overlay.hidden || !overlay.classList.contains('chooser')) return;
    var intro = $('.chooser-intro');
    if (intro) intro.textContent = chooserIntroText(pk);
  }

  /* Fit the reveal frame to the photo's own shape (clamped so extreme
   * panoramas and strips stay a sane card) instead of letterboxing it. */
  function fitPeekFrame(pre) {
    var frame = $('#peek-frame');
    if (!frame || !pre.naturalWidth || !pre.naturalHeight) return;
    var ratio = Math.min(1.4, Math.max(0.8, pre.naturalWidth / pre.naturalHeight));
    frame.style.aspectRatio = String(ratio);
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
        var frame = $('#peek-frame');
        if (!imgEl) return;
        fitPeekFrame(pre);
        imgEl.src = pk.image;
        imgEl.hidden = false;
        if (frame) frame.hidden = false;
        var t = $('#peek-title');
        if (t && pk.title) { t.textContent = pk.title; t.hidden = false; }
      };
      pre.onerror = function () {
        if (healProxyImage(pk)) pre.src = pk.image;
      };
      pre.src = pk.image;
      return;
    }
    if (overlay.classList.contains('chooser')) {
      enhanceChooserWithPeek(pk);
      peekToast(pk);
      return;
    }
    productChip(true);
    peekToast(pk);
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
      img.hidden = false;
      wireProductImg(img, pk);
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
      var setLinkHint = function () {
        var pk0 = peekFor(state.sel.link);
        if (pk0 && pk0.social) {
          linkHint.textContent = pk0.social + ' keeps its pages closed, so this link cannot carry your product photo. Add photos in the Upload photos tab and the film builds around the real thing.';
        } else if (pk0 && pk0.title) {
          linkHint.textContent = 'We read this page and found ' + pk0.title + '. Its images and details flow straight into your order.';
        } else {
          linkHint.textContent = 'We pull the images and details from the page automatically.';
        }
      };
      setLinkHint();
      input.addEventListener('input', function () {
        state.sel.link = input.value.trim();
        // the peek belongs to the link it was read from; editing the link voids it
        if (state.sel.productName && !peekFor(state.sel.link)) {
          delete state.sel.productName;
          delete state.sel.productImage;
          delete state.sel.productSiteName;
          delete state.sel.productPrice;
          delete state.sel.productCurrency;
          productChip(false);
        }
        setLinkHint();
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
      var pNote = el('span', null, 'This is your creator. Every segment of your film uses this exact person.');
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
      step.appendChild(el('h3', null, '<span class="step-n">' + n + '</span>Pick your formats <span style="text-transform:none;letter-spacing:0;font-weight:500;">(twenty included)</span>'));
      var wrap = el('div', 'picker picker-media');
      var chipRow = el('div', 'picker picker-chips');
      state.sel.formats = [];

      function toggle(f, node) {
        var i = state.sel.formats.findIndex(function (x) { return x.id === f.id; });
        if (i >= 0) {
          state.sel.formats.splice(i, 1);
          node.classList.remove('sel');
        } else {
          // No hard cap below the catalog size: twenty are included and every
          // one past that is a real extra render, priced as one.
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
      step.appendChild(el('p', 'picker-note', 'Twenty creatives included · +$1 each after that.'));
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

  /*
   * The same price as credits, which is what the studio actually charges.
   *
   * 500 credits to the dollar is chosen so the numbers read large: a $12 ad
   * pack is 6,000 credits and the 2,500 a new account is given is a real
   * allowance rather than loose change. The dollar figure stays alongside it in
   * small type, because a visitor who has never seen our credits cannot judge
   * whether 7,000 is a lot without one reference point.
   */
  function creditPrice(productId) {
    return creditsForTotal(priceInfo(productId).base).toLocaleString();
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
    // Mirrors ADPACK_INCLUDED_FORMATS / extra_format_usd in the server pricer.
    // The server is the authority, so any drift here shows the buyer one number
    // and charges another; keep the two in step.
    if (state.product === 'adpack' && state.sel.formats && state.sel.formats.length > ADPACK_INCLUDED_FORMATS) {
      total += (state.sel.formats.length - ADPACK_INCLUDED_FORMATS) * EXTRA_FORMAT_PRICE;
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

  /*
   * Dollars to credits, matching CREDITS_PER_CENT in netlify/functions/lib/pricing.js.
   *
   * Deliberately a big number: 500 credits to the dollar means a $12 ad pack
   * reads as 6,000 credits, and the 2,500 a new account is given reads as a
   * real allowance rather than as pocket change. The server reprices every
   * order from catalog/pricing.json regardless of what this says, so a wrong
   * number here is a display bug and never a way to underpay.
   */
  var CREDITS_PER_DOLLAR = 500;
  function creditsForTotal(dollars) {
    return Math.round(dollars * CREDITS_PER_DOLLAR);
  }

  /*
   * The balance, read once per page and refreshed after a spend.
   *
   * my_credit_balance() is SECURITY INVOKER and sums only the caller's own
   * ledger rows, so this is safe to call straight from the browser with the
   * anon key: there is no argument to tamper with and no other account's rows
   * to reach.
   */
  function loadCreditBalance() {
    if (!window.HexaAuth || !window.HexaAuth.client) return Promise.resolve(null);
    return window.HexaAuth.ready()
      .then(function () {
        if (!window.HexaAuth.user()) { state.creditBalance = null; return null; }
        return window.HexaAuth.client.rpc('my_credit_balance').then(function (r) {
          state.creditBalance = r && r.error ? null : Number(r.data || 0);
          return state.creditBalance;
        });
      })
      .catch(function () { state.creditBalance = null; return null; });
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

    var altBtn = $('#config-pay-card');
    if (altBtn) altBtn.hidden = true;

    if (state.view === 'ticket') {
      btn.disabled = false;

      /*
       * Credits lead when the balance covers it.
       *
       * Every new account is given 2,500 credits, and until now there was no
       * way to spend them: the only button here went to Stripe, so the welcome
       * grant was a number on a page. Someone who can already afford the order
       * from their balance should be one press from having it, with the card as
       * the fallback rather than the toll gate.
       */
      var credits = creditsForTotal(total);
      var balance = state.creditBalance;
      if (STUDIO_LIVE && balance != null && balance >= credits) {
        state.payWith = 'credits';
        btn.textContent = 'Use ' + credits.toLocaleString() + ' credits';
        if (altBtn) {
          altBtn.hidden = false;
          altBtn.textContent = 'Pay $' + total + ' by card instead';
        }
        if (hint) {
          hint.hidden = false;
          hint.classList.add('config-hint-ok');
          hint.textContent = 'You have ' + balance.toLocaleString() + ' credits. Anything we fail to deliver comes straight back to your balance.';
        }
        return;
      }

      state.payWith = 'card';
      btn.textContent = STUDIO_LIVE ? 'Pay $' + total + ' securely' : 'Place order · $' + total;
      if (hint) {
        hint.hidden = false;
        hint.classList.add('config-hint-ok');
        if (STUDIO_LIVE && balance != null && balance > 0) {
          // Naming the shortfall beats a silent card button: they can see the
          // balance is real and how far it goes.
          hint.textContent = 'This one needs ' + credits.toLocaleString() + ' credits and you have '
            + balance.toLocaleString() + '. Secure Stripe checkout, and you are never charged for work we do not deliver.';
        } else {
          hint.textContent = STUDIO_LIVE
            ? 'Secure Stripe checkout. You are never charged for work we do not deliver.'
            : 'Delivered on this page and to your email.';
        }
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
    if (state.product === 'adpack' && s.formats && s.formats.length > ADPACK_INCLUDED_FORMATS) {
      var extraFmts = s.formats.length - ADPACK_INCLUDED_FORMATS;
      line('Extra formats, ' + extraFmts + ' at $' + EXTRA_FORMAT_PRICE, '$' + (extraFmts * EXTRA_FORMAT_PRICE));
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

    /*
     * A brief that came from a research report survives the format choice.
     *
     * The angle used to be applied only by the one openConfig call the handoff
     * made itself, so a merchant who arrived from a report and then picked a
     * different goal got a blank creative direction and had to retype the hook
     * we had just proved. Held on state instead, and consumed by whichever
     * product they land on.
     */
    if (state.angleBrief && p.steps.indexOf('notes') >= 0 && !state.sel.directions) {
      state.sel.directions = state.angleBrief.slice(0, 1200);
    }

    /* Photos chosen in the hero, before there was a product to attach them to.
     * Same reason the brief is held on state: openConfig resets state.sel. */
    if (state.heroPhotos.length && !(state.sel.photos || []).length) {
      state.sel.photos = state.heroPhotos.slice();
    }

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

  /*
   * Styles, grouped by what people will think of the ad rather than by which
   * engine family made it.
   *
   * "Creator videos / Premium spots / Photo sets" is our org chart. A merchant
   * choosing between them has to already know that UGC reads as authentic and
   * that a TV spot reads as expensive, which is the exact knowledge they came
   * here without. The tiles underneath are unchanged; only the question they
   * answer is.
   */
  var CHOOSER_GROUPS = [
    { name: 'Feels authentic', sub: 'Reads like a real customer filmed it.',
      products: ['mode:ugc', 'mode:unboxing', 'mode:ugc_try_on'] },
    { name: 'Looks expensive', sub: 'Reads like a brand with a budget.',
      products: ['cinematic', 'mode:tv_spot', 'mode:pro_try_on'] },
    { name: 'Looks viral', sub: 'Built to survive the first second of a scroll.',
      products: ['mode:hyper_motion', 'mode:wild_card'] },
    { name: 'Feels trustworthy', sub: 'Reads like a review rather than an ad.',
      products: ['mode:product_review', 'mode:tutorial'] },
    { name: 'Looks like a product commercial', sub: 'The product itself, shot properly.',
      products: ['photoshoot', 'adpack'] },
  ];

  /*
   * The first question, in outcomes.
   *
   * Asking "pick a format" asks the merchant to translate a business goal into
   * our vocabulary before they can buy anything. Asking what they want the ad
   * to DO is a question anyone selling something can answer, and each answer
   * maps to exactly one product we already build.
   */
  var GOALS = [
    { ico: '🤷', name: 'Let Hexa choose', sub: 'We pick the format, the look and the script from what the research found.', product: 'auto', lead: true },
    { ico: '🔥', name: 'Make people stop scrolling', sub: 'Fast, impossible camera moves that break a scroll.', product: 'mode:hyper_motion' },
    { ico: '👤', name: 'Make it feel like a real customer', sub: 'A creator holding your product, talking to camera.', product: 'mode:ugc' },
    { ico: '🎬', name: 'Make it look premium', sub: 'Director-grade camera, lighting and colour.', product: 'cinematic' },
    { ico: '📦', name: 'Show the product', sub: 'Your product in real hands, opened and shown off.', product: 'mode:unboxing' },
    { ico: '🧪', name: 'Show how it works', sub: 'A clear walkthrough of using it, start to finish.', product: 'mode:tutorial' },
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
    img.alt = '';
    wireProductImg(img, pk, function () { img.remove(); });
    return img;
  }

  function chooserIntroText(pk) {
    if (pk && pk.title) {
      var base = pk.title + ', styled ' + state.presets.length + ' ways.';
      if (pk.scrapeFailed && !pk.image) {
        return base + ' That page kept its photo to itself, so add one of yours on the next step. The film comes out just as sharp.';
      }
      if (pk.social) {
        return base + ' Add a product photo on the next step and it goes straight into frame.';
      }
      if (!pk.image && pk.webProductId) {
        return base + ' Your product photo is still on its way and pops in here the moment it lands.';
      }
      if (!pk.image) {
        return base + ' Add a photo of it on the next step and it goes straight into frame.';
      }
      return base + ' Pick what you want it to do and we make it with your product in frame.';
    }
    if (pk && pk.social) {
      return 'Here is what we can make. ' + pk.social + ' keeps its pages to itself, so add a product photo on the next step and we build the film around the real thing.';
    }
    return state.composerLink
      ? 'Tell us what you want it to do and we build exactly that around your product.'
      : 'Tell us what you want the ad to do. You add photos or a description on the next step.';
  }

  function openChooser(peek) {
    $('#config-kicker').textContent = 'Step 1 of 2';
    $('#config-title').textContent = 'Your ad';
    var overlay = $('#config-overlay');
    overlay.classList.add('chooser');
    var pk = peek && peek.ok ? peek : null;
    productChip(!!pk);

    var body = $('#config-body');
    body.innerHTML = '';
    var head = el('div', 'chooser-head');
    /* Arriving from a report, what to say is settled and only the making is
     * open, so the question changes to match what is actually still undecided. */
    var fromRead = !!state.angleBrief;
    head.appendChild(el('h3', 'chooser-headline',
      fromRead ? 'How should we make it?' : 'What do you want the ad to do?'));
    head.appendChild(el('p', 'chooser-intro',
      fromRead
        ? 'Your angle and opening line are already loaded, so whatever you pick here gets built around them.'
        : chooserIntroText(pk)));
    body.appendChild(head);

    /* Goals first. Every one of these opens a product we already build; the
     * mapping is ours to know and the merchant's to never think about. */
    var goals = el('div', 'goal-grid');
    GOALS.forEach(function (g) {
      var t = el('button', 'goal-tile' + (g.lead ? ' goal-tile-lead' : ''));
      t.type = 'button';
      t.appendChild(el('span', 'goal-ico', g.ico));
      var meta = el('span', 'goal-meta');
      if (g.lead) meta.appendChild(el('span', 'goal-badge', 'Recommended'));
      meta.appendChild(el('span', 'goal-name', g.name));
      meta.appendChild(el('span', 'goal-sub', g.sub));
      t.appendChild(meta);
      t.appendChild(el('span', 'goal-price', formatPrice(g.product)));
      t.addEventListener('click', function () {
        if (g.product.indexOf('mode:') === 0) openMode(g.product.slice(5));
        else openConfig(g.product);
      });
      goals.appendChild(t);
    });
    body.appendChild(goals);

    var grid = el('div', 'chooser-grid');

    // The free taste: a 5 second grounded clip, one per account. Only offered
    // when a real link is in play; an ungrounded sample sells nothing.
    if (state.composerLink) {
      var sample = el('button', 'chooser-sample');
      sample.type = 'button';
      var sampleCopy = el('span', 'chooser-sample-copy');
      var strong = document.createElement('strong');
      strong.textContent = 'Not ready to pay? Watch it move, free.';
      sampleCopy.appendChild(strong);
      sampleCopy.appendChild(document.createTextNode(
        ' A 5 second clip of ' + (pk && pk.title ? pk.title : 'your product') +
        ' in a creator’s hands. One per account, no card.'));
      sample.appendChild(el('span', 'chooser-sample-badge', 'Free'));
      sample.appendChild(sampleCopy);
      sample.appendChild(el('span', 'chooser-sample-arrow', '→'));
      sample.addEventListener('click', function () { startFreeSample(state.composerLink); });
      grid.appendChild(sample);
    }

    var used = {};
    CHOOSER_GROUPS.forEach(function (group) {
      var members = state.presets.filter(function (p) {
        return group.products.indexOf(p.product) >= 0;
      });
      members.forEach(function (p) { used[p.id] = true; });
      renderChooserGroup(grid, group.name, members, pk, group.sub);
    });
    // presets outside the group map still show, ungrouped
    var rest = state.presets.filter(function (p) { return !used[p.id]; });
    renderChooserGroup(grid, rest.length && Object.keys(used).length ? 'More styles' : null, rest, pk);

    /* The library, folded away. It is the best thing in the product for
     * somebody who knows what they want, and the worst possible first screen
     * for somebody who does not: twelve tiles is twelve decisions before any
     * ad exists. */
    var lib = document.createElement('details');
    lib.className = 'chooser-lib';
    var libSum = document.createElement('summary');
    libSum.textContent = 'Or browse every style';
    lib.appendChild(libSum);
    lib.appendChild(grid);
    body.appendChild(lib);

    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    body.scrollTop = 0;
  }

  function renderChooserGroup(grid, name, presets, pk, sub) {
    if (!presets.length) return;
    if (name) {
      var h = el('p', 'chooser-group', name);
      if (sub) h.appendChild(el('span', 'chooser-group-sub', sub));
      grid.appendChild(h);
    }
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
  /*
   * Where a recognised product goes next.
   *
   * The composer used to run link → photo → style picker, which put the
   * question "what should this look like" in front of the question "what
   * should this say". The read answers the second one, so it now sits between
   * them: /validate takes the same link, does the research, and ends on the
   * angle with a button that makes the ad. Anyone who already knows what they
   * want still has the skip, and every other entry (style tiles, mode rails,
   * the quiz) still opens the studio directly.
   */
  function goToRead(link) {
    window.location.href = '/validate?url=' + encodeURIComponent(link);
  }

  function openReveal(link) {
    if (REDUCED_MOTION) {
      // There is no stage to play, so the read is simply the next step. No
      // peek is started: the navigation would abort it, and the report reads
      // the product page itself anyway.
      goToRead(link);
      return;
    }

    var overlay = $('#config-overlay');
    var stage = $('#peek-stage');
    var card = $('#peek-card');
    var frame = $('#peek-frame');
    var imgEl = $('#peek-img');
    var eyebrow = $('#peek-eyebrow');
    var lbl = $('#peek-label');
    var titleEl = $('#peek-title');
    var priceEl = $('#peek-price');
    var progEl = $('#peek-progress');
    var noteEl = $('#peek-note');
    var skipEl = $('#peek-skip');
    var nextEl = $('#peek-next');
    var nextGo = $('#peek-next-go');
    var nextSkip = $('#peek-next-skip');

    // reset the stage: no photo yet means no frame at all. The card reads as
    // a typographic slate until a real image earns the space.
    clearRevealTimers();
    card.classList.remove('peek-in', 'peek-found', 'peek-out');
    frame.hidden = true;
    frame.style.aspectRatio = '';
    imgEl.hidden = true; imgEl.removeAttribute('src');
    titleEl.hidden = true;
    priceEl.hidden = true;
    noteEl.hidden = true;
    skipEl.hidden = true;
    skipEl.onclick = null;
    if (nextEl) { nextEl.hidden = true; nextGo.onclick = null; nextSkip.onclick = null; }
    progEl.hidden = false;
    eyebrow.textContent = 'Hexa Studio';
    var hostname = '';
    try { hostname = new URL(link).hostname.replace(/^www\./, ''); } catch (e) { /* keep default */ }
    lbl.textContent = hostname ? 'Reading ' + hostname : 'Reading your page';
    lbl.style.opacity = '';

    overlay.classList.add('revealing');
    overlay.hidden = false;
    stage.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { card.classList.add('peek-in'); });

    var t0 = Date.now();
    var docked = false;
    var identified = false;

    /* The stage has two exits now. */

    function exitToStudio(pk) {
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

    /*
     * The product is known, so the next thing to work out is what to say about
     * it. This is a question rather than a countdown: a merchant who has never
     * run an ad wants it decided for them, and one who runs ads every week
     * wants the controls. Guessing which is which, or auto-advancing past the
     * choice, gets one of them wrong every time.
     */
    function exitToRead(pk) {
      clearRevealTimers();
      progEl.hidden = true;
      noteEl.hidden = true;
      skipEl.hidden = true;
      if (!nextEl) { goToRead(link); return; }
      nextEl.hidden = false;
      nextGo.onclick = function () { goToRead(link); };
      nextSkip.onclick = function () {
        nextEl.hidden = true;
        exitToStudio(pk);
      };
    }

    function dock(pk) {
      if (docked) return;
      docked = true;
      // A page we could not read, or a social post, gives the read nothing to
      // work with. Those go straight to the studio, where photos and a typed
      // description still get an ad made.
      if (!pk || !pk.ok || pk.social) { exitToStudio(pk); return; }
      exitToRead(pk);
    }

    function identify(pk, withImage) {
      if (docked || identified) return;
      identified = true;
      progEl.hidden = true;

      // A social post is not a product page: say so plainly and point at the
      // paths that do work. No fake product name, no dead-end.
      if (pk.social && !pk.image && !pk.title) {
        card.classList.add('peek-found');
        eyebrow.textContent = pk.social + ' link';
        lbl.textContent = '';
        titleEl.textContent = 'That is a post on ' + pk.social + ', not a product page';
        titleEl.hidden = false;
        noteEl.textContent = "Paste the product's own store page, or start with photos or a description.";
        noteEl.hidden = false;
        revealTimers.push(setTimeout(function () { dock(pk); }, 4600));
        return;
      }

      if (withImage) {
        frame.hidden = false;
        imgEl.hidden = false;
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

      // A photo is still on its way: either the engine's scrape of a blocked
      // page, or a known image that is just slow to load. Hold the stage and
      // wait for it instead of rushing past. The moment it paints (the frame
      // unhides), give it a beat, then move on. If the scrape dies, say so
      // and stop promising. Seeing their own product on this card is the
      // moment that sells the film, so ANY result that has a photo coming
      // (guessed or not) waits for it; the stage never moves on without it.
      var photoComing = pk.imageSlow || (!pk.image && pk.webProductId);
      if (photoComing && frame.hidden) {
        progEl.hidden = false;
        if (pk.guessed && !pk.image) {
          noteEl.textContent = 'That page is guarded, so we are fetching your product photo another way.';
          noteEl.hidden = false;
        }
        clearRevealTimers();
        // The wait is long on purpose: seeing their own product on this card
        // is the moment that sells the film. Keep the copy moving so the
        // wait reads as work, not as a hang, and offer a way out.
        var waited = 0;
        var waiter = setInterval(function () {
          waited += 400;
          if (waited === 8000 && frame.hidden) {
            noteEl.textContent = 'A real browser is opening your page right now.';
            noteEl.hidden = false;
          } else if (waited === 18000 && frame.hidden) {
            noteEl.textContent = 'Reading the page and picking the best product photo.';
          } else if (waited === 34000 && frame.hidden) {
            noteEl.textContent = 'Almost there. A good photo is worth a few more seconds.';
          }
          if (waited === 12000 && frame.hidden) skipEl.hidden = false;
          if (!frame.hidden) {
            clearInterval(waiter);
            eyebrow.textContent = pk.siteName ? 'Product found · ' + pk.siteName : 'Product found';
            if (pk.title) titleEl.textContent = pk.title;
            progEl.hidden = true;
            noteEl.hidden = true;
            skipEl.hidden = true;
            revealTimers.push(setTimeout(function () { dock(pk); }, 1500));
          } else if (pk.scrapeFailed) {
            clearInterval(waiter);
            progEl.hidden = true;
            skipEl.hidden = true;
            noteEl.textContent = 'This page keeps its photos to itself. Add one of yours on the next step; the film comes out just as sharp.';
            noteEl.hidden = false;
            revealTimers.push(setTimeout(function () { dock(pk); }, 2600));
          } else if (waited >= GUESS_HOLD_MS) {
            clearInterval(waiter);
            progEl.hidden = true;
            skipEl.hidden = true;
            noteEl.textContent = pk.webProductId
              ? 'Still working on the photo. We pop it in the moment it lands.'
              : 'The photo would not load. You can add one on the next step.';
            noteEl.hidden = false;
            revealTimers.push(setTimeout(function () { dock(pk); }, 1300));
          }
        }, 400);
        revealTimers.push(waiter); // clearTimeout clears intervals too
        skipEl.onclick = function () {
          clearInterval(waiter);
          skipEl.hidden = true;
          dock(pk); // the toast still announces the photo when it lands
        };
        return;
      }
      if (pk.guessed && !pk.image) {
        noteEl.textContent = 'That page would not let us read it, so check the name on the next step.';
        noteEl.hidden = false;
      }
      revealTimers.push(setTimeout(function () { dock(pk); }, PEEK_HOLD_MS));
    }

    // stage copy progression while we wait
    revealTimers.push(setTimeout(function () {
      if (!identified && !docked) lbl.textContent = 'Finding your product';
    }, 1200));
    revealTimers.push(setTimeout(function () {
      if (!identified && !docked) lbl.textContent = 'The page is slow, still reading it';
    }, 5500));
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
          // the photo exists but is slow (cold CDN transform): identify now
          // and let the stage hold for it instead of moving on without it
          if (settled) return; settled = true;
          pk.imageSlow = true;
          reveal(false);
        }, PEEK_IMG_MS);
        pre.onload = function () {
          if (settled) {
            // arrived after the budget: if the stage is still up, paint it
            // anyway; the identify waiter sees the frame appear and settles
            if (!stage.hidden && !overlay.hidden) {
              fitPeekFrame(pre);
              imgEl.src = pk.image;
              imgEl.hidden = false;
              frame.hidden = false;
            }
            return;
          }
          settled = true; clearTimeout(imgTimer);
          fitPeekFrame(pre);
          imgEl.src = pk.image;
          reveal(true);
        };
        pre.onerror = function () {
          if (healProxyImage(pk)) { pre.src = pk.image; return; }
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
      /*
       * Credits go straight to the render screen, which calls render-create
       * with the session token and no Stripe id; the server charges the ledger
       * there, refuses cleanly if the balance moved in the meantime, and
       * refunds per creative anything that then fails to render.
       */
      if (state.payWith === 'credits') {
        window.location.href = 'render.html?credits=1';
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

    /*
     * The two ways in.
     *
     * Connecting the store leads because it is the only path where the
     * merchant never copies anything: their catalogue arrives, they tap a
     * product, and the read starts. Pasting a link is the fallback and stays
     * one click away, because most first-time visitors have not connected
     * anything and a store connect is a big ask for someone still deciding.
     */
    (function initEntrySwitch() {
      var SHOP = 2;
      var tabs = [
        { btn: $('#entry-tab-link'), pane: $('#entry-link'), focus: '#composer-link' },
        { btn: $('#entry-tab-photos'), pane: $('#entry-photos'), focus: null },
        { btn: $('#entry-tab-shopify'), pane: $('#entry-shopify'), focus: '#shop-domain' },
      ];
      if (tabs.some(function (t) { return !t.btn || !t.pane; })) return;

      function show(i, focus) {
        tabs.forEach(function (t, k) {
          var on = k === i;
          t.btn.classList.toggle('is-on', on);
          t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
          t.pane.hidden = !on;
        });
        if (focus && tabs[i].focus) {
          var target = $(tabs[i].focus);
          if (target) target.focus();
        }
      }
      tabs.forEach(function (t, i) {
        t.btn.addEventListener('click', function () { show(i, true); });
      });

      /*
       * Photos, for people who have a product but no page for it yet.
       *
       * Collected into state.heroPhotos rather than state.sel, because
       * openConfig resets state.sel on every open and these were chosen before
       * any product existed to attach them to. Same shrinkImage path the drawer
       * uses, so what arrives downstream is byte-identical to a drawer upload.
       */
      var drop = $('#hero-drop');
      var fileInput = $('#hero-photos');
      var thumbs = $('#hero-thumbs');
      var photosGo = $('#hero-photos-go');

      function renderHeroThumbs() {
        thumbs.textContent = '';
        state.heroPhotos.forEach(function (src, i) {
          var w = el('div', 'photo-thumb');
          var img = el('img');
          img.src = src;
          img.alt = '';
          var x = el('button', 'photo-x');
          x.type = 'button';
          x.setAttribute('aria-label', 'Remove photo ' + (i + 1));
          x.innerHTML = '&times;';
          x.addEventListener('click', function (e) {
            e.preventDefault();
            state.heroPhotos.splice(i, 1);
            renderHeroThumbs();
          });
          w.appendChild(img);
          w.appendChild(x);
          thumbs.appendChild(w);
        });
        if (drop) drop.classList.toggle('is-full', state.heroPhotos.length >= 3);
      }

      if (fileInput) {
        fileInput.addEventListener('change', function () {
          var room = 3 - state.heroPhotos.length;
          Array.prototype.slice.call(fileInput.files || []).slice(0, room).forEach(function (f) {
            shrinkImage(f, 1024, function (dataUrl) {
              if (dataUrl && state.heroPhotos.length < 3) {
                state.heroPhotos.push(dataUrl);
                renderHeroThumbs();
              }
            });
          });
          fileInput.value = '';
        });
      }

      if (photosGo) {
        photosGo.addEventListener('click', function () {
          // No link to peek, so there is nothing to identify: straight to the
          // question of what the ad should do.
          state.composerLink = '';
          openChooser();
        });
      }

      /* Someone with a store already connected does not need the connect
       * field; the catalogue picker lives in the link pane, so that stays the
       * default for them too. The tab is only pre-opened for a signed-in
       * merchant who has NOT connected one, where it is the better offer. */
      if (window.HexaAuth) {
        window.HexaAuth.onChange(function (user) {
          if (!user) return;
          window.HexaAuth.client.from('my_store_connections')
            .select('store')
            .limit(1)
            .then(function (r) {
              var connected = r && !r.error && r.data && r.data.length;
              if (!connected) show(SHOP, false);
            });
        });
      }

      var form = $('#shop-form');
      var field = $('#shop-domain');
      var note = $('#shop-note');
      var noteText = note ? note.textContent : '';
      if (!form || !field) return;

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        /* Merchants paste all of it: the admin URL, the https, the trailing
         * slash, sometimes their custom domain. Everything but the shop name
         * is stripped here, because shopify-install rejects anything that is
         * not exactly <name>.myshopify.com and a rejection at that point looks
         * to the merchant like we are broken. */
        var raw = (field.value || '').trim().toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/^admin\.shopify\.com\/store\//, '')
          .replace(/\/.*$/, '')
          .replace(/\.myshopify\.com$/, '');
        if (!/^[a-z0-9][a-z0-9-]*$/.test(raw)) {
          if (note) {
            note.textContent = 'That does not look like a store address yet. It is the name in your admin URL, before .myshopify.com';
            note.classList.add('is-err');
          }
          field.focus();
          return;
        }
        if (note) { note.textContent = noteText; note.classList.remove('is-err'); }
        window.location.href = '/.netlify/functions/shopify-install?shop='
          + encodeURIComponent(raw + '.myshopify.com');
      });
    })();

    /*
     * Guess the angle.
     *
     * The one part of this page that does not argue, it demonstrates. A real
     * product, three real themes, and the two wrong answers are the ones
     * competitors actually advertise. Most people pick a crowded lane, and
     * feeling that happen is worth more than any headline claiming it would.
     *
     * Frozen data, deliberately: it has to be instant, it has to cost nothing
     * per visitor, and every number in it has to be one we actually measured.
     * There is no "62% of people pick wrong" line and there will not be one
     * until picks are really counted, because inventing it would poison the
     * only section whose whole argument is that we do not guess.
     */
    (function initGuess() {
      var stage = $('#guess-stage');
      if (!stage) return;
      var rounds = [];
      var at = 0;

      fetch('/catalog/guess-angles.json')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          rounds = (d && d.rounds) || [];
          if (rounds.length) draw();
          else stage.closest('.guess').hidden = true;
        })
        .catch(function () {
          // No data, no section. A broken quiz is worse than no quiz.
          var sec = stage.closest('.guess');
          if (sec) sec.hidden = true;
        });

      function draw() {
        var r = rounds[at % rounds.length];
        stage.textContent = '';

        var head = el('div', 'guess-product');
        head.appendChild(el('span', 'guess-product-label', 'The product'));
        head.appendChild(el('span', 'guess-product-name', r.product));
        head.appendChild(el('span', 'guess-product-price', r.price));
        stage.appendChild(head);

        var group = el('div', 'guess-options');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', 'Which would you run?');

        r.options.forEach(function (o, i) {
          var b = el('button', 'guess-option');
          b.type = 'button';
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', 'false');
          b.appendChild(el('span', 'guess-option-mark'));
          b.appendChild(el('span', 'guess-option-claim', o.claim));
          b.addEventListener('click', function () { reveal(r, i); });
          group.appendChild(b);
        });
        stage.appendChild(group);
        stage.appendChild(el('p', 'guess-hint', 'Pick one. Nothing is submitted anywhere.'));
      }

      function reveal(r, picked) {
        var winner = r.options.reduce(function (best, o, i) {
          return o.people > r.options[best].people ? i : best;
        }, 0);
        var right = picked === winner;

        stage.textContent = '';

        var head = el('div', 'guess-product');
        head.appendChild(el('span', 'guess-product-label', right ? 'You got it' : 'What the evidence says'));
        head.appendChild(el('span', 'guess-product-name', r.product));
        head.appendChild(el('span', 'guess-product-price', r.price));
        stage.appendChild(head);

        var list = el('div', 'guess-options is-revealed');
        r.options.forEach(function (o, i) {
          var row = el('div', 'guess-result' + (i === winner ? ' is-winner' : '') + (i === picked ? ' is-picked' : ''));

          var top = el('div', 'guess-result-top');
          top.appendChild(el('span', 'guess-result-claim', o.claim));
          var tag = el('span', 'guess-tag', i === picked ? 'Your pick' : '');
          if (i === picked) top.appendChild(tag);
          row.appendChild(top);

          var stats = el('div', 'guess-stats');
          var people = el('span', 'guess-stat');
          people.appendChild(el('b', null, String(o.people)));
          people.appendChild(document.createTextNode(o.people === 1 ? ' customer raised it' : ' customers raised it'));
          stats.appendChild(people);
          var ads = el('span', 'guess-stat');
          ads.appendChild(el('b', null, String(o.ads)));
          ads.appendChild(document.createTextNode(o.ads === 1 ? ' competitor ad says it' : ' competitor ads say it'));
          stats.appendChild(ads);
          row.appendChild(stats);

          row.appendChild(el('p', 'guess-note', o.note));

          (o.quotes || []).forEach(function (q) {
            var card = el('div', 'ev-card');
            card.appendChild(el('blockquote', null, q.text));
            var meta = el('div', 'ev-meta');
            meta.appendChild(el('span', 'ev-src', 'r/' + q.sub));
            meta.appendChild(el('span', 'ev-score', q.score + ' points'));
            card.appendChild(meta);
            row.appendChild(card);
          });

          list.appendChild(row);
        });
        stage.appendChild(list);

        var close = el('div', 'guess-close');
        close.appendChild(el('p', 'guess-close-line', right
          ? 'You picked the one the evidence backs. Now do it for a product where you do not already know the answer.'
          : 'That is the lane most brands are already in. We read ' + r.read.comments +
            ' customer comments and ' + r.read.ads + ' competitor ads before answering.'));

        var again = el('button', 'guess-again', 'Try another product');
        again.type = 'button';
        again.addEventListener('click', function () { at += 1; draw(); });

        var go = el('a', 'btn btn-primary', 'Read my market, free');
        go.href = '/validate';

        var row2 = el('div', 'guess-close-actions');
        row2.appendChild(go);
        row2.appendChild(again);
        close.appendChild(row2);
        stage.appendChild(close);
      }
    })();

    // composer
    var linkInput = $('#composer-link');
    // Prefetch the peek the moment a full URL is in the bar, however it got
    // there. Phone keyboards' clipboard chips, "paste and go", autofill and
    // drag-in insert text WITHOUT a paste event, so listening to paste alone
    // meant the product chip never appeared for most phone users. Debounced
    // so hand-typing peeks once at the end, not per keystroke; startPeek
    // dedups repeats via its cache.
    var peekDebounce = null;
    linkInput.addEventListener('input', function () {
      state.composerLink = linkInput.value.trim();
      if (peekDebounce) clearTimeout(peekDebounce);
      var link = looksLikeUrl(state.composerLink);
      if (!link) { updateComposerProduct(); return; }
      peekDebounce = setTimeout(function () {
        startPeek(link).then(function () { updateComposerProduct(); });
      }, 350);
    });
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

    /*
     * The connected store's catalogue, if there is one.
     *
     * Strictly additive: the whole picker stays hidden unless a connection
     * exists, so nothing about the paste-a-link path changes for the people who
     * sell on Amazon, Etsy, WooCommerce or their own site. Picking a product
     * fills the same bar and runs the same peek, so everything downstream is
     * identical whether the URL was typed or chosen.
     */
    function initStorePicker() {
      var box = $('#composer-store');
      if (!box || !window.HexaAuth) return;
      var toggle = $('#composer-store-toggle');
      var grid = $('#composer-store-grid');
      var loaded = false;

      window.HexaAuth.onChange(function (user) {
        if (!user) { box.hidden = true; return; }
        window.HexaAuth.client.from('my_store_connections')
          .select('platform,store,store_name')
          .limit(1)
          .then(function (r) {
            var conn = r && !r.error && r.data && r.data[0];
            box.hidden = !conn;
            if (conn) {
              $('#composer-store-name').textContent = conn.store_name || conn.store;
            }
          });
      });

      toggle.addEventListener('click', function () {
        if (!grid.hidden) { grid.hidden = true; return; }
        grid.hidden = false;
        if (loaded) return;

        grid.textContent = '';
        var loading = document.createElement('p');
        loading.className = 'composer-store-note';
        loading.textContent = 'Reading your catalogue…';
        grid.appendChild(loading);

        fetch('/.netlify/functions/shopify-products', {
          headers: { Authorization: 'Bearer ' + window.HexaAuth.accessToken() },
        })
          .then(function (r) { return r.json().then(function (d) { return r.ok ? d : Promise.reject(d); }); })
          .then(function (d) {
            loaded = true;
            grid.textContent = '';
            var items = d.products || [];
            if (!items.length) {
              var none = document.createElement('p');
              none.className = 'composer-store-note';
              none.textContent = 'No active products found in that store.';
              grid.appendChild(none);
              return;
            }
            items.forEach(function (p) {
              var card = document.createElement('button');
              card.type = 'button';
              card.className = 'composer-store-card';
              if (p.image) {
                var img = document.createElement('img');
                img.src = p.image;
                img.alt = '';
                img.loading = 'lazy';
                card.appendChild(img);
              }
              var name = document.createElement('span');
              name.className = 'cs-name';
              name.textContent = p.title;
              card.appendChild(name);
              if (p.price) {
                var price = document.createElement('span');
                price.className = 'cs-price';
                price.textContent = p.price;
                card.appendChild(price);
              }
              card.addEventListener('click', function () {
                // Same bar, same peek, same everything downstream.
                linkInput.value = p.url;
                state.composerLink = p.url;
                grid.hidden = true;
                startPeek(p.url).then(function () { updateComposerProduct(); });
                updateComposerProduct();
              });
              grid.appendChild(card);
            });
          })
          .catch(function (d) {
            grid.textContent = '';
            var err = document.createElement('p');
            err.className = 'composer-store-note';
            err.textContent = (d && d.error) || 'Could not read your catalogue just now.';
            grid.appendChild(err);
          });
      });
    }

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
        img.hidden = false;
        wireProductImg(img, pk);
      } else {
        img.hidden = true;
      }
      $('#composer-product-name').textContent = pk.title || pk.siteName || '';
    }
    linkInput.addEventListener('input', updateComposerProduct);
    initStorePicker();

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
    // Credits lead on the pricing cards; the dollar figure sits under them in
    // small type via [data-price], filled above.
    $all('[data-price-credits]').forEach(function (n) {
      var id = n.getAttribute('data-price-credits');
      try { n.textContent = creditPrice(id); } catch (e) {}
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

    /*
     * The price range, computed rather than typed.
     *
     * The FAQ used to state "$12 to $29" in prose. Both ends were wrong (the
     * real spread is the cheapest short-form to the dearest premium spot) and
     * so was the extension price next to it, because prose does not get updated
     * when MODE_CONFIG does. Anything on this page that quotes money now reads
     * it from the same place the cards do.
     */
    $all('[data-price-lo], [data-price-hi]').forEach(function (n) {
      var all = Object.keys(MODE_CONFIG).map(function (m) { return priceInfo('mode:' + m).base; })
        .concat(Object.keys(PRODUCTS)
          .filter(function (k) { return k !== 'auto' && k !== 'soul'; })
          .map(function (k) { return priceInfo(k).base; }));
      var lo = Math.min.apply(null, all);
      var hi = Math.max.apply(null, all);
      n.textContent = '$' + (n.hasAttribute('data-price-lo') ? lo : hi);
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

    var payCard = $('#config-pay-card');
    if (payCard) {
      payCard.addEventListener('click', function () {
        state.payWith = 'card';
        submitOrder();
      });
    }

    /*
     * The balance decides which button the review step shows, so it is fetched
     * on load and again whenever the session changes. onChange fires once the
     * session is known and on every sign-in or sign-out, which covers the case
     * that matters: someone who signs in from the gate and comes back to an
     * order they already built.
     */
    if (window.HexaAuth) window.HexaAuth.onChange(function () { loadCreditBalance(); });

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

    /*
     * Arriving from a research report.
     *
     * /validate writes the chosen angle to localStorage and sends the visitor
     * here. This is the seam the whole product hangs on: the research is only
     * worth anything if the thing it proved is what actually gets made, so the
     * angle arrives with its link, its format and its hook, and the creative
     * direction is filled in with the line the evidence supports rather than
     * left blank for the customer to re-derive.
     *
     * Read once and deleted immediately: it is a handoff, not a setting, and a
     * stale angle silently steering a later unrelated order would be worse than
     * no bridge at all.
     */
    var handoff = null;
    try {
      handoff = JSON.parse(localStorage.getItem(ANGLE_KEY) || 'null');
      localStorage.removeItem(ANGLE_KEY);
    } catch (e) { handoff = null; }

    if (handoff && handoff.v === 1 && Date.now() - (handoff.ts || 0) < ANGLE_TTL_MS) {
      var angleLink = looksLikeUrl(handoff.url || '');
      var angleProduct = handoff.product === 'adpack' ? 'adpack' : 'mode:ugc';

      // The hook is what a video says out loud; the headline is what a static
      // ad puts on the image. Sending the wrong one is how a proven angle turns
      // into a generic ad.
      var direction = angleProduct === 'adpack'
        ? (handoff.headline || handoff.claim || '')
        : (handoff.hook || handoff.claim || '');
      if (direction && handoff.persona) direction += '\nWho it is for: ' + handoff.persona;
      // Held on state so it survives whichever goal they pick next, instead of
      // only reaching the single product this handoff happened to name.
      state.angleBrief = direction || '';

      /*
       * The research decided what to say. How to make it is still a question,
       * and the goal grid is where it gets asked, with "let Hexa choose" the
       * default. Jumping straight into one product was us answering it on the
       * merchant's behalf twice in a row.
       */
      var openWithAngle = function () {
        openChooser(angleLink ? peekFor(angleLink) : null);
      };

      if (angleLink) {
        state.composerLink = angleLink;
        linkInput.value = angleLink;
        updateComposerProduct();
        // Peeked first so the drawer opens with the product identity already
        // attached, exactly as it would had the link been pasted by hand.
        // Both handlers on the same .then, so the drawer opens exactly once
        // whether the peek lands or falls over.
        startPeek(angleLink)
          .then(function () { updateComposerProduct(); })
          .then(openWithAngle, openWithAngle);
      } else {
        openWithAngle();
      }
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

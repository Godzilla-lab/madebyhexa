/* ═════ "Watch your product come alive" · homepage guided quiz ═════
 * A 4-step, one-question-per-screen flow. Each answer is a real render
 * parameter; the payoff is the customer's own product in the grounded config.
 * Reuses the studio's peek (window.hexaPeek/hexaPeekData) and hands off via
 * window.hexaQuizHandoff. Signup is only required later, at the render/pay gate.
 */
(function () {
  'use strict';

  var CATEGORIES = [
    { id: 'apparel', emoji: '👕', label: 'Apparel' },
    { id: 'beauty', emoji: '💄', label: 'Beauty' },
    { id: 'food', emoji: '🥤', label: 'Food & drink' },
    { id: 'tech', emoji: '📱', label: 'Tech' },
    { id: 'jewelry', emoji: '💍', label: 'Jewelry' },
    { id: 'home', emoji: '🛋️', label: 'Home & decor' },
    { id: 'other', emoji: '✨', label: 'Something else' },
  ];
  var VIBES = [
    { id: 'cinematic', name: 'Cinematic', clip: 'assets/hf/hooks/camera_bump.mp4' },
    { id: 'studio', name: 'Clean studio', clip: 'assets/hf/hooks/product_hit.mp4' },
    { id: 'lifestyle', name: 'Lifestyle', clip: 'assets/hf/hooks/interview.mp4' },
    { id: 'bold', name: 'Bold & punchy', clip: 'assets/hf/hooks/spicy.mp4' },
  ];
  var FORMATS = [
    { id: 'video', emoji: '🎬', label: 'Video' },
    { id: 'photoshoot', emoji: '📸', label: 'Photoshoot' },
    { id: 'both', emoji: '✨', label: 'Both' },
  ];
  var FILL = ['25%', '50%', '75%', '95%'];
  var SAMPLE = 'https://www.allbirds.com/products/mens-wool-runner-go';

  var answers = { category: null, link: null, vibe: null, format: null };
  var stepIdx = 0;
  var root = null;

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function normalizeUrl(v) {
    v = (v || '').trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/[a-z0-9-]+\.[a-z]{2,}/i.test(v)) return 'https://' + v;
    return null;
  }
  function doPeek(link) {
    if (window.hexaPeek && window.hexaPeekData) {
      return window.hexaPeek(link).then(function () { return window.hexaPeekData(link); }, function () { return null; });
    }
    return fetch('/.netlify/functions/product-peek?url=' + encodeURIComponent(link))
      .then(function (r) { return r.json(); }).catch(function () { return null; });
  }

  // For sites that block our direct fetch, Higgsfield scrapes the product in the
  // background. Poll until its re-hosted image is ready, then fill it in.
  function pollWebProduct(id, onUpdate) {
    var tries = 0;
    (function tick() {
      if (tries++ >= 12) return;
      fetch('/.netlify/functions/product-peek?webProduct=' + encodeURIComponent(id))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.image) { onUpdate(res); return; }
          if (res && res.ready) return; // finished without an image
          setTimeout(tick, 2500);
        })
        .catch(function () { setTimeout(tick, 3000); });
    })();
  }

  function build() {
    root = document.createElement('div');
    root.className = 'quiz-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Watch your product come alive');
    root.innerHTML =
      '<div class="quiz-progress"><div class="quiz-progress-fill" id="quiz-fill"></div></div>' +
      '<div class="quiz-top">' +
        '<a class="brand" href="/"><img src="assets/brand/hexa-logo.avif" alt="" width="26" height="26" /><span>Hexa<span class="brand-dot">·</span>AI</span></a>' +
        '<button class="quiz-close" id="quiz-close" type="button" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="quiz-body"><div class="quiz-step" id="quiz-step"></div></div>';
    document.body.appendChild(root);
    root.querySelector('#quiz-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && root.classList.contains('is-open')) close(); });
  }

  function setStepHtml(html) {
    var step = root.querySelector('#quiz-step');
    step.innerHTML = html;
    // re-trigger the entry animation
    step.style.animation = 'none'; void step.offsetWidth; step.style.animation = '';
    root.querySelector('#quiz-fill').style.width = FILL[stepIdx] || '100%';
    root.querySelector('.quiz-body').scrollTop = 0;
    return step;
  }

  function renderCategory() {
    var tiles = CATEGORIES.map(function (c) {
      return '<button class="quiz-tile" type="button" data-id="' + c.id + '"><span class="emoji">' + c.emoji + '</span>' + c.label + '</button>';
    }).join('');
    var step = setStepHtml(
      '<p class="quiz-count">Step 1 of 4</p>' +
      '<h2 class="quiz-q">What are you selling?</h2>' +
      '<p class="quiz-sub">So we set the scene right for your product.</p>' +
      '<div class="quiz-tiles cols-3">' + tiles + '</div>');
    step.querySelectorAll('.quiz-tile').forEach(function (b) {
      b.addEventListener('click', function () { answers.category = b.getAttribute('data-id'); next(); });
    });
  }

  function renderLink() {
    var step = setStepHtml(
      '<p class="quiz-count">Step 2 of 4</p>' +
      '<h2 class="quiz-q">Paste your link and watch</h2>' +
      '<p class="quiz-sub">We read your page and pull your product in, right now.</p>' +
      '<div class="quiz-linkrow"><input id="quiz-url" type="url" placeholder="Paste a Shopify, Amazon or any product link" autocomplete="off" spellcheck="false" /><button id="quiz-watch" type="button">Watch it</button></div>' +
      '<p class="quiz-sample">No link handy? <button id="quiz-sample-btn" type="button">Use a sample</button></p>' +
      '<div class="quiz-peek" id="quiz-peek"><img id="quiz-peek-img" alt="" hidden /><div><p class="pk-eyebrow" id="quiz-peek-eyebrow">Found your product</p><p class="pk-title" id="quiz-peek-title"></p><p class="pk-host" id="quiz-peek-host"></p></div></div>' +
      '<button class="quiz-continue" id="quiz-continue" type="button" style="display:none">Continue</button>');

    var url = step.querySelector('#quiz-url');
    var watch = step.querySelector('#quiz-watch');
    var peek = step.querySelector('#quiz-peek');
    var cont = step.querySelector('#quiz-continue');

    function showPeek(pk, link) {
      answers.link = link;
      var img = step.querySelector('#quiz-peek-img');
      var eyebrow = step.querySelector('#quiz-peek-eyebrow');
      var title = step.querySelector('#quiz-peek-title');
      var host = step.querySelector('#quiz-peek-host');
      var hasData = pk && (pk.image || pk.title);
      eyebrow.textContent = hasData ? 'Found your product' : 'Got your link';
      title.textContent = (pk && pk.title) || 'Ready to bring it to life';
      try { host.textContent = new URL(link).hostname.replace(/^www\./, ''); } catch (e) { host.textContent = ''; }
      if (pk && pk.image) { img.src = pk.image; img.hidden = false; img.onerror = function () { img.hidden = true; }; answers.productImage = pk.image; }
      else {
        img.hidden = true;
        var wpId = pk && pk.webProductId;
        if (wpId) {
          if (!hasData) eyebrow.textContent = 'Reading your product…';
          pollWebProduct(wpId, function (res) {
            if (res.image) {
              img.src = res.image; img.hidden = false; img.onerror = function () { img.hidden = true; };
              answers.productImage = res.image;
              eyebrow.textContent = 'Found your product';
            }
            if (res.title && !(pk && pk.title)) { title.textContent = res.title; }
          });
        }
      }
      peek.classList.add('show');
      cont.style.display = '';
      cont.focus();
    }

    function run() {
      var link = normalizeUrl(url.value);
      if (!link) { url.focus(); url.style.borderColor = 'var(--accent)'; return; }
      watch.disabled = true; watch.textContent = 'Reading…';
      doPeek(link).then(function (pk) {
        watch.disabled = false; watch.textContent = 'Watch it';
        showPeek(pk, link);
      });
    }
    watch.addEventListener('click', run);
    url.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    step.querySelector('#quiz-sample-btn').addEventListener('click', function () { url.value = SAMPLE; run(); });
    cont.addEventListener('click', next);
    setTimeout(function () { url.focus(); }, 60);
  }

  function renderVibe() {
    var tiles = VIBES.map(function (v) {
      return '<button class="quiz-vibe" type="button" data-id="' + v.id + '">' +
        '<video src="' + v.clip + '" muted loop playsinline autoplay preload="metadata"></video>' +
        '<span class="shade"></span><span class="name">' + esc(v.name) + '</span></button>';
    }).join('');
    var step = setStepHtml(
      '<p class="quiz-count">Step 3 of 4</p>' +
      '<h2 class="quiz-q">Pick the vibe</h2>' +
      '<p class="quiz-sub">This sets the look and the camera. Tap one.</p>' +
      '<div class="quiz-vibes">' + tiles + '</div>');
    step.querySelectorAll('.quiz-vibe').forEach(function (b) {
      var v = b.querySelector('video'); if (v) v.play().catch(function () {});
      b.addEventListener('click', function () { answers.vibe = b.getAttribute('data-id'); next(); });
    });
  }

  function renderFormat() {
    var tiles = FORMATS.map(function (f) {
      return '<button class="quiz-tile" type="button" data-id="' + f.id + '"><span class="emoji">' + f.emoji + '</span>' + f.label + '</button>';
    }).join('');
    var step = setStepHtml(
      '<p class="quiz-count">Step 4 of 4</p>' +
      '<h2 class="quiz-q">Video or photoshoot?</h2>' +
      '<p class="quiz-sub">Pick one to start. You can make the other next.</p>' +
      '<div class="quiz-tiles cols-3">' + tiles + '</div>');
    step.querySelectorAll('.quiz-tile').forEach(function (b) {
      b.addEventListener('click', function () { answers.format = b.getAttribute('data-id'); finish(); });
    });
  }

  function finish() {
    root.querySelector('#quiz-fill').style.width = '100%';
    var prod = 'your product';
    if (window.hexaPeekData && answers.link) {
      var pk = window.hexaPeekData(answers.link);
      if (pk && pk.title) prod = pk.title;
    }
    setStepHtml(
      '<div class="quiz-gen"><div class="quiz-gen-ring"></div>' +
      '<h2 class="quiz-q">Bringing ' + esc(prod) + ' to life…</h2>' +
      '<p class="quiz-sub">Setting the light, the motion and the storyboard.</p></div>');
    setTimeout(function () {
      close();
      if (window.hexaQuizHandoff) window.hexaQuizHandoff(answers);
      else fallbackHandoff();
    }, 1700);
  }

  function fallbackHandoff() {
    var inp = document.getElementById('composer-link');
    if (inp && answers.link) {
      inp.value = answers.link;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      var go = document.getElementById('composer-go');
      if (go) go.click();
    }
  }

  var RENDERERS = [renderCategory, renderLink, renderVibe, renderFormat];
  function renderStep() { RENDERERS[stepIdx](); }
  function next() { if (stepIdx < RENDERERS.length - 1) { stepIdx++; renderStep(); } }

  function open() {
    if (!root) build();
    answers = { category: null, link: null, vibe: null, format: null };
    stepIdx = 0;
    renderStep();
    root.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    if (window.hexaTrack) window.hexaTrack('quiz-open', 'homepage', '');
  }
  function close() {
    if (!root) return;
    root.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  window.hexaOpenQuiz = open;
  function wireTriggers() {
    document.querySelectorAll('[data-quiz-open]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); open(); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireTriggers);
  else wireTriggers();
})();

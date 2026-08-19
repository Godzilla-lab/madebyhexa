(function () {
  'use strict';

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const gallery = document.getElementById('gallery');
  const emptyMsg = document.getElementById('gallery-empty');

  const isTouch = matchMedia('(hover: none)').matches;
  const saveData = (navigator.connection && navigator.connection.saveData) === true;

  // ── Results section: count-up + SVG draw-in ────────────────
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function formatCount(value, format) {
    if (format === 'comma') return value.toLocaleString('en-US');
    return String(value);
  }

  function countUp(el) {
    const target = parseInt(el.dataset.count, 10);
    const format = el.dataset.format;
    if (isNaN(target)) return;
    if (reduceMotion) { el.textContent = formatCount(target, format); return; }
    const duration = 1400;
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      el.textContent = formatCount(Math.round(target * eased), format);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = formatCount(target, format);
    }
    requestAnimationFrame(tick);
  }

  const resultsSection = document.getElementById('results');
  if (resultsSection) {
    // Screenshot slots: mark empty so the labelled placeholder shows
    // cleanly until Chris drops the real (anonymized) screenshots in.
    resultsSection.querySelectorAll('.case-shot img').forEach((img) => {
      const fig = img.closest('.case-shot');
      img.addEventListener('error', () => fig && fig.classList.add('is-empty'));
      if (img.complete && img.naturalWidth === 0 && fig) fig.classList.add('is-empty');
    });

    let played = false;
    const fire = () => {
      if (played) return;
      played = true;
      resultsSection.querySelectorAll('.count').forEach(countUp);
    };
    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { fire(); obs.disconnect(); } });
      }, { threshold: 0.3 });
      obs.observe(resultsSection);
    } else {
      fire();
    }
  }

  // ── Lightbox ────────────────────────────────────────────────
  const lb = document.getElementById('lightbox');
  const lbVideo = document.getElementById('lightbox-video');
  const lbLabel = document.getElementById('lightbox-label');
  const lbClose = lb ? lb.querySelector('.lightbox-close') : null;

  let lbImage = null;
  function ensureLightboxImage() {
    if (lbImage || !lb) return lbImage;
    const stage = lb.querySelector('.lightbox-stage');
    if (!stage) return null;
    lbImage = document.createElement('img');
    lbImage.id = 'lightbox-image';
    lbImage.alt = '';
    lbImage.hidden = true;
    stage.appendChild(lbImage);
    return lbImage;
  }

  function openLightbox(url, category, type) {
    if (!lb || !lbVideo) return;
    lbLabel.textContent = category || 'Showreel';
    const isImage = type === 'image';
    ensureLightboxImage();
    if (isImage) {
      lbVideo.pause();
      lbVideo.removeAttribute('src');
      lbVideo.hidden = true;
      if (lbImage) { lbImage.src = url; lbImage.hidden = false; }
    } else {
      if (lbImage) { lbImage.removeAttribute('src'); lbImage.hidden = true; }
      lbVideo.hidden = false;
      lbVideo.src = url;
      lbVideo.currentTime = 0;
    }
    if (typeof lb.showModal === 'function') {
      lb.showModal();
    } else {
      lb.setAttribute('open', '');
    }
    document.body.classList.add('lb-open');
    if (!isImage) {
      const p = lbVideo.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  function closeLightbox() {
    if (!lb || !lbVideo) return;
    lbVideo.pause();
    lbVideo.removeAttribute('src');
    lbVideo.load();
    if (lbImage) { lbImage.removeAttribute('src'); lbImage.hidden = true; }
    if (typeof lb.close === 'function' && lb.open) {
      lb.close();
    } else {
      lb.removeAttribute('open');
    }
    document.body.classList.remove('lb-open');
  }

  if (lb) {
    if (lbClose) lbClose.addEventListener('click', closeLightbox);
    lb.addEventListener('click', (e) => {
      // Click outside the .lightbox-stage closes
      const stage = lb.querySelector('.lightbox-stage');
      const meta = lb.querySelector('.lightbox-meta');
      if (e.target === lb || (stage && !stage.contains(e.target) && (!meta || !meta.contains(e.target)) && e.target !== lbClose)) {
        closeLightbox();
      }
    });
    lb.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lb.open) closeLightbox();
    });
  }

  // ── Gallery ──────────────────────────────────────────────────
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Append #t=0.1 so the browser seeks to the first frame and renders it
  // as a poster without downloading the full video.
  function posterUrl(url) {
    return url + (url.indexOf('#') === -1 ? '#t=0.1' : '');
  }

  function makeTile(item, index, allItems) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    const isImage = item.type === 'image';
    if (isImage) tile.classList.add('tile-image');
    tile.style.transitionDelay = Math.min(index * 35, 500) + 'ms';
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', 'View ' + (item.category || 'item'));

    let video = null;
    let imgEl = null;
    if (isImage || item.thumb) {
      // A local poster paints the grid instantly; the video only exists
      // once the tile is hovered or opened.
      imgEl = document.createElement('img');
      imgEl.className = 'tile-poster';
      imgEl.alt = item.category || '';
      imgEl.loading = 'lazy';
      imgEl.decoding = 'async';
      imgEl.dataset.src = isImage ? item.url : item.thumb;
    } else {
      video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('disableremoteplayback', '');
      video.preload = 'none';
      video.dataset.src = posterUrl(item.url);
      video.dataset.fullSrc = item.url;
    }

    // Hover preview on poster tiles mounts its video on first use.
    function mountHoverVideo() {
      if (video || isImage) return video;
      video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.preload = 'auto';
      video.src = item.url;
      video.className = 'tile-hover-video';
      tile.insertBefore(video, tile.firstChild.nextSibling);
      video.addEventListener('playing', () => tile.classList.add('tile-live'));
      return video;
    }

    const shade = document.createElement('div');
    shade.className = 'tile-shade';

    tile.appendChild(imgEl || video);
    tile.appendChild(shade);

    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = item.category || 'Showreel';

    const play = document.createElement('span');
    play.className = 'tile-play';
    play.setAttribute('aria-hidden', 'true');
    play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

    tile.appendChild(label);
    tile.appendChild(play);

    let stage = 0; // 0 none, 1 metadata, 2 auto
    let revealed = true;

    function loadPoster() {
      if (imgEl) {
        if (!imgEl.src) imgEl.src = imgEl.dataset.src;
        return;
      }
      if (isImage || stage >= 1) return;
      stage = 1;
      video.preload = 'metadata';
      if (!video.src) video.src = video.dataset.src;
    }
    function loadFull() {
      if (isImage) return;
      loadPoster();
      if (imgEl) return; // poster tiles fetch video on hover/open only
      if (stage >= 2) return;
      stage = 2;
      video.preload = 'auto';
    }
    function reveal() {
      if (revealed) return;
      revealed = true;
      tile.classList.add('revealed');
      tile.setAttribute('aria-label', (isImage ? 'View ' : 'Play ') + (item.category || 'item'));
      loadFull();
    }

    function openFromTile() {
      if (!revealed) {
        reveal();
        return;
      }
      // The examples viewer plays the whole reel with sound; the plain
      // lightbox is the fallback when studio.js isn't on the page.
      if (window.hexaViewer && allItems) {
        window.hexaViewer.open({
          kicker: 'From the reel',
          title: item.category || 'Showreel',
          items: allItems.map((v) => (v.type === 'image'
            ? { image: v.url, thumb: v.thumb, label: v.category }
            : { video: v.url, thumb: v.thumb, label: v.category })),
          start: index,
          cta: window.hexaCreateAuto
            ? { label: 'Make one like this', run: window.hexaCreateAuto }
            : null,
        });
        return;
      }
      openLightbox(item.url, item.category, item.type);
    }

    if (!isTouch && !isImage) {
      tile.addEventListener('mouseenter', () => {
        if (!revealed) return; // no preview-play until revealed
        const v = imgEl ? mountHoverVideo() : (loadFull(), video);
        if (!v) return;
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      });
      tile.addEventListener('mouseleave', () => {
        if (!revealed || !video) return;
        video.pause();
        try { video.currentTime = 0.1; } catch (_) {}
      });
    }
    tile.addEventListener('click', openFromTile);
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFromTile();
      }
    });

    return { el: tile, video: video, loadPoster: loadPoster, loadFull: loadFull };
  }

  function render(items) {
    gallery.innerHTML = '';
    const tiles = items.map((item, i) => makeTile(item, i, items));
    const frag = document.createDocumentFragment();
    tiles.forEach(t => frag.appendChild(t.el));
    gallery.appendChild(frag);
    gallery.setAttribute('aria-busy', 'false');

    // 35 tiles is eighteen phone screens or seven desktop rows: nobody needs
    // the whole reel up front. Show the first rows, put the rest behind one
    // honest button. Tiles stay in the DOM (hidden, posters unloaded) so the
    // lightbox still walks the full reel.
    if (items.length > 12) {
      gallery.classList.add('gallery-capped');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'gallery-more';
      more.textContent = 'Show all ' + items.length + ' clips';
      gallery.insertAdjacentElement('afterend', more);
      more.addEventListener('click', () => {
        gallery.classList.remove('gallery-capped');
        more.remove();
      });
    }

    const eagerCount = saveData ? 4 : 8;
    tiles.slice(0, eagerCount).forEach(t => t.loadPoster());

    if (!('IntersectionObserver' in window)) {
      tiles.forEach(t => { t.el.classList.add('in'); t.loadPoster(); });
      return;
    }

    const fadeObs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          fadeObs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

    const posterObs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const idx = tiles.findIndex(t => t.el === entry.target);
          if (idx !== -1) tiles[idx].loadPoster();
          posterObs.unobserve(entry.target);
        }
      });
    }, { rootMargin: saveData ? '200px 0px' : '800px 0px' });

    tiles.forEach(t => {
      fadeObs.observe(t.el);
      posterObs.observe(t.el);
    });
  }

  // Defensive: the public reel never shows mature content (X-Mode removed).
  function withoutNsfw(items) {
    return items.filter(v => v.nsfw !== true);
  }

  if (gallery) {
    const feed = document.body.dataset.feed === 'eco' ? 'videos-eco.json' : 'videos.json';
    fetch(feed + '?v=' + Date.now(), { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(data => {
        if (!Array.isArray(data) || data.length === 0) throw new Error('Empty data');
        const filtered = withoutNsfw(data);
        if (filtered.length === 0) {
          gallery.setAttribute('aria-busy', 'false');
          if (emptyMsg) {
            emptyMsg.hidden = false;
            emptyMsg.textContent = "Couldn't load the reel. Refresh to try again.";
          }
          return;
        }
        render(shuffle(filtered));
      })
      .catch(err => {
        console.error('Gallery load failed:', err);
        gallery.setAttribute('aria-busy', 'false');
        if (emptyMsg) emptyMsg.hidden = false;
      });
  }

  // Hero side panels are pre-rendered grid montages (assets/hero/grid-*.mp4).
  // Nudge them to play: some browsers (and iOS Safari) ignore the autoplay
  // attribute until play() is called explicitly on a muted, inline video.
  document.querySelectorAll('.hero-montage').forEach((v) => {
    v.muted = true;
    const tryPlay = () => {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    tryPlay();
    v.addEventListener('loadeddata', tryPlay, { once: true });
    v.addEventListener('canplay', tryPlay, { once: true });
  });

  // ── Pricing checkout (Stripe via Netlify function) ──────────
  // Delegated from document so cloned cards in the pricing marquee work too.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-checkout]');
    if (!btn) return;
    const tier = btn.dataset.checkout;
    if (!tier || btn.dataset.loading === '1') return;
    const base = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const atcId = 'atc_' + base;
    const icId = 'ic_' + base;
    if (window.hexaTrackAddToCart) window.hexaTrackAddToCart(tier, atcId);
    if (window.hexaServerEvent) window.hexaServerEvent('AddToCart', { tier: tier, event_id: atcId });
    if (window.hexaTrackInitiateCheckout) window.hexaTrackInitiateCheckout(tier, icId);
    if (window.hexaServerEvent) window.hexaServerEvent('InitiateCheckout', { tier: tier, event_id: icId });
    const original = btn.textContent;
    btn.dataset.loading = '1';
    btn.disabled = true;
    btn.textContent = 'Starting checkout...';
    try {
      const res = await fetch('/.netlify/functions/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: tier }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      throw new Error(data.error || 'Checkout unavailable');
    } catch (err) {
      console.error('Checkout failed:', err);
      btn.textContent = original;
      btn.disabled = false;
      btn.dataset.loading = '';
      alert("We couldn't start checkout right now. Please try again, or book a call and we'll sort it out.");
    }
  });

  // ── Order intake prefill (after Stripe redirect) ────────────
  const intakeForm = document.querySelector('form[name="order-intake"]');
  if (intakeForm) {
    const params = new URLSearchParams(window.location.search);
    const tier = (params.get('tier') || '').toLowerCase();
    const session = params.get('session_id') || '';
    const tierField = document.getElementById('lf-tier');
    const sessionField = document.getElementById('lf-session');
    if (tierField) tierField.value = tier;
    if (sessionField) sessionField.value = session;
    const labels = { single: '1 finished video', triple: '3 videos (split-test pack)' };
    const tierLabelEl = document.getElementById('order-tier');
    if (tierLabelEl && labels[tier]) tierLabelEl.textContent = 'confirmed: ' + labels[tier];

    // Require at least a product link OR an uploaded file so we always
    // have something to work from.
    intakeForm.addEventListener('submit', (e) => {
      const linkEl = document.getElementById('lf-link');
      const fileEl = document.getElementById('lf-asset');
      const hasLink = linkEl && linkEl.value.trim() !== '';
      const hasFile = fileEl && fileEl.files && fileEl.files.length > 0;
      if (!hasLink && !hasFile) {
        e.preventDefault();
        alert('Please add a product link or upload a photo or PDF so we know what to film.');
      }
    });
  }

  // ── URL field helper: accept bare domains ──────────────────
  // <input type="url"> requires a scheme, so "brand.com" is rejected with
  // "Please enter a URL". Most people type a bare domain, so prepend https://
  // before native validation runs (on blur, and on Enter before submit).
  const normalizeUrlField = (input) => {
    const v = input.value.trim();
    if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      input.value = 'https://' + v;
    }
  };
  document.querySelectorAll('input[type="url"]').forEach((input) => {
    input.addEventListener('blur', () => normalizeUrlField(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') normalizeUrlField(input);
    });
  });

  // ── Free-sample soft guard (one request per browser) ────────
  // Remember a completed free-sample request in this browser and, on return
  // visits, swap the form for an "already requested" card that points to the
  // paid packs. Soft guard only: a determined user can clear storage, use
  // another browser, or a new email. Real fulfillment is gated manually and
  // deduped by email server-side in auto-reply.js.
  const sampleForm = document.querySelector('form[name="free-sample"]');
  if (sampleForm) {
    const SAMPLE_KEY = 'hexa-sample-claimed';
    // The synchronous localStorage write completes before the form's normal
    // POST navigates away to /thanks.html, so no preventDefault is needed.
    sampleForm.addEventListener('submit', () => {
      try { localStorage.setItem(SAMPLE_KEY, String(Date.now())); } catch (_) {}
    });
    let claimed = false;
    try { claimed = !!localStorage.getItem(SAMPLE_KEY); } catch (_) {}
    if (claimed) {
      const card = document.createElement('div');
      card.className = 'lead-claimed';
      card.innerHTML =
        '<h3>You have already asked for a read</h3>' +
        '<p>It is saved. Open it any time, and if you want the ad made from it, sign in and the ' +
        'first one is free.</p>' +
        '<a class="btn btn-primary btn-lg" href="#pricing">See the packs</a>';
      sampleForm.replaceWith(card);
    }
  }

  // Capture the lead email client-side (synchronously, before the form's POST
  // navigates away to the thank-you page) so that page can hash it for TikTok
  // Advanced Matching (ttq.identify) before firing the Lead event. Covers both
  // the main and eco free-sample forms.
  document.querySelectorAll('form[name="free-sample"], form[name="free-sample-eco"]').forEach(function (form) {
    form.addEventListener('submit', function () {
      try {
        var em = form.querySelector('input[type="email"]');
        if (em && em.value) sessionStorage.setItem('hexa_lead_em', em.value.trim().toLowerCase());
      } catch (_) {}
    });
  });

  // ── Reviews strip (rendered from reviews.json, grows over time) ──
  const reviewStrip = document.getElementById('review-strip');
  if (reviewStrip) {
    const STAR = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 7.1-1.01L12 2z"/></svg>';

    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    function initials(name) {
      const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return '★';
      return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    }
    function starRow(n) {
      const count = Math.max(0, Math.min(5, parseInt(n, 10) || 5));
      return '<span class="review-stars" aria-label="' + count + ' out of 5">' + STAR.repeat(count) + '</span>';
    }
    function reviewCard(r) {
      const card = document.createElement('article');
      card.className = 'review-card';
      const avatar = r.avatar
        ? '<img class="review-avatar" src="' + esc(r.avatar) + '" alt="" loading="lazy" decoding="async" />'
        : '<span class="review-avatar" aria-hidden="true">' + esc(initials(r.name)) + '</span>';
      const verified = r.verified ? '<span class="review-verified" title="Verified by Hexa AI">✓</span>' : '';
      card.innerHTML =
        '<div class="review-head">' + avatar +
          '<span class="review-meta">' +
            '<span class="review-name">' + esc(r.name || 'Hexa AI client') + verified + '</span>' +
            '<span class="review-role">' + esc(r.role || '') + '</span>' +
          '</span>' +
        '</div>' +
        starRow(r.stars) +
        '<p class="review-quote">' + esc(r.quote || '') + '</p>';
      return card;
    }
    function inviteCard() {
      const card = document.createElement('article');
      card.className = 'review-card review-cta';
      card.innerHTML =
        '<h3>Your brand here</h3>' +
        '<p>Make your first video from $12 and see your product as hyper-real video. If you love it, your review could be next.</p>' +
        '<a href="#composer">Start with your link</a>';
      return card;
    }
    // Real anchor testimonial, used if reviews.json is unavailable.
    const FALLBACK = [{
      name: 'Confidential creator',
      role: 'Creator client, 881K followers',
      quote: 'I handed Hexa AI my content and stopped thinking about it. 881K followers and 10M views in 30 days, no shoots, no studio.',
      stars: 5,
      verified: true,
    }];
    function renderReviews(list) {
      reviewStrip.innerHTML = '';
      // Unique cards: the real reviews plus one invite card.
      const unique = list.map(reviewCard);
      unique.push(inviteCard());
      // Phones swipe through the real cards; the endless marquee is a desktop
      // gesture (on a small screen it just looks like a card cut in half).
      if (window.matchMedia('(max-width: 720px)').matches) {
        const marquee = reviewStrip.closest('.review-marquee');
        if (marquee) marquee.classList.add('review-swipe');
        const frag = document.createDocumentFragment();
        unique.forEach((n) => frag.appendChild(n));
        reviewStrip.appendChild(frag);
        reviewStrip.setAttribute('aria-busy', 'false');
        return;
      }
      // Build a segment wide enough to fill the viewport, then duplicate it so
      // the horizontal scroll loops seamlessly (the keyframe shifts by -50%,
      // i.e. exactly one segment).
      const minCards = Math.max(8, unique.length);
      const segment = [];
      for (let k = 0; segment.length < minCards; k++) {
        segment.push(unique[k % unique.length].cloneNode(true));
      }
      const frag = document.createDocumentFragment();
      segment.forEach((n) => frag.appendChild(n));
      segment.forEach((n) => {
        const dup = n.cloneNode(true);
        dup.setAttribute('aria-hidden', 'true');
        frag.appendChild(dup);
      });
      reviewStrip.appendChild(frag);
      reviewStrip.setAttribute('aria-busy', 'false');
      // Keep a constant scroll speed (~60px/s) no matter how many reviews exist.
      if (!reduceMotion) {
        const half = reviewStrip.scrollWidth / 2;
        if (half > 0) reviewStrip.style.animationDuration = Math.round(half / 60) + 's';
      }
    }
    fetch('reviews.json?v=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((data) => renderReviews(Array.isArray(data) && data.length ? data : FALLBACK))
      .catch(() => renderReviews(FALLBACK));
  }

  // ── Top promo bar (dismissible, remembers choice) ───────────
  const promoBar = document.getElementById('promo-bar');
  if (promoBar) {
    const PROMO_KEY = 'hexa-promo-dismissed';
    let dismissed = false;
    try { dismissed = localStorage.getItem(PROMO_KEY) === '1'; } catch (_) {}
    if (dismissed) promoBar.classList.add('is-hidden');
    const close = promoBar.querySelector('.promo-bar-close');
    if (close) close.addEventListener('click', () => {
      promoBar.classList.add('is-hidden');
      try { localStorage.setItem(PROMO_KEY, '1'); } catch (_) {}
    });
  }

  // ── Floating CTA: hovers in past the hero, hides over pricing ──
  const floatCta = document.getElementById('float-cta');
  if (floatCta) {
    let ctaDismissed = false;
    // Hide the floating CTA when a destination section is on screen, so it
    // never overlaps the free-sample form or the pricing buttons.
    const hideSecs = ['claim', 'pricing', 'composer'].map((id) => document.getElementById(id))
      .concat([document.querySelector('.c-closer'), document.querySelector('footer.footer')])
      .filter(Boolean);
    function updateFloat() {
      if (ctaDismissed) { floatCta.classList.remove('show'); return; }
      const pastHero = window.scrollY > window.innerHeight * 0.7;
      const overTarget = hideSecs.some((sec) => {
        const r = sec.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      });
      floatCta.classList.toggle('show', pastHero && !overTarget);
    }
    window.addEventListener('scroll', updateFloat, { passive: true });
    window.addEventListener('resize', updateFloat);
    updateFloat();
    const ctaClose = floatCta.querySelector('.float-cta-close');
    if (ctaClose) ctaClose.addEventListener('click', (e) => {
      e.preventDefault();
      ctaDismissed = true;
      floatCta.classList.remove('show');
    });
  }

  // ── Reveal choreography (homepage cinematic system) ──
  // Elements opt in via data-reveal; optional data-reveal-delay staggers
  // children. One IO for the whole page; unobserves after first entry.
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (revealEls.length && 'IntersectionObserver' in window && !reduceMotion) {
    /*
     * Anything already on screen when the script runs is shown AT ONCE, with no
     * transition and no stagger. Staggering the first screen is what makes a
     * page look like it is loading in pieces: the delays are read as slowness,
     * not as polish, and they stack on top of however long the six scripts took
     * to arrive. Choreography is for content the reader scrolls to, where the
     * motion is a reward rather than a wait.
     */
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const pending = [];
    revealEls.forEach((n) => {
      if (n.getBoundingClientRect().top < vh) {
        n.classList.add('is-instant', 'in');
      } else {
        pending.push(n);
      }
    });

    if (pending.length) {
      const ro = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          ro.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
      pending.forEach((n) => {
        if (n.dataset.revealDelay) n.style.setProperty('--d', n.dataset.revealDelay + 'ms');
        ro.observe(n);
      });
    }
  } else {
    revealEls.forEach((n) => n.classList.add('in'));
  }

  // ── Hero theatre: a fan of rendered variants, one of them playing ──
  //
  // Replaced the single hero monitor. The monitor could argue one thing at a
  // time; the fan shows that a single read produces several different ads,
  // which is the actual product. Only the card in front streams: five videos
  // in a hero is a bandwidth bill, not a design, and the site has already been
  // suspended once for shipping heavy media.
  const theatre = document.getElementById('theatre');
  if (theatre) {
    const cards = [...theatre.querySelectorAll('.adcard')];
    const N = cards.length;
    // The middle card leads, so the fan is symmetrical on first paint.
    let active = Math.floor(N / 2);
    let visible = true;

    const two = (n) => String(n).padStart(2, '0');
    const fmt = (t) => '00:' + two(Math.floor(t % 60)) + '.' + Math.floor((t % 1) * 10);

    // How far apart the cards sit, as a percentage of a card's width. A phone
    // is barely wider than one card, so the desktop spread throws both
    // neighbours off the screen and the fan reads as a single card with two
    // slivers. Narrow screens overlap the cards more instead.
    const spread = () => (window.innerWidth < 660 ? 52 : window.innerWidth < 980 ? 62 : 70);

    function layout() {
      const gap = spread();
      cards.forEach((card, i) => {
        const off = offsetOf(i);
        const abs = Math.abs(off);
        card.style.transform =
          `translateX(${off * gap}%) translateZ(${-abs * 150}px) ` +
          `rotateY(${off * -14}deg) scale(${1 - abs * 0.07})`;
        card.style.zIndex = String(10 - abs);
        card.style.opacity = abs > 2 ? '0' : String(1 - abs * 0.24);
        card.style.filter = abs ? `brightness(${1 - abs * 0.24})` : 'none';
        // A card nobody can see must not be tabbable or clickable, or the tab
        // order walks through cards that are not on screen.
        card.style.pointerEvents = abs > 2 ? 'none' : 'auto';
        card.tabIndex = abs > 2 ? -1 : 0;
        card.classList.toggle('is-active', off === 0);
      });
      mount();
    }

    // How far round the fan a card is from the one in front, taking the
    // shorter way round.
    function offsetOf(i) {
      let off = i - active;
      if (off > N / 2) off -= N;
      if (off < -N / 2) off += N;
      return off;
    }

    // Neither the posters nor the films are attached in the markup for cards
    // you cannot see yet, and nothing is ever detached: once a card has been
    // looked at its bytes are already spent, and re-setting src would refetch
    // it on every pass through the fan.
    function mount() {
      cards.forEach((card, i) => {
        const poster = card.querySelector('.adcard-poster');
        // One card either side of what is visible, so browsing never lands on
        // an empty frame.
        if (poster && Math.abs(offsetOf(i)) <= 3 && !poster.getAttribute('src') && poster.dataset.poster) {
          poster.setAttribute('src', poster.dataset.poster);
        }
        const film = card.querySelector('.adcard-film');
        if (!film) return;
        if (i !== active) {
          film.pause();
          card.classList.remove('is-playing');
          return;
        }
        if (!film.getAttribute('src') && card.dataset.src) {
          film.setAttribute('src', card.dataset.src);
        }
        if (!reduceMotion && visible) {
          const p = film.play();
          if (p && p.catch) p.catch(() => {});
        }
      });
      if (!ticking) { ticking = true; requestAnimationFrame(tick); }
    }

    // One loop for the whole fan rather than one per card: the HUD only ever
    // describes the card in front.
    let ticking = false;
    function tick() {
      const card = cards[active];
      const film = card && card.querySelector('.adcard-film');
      const tc = card && card.querySelector('.adcard-tc');
      const bar = card && card.querySelector('.adcard-prog i');
      if (film && tc && bar) {
        const d = film.duration;
        const t = film.currentTime || 0;
        tc.textContent = fmt(t);
        bar.style.width = (d && isFinite(d) ? (t / d) * 100 : 0).toFixed(1) + '%';
        if (!film.paused && film.readyState > 2) card.classList.add('is-playing');
      }
      if (!reduceMotion && visible) requestAnimationFrame(tick);
      else ticking = false;
    }

    function go(i) {
      active = ((i % N) + N) % N;
      layout();
    }

    cards.forEach((card, i) => {
      card.addEventListener('click', () => { if (i !== active) go(i); });
      // Keyboard focus follows the same rule as a click: the card you are on
      // is the card in front, or the HUD describes something you cannot see.
      card.addEventListener('focus', () => { if (i !== active) go(i); });
      const film = card.querySelector('.adcard-film');
      // A clip that will not load keeps its poster instead of going black.
      if (film) film.addEventListener('error', () => card.classList.remove('is-playing'));
    });

    // Arrows drive the fan, but not while someone is typing a product link:
    // left and right belong to the caret first.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (!visible) return;
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      go(active + (e.key === 'ArrowRight' ? 1 : -1));
      e.preventDefault();
    });

    // Swipe, because on a phone there are no arrow keys and the side cards are
    // small targets.
    let x0 = null;
    theatre.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    theatre.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 40) go(active + (dx < 0 ? 1 : -1));
    }, { passive: true });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          visible = e.intersectionRatio > 0.2;
          if (visible) mount();
          else cards.forEach((c) => {
            const f = c.querySelector('.adcard-film');
            if (f) f.pause();
          });
        });
      }, { threshold: [0, 0.2] }).observe(theatre);
    }

    layout();

    // A phone rotated into landscape crosses the spread breakpoints, and the
    // fan is drawn with inline transforms, so nothing re-lays it out but this.
    let relayout;
    window.addEventListener('resize', () => {
      clearTimeout(relayout);
      relayout = setTimeout(layout, 150);
    });

    // ── The research strip: the chain, revealed in the order it runs ──
    const chips = [...document.querySelectorAll('.rchip')];
    if (chips.length) {
      const show = () => chips.forEach((c, i) => {
        if (reduceMotion) { c.classList.add('on'); return; }
        setTimeout(() => c.classList.add('on'), 400 + i * 340);
      });
      if ('IntersectionObserver' in window) {
        const cio = new IntersectionObserver((entries, obs) => {
          if (entries.some((e) => e.isIntersecting)) { show(); obs.disconnect(); }
        }, { threshold: 0.3 });
        cio.observe(chips[0].parentElement);
      } else {
        show();
      }
    }
  }

  // ── How it works: the rail lights as you scroll it ──
  //
  // The section claims a pipeline, so it runs one. Each pass lifts in as it
  // arrives, the rail fills behind it, and the readout on the pinned left
  // column says which pass you are looking at. Nothing here is decoration
  // that repeats what the words already say: the rail is the only thing on
  // the page that shows the passes are ordered.
  const pipeline = document.getElementById('how-pipeline');
  if (pipeline) {
    const passes = [...pipeline.querySelectorAll('.how-step')];
    const gate = document.getElementById('how-gate');
    const rail = document.getElementById('how-rail');
    const posEl = document.getElementById('how-pos');
    const meterEl = document.getElementById('how-meter');
    const TOTAL = passes.length;

    if (reduceMotion) {
      // No fade, no crawl: everything lit, rail full, readout at the end.
      passes.forEach((s) => s.classList.add('is-lit'));
      if (gate) gate.classList.add('is-lit');
      if (rail) rail.style.height = '100%';
      if (posEl) posEl.textContent = String(TOTAL).padStart(2, '0');
      if (meterEl) meterEl.style.width = '100%';
    } else if ('IntersectionObserver' in window) {
      const lio = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-lit');
          const n = e.target.dataset.n;
          if (!n) return;
          if (posEl) posEl.textContent = n;
          if (meterEl) meterEl.style.width = (parseInt(n, 10) / TOTAL) * 100 + '%';
        });
      }, { threshold: 0.45 });
      passes.forEach((s) => lio.observe(s));
      if (gate) lio.observe(gate);

      // The fill tracks scroll rather than the observer, so it moves
      // continuously between passes instead of jumping a sixth at a time.
      // 0.62 of the viewport is roughly where the eye sits while reading.
      let queued = false;
      const fill = () => {
        queued = false;
        if (!rail) return;
        const r = pipeline.getBoundingClientRect();
        const total = r.height - 52;   // the rail is inset by half a node at each end
        const done = Math.min(Math.max(window.innerHeight * 0.62 - r.top, 0), total);
        rail.style.height = done + 'px';
      };
      const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(fill);
      };
      fill();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
    } else {
      passes.forEach((s) => s.classList.add('is-lit'));
      if (gate) gate.classList.add('is-lit');
    }
  }

  // ── Marquees: pause the CSS animation while offscreen (battery, main thread) ──
  const marqueeBands = document.querySelectorAll('.marquee, .review-track');
  if (marqueeBands.length && 'IntersectionObserver' in window && !reduceMotion) {
    const mio = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        e.target.style.animationPlayState = e.isIntersecting ? 'running' : 'paused';
      });
    }, { threshold: 0 });
    marqueeBands.forEach((m) => mio.observe(m));
  }

  // ── Filmstrip: scroll position locks segments in, one by one ──
  const stripZone = document.getElementById('strip-zone');
  const strip = document.getElementById('film-strip');
  if (stripZone && strip) {
    const cells = strip.querySelectorAll('.c-cell');
    if (reduceMotion) {
      cells.forEach((c) => c.classList.add('locked'));
      stripZone.classList.add('complete');
    } else {
      let raf = 0;
      const update = () => {
        raf = 0;
        const r = stripZone.getBoundingClientRect();
        const vh = window.innerHeight;
        // 0 when the zone enters the lower viewport, 1 shortly before it leaves
        const p = Math.min(1, Math.max(0, (vh - r.top - vh * 0.25) / (vh * 0.85)));
        cells.forEach((c, i) => c.classList.toggle('locked', p >= (i + 1) / cells.length));
        stripZone.classList.toggle('complete', p >= 1);
      };
      const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      update();
    }
  }

  // ── Free read entry on the offer page ──────────────────────────
  // Was the free-clip entry: it composed a `product: 'sample'` order and sent
  // the visitor to render.html?sample=1, an endpoint that has answered 410
  // since the clip was retired. The free thing is the market read now, it
  // needs no account either, and it ends by naming the angle before offering
  // to make it. Lives here (not inline) because the site CSP allows
  // self-hosted scripts only.
  const freeClipForm = document.getElementById('free-clip-form');
  if (freeClipForm) {
    freeClipForm.addEventListener('submit', (e) => {
      e.preventDefault();
      let raw = document.getElementById('lf-link').value.trim();
      if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
      let link;
      try { link = new URL(raw).href; } catch (err) { return; }
      if (window.hexaTrack) window.hexaTrack('gate-clicked', 'offer');
      window.location.href = '/validate?url=' + encodeURIComponent(link);
    });
  }
})();

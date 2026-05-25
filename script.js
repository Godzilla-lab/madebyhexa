(function () {
  'use strict';

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const gallery = document.getElementById('gallery');
  const emptyMsg = document.getElementById('gallery-empty');

  const isTouch = matchMedia('(hover: none)').matches;
  const saveData = (navigator.connection && navigator.connection.saveData) === true;

  // ── Process placeholders ────────────────────────────────────
  // If a process image fails to load (user hasn't dropped photos yet),
  // mark its container so the numbered placeholder shows cleanly.
  document.querySelectorAll('.process-input img').forEach((img) => {
    img.addEventListener('error', () => {
      const fig = img.closest('.process-input');
      if (fig) fig.classList.add('is-empty');
    });
    if (img.complete && img.naturalWidth === 0) {
      const fig = img.closest('.process-input');
      if (fig) fig.classList.add('is-empty');
    }
  });

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

  function makeTile(item, index) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    const isNsfw = item.nsfw === true;
    const isImage = item.type === 'image';
    if (isNsfw) tile.classList.add('tile-nsfw');
    if (isImage) tile.classList.add('tile-image');
    tile.style.transitionDelay = Math.min(index * 35, 500) + 'ms';
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.setAttribute('aria-label', (isNsfw ? 'Reveal mature ' : 'View ') + (item.category || 'item'));

    let video = null;
    let imgEl = null;
    if (isImage) {
      imgEl = document.createElement('img');
      imgEl.src = item.url;
      imgEl.alt = item.category || '';
      imgEl.loading = 'lazy';
      imgEl.decoding = 'async';
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

    const shade = document.createElement('div');
    shade.className = 'tile-shade';

    tile.appendChild(isImage ? imgEl : video);
    tile.appendChild(shade);

    if (isNsfw) {
      const badge = document.createElement('span');
      badge.className = 'tile-nsfw-badge';
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>' +
        '<circle cx="12" cy="12" r="3"/>' +
        '<line x1="3" y1="3" x2="21" y2="21"/>' +
        '</svg><span>18+</span>';
      tile.appendChild(badge);

      const bottom = document.createElement('div');
      bottom.className = 'tile-nsfw-bottom';
      bottom.innerHTML =
        '<span class="tile-nsfw-showcase">Showcase</span>' +
        '<span class="tile-nsfw-category">' + (item.category || 'X-MODE') + '</span>';
      tile.appendChild(bottom);

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'tile-nsfw-eye';
      eye.setAttribute('aria-label', 'Reveal mature content');
      eye.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>' +
        '<circle cx="12" cy="12" r="3"/>' +
        '</svg>';
      tile.appendChild(eye);
    } else {
      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = item.category || 'Showreel';

      const play = document.createElement('span');
      play.className = 'tile-play';
      play.setAttribute('aria-hidden', 'true');
      play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

      tile.appendChild(label);
      tile.appendChild(play);
    }

    let stage = 0; // 0 none, 1 metadata, 2 auto
    let revealed = !isNsfw;

    function loadPoster() {
      if (isImage || stage >= 1) return;
      stage = 1;
      video.preload = 'metadata';
      if (!video.src) video.src = video.dataset.src;
    }
    function loadFull() {
      if (isImage) return;
      loadPoster();
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
      openLightbox(item.url, item.category, item.type);
    }

    if (!isTouch && !isImage) {
      tile.addEventListener('mouseenter', () => {
        if (!revealed) return; // no preview-play until revealed
        loadFull();
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      });
      tile.addEventListener('mouseleave', () => {
        if (!revealed) return;
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
    const tiles = items.map(makeTile);
    const frag = document.createDocumentFragment();
    tiles.forEach(t => frag.appendChild(t.el));
    gallery.appendChild(frag);
    gallery.setAttribute('aria-busy', 'false');

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

  // Each page sets <body data-mode="..."> to filter the gallery.
  //   "main" (or unset) → exclude NSFW
  //   "nsfw"             → only NSFW
  const mode = document.body.dataset.mode || 'main';
  function filterByMode(items) {
    if (mode === 'nsfw') return items.filter(v => v.nsfw === true);
    return items.filter(v => v.nsfw !== true);
  }

  if (gallery) {
    fetch('videos.json?v=' + Date.now(), { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(data => {
        if (!Array.isArray(data) || data.length === 0) throw new Error('Empty data');
        const filtered = filterByMode(data);
        if (filtered.length === 0) {
          gallery.setAttribute('aria-busy', 'false');
          if (emptyMsg) {
            emptyMsg.hidden = false;
            emptyMsg.textContent = mode === 'nsfw'
              ? 'No mature content yet. Check back soon.'
              : "Couldn't load the reel. Refresh to try again.";
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

  // ── 18+ age gate (only on pages with #age-gate) ─────────────
  const ageGate = document.getElementById('age-gate');
  if (ageGate) {
    const STORAGE_KEY = 'hexa-age-confirmed';
    let confirmed = false;
    try { confirmed = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}

    if (!confirmed) {
      ageGate.classList.add('is-open');
      document.body.classList.add('lb-open');
    }

    const confirmBtn = ageGate.querySelector('[data-action="confirm"]');
    const leaveBtn = ageGate.querySelector('[data-action="leave"]');
    if (confirmBtn) confirmBtn.addEventListener('click', () => {
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
      ageGate.classList.remove('is-open');
      document.body.classList.remove('lb-open');
    });
    if (leaveBtn) leaveBtn.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }
})();

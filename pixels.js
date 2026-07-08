/*
 * Hexa AI ad tracking pixels (Meta + TikTok), behind a consent banner.
 *
 * Nothing loads, no cookie is written and no event leaves the page until the
 * visitor accepts (EU ePrivacy/GDPR). The choice is remembered either way in
 * localStorage['hexa-consent'] = 'granted' | 'denied'; declining is exactly
 * as easy as accepting. Every hexaTrack* helper stays safe to call at any
 * time: without consent they are silent no-ops.
 *
 * Pages load this in <head>. The thank-you page sets <body data-track="lead">,
 * which fires the conversion event once the page is reached after a form submit.
 */
(function () {
  'use strict';

  var META_PIXEL_ID = '1665679184667318';
  var TIKTOK_PIXEL_ID = 'D8OK0M3C77UBB84C775G';

  var metaReady = META_PIXEL_ID && META_PIXEL_ID !== 'META_PIXEL_ID';
  var tiktokReady = TIKTOK_PIXEL_ID && TIKTOK_PIXEL_ID !== 'TIKTOK_PIXEL_ID';

  /* ── Consent state ── */
  var CONSENT_KEY = 'hexa-consent';
  function consentState() {
    try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }
  function granted() { return consentState() === 'granted'; }
  function setConsent(v) {
    try { localStorage.setItem(CONSENT_KEY, v); } catch (e) {}
  }

  /* ── Pixel loaders (called only after consent) ── */
  function loadMeta() {
    if (!metaReady || window.fbq) return;
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  function loadTikTok() {
    if (!tiktokReady || window.ttq) return;
    !function (w, d, t) {
      w.TiktokAnalyticsObject = t; var ttq = w[t] = w[t] || [];
      ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
      ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
      ttq.load = function (e, n) { var r = 'https://analytics.tiktok.com/i18n/pixel/events.js', o = n && n.partner; ttq._i = ttq._i || {}, ttq._i[e] = [], ttq._i[e]._u = r, ttq._t = ttq._t || {}, ttq._t[e] = +new Date, ttq._o = ttq._o || {}, ttq._o[e] = n || {}; var s = d.createElement('script'); s.type = 'text/javascript', s.async = !0, s.src = r + '?sdkid=' + e + '&lib=' + t; var a = d.getElementsByTagName('script')[0]; a.parentNode.insertBefore(s, a); };
      ttq.load(TIKTOK_PIXEL_ID);
      ttq.page();
    }(window, document, 'ttq');
  }

  function qs(name) {
    try { return new URLSearchParams(window.location.search).get(name) || ''; } catch (e) { return ''; }
  }
  function getCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : '';
  }

  /* Click-id capture writes cookies, so it also waits for consent. */
  function captureClickIds() {
    var id = qs('ttclid');
    if (id) { try { document.cookie = 'ttclid=' + encodeURIComponent(id) + ';path=/;max-age=2592000;samesite=lax'; } catch (e) {} }
    var fbclid = qs('fbclid');
    if (fbclid && !getCookie('_fbc')) {
      try { document.cookie = '_fbc=fb.1.' + Date.now() + '.' + encodeURIComponent(fbclid) + ';path=/;max-age=7776000;samesite=lax'; } catch (e) {}
    }
  }

  /* Everything tracking-related starts here, and only here. */
  function enableTracking() {
    captureClickIds();
    loadMeta();
    loadTikTok();
  }

  // Per-tier value + identity. Both Meta and TikTok require a content_id on
  // commerce events to optimize toward revenue (ROAS) and match products.
  var TIER_VALUES = { single: 59, triple: 129, starter: 119, growth: 349 };
  var TIER_NAMES = {
    single: 'Hexa AI Single', triple: 'Hexa AI Triple',
    starter: 'Hexa AI Starter', growth: 'Hexa AI Growth'
  };

  window.hexaGetUserData = function () {
    return {
      ttclid: qs('ttclid') || getCookie('ttclid'),
      ttp: getCookie('_ttp'),
      fbp: getCookie('_fbp'),
      fbc: getCookie('_fbc')
    };
  };
  // Server-side mirror of an event (TikTok Events API), unblockable by ad blockers.
  // Same-origin call, so first-party; the function then talks to TikTok server-to-server.
  // Consent applies to this exactly as to the pixels: it carries click ids + cookies.
  window.hexaServerEvent = function (name, extra) {
    if (!granted()) return;
    try {
      var u = window.hexaGetUserData();
      var payload = { event: name, url: location.href, ttclid: u.ttclid, ttp: u.ttp, fbp: u.fbp, fbc: u.fbc };
      if (extra) { for (var k in extra) payload[k] = extra[k]; }
      fetch('/.netlify/functions/track-conversion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  };

  // Client-side SHA-256 (lowercase hex). TikTok Advanced Matching requires PII
  // to be hashed in the browser before it is handed to the pixel.
  window.hexaSha256Hex = function (value) {
    try {
      if (!window.crypto || !crypto.subtle) return Promise.resolve('');
      var bytes = new TextEncoder().encode(String(value));
      return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
        var arr = new Uint8Array(buf), hex = '';
        for (var i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
        return hex;
      }).catch(function () { return ''; });
    } catch (e) { return Promise.resolve(''); }
  };
  // TikTok Advanced Matching. Hash the email (normalized the same way as the
  // server-side hash in track-conversion.js: trim + lowercase) and attach it to
  // the pixel so the event that follows can be matched to a TikTok account.
  // Returns a promise so callers can identify, then fire the event in order.
  window.hexaIdentify = function (email) {
    var em = String(email || '').trim().toLowerCase();
    if (!em || !tiktokReady || !window.ttq || !granted()) return Promise.resolve();
    return window.hexaSha256Hex(em).then(function (hash) {
      if (hash) { try { window.ttq.identify({ email: hash }); } catch (e) {} }
    });
  };

  // Build Meta- and TikTok-shaped property objects, each carrying a content_id.
  // (TikTok wants contents[].content_id; Meta wants content_ids / contents[].id.)
  function productProps(tier, contentType) {
    var key = String(tier || 'hexa_offer').toLowerCase();
    var name = TIER_NAMES[key] || 'Hexa AI video';
    var price = TIER_VALUES[key];
    var ctype = contentType || (price ? 'product' : 'product_group');
    var meta = {
      content_type: ctype,
      content_ids: [key],
      content_name: name,
      contents: [{ id: key, quantity: 1 }]
    };
    var tt = {
      content_type: ctype,
      contents: [{ content_id: key, content_type: ctype, content_name: name, price: price || 0, quantity: 1 }]
    };
    if (price) { meta.value = price; meta.currency = 'USD'; tt.value = price; tt.currency = 'USD'; }
    return { meta: meta, tt: tt };
  }

  function fireEvent(metaEvent, ttEvent, props, eventId) {
    if (!granted()) return;
    var metaOpts = eventId ? { eventID: eventId } : undefined;
    var ttOpts = eventId ? { event_id: eventId } : undefined;
    try { if (metaReady && window.fbq) window.fbq('track', metaEvent, props.meta, metaOpts); } catch (e) {}
    try { if (tiktokReady && window.ttq) window.ttq.track(ttEvent, props.tt, ttOpts); } catch (e) {}
  }

  window.hexaTrackViewContent = function () {
    fireEvent('ViewContent', 'ViewContent', productProps('hexa_offer', 'product_group'));
  };
  window.hexaTrackAddToCart = function (tier, eventId) {
    fireEvent('AddToCart', 'AddToCart', productProps(tier, 'product'), eventId);
  };
  window.hexaTrackInitiateCheckout = function (tier, eventId) {
    fireEvent('InitiateCheckout', 'InitiateCheckout', productProps(tier, 'product'), eventId);
  };
  window.hexaTrackPurchase = function (tier, eventId) {
    fireEvent('Purchase', 'CompletePayment', productProps(tier, 'product'), eventId);
  };
  window.hexaTrackLead = function () {
    if (!granted()) return;
    try { if (metaReady && window.fbq) window.fbq('track', 'Lead'); } catch (e) {}
    try { if (tiktokReady && window.ttq) window.ttq.track('SubmitForm'); } catch (e) {}
  };

  // Conversion pages set a <body data-track="..."> value:
  //   view-content  product / offer pages (fires alongside the automatic PageView)
  //   lead          free-sample thank-you pages
  //   purchase      post-checkout page (intake.html); needs tier + session_id in the URL
  var conversionFired = false;
  function fireConversion() {
    if (conversionFired || !granted() || !document.body) return;
    conversionFired = true;
    var t = document.body.dataset.track;
    if (t === 'view-content') {
      window.hexaTrackViewContent();
    } else if (t === 'lead') {
      // If the visitor gave an email on the form (stashed before navigation),
      // identify first so the Lead/SubmitForm event carries Advanced Matching.
      var em = '';
      try { em = sessionStorage.getItem('hexa_lead_em') || ''; } catch (e) {}
      if (em) {
        try { sessionStorage.removeItem('hexa_lead_em'); } catch (e) {}
        window.hexaIdentify(em).then(function () { window.hexaTrackLead(); });
      } else {
        window.hexaTrackLead();
      }
    } else if (t === 'purchase') {
      // Only count a purchase that followed a real Stripe checkout (session_id present),
      // so landing on the page directly never fires a false conversion. The Stripe
      // session id doubles as the event_id so the browser + server events dedupe.
      var sid = qs('session_id');
      if (!sid) return;
      var tier = qs('tier');
      window.hexaTrackPurchase(tier, sid);
      window.hexaServerEvent('CompletePayment', { session_id: sid, event_id: sid, tier: tier });
    }
  }

  /* ── The banner ─────────────────────────────────────────────────
   * Shown once, only while no choice is stored. Self-contained styling so it
   * looks right on every page that loads pixels.js. */
  function showBanner() {
    var css =
      '.hexa-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;' +
      'display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;' +
      'max-width:720px;margin:0 auto;padding:14px 18px;border-radius:14px;' +
      'background:rgba(16,16,20,.96);border:1px solid rgba(255,255,255,.14);' +
      'box-shadow:0 12px 40px rgba(0,0,0,.45);backdrop-filter:blur(12px);' +
      'font:14px/1.45 Inter,system-ui,sans-serif;color:#e8e8ee}' +
      '.hexa-consent p{margin:0;flex:1 1 280px}' +
      '.hexa-consent a{color:inherit;text-decoration:underline}' +
      '.hexa-consent-actions{display:flex;gap:8px}' +
      '.hexa-consent button{font:600 14px Inter,system-ui,sans-serif;padding:9px 16px;' +
      'border-radius:10px;cursor:pointer;border:1px solid rgba(255,255,255,.22);' +
      'background:transparent;color:#e8e8ee}' +
      '.hexa-consent button.hexa-consent-accept{background:#e8e8ee;color:#111;border-color:#e8e8ee}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var bar = document.createElement('div');
    bar.className = 'hexa-consent';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Cookie consent');
    bar.innerHTML =
      '<p>We use cookies to measure our ads. No accept, no cookies, simple as that. ' +
      '<a href="/privacy.html">Privacy</a></p>' +
      '<div class="hexa-consent-actions">' +
      '<button type="button" class="hexa-consent-decline">Decline</button>' +
      '<button type="button" class="hexa-consent-accept">Accept</button>' +
      '</div>';
    document.body.appendChild(bar);

    bar.querySelector('.hexa-consent-accept').addEventListener('click', function () {
      setConsent('granted');
      bar.remove();
      enableTracking();
      fireConversion();
    });
    bar.querySelector('.hexa-consent-decline').addEventListener('click', function () {
      setConsent('denied');
      bar.remove();
    });
  }

  function boot() {
    var state = consentState();
    if (state === 'granted') {
      enableTracking();
      fireConversion();
    } else if (state !== 'denied') {
      showBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

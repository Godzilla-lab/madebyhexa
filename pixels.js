/*
 * Hexa AI ad tracking pixels (Meta + TikTok).
 *
 * SETUP: paste your real pixel IDs below, then redeploy.
 *   - Meta:   Events Manager -> Data sources -> your pixel -> Pixel ID
 *   - TikTok: Ads Manager -> Assets -> Events -> Web Events -> Pixel ID
 * Until real IDs are added, tracking stays inert (no network calls, no errors),
 * so the site is safe to ship before the ad accounts are ready.
 *
 * Pages load this in <head>. The thank-you page sets <body data-track="lead">,
 * which fires the conversion event once the page is reached after a form submit.
 */
(function () {
  'use strict';

  var META_PIXEL_ID = '2058088931785888';
  var TIKTOK_PIXEL_ID = 'TIKTOK_PIXEL_ID';   // e.g. 'CABC123DEF456GHI789'

  var metaReady = META_PIXEL_ID && META_PIXEL_ID !== 'META_PIXEL_ID';
  var tiktokReady = TIKTOK_PIXEL_ID && TIKTOK_PIXEL_ID !== 'TIKTOK_PIXEL_ID';

  if (metaReady) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  if (tiktokReady) {
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

  window.hexaTrackLead = function () {
    try { if (metaReady && window.fbq) window.fbq('track', 'Lead'); } catch (e) {}
    try { if (tiktokReady && window.ttq) window.ttq.track('SubmitForm'); } catch (e) {}
  };

  function fireIfLeadPage() {
    if (document.body && document.body.dataset.track === 'lead') window.hexaTrackLead();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fireIfLeadPage);
  } else {
    fireIfLeadPage();
  }
})();

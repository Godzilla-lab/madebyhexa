/* ═════ hexaTrack: first-party funnel counting ═════
 *
 * Seven places in this codebase already call `window.hexaTrack(...)`, all of
 * them guarded with `if (window.hexaTrack)`. Nothing ever defined it. So every
 * one of those calls has been silently doing nothing since it was written, and
 * questions like "does the free ad convert better than the old clip did" have
 * had no data behind them at all, only the appearance of instrumentation.
 *
 * This defines it. Four events matter for the signup funnel:
 *
 *   gate-seen         a sign-in offer was drawn on a report
 *   gate-clicked      somebody pressed it
 *   signup-completed  an account came out the other side
 *   free-ad-viewed    the ad that account was promised finished rendering
 *
 * Deliberately not the ad pixels. Those live in pixels.js, they are behind a
 * consent banner, and they answer a different question (which ad spend
 * produced a customer). This answers whether our own funnel works, it is
 * first-party, it stores no identifiers, and it is fire-and-forget: nothing on
 * the page ever waits on it or breaks when it fails.
 */
(function () {
  'use strict';

  /* One label per event, and it is always a category rather than anything a
   * person typed: 'report', 'cold', 'recommendation'. Free text here would
   * turn a counter into an accidental log of product names. */
  function clean(s) {
    return String(s == null ? '' : s).replace(/[^a-z0-9_-]/gi, '').slice(0, 32).toLowerCase();
  }

  window.hexaTrack = function (name, label) {
    var n = clean(name);
    if (!n) return;
    try {
      var body = JSON.stringify({ event: n, label: clean(label) });
      // sendBeacon survives the page navigating away, which is exactly what
      // happens one instant after gate-clicked fires.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/.netlify/functions/funnel', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/.netlify/functions/funnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* counting must never be able to break a page */ }
  };
})();

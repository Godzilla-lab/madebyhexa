'use strict';

/*
 * Fixed-window rate limiter on Netlify Blobs, for the money-spending
 * functions. Best-effort by design: Blobs has no atomic increment, so a
 * concurrent burst can slightly overshoot the limit; that is fine for the
 * job of stopping abuse loops and runaway clients. Fails OPEN: if Blobs is
 * unavailable (plain node scripts, misconfig) legitimate customers pass.
 */

const WINDOW_MS = 60 * 60 * 1000; // one hour

function ipOf(event) {
  const h = (event && event.headers) || {};
  return h['x-nf-client-connection-ip'] ||
    String(h['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown';
}

/* allow('render', event, 12) -> false when this IP spent its hourly budget */
async function allow(name, event, limit) {
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('rate-limits');
    const key = name + ':' + ipOf(event);
    const now = Date.now();
    const cur = (await store.get(key, { type: 'json' })) || { start: now, count: 0 };
    if (now - cur.start >= WINDOW_MS) { cur.start = now; cur.count = 0; }
    cur.count += 1;
    await store.setJSON(key, cur);
    return cur.count <= limit;
  } catch (e) {
    return true;
  }
}

module.exports = { allow, ipOf };

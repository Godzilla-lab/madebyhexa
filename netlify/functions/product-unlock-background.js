'use strict';

/*
 * Read a blocked product page through Bright Data and cache what it gives us.
 *
 * Runs as a Netlify background function, invoked fire-and-forget by
 * product-peek the moment a paste comes back without a photo. Background
 * because the unlocker takes 5 to 10 seconds and sometimes 20, against a
 * synchronous function ceiling of 10; here there are minutes to spare, so the
 * page gets read properly instead of half-read against a stopwatch.
 *
 * The customer never waits on this function. Their paste already returned.
 * studio.js is polling product-peek for up to three minutes, and that poll
 * checks this cache before it asks the engine anything, so the photo simply
 * appears. Where the engine's own scrape takes 10 to 60 seconds and often
 * fails outright, this usually lands in under ten.
 *
 * Cached per URL in Blobs, so a given product page costs $0.0015 once, for
 * every customer who ever pastes it, rather than once per visitor.
 *
 * Auth: internal only. Callers must send x-unlock-key: WEBHOOK_SECRET.
 * Idempotent: a URL that is already cached returns without spending anything.
 *
 * env: BRIGHTDATA_API_TOKEN, BRIGHTDATA_UNLOCKER_ZONE, WEBHOOK_SECRET
 */

const unlocker = require('./lib/unlocker');
const peek = require('./product-peek');

/*
 * Reject a page that is really a 404.
 *
 * The unlocker reports Bright Data's own status, not the store's: a dead
 * product URL still comes back as HTTP 200 carrying the shop's "not found"
 * body. Those pages are not empty, which is the trap. Shopify themes put a
 * generic social-sharing thumbnail in og:image, so a mistyped or discontinued
 * link yields a real, validating image that is not the product.
 *
 * Measured 2026-08-13: ridge.com and vessi.com both returned 200 with
 * og:title "404 Not Found" and a store banner as og:image. Caching that would
 * show a customer someone else's artwork as their product and then ground a
 * paid render on it, which is worse than showing nothing and asking for a
 * better link.
 */
function looksLikeNotFound(html) {
  const title = (/<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html) || [])[1] || '';
  const og = peek.metaContent(html, 'og:title') || '';
  return /\b404\b|not found/i.test(title) || /\b404\b|not found/i.test(og);
}

/* Generous, because nothing is waiting on it. The only job of this ceiling is
 * to stop a pathological page holding a function open forever. */
const UNLOCK_BUDGET_MS = 60000;

/* A cached miss is worth remembering for a while: some pages genuinely have no
 * product image (oura.com, measured), and re-unlocking them on every paste
 * would spend money to learn the same thing. Short enough that a site fixing
 * its markup is picked up the same day. */
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);

  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const key = (event.headers && (event.headers['x-unlock-key'] || event.headers['X-Unlock-Key'])) || '';
  if (!process.env.WEBHOOK_SECRET || key !== process.env.WEBHOOK_SECRET) return { statusCode: 401 };
  if (!unlocker.configured()) return { statusCode: 503 };

  let raw;
  try { raw = JSON.parse(event.body || '{}').url; }
  catch (e) { return { statusCode: 400 }; }
  if (!raw) return { statusCode: 400 };

  // Re-guard rather than trust the caller. This function makes an outbound
  // request to whatever it is handed, so the SSRF checks that protect the peek
  // have to protect this too, even though today's only caller is the peek.
  const target = await peek.guardUrl(raw);
  if (!target) return { statusCode: 400 };

  let store = null;
  try {
    const { getStore } = require('@netlify/blobs');
    store = getStore('peeks');
  } catch (e) {
    return { statusCode: 503 }; // no cache means no point: the result would die here
  }

  const cacheKey = peek.unlockKey(target.href);
  try {
    const existing = await store.get(cacheKey, { type: 'json' });
    if (existing && existing.image) return { statusCode: 200 };
    if (existing && !existing.image && Date.now() - (existing.ts || 0) < MISS_TTL_MS) {
      return { statusCode: 200 }; // known to have nothing; do not pay to relearn it
    }
  } catch (e) { /* unreadable cache: carry on and try to write a good one */ }

  const t0 = Date.now();
  const un = await unlocker.unlockHtml(target.href, UNLOCK_BUDGET_MS);
  if (!un || !un.html) {
    console.log('[unlock] no read for', target.hostname, 'in', Date.now() - t0, 'ms');
    return { statusCode: 200 };
  }

  // A dead product link reads fine and carries a decoy image. Cache the miss
  // so we do not pay to rediscover it, but never cache its picture.
  if (looksLikeNotFound(un.html)) {
    console.log('[unlock]', target.hostname, 'is a 404 page, not caching its image');
    try { await store.setJSON(cacheKey, { image: null, notFound: true, ts: Date.now() }); }
    catch (e) { /* best effort */ }
    return { statusCode: 200 };
  }

  const fields = peek.extract(un.html, target.href);
  if (fields.image) fields.image = await peek.validateImage(fields.image, 4000);

  /*
   * The description is not for the peek card, which never shows it. It is for
   * the storyboard.
   *
   * A pasted link is what grounds the whole generation: the engine's scrape
   * becomes web_product_ids on the video job, and its title and description
   * are what the script actually talks about. That scrape failed on 2 of the 5
   * stores measured, and when it fails the render silently proceeds with no
   * product knowledge at all. Keeping the description here means a paid film
   * can still be written about the real product instead of a generic one.
   */
  const description =
    peek.metaContent(un.html, 'og:description') ||
    peek.metaContent(un.html, 'twitter:description') ||
    peek.metaContent(un.html, 'description') ||
    null;

  const record = {
    image: fields.image || null,
    title: fields.title || null,
    description: description ? String(description).slice(0, 900) : null,
    siteName: fields.siteName || null,
    price: fields.price || null,
    currency: fields.currency || null,
    ts: Date.now(),
  };
  try { await store.setJSON(cacheKey, record); }
  catch (e) { console.error('[unlock] cache write failed:', e.message); }

  console.log('[unlock]', target.hostname, record.image ? 'image cached' : 'no image on page',
    'in', Date.now() - t0, 'ms');
  return { statusCode: 200 };
};

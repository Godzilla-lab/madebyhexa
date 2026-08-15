/*
 * Product resolution: a pasted URL -> structured product facts.
 *
 * The ladder runs cheapest-first and only pays when the free tiers fail.
 * Measured 2026-08-13 against real storefronts with the same header set
 * netlify/functions/product-peek.js uses: allbirds, gymshark, amazon, shein,
 * zara, aliexpress and temu answered 200, but etsy 403'd, target 429'd and
 * bestbuy refused the connection outright. Roughly a third of major retail
 * refuses a plain datacenter fetch, and the pasted URL is the entire input to
 * the product, so tier 3 is not optional -- it is the fix for that bug.
 *
 *   1. Shopify /products.json   free, instant, covers most DTC
 *   2. Direct fetch             free, covers ~two thirds
 *   3. Higgsfield scraper       already paid for, and it reads pages we cannot
 *   4. Bright Data Web Unlocker new spend, only for what tiers 1-3 could not read
 *   5. Wayback                  free, last resort on a dead or hostile origin
 *
 * Tier 3 matters: Higgsfield's marketing-studio product scraper is the same one
 * the studio already trusts to ground a render, we are already paying for it,
 * and it succeeds on origins that refuse us. It goes ahead of any new vendor.
 *
 * env: HIGGSFIELD_TOKEN enables tier 3; BRIGHTDATA_API_TOKEN +
 * BRIGHTDATA_UNLOCKER_ZONE enable tier 4. Without either the ladder still runs,
 * it just cannot rescue a blocked origin.
 */

import * as hf from './higgsfield.mjs';
import { extractReviews } from './reviews.mjs';

const MAX_REDIRECTS = 4;
const MAX_BODY_BYTES = 900 * 1024;
const FETCH_MS = 12000;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

/* ── small helpers ─────────────────────────────────────────────── */

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
      return named[ent.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function metaContent(html, key) {
  const pats = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'),
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return '';
}

/* JSON-LD Product nodes, including @graph and array payloads. */
function jsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
      const t = node['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.some((x) => String(x).toLowerCase() === 'product')) out.push(node);
    }
  }
  return out;
}

function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (v && typeof v === 'object') return firstString(v.name || v.url || v['@id'] || '');
  return '';
}

/* ── tier 1: Shopify ───────────────────────────────────────────── */

function shopifyHandle(u) {
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  return m ? m[1] : '';
}

async function tryShopify(url) {
  const handle = shopifyHandle(url);
  if (!handle) return null;
  const target = `${url.origin}/products/${handle}.json`;
  const { signal, done } = withTimeout(FETCH_MS);
  try {
    const res = await fetch(target, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    const p = body && body.product;
    if (!p || !p.title) return null;
    const img = (p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src) || '';
    const variant = (p.variants && p.variants[0]) || {};
    return {
      source: 'shopify-json',
      url: url.href,
      title: p.title,
      description: stripTags(p.body_html || '').slice(0, 2000),
      image: img,
      price: variant.price || '',
      currency: '',
      vendor: p.vendor || '',
      type: p.product_type || '',
      tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
  } catch {
    return null;
  } finally {
    done();
  }
}

/* Reviews for a product that resolved from the Shopify JSON API, which does
 * not carry them. Best effort by construction: never throws, never blocks. */
async function shopifyReviews(url) {
  const { signal, done } = withTimeout(FETCH_MS);
  try {
    const res = await fetch(url.href, { signal, headers: BROWSER_HEADERS });
    if (!res.ok) return [];
    return extractReviews(await res.text());
  } catch {
    return [];
  } finally {
    done();
  }
}

/* ── tier 2: direct fetch ──────────────────────────────────────── */

async function fetchHtmlDirect(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { signal, done } = withTimeout(FETCH_MS);
    try {
      const res = await fetch(current.href, { signal, redirect: 'manual', headers: BROWSER_HEADERS });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { blocked: false, status: res.status, html: '' };
        current = new URL(loc, current.href);
        continue;
      }
      if (!res.ok) {
        // 403/429/503 are bot walls, not missing pages. Distinguish them so the
        // caller knows whether tier 3 can help.
        return { blocked: res.status === 403 || res.status === 429 || res.status === 503, status: res.status, html: '' };
      }
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (!type.includes('html')) return { blocked: false, status: res.status, html: '' };
      const buf = Buffer.from(await res.arrayBuffer());
      return { blocked: false, status: res.status, html: buf.subarray(0, MAX_BODY_BYTES).toString('utf8'), finalUrl: current.href };
    } catch (e) {
      // Connection refused / reset also reads as hostile (bestbuy did this).
      return { blocked: true, status: 0, html: '', error: e.message };
    } finally {
      done();
    }
  }
  return { blocked: false, status: 0, html: '' };
}

/* ── tier 3: Bright Data Web Unlocker ──────────────────────────── */

export function unlockerConfigured() {
  return !!(process.env.BRIGHTDATA_API_TOKEN && process.env.BRIGHTDATA_UNLOCKER_ZONE);
}

async function fetchHtmlUnlocked(url, cost) {
  if (!unlockerConfigured()) return { html: '', skipped: true };
  const { signal, done } = withTimeout(45000);
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zone: process.env.BRIGHTDATA_UNLOCKER_ZONE,
        url: url.href,
        format: 'raw',
      }),
    });
    cost.charge('brightdata.unlocker', 1);
    if (!res.ok) return { html: '', status: res.status };
    return { html: await res.text(), status: res.status };
  } catch (e) {
    return { html: '', error: e.message };
  } finally {
    done();
  }
}

/* ── tier 4: Wayback ───────────────────────────────────────────── */

async function fetchHtmlWayback(url) {
  const { signal, done } = withTimeout(FETCH_MS);
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url.href)}`;
    const res = await fetch(api, { signal });
    if (!res.ok) return '';
    const body = await res.json();
    const snap = body?.archived_snapshots?.closest;
    if (!snap?.available || !snap.url) return '';
    const raw = snap.url.replace(/\/https?:/, 'if_/https:');
    const page = await fetch(raw, { signal, headers: BROWSER_HEADERS });
    if (!page.ok) return '';
    return (await page.text()).slice(0, MAX_BODY_BYTES);
  } catch {
    return '';
  } finally {
    done();
  }
}

/* ── extraction ────────────────────────────────────────────────── */

function extract(html, pageUrl, source) {
  const ld = jsonLdProducts(html)[0] || null;
  const title =
    (ld && firstString(ld.name)) ||
    metaContent(html, 'og:title') ||
    decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');

  let description =
    (ld && firstString(ld.description)) ||
    metaContent(html, 'og:description') ||
    metaContent(html, 'description');

  // Fall back to visible body text so a page with no metadata still yields
  // something the category planner can work with.
  if (!description || description.length < 60) {
    const body = stripTags(html);
    if (body.length > 120) description = body.slice(0, 2000);
  }

  const offers = ld && (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers);
  return {
    source,
    url: pageUrl,
    // The page is already parsed and in memory here, so the product's own
    // reviews cost nothing extra to take. They are the only first-party
    // voice-of-customer in the whole pipeline.
    reviews: extractReviews(html),
    title: (title || '').slice(0, 300),
    description: (description || '').slice(0, 2000),
    image: (ld && firstString(ld.image)) || metaContent(html, 'og:image') || '',
    price: (offers && String(offers.price || '')) || '',
    currency: (offers && String(offers.priceCurrency || '')) || '',
    vendor: (ld && firstString(ld.brand)) || metaContent(html, 'og:site_name') || '',
    type: (ld && firstString(ld.category)) || '',
    tags: [],
  };
}

/* ── public API ────────────────────────────────────────────────── */

/*
 * resolveProduct(rawUrl, cost) -> product facts + a `trail` of which tiers ran.
 * The trail is what proves the ladder works; the verification gate reads it.
 */
/*
 * A page that returned 200 but is really a missing product.
 *
 * Soft 404s are the norm on hosted storefronts: the server answers 200 with a
 * "404 Not Found" template, so every status check upstream passes and the
 * extractor happily reports a product called "404 Not Found". Measured
 * 2026-08-14 on a dead Chemex URL, which reached the planner, was classified as
 * a category, and started a full harvest against a page that does not exist.
 *
 * Deliberately anchored rather than a bare /404/ search: real products do carry
 * numbers ("Peugeot 404", "Model 404 amplifier"), and refusing to research a
 * genuine product is a worse failure than researching a dead page. So this only
 * fires on titles that are ABOUT being missing.
 */
const MISSING_TITLE_RE = new RegExp(
  // A bare status code, or one followed somewhere by missing-page language.
  // "404 Sneaker by Nike" survives this; "404 - Page Not Found" does not.
  '^\\s*(404|410)\\s*$'
  + '|^\\s*(404|410)\\b[\\s\\S]*\\b(not\\s+found|error|oops|sorry|unavailable|page|missing)\\b'
  // The same pair the other way round, for "Oops! 404" and "Sorry, error 410".
  + '|\\b(oops|sorry|error|unavailable|missing)\\b[\\s\\S]*\\b(404|410)\\b'
  + '|\\b(page|product|item)\\s+not\\s+found\\b'
  + '|^\\s*not\\s+found\\s*$'
  + '|\\bno\\s+longer\\s+available\\b'
  + '|\\bpage\\s+(?:does\\s*n.t|cannot\\s+be)\\s+(?:exist|found)\\b'
  /*
   * Parked and for-sale domains. Not a missing page exactly, but the same
   * failure for us: measured 2026-08-14, yetiuk.com returned 200 and a title of
   * "YetiUk.com is for sale | HugeDomains", which would have been researched as
   * a product. Typo'd URLs and dead brands land on these constantly.
   *
   * Anchored on a domain-shaped token before "is for sale" so a genuine
   * "Vintage Rug for Sale" product title is untouched.
   */
  + '|\\b[\\w-]+\\.(?:com|net|org|io|co|shop|store)\\b[^|]{0,20}\\bis\\s+for\\s+sale\\b'
  + '|\\bhugedomains\\b|\\bbuy\\s+this\\s+domain\\b|\\bdomain\\s+(?:is\\s+)?for\\s+sale\\b'
  + '|\\bparked\\s+(?:domain|free)\\b',
  'i'
);

function looksMissing(facts) {
  return !!(facts && facts.title && MISSING_TITLE_RE.test(String(facts.title)));
}

export async function resolveProduct(rawUrl, cost) {
  let url;
  try {
    url = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new Error(`Not a usable URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  const trail = [];

  const shop = await tryShopify(url);
  trail.push({ tier: 'shopify-json', ok: !!shop });
  if (shop && shop.title && !looksMissing(shop)) {
    /*
     * The products.json API answers with the product and nothing else: no
     * reviews, because reviews belong to whichever app the merchant installed
     * rather than to Shopify. This is also the tier that resolves FIRST and
     * therefore the one most Shopify merchants land on, so leaving it here
     * would have meant the majority of stores silently never contributed their
     * own customers' words.
     *
     * One extra GET of a page we are already talking to, and it can fail
     * without consequence: a product that resolved is still resolved.
     */
    const withReviews = await shopifyReviews(url);
    return { ...shop, reviews: withReviews, trail };
  }

  const direct = await fetchHtmlDirect(url);
  trail.push({ tier: 'direct', ok: !!direct.html, status: direct.status, blocked: direct.blocked });
  if (direct.html) {
    const facts = extract(direct.html, direct.finalUrl || url.href, 'direct');
    if (facts.title && !looksMissing(facts)) return { ...facts, trail };
    if (looksMissing(facts)) trail.push({ tier: 'direct', softNotFound: true });
  }

  // Higgsfield before Bright Data: we already pay for it, and it reads pages
  // our own fetch cannot. Also returns an hfProductId we can reuse to ground a
  // later render in the real product.
  if (hf.configured()) {
    const scraped = await hf.scrapeProduct(url.href);
    trail.push({ tier: 'higgsfield', ok: !!scraped });
    if (scraped && scraped.title && !looksMissing(scraped)) return { ...scraped, trail };
  } else {
    trail.push({ tier: 'higgsfield', ok: false, skipped: true });
  }

  // Only reach for new spend when everything free or already-paid has failed.
  if (direct.blocked || !direct.html) {
    const un = await fetchHtmlUnlocked(url, cost);
    trail.push({ tier: 'brightdata-unlocker', ok: !!un.html, skipped: !!un.skipped, status: un.status });
    if (un.html) {
      const facts = extract(un.html, url.href, 'brightdata-unlocker');
      if (facts.title && !looksMissing(facts)) return { ...facts, trail };
    }
  }

  const wb = await fetchHtmlWayback(url);
  trail.push({ tier: 'wayback', ok: !!wb });
  if (wb) {
    const facts = extract(wb, url.href, 'wayback');
    if (facts.title && !looksMissing(facts)) return { ...facts, trail };
  }

  return {
    source: 'unresolved',
    url: url.href,
    title: '',
    description: '',
    image: '',
    price: '',
    currency: '',
    vendor: url.hostname.replace(/^www\./, ''),
    type: '',
    tags: [],
    trail,
  };
}

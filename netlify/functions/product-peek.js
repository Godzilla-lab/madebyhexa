/* Product peek: read og/JSON-LD metadata from a customer-pasted product URL.
 *
 * GET /.netlify/functions/product-peek?url=<encoded>
 *
 * Always answers 200 with { ok, url, title, image, siteName, price, currency }
 * (nulls for anything not found); 400 only for a missing/unparseable url
 * param. The studio treats every non-ok result as "no data": the reveal flow
 * silently falls back to the generic chooser, so this endpoint must never
 * produce a customer-visible error.
 *
 * The in-memory cache is best-effort per warm instance; the real caching is
 * the CDN via Cache-Control.
 */

'use strict';

const dns = require('dns').promises;

const DEADLINE_MS = 5000;
const SHOPIFY_MS = 2000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 600 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new Map(); // url -> { ts, data }

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(data),
  };
}

/* ── SSRF guard ───────────────────────────────────────────────── */

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable: treat as unsafe
  return PRIVATE_V4.some(([base, bits]) => {
    const b = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  });
}

function isPrivateV6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
      v.startsWith('fea') || v.startsWith('feb')) return true;
  // v4-mapped: ::ffff:a.b.c.d
  const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateV4(m[1]);
  return false;
}

/* Returns a URL object if safe to fetch, else null. Run on the initial URL
 * and again on every redirect hop. */
async function guardUrl(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.')) return null; // localhost, intranet single labels
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return null;
  let addrs;
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); } catch (e) { return null; }
  if (!addrs || !addrs.length) return null;
  for (const a of addrs) {
    if (a.family === 4 && isPrivateV4(a.address)) return null;
    if (a.family === 6 && isPrivateV6(a.address)) return null;
  }
  return u;
}

/* ── Fetch with manual redirects + body cap ───────────────────── */

/* Real product pages sit behind bot filters that reject obvious bot UAs.
 * We identify as a normal browser; this is the same fetch a link unfurler
 * or a user's own browser would make, and we only read public metadata. */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

async function fetchHtml(startUrl, signal) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.href, {
      signal,
      redirect: 'manual',
      headers: BROWSER_HEADERS,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      const next = await guardUrl(loc, current.href);
      if (!next) return null;
      current = next;
      continue;
    }
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('text/html')) return null;

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});
    return { html: Buffer.concat(chunks.map(Buffer.from)).toString('utf8'), finalUrl: current.href };
  }
  return null;
}

/* ── Extraction ───────────────────────────────────────────────── */

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 10), 0x10ffff)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/* <meta property="og:x" content="..."> in either attribute order. */
function metaContent(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp('<meta[^>]+(?:property|name)\\s*=\\s*["\']' + k + '["\'][^>]+content\\s*=\\s*["\']([^"\']+)["\']', 'i'),
    new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']+)["\'][^>]+(?:property|name)\\s*=\\s*["\']' + k + '["\']', 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function jsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let doc;
    try { doc = JSON.parse(m[1]); } catch (e) { continue; }
    const nodes = [];
    const push = (n) => { if (n && typeof n === 'object') nodes.push(n); };
    if (Array.isArray(doc)) doc.forEach(push);
    else { push(doc); if (Array.isArray(doc['@graph'])) doc['@graph'].forEach(push); }
    for (const n of nodes) {
      const t = n['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.some((x) => typeof x === 'string' && x.toLowerCase() === 'product')) out.push(n);
    }
  }
  return out;
}

function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) for (const x of v) { const s = firstString(x); if (s) return s; }
  if (v && typeof v === 'object' && typeof v.url === 'string') return v.url;
  return null;
}

/* ── Image extraction ──────────────────────────────────────────
 * Try structured + social tags, JSON-LD, Shopify CDN images, then any
 * prominent page image. Upgrade http/protocol-relative URLs to https (the
 * site CSP only loads https images). Returns the best candidate or null. */
function absHttps(u, pageUrl) {
  if (!u) return null;
  u = decodeEntities(String(u)).trim();
  if (u.indexOf('//') === 0) u = 'https:' + u;
  try {
    const abs = new URL(u, pageUrl);
    if (abs.protocol === 'http:') abs.protocol = 'https:';
    if (abs.protocol !== 'https:') return null;
    return abs.href.length <= 2048 ? abs.href : null;
  } catch (e) { return null; }
}

const BAD_IMG = /sprite|logo|favicon|icon-|placeholder|blank|spacer|1x1|loading|swatch|avatar|badge|\bpixel\b|\.svg(\?|$)/i;

function bestImage(html, pageUrl, product) {
  const raw = [];
  const push = (u) => { if (u) raw.push(u); };
  // 1) structured + social: the canonical product image lives here
  push(metaContent(html, 'og:image:secure_url'));
  push(metaContent(html, 'og:image:url'));
  push(metaContent(html, 'og:image'));
  push(metaContent(html, 'twitter:image'));
  push(metaContent(html, 'twitter:image:src'));
  push(metaContent(html, 'msapplication-TileImage'));
  if (product) push(firstString(product.image));
  jsonLdProducts(html).forEach((p) => { if (p && p.image) push(firstString(p.image)); });
  const link = html.match(/<link[^>]+rel\s*=\s*["']image_src["'][^>]+href\s*=\s*["']([^"']+)["']/i);
  if (link) push(link[1]);
  const itemprop = html.match(/itemprop\s*=\s*["']image["'][^>]*(?:content|src)\s*=\s*["']([^"']+)["']/i);
  if (itemprop) push(itemprop[1]);
  // 2) Shopify CDN images embedded in the HTML (JS-only themes still ship these)
  const shop = html.match(/(?:https?:)?\/\/[^"'\s)]*cdn\.shopify\.com\/[^"'\s)]+\.(?:jpe?g|png|webp)(?:\?[^"'\s)]*)?/gi);
  if (shop) shop.slice(0, 12).forEach(push);
  // 3) any prominent <img> (src / data-src / srcset) as a last resort
  (html.match(/<img[^>]+>/gi) || []).slice(0, 100).forEach((tag) => {
    const s = tag.match(/\b(?:data-src|data-original|src)\s*=\s*["']([^"']+)["']/i);
    if (s) push(s[1]);
    const ss = tag.match(/\b(?:data-srcset|srcset)\s*=\s*["']([^"']+)["']/i);
    if (ss) push(ss[1].split(',').pop().trim().split(/\s+/)[0]); // largest in a srcset
  });
  // normalize, dedupe, drop junk; source order keeps the best (structured) first
  const seen = new Set();
  for (const u of raw) {
    const abs = absHttps(u, pageUrl);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    if (BAD_IMG.test(abs)) continue;
    return abs;
  }
  return null;
}

function extract(html, pageUrl) {
  const products = jsonLdProducts(html);
  const product = products[0] || null;

  let title = metaContent(html, 'og:title') ||
    (product && firstString(product.name)) ||
    metaContent(html, 'twitter:title');
  if (!title) {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) title = m[1];
  }
  title = title ? decodeEntities(title).slice(0, 90) : null;

  let image = bestImage(html, pageUrl, product);

  let siteName = metaContent(html, 'og:site_name') ||
    (product && product.brand && firstString(product.brand.name || product.brand));
  if (!siteName) {
    try { siteName = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (e) { siteName = null; }
  }
  siteName = siteName ? decodeEntities(siteName).slice(0, 60) : null;

  let price = null;
  let currency = null;
  if (product && product.offers) {
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    for (const o of offers) {
      if (!o || typeof o !== 'object') continue;
      const p = o.price != null ? o.price : o.lowPrice;
      if (p != null && String(p).trim() !== '') {
        price = String(p).trim().slice(0, 20);
        currency = typeof o.priceCurrency === 'string' ? o.priceCurrency.slice(0, 8) : null;
        break;
      }
    }
  }
  if (!price) {
    const p = metaContent(html, 'product:price:amount') || metaContent(html, 'og:price:amount');
    if (p) {
      price = p.slice(0, 20);
      currency = metaContent(html, 'product:price:currency') || metaContent(html, 'og:price:currency') || currency;
      if (currency) currency = currency.slice(0, 8);
    }
  }
  if (!price) {
    const m = html.match(/itemprop\s*=\s*["']price["'][^>]+content\s*=\s*["']([^"']+)["']/i);
    if (m) price = m[1].slice(0, 20);
  }

  if (/(^|\.)amazon\./i.test(new URL(pageUrl).hostname)) {
    if (title) title = title.replace(/^amazon(\.[a-z.]+)?\s*[:,-]\s*/i, '').trim() || title;
    siteName = 'Amazon';
  }

  return { title, image, siteName, price, currency };
}

/* ── Strategy: Shopify product JSON ───────────────────────────────
 * Most DTC stores are Shopify, and every Shopify product page exposes
 * /products/<handle>.js: public JSON with title, vendor, price and images.
 * It works even when the HTML is a JS-only theme or behind a bot check. */
function shopifyHandle(u) {
  const m = u.pathname.match(/\/products\/([a-z0-9-_.]+?)(?:\.js(?:on)?)?$/i);
  return m ? m[1] : null;
}

async function tryShopifyJson(target, signal) {
  const handle = shopifyHandle(target);
  if (!handle) return null;
  const jsUrl = await guardUrl(target.origin + '/products/' + handle + '.js');
  if (!jsUrl) return null;
  try {
    const res = await fetch(jsUrl.href, {
      signal,
      redirect: 'manual',
      headers: { ...BROWSER_HEADERS, 'Accept': 'application/json,*/*;q=0.8' },
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('json') && !type.includes('javascript')) return null;
    const p = await res.json();
    if (!p || typeof p !== 'object' || !p.title) return null;
    let image = null;
    const cand = (p.images && p.images[0]) || p.featured_image || null;
    if (cand) {
      try {
        const abs = new URL(String(cand).replace(/^\/\//, 'https://'), target.origin);
        if (abs.protocol === 'https:') image = abs.href;
      } catch (e) { /* ignore */ }
    }
    // Shopify .js prices are in cents
    let price = null;
    if (typeof p.price === 'number') price = String(Math.round(p.price) / 100);
    return {
      title: String(p.title).slice(0, 90),
      image,
      siteName: (p.vendor && String(p.vendor).slice(0, 60)) || target.hostname.replace(/^www\./, ''),
      price,
      currency: null,
    };
  } catch (e) {
    return null;
  }
}

/* ── Strategy: read the URL itself ────────────────────────────────
 * When a page will not talk to us at all, the URL still names the
 * product. "wool-runners-2" on allbirds.com is a real answer; it keeps
 * the flow personal instead of collapsing to the generic chooser. */
const SLUG_STOPWORDS = /^(dp|gp|product|products|item|itm|p|ref|sku|b0[a-z0-9]{6,})$/i;

function slugGuess(target) {
  const host = target.hostname.replace(/^www\./, '');
  const isAmazon = /(^|\.)amazon\./i.test(target.hostname);
  const segs = target.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let best = null;
  for (const seg of segs) {
    const clean = seg.replace(/\.(html?|php|aspx?)$/i, '');
    if (SLUG_STOPWORDS.test(clean)) continue;
    if (!/[a-z]/i.test(clean)) continue;
    const words = clean.split(/[-_+]+/).filter((w) => w && !/^\d+$/.test(w));
    if (words.length < (isAmazon ? 2 : 1)) continue;
    if (!best || words.length > best.length) best = words;
  }
  if (!best) {
    // homepage or opaque path: the domain is still a brand name
    const label = host.split('.')[0].replace(/[-_]+/g, ' ');
    if (!/[a-z]/i.test(label)) return null;
    const brand = label.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
    return { title: brand, image: null, siteName: host, price: null, currency: null };
  }
  const title = best.slice(0, 10).join(' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 90);
  const siteName = isAmazon ? 'Amazon' : host;
  return { title, image: null, siteName, price: null, currency: null };
}

/* ── Handler ──────────────────────────────────────────────────── */

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false });

  // Higgsfield product-scrape poll: the fallback image for sites that block our
  // direct fetch (bot-protected DTC stores). The initial peek returns a
  // webProductId; the client polls here until the scrape finishes and its
  // re-hosted product image is ready. GET ?webProduct=<id>
  const wpId = event.queryStringParameters && event.queryStringParameters.webProduct;
  if (wpId) {
    try {
      const hf = require('./lib/hf');
      if (!hf.configured()) return json(200, { ok: false, ready: true });
      const wp = await hf.getWebProduct(wpId);
      const media = wp && Array.isArray(wp.medias) && wp.medias[0];
      const image = media && /^https:\/\//i.test(media.url || '') ? media.url : null;
      const status = (wp && wp.status) || '';
      const done = !!image || /complet|ready|success|failed|error/i.test(status);
      // only surface the scraped title when it is a real name, not the host echo
      let title = wp && wp.title ? String(wp.title) : null;
      if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title.trim())) title = null;
      return json(200, { ok: !!image, ready: done, image, title: title ? title.slice(0, 90) : null });
    } catch (e) {
      return json(200, { ok: false, ready: false });
    }
  }

  const raw = (event.queryStringParameters && event.queryStringParameters.url) || '';
  if (!raw) return json(400, { ok: false });

  const nothing = { ok: false, url: raw, title: null, image: null, siteName: null, price: null, currency: null };

  const hit = cache.get(raw);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return json(200, hit.data);

  const target = await guardUrl(raw);
  if (!target) return json(200, nothing);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);

  // The engine's own scrape starts immediately, in parallel with our read:
  // by the time the customer pays, the web product id grounds the render in
  // the real product. Creating one is ~1s and free; failures never block.
  let webProductPromise = Promise.resolve(null);
  try {
    const hf = require('./lib/hf');
    if (hf.configured()) {
      webProductPromise = hf.createWebProduct(target.href).catch((e) => {
        console.log('[product-peek] grounding create failed:', e && e.message);
        return null;
      });
    }
  } catch (e) { /* lib unavailable: skip grounding */ }

  let data = nothing;
  try {
    // 1) Shopify product JSON: exact title, image and price when available
    const shopCtl = new AbortController();
    const shopTimer = setTimeout(() => shopCtl.abort(), SHOPIFY_MS);
    const shop = await tryShopifyJson(target, shopCtl.signal).finally(() => clearTimeout(shopTimer));
    if (shop) {
      data = { ok: true, url: raw, ...shop };
    } else {
      // 2) the page's own metadata (og / JSON-LD / title tag)
      const page = await fetchHtml(target, controller.signal);
      if (page) {
        const fields = extract(page.html, page.finalUrl);
        if (fields.title || fields.image) data = { ok: true, url: raw, ...fields };
      }
    }
  } catch (e) {
    // timeouts, TLS failures, aborts: fall through to the URL itself
  } finally {
    clearTimeout(timer);
  }

  // 3) blocked or silent pages: the URL still names the product
  if (!data.ok) {
    const guess = slugGuess(target);
    if (guess) data = { ok: true, url: raw, guessed: true, ...guess };
  }

  if (data.ok) {
    // Never let grounding hold the customer-facing response hostage: give the
    // create call a short budget, then answer with what we have. The scrape
    // keeps running server-side either way; render-create re-resolves it.
    // Exception: when we have no image (blocked page), the grounding id IS
    // the image path (the client polls it for the re-hosted photo), so it
    // gets a longer budget; a cold token mint alone can eat the short one.
    const budget = data.image ? 1500 : 4500;
    const wp = await Promise.race([
      webProductPromise,
      new Promise((r) => setTimeout(() => r(null), budget)),
    ]);
    if (wp && wp.id) data.webProductId = wp.id;
  }

  cache.set(raw, { ts: Date.now(), data });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return json(200, data);
};

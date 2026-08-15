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
const unlocker = require('./lib/unlocker');
const { allow } = require('./lib/ratelimit');

const DEADLINE_MS = 5000;
const SHOPIFY_MS = 2000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 600 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

const cache = new Map(); // url -> { ts, data }

/* Scraped product images are large cold PNGs on Higgsfield's CloudFront
 * (10s+ first load). Serve them through the Netlify Image CDN instead:
 * small cached webp, same-origin. Hosts must match netlify.toml
 * [images].remote_images. */
const CDN_IMAGE_HOSTS = /^https:\/\/(d2ol7oe51mr4n9|d8j0ntlcm91z4)\.cloudfront\.net\//i;

/* One Blobs key per URL for the unlocked read, shared by the peek, the poll
 * and the background worker. A page is unlocked once for everybody. */
function unlockKey(href) {
  return 'unlock:' + href;
}

function cdnImage(u) {
  if (!u || !CDN_IMAGE_HOSTS.test(u)) return u;
  return '/.netlify/images?url=' + encodeURIComponent(u) + '&w=560&fit=cover&fm=webp';
}

/* Social posts are not product pages: no price, no clean product image, and
 * the engine's scraper cannot ground a render in them. Recognize them so the
 * UI can say so honestly instead of showing slug gibberish. */
const SOCIAL_HOSTS = {
  'instagram.com': 'Instagram', 'tiktok.com': 'TikTok', 'facebook.com': 'Facebook',
  'fb.com': 'Facebook', 'x.com': 'X', 'twitter.com': 'X', 'youtube.com': 'YouTube',
  'youtu.be': 'YouTube', 'threads.net': 'Threads', 'snapchat.com': 'Snapchat',
  'pinterest.com': 'Pinterest', 'reddit.com': 'Reddit',
};

function socialLabel(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  for (const key of Object.keys(SOCIAL_HOSTS)) {
    if (h === key || h.endsWith('.' + key)) return SOCIAL_HOSTS[key];
  }
  return null;
}

/* ── Meta links carry the brand in the URL itself ─────────────────
 * Nobody can scrape Facebook or Instagram (they serve a JS shell, and even
 * the engine's scraper fails), but small brands live there, so their links
 * land here anyway. Two things ARE public: the Graph picture endpoint
 * serves any page's photo tokenless (by id or username), and the URL path
 * names the account. An Ads Library link even carries the brand's page id.
 * Resolve what we can; guessed:true lets the customer fix the name inline. */
const FB_RESERVED = /^(marketplace|groups|watch|gaming|events|people|reel|reels|stories|share|sharer(\.php)?|photo(\.php)?|permalink\.php|story\.php|login|home\.php|help|business|legal|settings|friends|messages|notifications|search|hashtag|dialog|plugins|media|notes|live|games|fundraisers|places|posts)$/i;
const IG_RESERVED = /^(p|reel|reels|stories|tv|explore|accounts|direct|about|developer|legal|web|challenge)$/i;

function prettyHandle(s) {
  const words = decodeURIComponent(s).replace(/[._-]+/g, ' ').trim();
  if (!/[a-z]/i.test(words)) return null;
  return words.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 90);
}

async function socialResolve(target, label) {
  const segs = target.pathname.split('/').filter(Boolean);
  if (label === 'Facebook') {
    let id = null;
    let name = null;
    const pageIdParam = target.searchParams.get('view_all_page_id');
    if (segs[0] === 'ads' && pageIdParam && /^\d+$/.test(pageIdParam)) {
      id = pageIdParam;
    } else if (segs[0] === 'profile.php' && /^\d+$/.test(target.searchParams.get('id') || '')) {
      id = target.searchParams.get('id');
    } else if (segs[0] === 'pages' && segs[1]) {
      name = prettyHandle(segs[1]);
      if (segs[2] && /^\d+$/.test(segs[2])) id = segs[2];
    } else if (segs[0] === 'pg' && segs[1] && !FB_RESERVED.test(segs[1])) {
      id = segs[1];
      name = prettyHandle(segs[1]);
    } else if (segs[0] && segs[0] !== 'ads' && !FB_RESERVED.test(segs[0]) && /^[a-z0-9.]+$/i.test(segs[0])) {
      id = segs[0];
      if (!/^\d+$/.test(segs[0])) name = prettyHandle(segs[0]);
    }
    if (!id && !name) return null;
    let image = null;
    if (id) {
      // roomier budget than page images: this runs as the LAST hope for a
      // Meta link, and a cold TLS handshake to graph alone can eat 2s
      image = await validateImage('https://graph.facebook.com/' + encodeURIComponent(id) + '/picture?width=720', 4000);
    }
    if (!name && id && /^\d+$/.test(id)) {
      // a bare page id (Ads Library, profile.php): the page's own og:title
      // names the brand. Residential networks get it; when Facebook walls
      // off our datacenter this just falls through to the fixable chip.
      try {
        const pageUrl = await guardUrl('https://www.facebook.com/' + id);
        if (pageUrl) {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 3500);
          const page = await fetchHtml(pageUrl, ctl.signal).finally(() => clearTimeout(t));
          if (page) {
            const og = extract(page.html, page.finalUrl);
            if (og.title && og.title !== 'Facebook') name = og.title.replace(/\s*\|\s*Facebook\s*$/i, '').slice(0, 90);
          }
        }
      } catch (e) { /* walled off: the photo still identifies the brand */ }
    }
    if (!image && !name) return null;
    return { title: name, image, siteName: 'Facebook', price: null, currency: null };
  }
  if (label === 'Instagram') {
    const h = segs[0];
    if (!h || IG_RESERVED.test(h) || !/^[a-z0-9._]{2,30}$/i.test(h)) return null;
    const name = prettyHandle(h);
    if (!name) return null;
    return { title: name, image: null, siteName: 'Instagram', price: null, currency: null };
  }
  return null;
}

function json(statusCode, data, cacheControl) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl || 'public, max-age=300',
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
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
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
  // A bot-wall's page title is not a product name. Dropping it lets the
  // caller fall through to the archive copy or the slug guess instead of
  // shipping "Robot or human?" as somebody's product.
  if (title && /robot or human|access denied|just a moment|attention required|are you (a )?human|verify (you|yourself)|captcha|page not found|error \d{3}/i.test(title)) {
    title = null;
  }

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
  let jsUrl = await guardUrl(target.origin + '/products/' + handle + '.js');
  if (!jsUrl) return null;
  try {
    // follow up to two guarded redirects: stores commonly 301 apex -> www
    let res;
    for (let hop = 0; hop <= 2; hop++) {
      res = await fetch(jsUrl.href, {
        signal,
        redirect: 'manual',
        headers: { ...BROWSER_HEADERS, 'Accept': 'application/json,*/*;q=0.8' },
      });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get('location');
      if (!loc) return null;
      jsUrl = await guardUrl(loc, jsUrl.href);
      if (!jsUrl) return null;
    }
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

/* ── Strategy: Kickstarter widget card ────────────────────────────
 * Kickstarter hard-blocks page reads (ours 403s, and even the engine's
 * scraper fails with not_enough_data). But its embeddable widget card is
 * MEANT to be fetched by other sites, answers without a bot check, and
 * carries the campaign photo and title. */
const KICKSTARTER_HOST = /(^|\.)kickstarter\.com$/i;

async function tryKickstarterCard(target, signal) {
  if (!KICKSTARTER_HOST.test(target.hostname)) return null;
  const m = target.pathname.match(/^\/projects\/([^/]+)\/([^/?#]+)/);
  if (!m) return null;
  const cardUrl = 'https://www.kickstarter.com/projects/' + m[1] + '/' + m[2] + '/widget/card.html';
  try {
    const res = await fetch(cardUrl, { signal, redirect: 'follow', headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const t = html.match(/<title>([^<]+)<\/title>/i);
    const img = html.match(/<img[^>]+src\s*=\s*"([^"]+)"/i);
    let title = t ? decodeEntities(t[1]).replace(/\s+[-·|]\s+Kickstarter.*$/i, '').replace(/\.+$/, '').trim() : null;
    if (title) title = title.slice(0, 90);
    let image = img ? decodeEntities(img[1]) : null;
    if (image && !/^https:\/\//i.test(image)) image = null;
    if (!title && !image) return null;
    return { title, image, siteName: 'Kickstarter', price: null, currency: null };
  } catch (e) {
    return null;
  }
}

/* Page markup lies (tracking beacons in <img> tags, expired signed URLs,
 * moved CDNs). Whatever strategy found the image, trust it only if it still
 * answers as an image. One ranged byte, ~150ms on healthy CDNs. */
async function validateImage(url, budgetMs) {
  try {
    const ic = new AbortController();
    const it = setTimeout(() => ic.abort(), budgetMs || 1800);
    const probe = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Range: 'bytes=0-0', Accept: 'image/*,*/*;q=0.5' },
      signal: ic.signal,
    });
    clearTimeout(it);
    if (probe.body) probe.body.cancel().catch(() => {});
    const ct = (probe.headers.get('content-type') || '').toLowerCase();
    if (!probe.ok || !(ct.startsWith('image/') || ct === 'application/octet-stream')) return null;
    // a 200 that is a 1px placeholder is a "no": real product shots are KBs.
    // 206 => the total is after the slash in content-range; a full 200 =>
    // content-length IS the total (on 206 content-length is just our 1 byte).
    const total = probe.status === 206
      ? parseInt((probe.headers.get('content-range') || '').split('/')[1], 10) || null
      : parseInt(probe.headers.get('content-length') || '', 10) || null;
    if (total !== null && total > 0 && total < 500) return null;
    return url;
  } catch (e) {
    return null;
  }
}

/* ── Strategy: the Internet Archive's copy ────────────────────────
 * Generic fallback for ANY guarded page: the Wayback Machine has a crawl of
 * almost every popular product page, blocks nobody, and its id_ variant
 * returns the ORIGINAL html, so the og/JSON-LD extraction runs unchanged.
 * The metadata can be weeks old; for a product name and photo that is fine,
 * and a dead archived image URL is healed client-side by peekImageFailed. */
async function tryWayback(target, extract_, signal) {
  try {
    const av = await fetch('https://archive.org/wayback/available?url=' + encodeURIComponent(target.href), { signal });
    if (!av.ok) return null;
    const j = await av.json().catch(() => null);
    const snap = j && j.archived_snapshots && j.archived_snapshots.closest;
    if (!snap || !snap.available || !snap.url) return null;
    const snapUrl = String(snap.url)
      .replace(/^http:/, 'https:')
      .replace(/\/(\d{14})\//, '/$1id_/');
    const res = await fetch(snapUrl, { signal, redirect: 'follow', headers: BROWSER_HEADERS });
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
    const html = Buffer.concat(chunks.map(Buffer.from)).toString('utf8');
    const fields = extract_(html, target.href);
    if (!fields.title && !fields.image) return null;
    // archive-rewritten asset URLs still slip through on some snapshots;
    // strip the wrapper so the browser loads the original image directly
    if (fields.image) {
      const m = fields.image.match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:im_)?\/(https?:\/\/.+)$/i);
      if (m) fields.image = m[1];
    }
    if (fields.image) fields.image = await validateImage(fields.image);
    if (!fields.title && !fields.image) return null;
    return fields;
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

/* ── Bright Data leg ──────────────────────────────────────────────
 * Reading the cache is cheap and safe from anywhere; writing it and paying
 * for the unlock happens in product-unlock-background, which has minutes to
 * work with instead of this function's ten seconds. */
async function readUnlocked(href) {
  try {
    const { getStore } = require('@netlify/blobs');
    const rec = await getStore('peeks').get(unlockKey(href), { type: 'json' });
    return rec && rec.image ? rec : null;
  } catch (e) {
    return null;
  }
}

/*
 * Kick off the unlock worker.
 *
 * This IS awaited, and it has to be. "Fire and forget" is not a thing in a
 * Lambda: the container is frozen the moment the handler returns, so an
 * unawaited fetch is simply never sent. Measured on a live draft 2026-08-13,
 * with the token present, the secret present and the URL correct, the worker
 * still only ever ran when invoked by hand. Awaiting costs almost nothing,
 * because a background function answers 202 immediately and does its real work
 * after we are gone. render-status awaits its stitcher invoke for exactly the
 * same reason.
 */
async function startUnlock(href, event) {
  if (!unlocker.configured() || !process.env.WEBHOOK_SECRET) return;
  /*
   * Self-invoke on the host that served THIS request, taken from the request
   * itself rather than from the environment.
   *
   * The env route does not survive contact with reality: process.env.URL is
   * always the production address, and DEPLOY_URL is a build variable that is
   * not reliably present in the function runtime. A draft that fell back to URL
   * posted its work at the live site, where a brand new function does not exist
   * yet, got a 404, and swallowed it. Measured on a live draft 2026-08-13: the
   * background worker only ever ran when invoked by hand.
   *
   * The host header is the one thing that is always correct for the deploy
   * actually handling the request.
   */
  const h = event && event.headers ? event.headers : {};
  const host = h['x-forwarded-host'] || h['X-Forwarded-Host'] || h.host || h.Host;
  const base = host
    ? 'https://' + String(host).replace(/\/$/, '')
    : (process.env.DEPLOY_URL || process.env.URL || '').replace(/\/$/, '');
  if (!base) return;
  await fetch(base + '/.netlify/functions/product-unlock-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-unlock-key': process.env.WEBHOOK_SECRET },
    body: JSON.stringify({ url: href }),
  }).catch(function (e) { console.log('[product-peek] unlock invoke failed:', e.message); });
}

/* ── Handler ──────────────────────────────────────────────────── */

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'GET') return json(405, { ok: false });

  // Higgsfield product-scrape poll: the fallback image for sites that block our
  // direct fetch (bot-protected DTC stores). The initial peek returns a
  // webProductId; the client polls here until the scrape finishes and its
  // re-hosted product image is ready. GET ?webProduct=<id>
  /* Guarded self-check. Answers "is the Bright Data leg actually armed in this
   * runtime", which is otherwise invisible: startUnlock is fire-and-forget by
   * design, so every way it can fail fails silently. Requires the shared
   * secret, so it tells the public nothing. */
  if (event.queryStringParameters && event.queryStringParameters.diag) {
    const given = (event.headers && (event.headers['x-unlock-key'] || event.headers['X-Unlock-Key'])) || '';
    if (!process.env.WEBHOOK_SECRET || given !== process.env.WEBHOOK_SECRET) return json(404, { ok: false });
    const h = event.headers || {};
    return json(200, {
      unlockerConfigured: unlocker.configured(),
      hasWebhookSecret: !!process.env.WEBHOOK_SECRET,
      hasBrightToken: !!process.env.BRIGHTDATA_API_TOKEN,
      hasBrightZone: !!process.env.BRIGHTDATA_UNLOCKER_ZONE,
      envUrl: process.env.URL || null,
      envDeployUrl: process.env.DEPLOY_URL || null,
      hostHeader: h['x-forwarded-host'] || h.host || null,
    }, 'no-store');
  }

  const wpId = event.queryStringParameters && event.queryStringParameters.webProduct;

  /*
   * Two very different costs behind one endpoint, so two very different limits.
   *
   * A paste (?url=) starts an engine scrape and can invoke the Bright Data
   * unlocker at $0.0015 a call, so an unlimited peek is a way to spend our
   * money from a browser with no account. A poll (?webProduct=) is one cheap
   * status read, but the studio polls it every couple of seconds for up to
   * three minutes, so a single honest customer legitimately makes ~90 calls.
   * One shared bucket would either bankrupt us or cut off a paying user
   * mid-render; these numbers are set so neither happens.
   */
  const limited = wpId
    ? !(await allow('peek-poll', event, 3000))
    : !(await allow('peek', event, 300));
  if (limited) {
    return json(429, { ok: false, error: 'Too many requests. Give it a minute and try again.' }, 'no-store');
  }

  if (wpId) {
    /*
     * NEVER cacheable. This is a polling endpoint: the client asks the same URL
     * over and over precisely because the answer is expected to change. The
     * shared json() helper defaults to a five minute public cache, which meant
     * the browser and the CDN pinned the FIRST answer, always "not ready yet",
     * and re-served it for five minutes. The photo could not arrive however
     * fast we fetched it, which is exactly the "it only works after a while"
     * behaviour: it worked when the cache finally expired. Measured on a live
     * draft 2026-08-13, cache-control: public,max-age=300 on a poll response.
     */
    const NO_CACHE = 'no-store, max-age=0';

    // Bright Data usually beats the engine to it. The unlocked read lands in
    // 5 to 10 seconds where the engine scrape takes 10 to 60 and frequently
    // fails outright, so whatever the background worker has already cached is
    // checked before asking the engine anything. GET ?webProduct=<id>&url=<href>
    const pollUrl = (event.queryStringParameters && event.queryStringParameters.url) || '';
    if (pollUrl) {
      const un = await readUnlocked(pollUrl);
      if (un && un.image) {
        return json(200, { ok: true, ready: true, failed: false, image: un.image, title: un.title || null }, NO_CACHE);
      }
    }
    try {
      const hf = require('./lib/hf');
      if (!hf.configured()) return json(200, { ok: false, ready: true }, NO_CACHE);
      const wp = await hf.getWebProduct(wpId);
      const media = wp && Array.isArray(wp.medias) && wp.medias[0];
      const image = media && /^https:\/\//i.test(media.url || '') ? cdnImage(media.url) : null;
      const status = (wp && wp.status) || '';
      const done = !!image || /complet|ready|success|failed|error/i.test(status);
      // only surface the scraped title when it is a real name, not the host echo
      let title = wp && wp.title ? String(wp.title) : null;
      if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title.trim())) title = null;
      // failed: the scrape finished with nothing. Tell the client plainly so
      // it can ask for a fresh attempt instead of waiting forever.
      return json(200, { ok: !!image, ready: done, failed: done && !image, image, title: title ? title.slice(0, 90) : null }, NO_CACHE);
    } catch (e) {
      return json(200, { ok: false, ready: false }, NO_CACHE);
    }
  }

  const raw = (event.queryStringParameters && event.queryStringParameters.url) || '';
  if (!raw) return json(400, { ok: false });

  // rescrape=1: the client saw the remembered scrape finish empty and is
  // asking for one fresh attempt. Bypass caches and start a new scrape.
  const rescrape = !!(event.queryStringParameters && event.queryStringParameters.rescrape);

  const nothing = { ok: false, url: raw, title: null, image: null, siteName: null, price: null, currency: null };

  const hit = cache.get(raw);
  if (hit && !rescrape && Date.now() - hit.ts < (hit.ttl || CACHE_TTL_MS)) return json(200, hit.data);

  // Links copied out of Facebook/Instagram/Messenger arrive wrapped in the
  // l.facebook.com shim; unwrap to the real destination before anything else.
  let unwrapped = raw;
  try {
    const shim = new URL(raw);
    if (/^(l|lm)\.(facebook|instagram|messenger)\.com$/i.test(shim.hostname)) {
      const u = shim.searchParams.get('u');
      if (u && /^https?:\/\//i.test(u)) unwrapped = u;
    }
  } catch (e) { /* not parseable here: guardUrl decides */ }

  const target = await guardUrl(unwrapped);
  if (!target) return json(200, nothing);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);

  // The engine's own scrape starts immediately, in parallel with our read:
  // by the time the customer pays, the web product id grounds the render in
  // the real product. Creating one is ~1s and free; failures never block.
  // One scrape per URL, remembered in Blobs: heavy pages (Indiegogo) take the
  // engine minutes, far longer than a page visit. The first paste starts the
  // scrape; any later paste of the same URL finds it finished and gets the
  // real image + title inline, no client polling needed.
  let peekStore = null;
  try {
    const { getStore } = require('@netlify/blobs');
    peekStore = getStore('peeks');
  } catch (e) { /* no blobs: grounding still works, just without reuse */ }
  const wpKey = 'wp:' + target.href;
  let knownWpId = null;
  if (peekStore) {
    try { knownWpId = await peekStore.get(wpKey); } catch (e) { /* ignore */ }
  }

  const social = socialLabel(target.hostname);

  let webProductPromise = Promise.resolve(null);
  let inlineScrapePromise = null; // known scrape fetched in parallel with the page read
  try {
    const hf = require('./lib/hf');
    if (hf.configured() && !social) {
      const startFresh = () => hf.createWebProduct(target.href).then(async (wp) => {
        if (wp && wp.id && peekStore) {
          try { await peekStore.set(wpKey, wp.id); } catch (e) { /* ignore */ }
        }
        return wp;
      }).catch((e) => {
        console.log('[product-peek] grounding create failed:', e && e.message);
        return null;
      });
      if (knownWpId && !rescrape) {
        const known = hf.getWebProduct(knownWpId).catch(() => null);
        inlineScrapePromise = known;
        // A remembered scrape that finished with nothing is not worth keeping:
        // forget it and start over, otherwise this URL can never get a photo.
        webProductPromise = known.then((wp) => {
          const media = wp && Array.isArray(wp.medias) && wp.medias[0];
          const dead = !media && (!wp || /complet|ready|success|failed|error/i.test(wp.status || ''));
          if (!dead) return { id: knownWpId };
          if (peekStore) { try { peekStore.delete(wpKey); } catch (e) { /* ignore */ } }
          return startFresh();
        });
      } else {
        if (rescrape && knownWpId && peekStore) {
          try { await peekStore.delete(wpKey); } catch (e) { /* ignore */ }
        }
        webProductPromise = startFresh();
      }
    }
  } catch (e) { /* lib unavailable: skip grounding */ }

  let data = nothing;
  try {
    // 0) Kickstarter: the project page is unreadable, the widget card is not
    const ks = await tryKickstarterCard(target, controller.signal);
    if (ks) {
      data = { ok: true, url: raw, ...ks };
    } else {
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
          if (fields.image) fields.image = await validateImage(fields.image);
          if (fields.title || fields.image) data = { ok: true, url: raw, ...fields };
        }
      }
    }
  } catch (e) {
    // timeouts, TLS failures, aborts: fall through to the URL itself
  } finally {
    clearTimeout(timer);
  }

  // 2a) Amazon without a photo: the ancient media endpoint still serves the
  // primary product shot straight from the ASIN in the URL, no page read.
  if ((!data.ok || !data.image) && /(^|\.)amazon\./i.test(target.hostname)) {
    const asin = (target.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i) || [])[1];
    if (asin) {
      const shot = await validateImage('https://images-na.ssl-images-amazon.com/images/P/' + asin.toUpperCase() + '.01._SL500_.jpg');
      if (shot) {
        if (data.ok) data.image = shot;
        else data = { ok: true, url: raw, title: null, image: shot, siteName: 'Amazon', price: null, currency: null };
      }
    }
  }

  /*
   * 2a-bis) The store refused us. This is the common case, not the edge one:
   * about a third of real DTC storefronts will not answer a datacenter fetch,
   * and their Shopify JSON is walled with them, so there is nothing free left
   * to try. Bright Data reads the page as a residential visitor and gets the
   * real metadata.
   *
   * It is NOT raced inline here. The unlocker needs 5 to 10 seconds and this
   * function dies at 10, so an inline attempt short enough to be safe is also
   * short enough to lose almost every time, and losing still costs a call. So
   * the work is handed to the background worker and the paste returns now; the
   * client is already polling and picks the photo up seconds later.
   *
   * A read that already happened is free and instant, so that is checked first.
   * Cached per URL, which means a product page is unlocked once for every
   * customer who ever pastes it, not once per visitor.
   */
  if (!social && !data.image && unlocker.configured()) {
    const cachedUnlock = await readUnlocked(target.href);
    if (cachedUnlock && cachedUnlock.image) {
      data = {
        ok: true,
        url: raw,
        title: (data.ok && data.title && !data.guessed) ? data.title : (cachedUnlock.title || data.title || null),
        image: cachedUnlock.image,
        siteName: (data.ok && data.siteName) || cachedUnlock.siteName || null,
        price: (data.ok && data.price) || cachedUnlock.price || null,
        currency: (data.ok && data.currency) || cachedUnlock.currency || null,
      };
      delete data.guessed;
    } else {
      await startUnlock(target.href, event);
    }
  }

  // 2b) guarded page, no photo yet: the Internet Archive's copy of the same
  // page usually carries the metadata the live page refused to give us.
  // Runs for any host; social links are excluded (a post is not a product).
  if (!social && (!data.ok || !data.image)) {
    const wbCtl = new AbortController();
    const wbTimer = setTimeout(() => wbCtl.abort(), 5200);
    const wb = await tryWayback(target, extract, wbCtl.signal);
    clearTimeout(wbTimer);
    if (wb) {
      data = {
        ok: true,
        url: raw,
        title: (data.ok && data.title) || wb.title,
        image: (data.ok && data.image) || wb.image,
        siteName: (data.ok && data.siteName) || wb.siteName,
        price: (data.ok && data.price) || wb.price,
        currency: (data.ok && data.currency) || wb.currency,
      };
    }
  }

  // Social link: never pretend it is a product page, but resolve the brand
  // when the URL itself names it (page id, username, handle). A page read
  // that only echoed the platform's name ("Facebook") counts as nothing.
  if (social) {
    if (data.ok && data.title) {
      // page reads that DO get through return boilerplate around the brand:
      // "Nike (@nike) • Instagram photos and videos" is Nike, and a bare
      // platform echo ("Facebook") is nothing at all
      data.title = data.title
        .replace(/\s*\(@[a-z0-9._]+\)\s*/i, ' ')
        .replace(/\s*[•|·–—-]?\s*Instagram (photos and videos|profile).*$/i, '')
        .replace(/\s*[•|·–—-]?\s*(on\s+)?Facebook\s*$/i, '')
        .replace(/\s+/g, ' ').trim() || null;
      if (data.title === social) data.title = null;
    }
    if (!data.ok || (!data.title && !data.image)) {
      const res = await socialResolve(target, social).catch(() => null);
      data = res
        ? { ok: true, url: raw, social, guessed: true, ...res }
        : { ok: true, url: raw, social, title: null, image: null, siteName: social, price: null, currency: null };
    } else {
      data.social = social;
    }
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
    // With a photo already in hand the wait is near zero: the id is nice to
    // have, nothing downstream needs it from THIS response. Without a photo
    // the grounding id IS the image path (the client polls it for the
    // re-hosted photo), so it gets a longer budget; a cold token mint alone
    // can eat the short one.
    const budget = data.image ? 250 : 4500;
    const wp = await Promise.race([
      webProductPromise,
      new Promise((r) => setTimeout(() => r(null), budget)),
    ]);
    if (wp && wp.id) data.webProductId = wp.id;

    // A remembered scrape may already be done: inline its result so repeat
    // pastes of a blocked page get the real name and image immediately.
    // It has been loading in parallel with the page read, so the wait here
    // is short.
    if (!data.image && inlineScrapePromise) {
      try {
        const done = await Promise.race([
          inlineScrapePromise,
          new Promise((r) => setTimeout(() => r(null), 1200)),
        ]);
        const media = done && Array.isArray(done.medias) && done.medias[0];
        if (media && /^https:\/\//i.test(media.url || '')) {
          data.image = cdnImage(media.url);
          const t = done.title && String(done.title);
          if (t && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t.trim()) && (data.guessed || !data.title)) {
            data.title = t.slice(0, 90);
          }
          delete data.guessed; // real scraped data now, not a URL guess
        }
      } catch (e) { /* scrape still running or gone; the client polls */ }
    }
  }

  // Imageless results go stale fast on purpose: the scrape may finish any
  // minute, and the next paste of this URL should pick its result up.
  const complete = !!data.image;
  cache.set(raw, { ts: Date.now(), ttl: complete ? CACHE_TTL_MS : 15000, data });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return json(200, data, complete ? undefined : 'public, max-age=15');
};

/* Shared with product-unlock-background, which reads a blocked page through
 * Bright Data and needs the exact same extraction and validation this handler
 * uses. Exported rather than duplicated: two copies of "what counts as a
 * product image" would drift, and the divergence would only show up on the
 * stores we already struggle with. */
exports.extract = extract;
exports.metaContent = metaContent;
exports.validateImage = validateImage;
exports.cdnImage = cdnImage;
exports.guardUrl = guardUrl;
exports.unlockKey = unlockKey;

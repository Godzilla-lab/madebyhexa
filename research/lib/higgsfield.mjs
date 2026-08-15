/*
 * Higgsfield's web-product scraper, used as a product-resolution tier.
 *
 * Chris's point: Higgsfield already reads product pages our own fetch cannot,
 * and we already pay for it. So it belongs in the ladder BEFORE any new paid
 * vendor -- it is effectively free at the margin, and it is the same scraper
 * the studio already trusts to ground a render in the real product.
 *
 * Flow (mirrors netlify/functions/lib/hf.js:214):
 *   POST /developer/v1alpha/marketing-studio/products {source:'product_url',url}
 *   -> { id }, then poll GET .../products/{id} until status === 'completed'
 *
 * Auth matches the existing client: a long-lived key if present, otherwise the
 * OAuth bearer plus workspace header. This is a read-only standalone copy so the
 * CLI does not have to drag in the Netlify Blobs token manager.
 *
 * env: HIGGSFIELD_TOKEN (or HF_KEY_ID + HF_KEY_SECRET), HIGGSFIELD_WORKSPACE_ID
 *
 * TOKENS ROTATE, AND NOTHING HERE SHOULD EVER NEED A HUMAN.
 * The bare OAuth token expires in ~24h, so a static HIGGSFIELD_TOKEN in .env is
 * stale by tomorrow. `netlify/functions/lib/hf.js` already solved this and this
 * module now uses the same local answer: the installed `higgsfield` CLI keeps
 * its own Clerk session alive, so `higgsfield auth token` mints a fresh one on
 * demand. That chain is fully separate from HIGGSFIELD_REFRESH_TOKEN, so using
 * it can never revoke production's rotation.
 *
 * Order: API key (never expires) -> CLI-minted token -> static env token.
 */

import { execFileSync } from 'node:child_process';

const BASE = process.env.HIGGSFIELD_API_BASE || 'https://fnf-api-gw.higgsfield.ai/fnf';
const POLL_MS = 1500;
const POLL_MAX = 20;         // ~30s ceiling; the scraper is usually much faster

/* Minted tokens live ~24h; re-mint every 20 minutes so a long run never carries
 * a token across its own expiry. */
let cliToken = { access: null, exp: 0 };

function cliBearer(force = false) {
  if (force) cliToken.exp = 0;
  if (cliToken.access && Date.now() < cliToken.exp) return cliToken.access;
  try {
    const out = execFileSync('higgsfield', ['auth', 'token'], {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const last = out.split('\n').pop().trim();
    if (last.length > 20) {
      cliToken = { access: last, exp: Date.now() + 20 * 60 * 1000 };
      return last;
    }
  } catch {
    // CLI missing or signed out: fall through to the static token.
  }
  return null;
}

export function configured() {
  return !!(
    process.env.HIGGSFIELD_TOKEN ||
    (process.env.HF_KEY_ID && process.env.HF_KEY_SECRET) ||
    cliBearer()
  );
}

function authHeaders({ force = false } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.HF_KEY_ID && process.env.HF_KEY_SECRET) {
    h.Authorization = `Key ${process.env.HF_KEY_ID}:${process.env.HF_KEY_SECRET}`;
  } else {
    const token = cliBearer(force) || process.env.HIGGSFIELD_TOKEN;
    if (token) h.Authorization = `Bearer ${token}`;
  }
  if (process.env.HIGGSFIELD_WORKSPACE_ID) {
    h['hf-workspace-id'] = process.env.HIGGSFIELD_WORKSPACE_ID;
  }
  return h;
}

/*
 * A 401 means the token was revoked even though its clock looked fine, so mint
 * a fresh one and retry ONCE rather than failing the run. This is what makes
 * the tier self-healing: a stale token in .env stops being an outage.
 */
async function api(method, path, body, { retried = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: authHeaders({ force: retried }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    if ((res.status === 401 || res.status === 403) && !retried) {
      return api(method, path, body, { retried: true });
    }
    const msg = (data && (data.detail || data.message)) || text.slice(0, 200) || res.statusText;
    const err = new Error(`higgsfield ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Scrape one product URL. Returns normalised facts in the same shape the rest
 * of the ladder produces, or null if Higgsfield could not read it either.
 */
export async function scrapeProduct(url) {
  if (!configured()) return null;

  let created;
  try {
    created = await api('POST', '/developer/v1alpha/marketing-studio/products', {
      source: 'product_url',
      url,
    });
  } catch (e) {
    // 401/403 means our token is stale, which is worth surfacing rather than
    // silently falling through to a paid tier.
    if (e.status === 401 || e.status === 403) {
      console.error(`  ! higgsfield auth rejected (${e.status}); refresh HIGGSFIELD_TOKEN`);
    }
    return null;
  }

  const id = created && (created.id || created.product_id);
  if (!id) return null;

  let record = created;
  for (let i = 0; i < POLL_MAX; i++) {
    const status = String(record.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded') break;
    if (status === 'failed' || status === 'error') return null;
    await sleep(POLL_MS);
    try {
      record = await api('GET', `/developer/v1alpha/marketing-studio/products/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
  }

  return normalise(record, url, id);
}

/* The payload shape has drifted before, so read defensively across the
 * plausible field names rather than assuming one. */
function pick(obj, keys) {
  for (const k of keys) {
    const parts = k.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
      else { cur = null; break; }
    }
    if (cur != null && cur !== '') return cur;
  }
  return '';
}

function normalise(rec, url, id) {
  if (!rec || typeof rec !== 'object') return null;

  const title = String(pick(rec, ['name', 'title', 'product.name', 'product.title', 'data.name'])).trim();
  if (!title) return null;

  const images = pick(rec, ['images', 'image_urls', 'product.images', 'data.images']);
  const image = Array.isArray(images)
    ? String(images[0]?.url || images[0] || '')
    : String(pick(rec, ['image', 'image_url', 'thumbnail_url']) || '');

  return {
    source: 'higgsfield',
    url,
    title: title.slice(0, 300),
    description: String(pick(rec, ['description', 'summary', 'product.description', 'data.description'])).slice(0, 2000),
    image,
    price: String(pick(rec, ['price', 'product.price', 'data.price']) || ''),
    currency: String(pick(rec, ['currency', 'product.currency']) || ''),
    vendor: String(pick(rec, ['brand', 'vendor', 'product.brand']) || ''),
    type: String(pick(rec, ['category', 'product_type', 'product.category']) || ''),
    tags: [],
    hfProductId: id,          // reusable: grounds a later marketing_studio_video render
  };
}

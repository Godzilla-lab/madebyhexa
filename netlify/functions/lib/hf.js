'use strict';

/*
 * Minimal Higgsfield API client for the render backend.
 *
 * Auth, in priority order:
 *   1. Long-lived Cloud API key (preferred, no expiry) ->
 *        Authorization: Key <KEY_ID>:<KEY_SECRET>
 *      Set HF_KEY_ID + HF_KEY_SECRET, or HF_CREDENTIALS="KEY_ID:KEY_SECRET".
 *      Generated once at https://cloud.higgsfield.ai/api-keys .
 *   2. Short-lived OAuth token (the CLI login, expires ~24h) ->
 *        Authorization: Bearer <oat_ token>  +  hf-workspace-id: <uuid>
 *      Set HIGGSFIELD_TOKEN + HIGGSFIELD_WORKSPACE_ID. Used for local dev and
 *      for the marketing-studio scraper, which lives only on the CLI gateway.
 *      With HIGGSFIELD_REFRESH_TOKEN + HIGGSFIELD_OAUTH_CLIENT_ID also set,
 *      the client keeps this token fresh on its own (see the token manager
 *      below) instead of dying when the 24h token in env goes stale.
 *
 * Endpoint surface (same /developer/v2alpha paths the CLI uses):
 *   create  POST /developer/v2alpha/{images|videos}/{job_type}/generations  {params}
 *   status  GET  /developer/v2alpha/jobs/{id}
 *
 * Base URL is env-overridable (HIGGSFIELD_API_BASE) so render can point at the
 * public platform host while the scraper stays on the CLI gateway if needed.
 */

const BASE = process.env.HIGGSFIELD_API_BASE || 'https://fnf-api-gw.higgsfield.ai/fnf';

/* Returns "KEY_ID:KEY_SECRET" if a long-lived API key is configured, else null. */
function apiKey() {
  if (process.env.HF_CREDENTIALS) return process.env.HF_CREDENTIALS.trim();
  if (process.env.HF_KEY_ID && process.env.HF_KEY_SECRET) {
    return process.env.HF_KEY_ID.trim() + ':' + process.env.HF_KEY_SECRET.trim();
  }
  return null;
}

/* ── OAuth token manager ─────────────────────────────────────────
 * Mints fresh access tokens against the same Clerk endpoint the CLI uses
 * (grant_type=refresh_token). The newest grant is persisted in Netlify
 * Blobs so every function instance shares it: refresh tokens can rotate,
 * and after a rotation only the stored pair is still alive. Degrades to
 * the static HIGGSFIELD_TOKEN when refresh config is absent or refresh
 * fails, so a bad rollout never turns off what works today. */

const TOKEN_URL = process.env.HIGGSFIELD_OAUTH_TOKEN_URL || 'https://clerk.higgsfield.ai/oauth/token';
const TOKEN_STORE = 'service-tokens';
const TOKEN_KEY = 'higgsfield';
const EXP_MARGIN_S = 300; // treat tokens as stale 5 min early

let grant = { access: null, refresh: null, exp: 0 }; // exp in ms epoch

function canRefresh() {
  return !!(process.env.HIGGSFIELD_OAUTH_CLIENT_ID &&
    (grant.refresh || process.env.HIGGSFIELD_REFRESH_TOKEN));
}

function blobStore() {
  try {
    const { getStore } = require('@netlify/blobs');
    return getStore(TOKEN_STORE);
  } catch (e) { return null; }
}

async function readStoredGrant() {
  const store = blobStore();
  if (!store) return null;
  try { return await store.get(TOKEN_KEY, { type: 'json' }); } catch (e) { return null; }
}

async function writeStoredGrant(g) {
  const store = blobStore();
  if (!store) return;
  try { await store.setJSON(TOKEN_KEY, g); } catch (e) { /* best effort */ }
}

async function refreshGrant(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.HIGGSFIELD_OAUTH_CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error('higgsfield token refresh failed (' + res.status + ')');
    err.status = res.status;
    throw err;
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken, // rotated, or reusable as-is
    exp: Date.now() + Math.max(60, (data.expires_in || 3600) - EXP_MARGIN_S) * 1000,
  };
}

/* Local-dev auto-refresh: the installed `higgsfield` CLI keeps its own Clerk
 * session alive (a chain fully separate from HIGGSFIELD_REFRESH_TOKEN, so
 * using it can never revoke production's rotation). Minting through the CLI
 * means a stale HIGGSFIELD_TOKEN in .env no longer breaks localhost. */
let cliToken = { access: null, exp: 0 };
function cliBearer(force) {
  if (force) cliToken.exp = 0;
  if (cliToken.access && Date.now() < cliToken.exp) return cliToken.access;
  try {
    const out = require('child_process')
      .execSync('higgsfield auth token', { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (out && out.split('\n').pop().length > 20) {
      cliToken = { access: out.split('\n').pop(), exp: Date.now() + 20 * 60 * 1000 };
      return cliToken.access;
    }
  } catch (e) { /* CLI missing or signed out: fall back to the static token */ }
  return null;
}

/* The bearer token to send. force=true after a 401: the token was revoked
 * even though its clock looked fine, so skip every cache. */
async function bearer(force) {
  if (!force && grant.access && Date.now() < grant.exp) return grant.access;

  // Refresh tokens rotate on every use and Clerk revokes the WHOLE chain on
  // reuse of a stale one. Only production may refresh: it persists rotations
  // in Blobs that every prod instance shares. Local dev / standalone scripts
  // have their own (or no) blob store, so a refresh there orphans the
  // rotation and the next prod refresh trips reuse revocation. Locally the
  // CLI session is the auto-refresh instead; the static token is the last resort.
  if (process.env.NETLIFY_DEV || !blobStore()) {
    return cliBearer(force) || process.env.HIGGSFIELD_TOKEN || null;
  }
  if (!canRefresh()) return process.env.HIGGSFIELD_TOKEN || null;

  const stored = await readStoredGrant();
  if (!force && stored && stored.access && stored.exp && Date.now() < stored.exp) {
    grant = stored;
    return grant.access;
  }
  const use = (stored && stored.refresh) || grant.refresh || process.env.HIGGSFIELD_REFRESH_TOKEN;
  try {
    grant = await refreshGrant(use);
    await writeStoredGrant(grant);
    return grant.access;
  } catch (e) {
    // rotation race: another instance refreshed first and invalidated `use`;
    // its stored grant is the live one
    const latest = await readStoredGrant();
    if (latest && latest.access && latest.refresh !== use) {
      grant = latest;
      return grant.access;
    }
    return process.env.HIGGSFIELD_TOKEN || null;
  }
}

function configured() {
  const oauth = process.env.HIGGSFIELD_TOKEN ||
    (process.env.HIGGSFIELD_REFRESH_TOKEN && process.env.HIGGSFIELD_OAUTH_CLIENT_ID);
  return !!(apiKey() || (oauth && process.env.HIGGSFIELD_WORKSPACE_ID));
}

async function api(method, path, body, _retried) {
  const h = { 'Content-Type': 'application/json' };
  const key = apiKey();
  if (key) {
    h['Authorization'] = 'Key ' + key;
  } else {
    const token = await bearer(!!_retried);
    if (token) h['Authorization'] = 'Bearer ' + token;
  }
  if (process.env.HIGGSFIELD_WORKSPACE_ID) {
    h['hf-workspace-id'] = process.env.HIGGSFIELD_WORKSPACE_ID;
  }
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !key && !_retried &&
      (canRefresh() || process.env.NETLIFY_DEV || !blobStore())) {
    return api(method, path, body, true);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error('higgsfield ' + res.status + ' on ' + path);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

/* kind: 'images' | 'videos' | '3d' | 'audios' */
function createJob(kind, jobType, params) {
  return api('POST', '/developer/v2alpha/' + kind + '/' + jobType + '/generations', { params });
}

function getJob(id) {
  return api('GET', '/developer/v2alpha/jobs/' + encodeURIComponent(id));
}

function getBalance() {
  return api('GET', '/developer/v2alpha/account/balance');
}

/* Marketing Studio web products: the engine's own scraper. Created from a
 * customer URL; once status=completed the id grounds marketing_studio_video
 * renders in the real product (web_product_ids + specific_mode=web_product). */
function createWebProduct(url) {
  return api('POST', '/developer/v1alpha/marketing-studio/products', { source: 'product_url', url: url });
}
function getWebProduct(id) {
  return api('GET', '/developer/v1alpha/marketing-studio/products/' + encodeURIComponent(id));
}

/* There is deliberately no uploadImageFromUrl here. POSTing { url } to the
 * media endpoint looks like a URL import and is not one: the endpoint only ever
 * PRESIGNS, the url in the body is ignored for images exactly as it is for
 * video, and the media id it returns has no bytes behind it. Passing that id as
 * an image_reference 500s the generation. Measured live 2026-08-13, after it
 * silently un-grounded every ad pack and photoshoot. Use uploadImageBytes, or
 * better, the web product's own media_input_id. */

/* A finished render's CDN URL becomes a media input for post-render jobs
 * (voice_change, dubbing, video_upscale). The media endpoint only PRESIGNS
 * for video (the url in the body is ignored); using the id without PUTting
 * the bytes 500s the job. Verified live 2026-07-09: fetch + PUT + confirm,
 * then voice_change accepted the id and rendered. */
async function uploadVideoFromUrl(url) {
  const media = await api('POST', '/developer/v2alpha/media?type=video', {});
  const src = await fetch(url);
  if (!src.ok) throw new Error('source video fetch failed (' + src.status + ')');
  const buf = Buffer.from(await src.arrayBuffer());
  const put = await fetch(media.upload_url, {
    method: 'PUT',
    body: buf,
    headers: { 'Content-Type': src.headers.get('content-type') || 'video/mp4' },
  });
  if (!put.ok) throw new Error('video upload PUT failed (' + put.status + ')');
  try { await api('POST', '/developer/v2alpha/media/' + media.id + '/confirm?type=video', {}); }
  catch (e) { /* confirm is advisory for some types; the PUT is what matters */ }
  return media;
}

/* Product photoshoot prompt writer: mode + intent -> structured prompts. */
function photoshootEnhance(body) {
  return api('POST', '/developer/v2alpha/product-photoshoot/enhance', body);
}

/* Presigned media upload from raw bytes. This is the flow avatar references
 * require, and the only correct way to turn a URL into usable image media. */
async function uploadImageBytes(buf, contentType) {
  const media = await api('POST', '/developer/v2alpha/media?type=image', {});
  const put = await fetch(media.upload_url, {
    method: 'PUT',
    body: buf,
    headers: { 'Content-Type': contentType || 'image/jpeg' },
  });
  if (!put.ok) throw new Error('media upload PUT failed (' + put.status + ')');
  await api('POST', '/developer/v2alpha/media/' + media.id + '/confirm?type=image', {});
  return media;
}

/* Create custom marketing-studio avatars from uploaded photo media.
 * items: [{ name, image_references: [{ type: 'media_input', id }] }] */
function createAvatars(items) {
  return api('POST', '/developer/v1alpha/marketing-studio/avatars', { avatars: items });
}

module.exports = {
  api, createJob, getJob, getBalance, configured, apiKey,
  createWebProduct, getWebProduct, uploadVideoFromUrl,
  photoshootEnhance, uploadImageBytes, createAvatars,
};

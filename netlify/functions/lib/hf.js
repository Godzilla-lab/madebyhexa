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

/* The bearer token to send. force=true after a 401: the token was revoked
 * even though its clock looked fine, so skip every cache. */
async function bearer(force) {
  if (!force && grant.access && Date.now() < grant.exp) return grant.access;
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
  if (res.status === 401 && !key && !_retried && canRefresh()) {
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

/* Turn any public https image into a media UUID usable as a job reference. */
function uploadImageFromUrl(url) {
  return api('POST', '/developer/v2alpha/media?type=image', { url: url });
}

/* Product photoshoot prompt writer: mode + intent -> structured prompts. */
function photoshootEnhance(body) {
  return api('POST', '/developer/v2alpha/product-photoshoot/enhance', body);
}

module.exports = {
  api, createJob, getJob, getBalance, configured, apiKey,
  createWebProduct, getWebProduct, uploadImageFromUrl, photoshootEnhance,
};

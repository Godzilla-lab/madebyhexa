'use strict';

/*
 * Finish a Shopify install.
 *
 * GET ?code=...&shop=...&state=...&hmac=...  ->  302 back into the app
 *
 * Everything in this file exists to answer one question before we store a
 * credential: did Shopify actually send this, for a store this person asked to
 * connect? A callback is a plain GET that anyone can forge, so it is checked
 * four ways and any failure stops the request without writing anything.
 *
 *   1. shop is a real myshopify.com hostname     (stops open redirect / SSRF)
 *   2. hmac verifies against our client secret   (proves Shopify sent it)
 *   3. state matches the cookie we set           (proves WE started it)
 *   4. a signed-in Hexa account is present       (says whose store it is)
 *
 * Only then is the code exchanged for a token, and the token goes straight to
 * a service-role write. It is never returned to the browser, never logged, and
 * never put in a redirect.
 *
 * env: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SUPABASE_URL,
 *      SUPABASE_SERVICE_ROLE_KEY
 */

const crypto = require('crypto');
const sb = require('./lib/supabase');
const { getUser } = require('./lib/auth');
const { allow } = require('./lib/ratelimit');
const { normaliseShop, SCOPES } = require('./shopify-install');

function fail(reason, human) {
  // Deliberately vague to the visitor, specific in the log. A callback that
  // explains exactly which check it failed is a tool for whoever is probing it.
  console.error('shopify-callback: ' + reason);
  return {
    statusCode: 302,
    headers: {
      Location: '/account.html?shopify=' + encodeURIComponent(human || 'failed'),
      'Set-Cookie': 'hexa_shopify=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'Cache-Control': 'no-store',
    },
    body: '',
  };
}

/*
 * Shopify signs the query string with our client secret.
 *
 * The rule is: drop hmac, sort the remaining parameters, join as key=value
 * pairs with &, and HMAC-SHA256 it. Compared with timingSafeEqual, because a
 * plain === on a signature leaks how much of a guess was right, one byte at a
 * time, to anyone willing to measure.
 */
function hmacValid(params, secret) {
  const given = params.hmac;
  if (!given || !/^[a-f0-9]{64}$/i.test(given)) return false;

  const message = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => k + '=' + params[k])
    .join('&');

  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(given).toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'GET only' };

  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!secret || !clientId) return fail('missing client credentials', 'unconfigured');

  // Cheap and blunt: a forged-callback probe should not get unlimited attempts
  // at the hmac check, however constant-time that check is.
  if (!(await allow('shopify-callback', event, 60))) {
    return fail('rate limited', 'busy');
  }

  const params = event.queryStringParameters || {};

  // 1. a real shop hostname, before the value is used anywhere
  const shop = normaliseShop(params.shop);
  if (!shop) return fail('bad shop parameter: ' + params.shop, 'bad-shop');

  // 2. Shopify really sent this
  if (!hmacValid(params, secret)) return fail('hmac failed for ' + shop, 'bad-signature');

  // 3. we started it, and for this same shop
  const cookie = cookieValue(event.headers && (event.headers.cookie || event.headers.Cookie), 'hexa_shopify');
  if (!cookie) return fail('no install cookie for ' + shop, 'expired');
  const sep = cookie.lastIndexOf('.');
  const cookieNonce = sep > 0 ? cookie.slice(0, sep) : '';
  const cookieShop = sep > 0 ? cookie.slice(sep + 1) : '';
  const given = String(params.state || '');
  const nonceOk = cookieNonce.length === given.length && cookieNonce.length > 0
    && crypto.timingSafeEqual(Buffer.from(cookieNonce), Buffer.from(given));
  if (!nonceOk) return fail('state mismatch for ' + shop, 'expired');
  if (cookieShop !== shop) return fail('cookie shop ' + cookieShop + ' != callback shop ' + shop, 'bad-shop');

  // 4. whose store is this
  if (!sb.configured()) return fail('supabase not configured', 'unconfigured');
  const user = await getUser(event);
  if (!user) {
    /* The merchant approved on Shopify but their Hexa session was gone by the
     * time they came back. The install is fine; we simply cannot say whose it
     * is. Send them to sign in and start again rather than storing an orphan. */
    return fail('no signed-in user completing install for ' + shop, 'signin');
  }

  const code = String(params.code || '');
  if (!/^[A-Za-z0-9._-]{10,512}$/.test(code)) return fail('bad code for ' + shop, 'failed');

  /* Exchange. This is the only place the secret leaves the environment, and it
   * goes to the shop's own domain, which we validated in step 1. */
  let token;
  let grantedScope = '';
  try {
    const res = await fetch('https://' + shop + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, code: code }),
    });
    if (!res.ok) return fail('token exchange ' + res.status + ' for ' + shop, 'failed');
    const body = await res.json();
    token = body && body.access_token;
    grantedScope = (body && body.scope) || '';
    if (!token) return fail('token exchange returned no token for ' + shop, 'failed');
  } catch (e) {
    return fail('token exchange threw for ' + shop + ': ' + e.message, 'failed');
  }

  /*
   * Check what they actually granted, rather than what we asked for. A merchant
   * can approve a narrower set, and a store connected without read_products
   * would look connected and then fail on every catalogue read, which is worse
   * than refusing here.
   */
  if (grantedScope && grantedScope.indexOf('read_products') === -1) {
    return fail('scope ' + grantedScope + ' lacks read_products for ' + shop, 'scope');
  }

  /* Friendly name for the picker. Never fatal: a store with no readable name is
   * still a perfectly good store. */
  let shopName = null;
  try {
    const r = await fetch('https://' + shop + '/admin/api/2025-01/shop.json', {
      headers: { 'X-Shopify-Access-Token': token },
    });
    if (r.ok) {
      const d = await r.json();
      shopName = (d && d.shop && d.shop.name) || null;
    }
  } catch (e) { /* cosmetic */ }

  try {
    const { error } = await sb.admin().from('store_connections').upsert({
      user_id: user.userId,
      // Shopify is simply the first platform. The column exists so the next one
      // is a row value rather than a migration against live merchant tokens.
      platform: 'shopify',
      store: shop,
      access_token: token,
      scope: grantedScope || SCOPES,
      store_name: shopName,
      installed_at: new Date().toISOString(),
    }, { onConflict: 'user_id,platform,store' });
    if (error) throw new Error(error.message);
  } catch (e) {
    return fail('store write failed for ' + shop + ': ' + e.message, 'failed');
  }

  console.log('shopify-callback: connected ' + shop + ' to ' + user.userId);

  // Cookie is spent. Clear it so a replay of this exact URL fails step 3.
  return {
    statusCode: 302,
    headers: {
      Location: '/account.html?shopify=connected',
      'Set-Cookie': 'hexa_shopify=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'Cache-Control': 'no-store',
    },
    body: '',
  };
};

exports.hmacValid = hmacValid;

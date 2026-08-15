'use strict';

/*
 * Start a Shopify install.
 *
 * GET ?shop=something.myshopify.com  ->  302 to Shopify's consent screen
 *
 * This is the first leg of the authorization code grant. It does three things
 * and nothing else: check the shop is a real Shopify hostname, mint a nonce,
 * and send the merchant to Shopify to approve.
 *
 * The nonce is the whole point of this function. Without one, anybody could
 * hand a signed-in Hexa user a crafted callback URL and attach THEIR store to
 * the victim's account, or attach the victim's store somewhere else. So the
 * nonce is set as a signed, HttpOnly cookie here and checked against the one
 * Shopify echoes back in shopify-callback. A callback whose state does not
 * match a cookie we set is not a callback we started.
 *
 * env: SHOPIFY_CLIENT_ID
 */

const crypto = require('crypto');

/* read_products only. The merchant sees this list on the consent screen, and
 * every extra word on it costs installs. It is also the whole reason we stay
 * clear of Shopify's protected customer data rules. */
const SCOPES = 'read_products';

/*
 * A Shopify shop hostname, and nothing that merely looks like one.
 *
 * This value is interpolated straight into the URL we redirect to, so a loose
 * check here is an open redirect: "evil.com/?x=.myshopify.com" or a hostname
 * carrying a backslash or an @ would send the merchant somewhere else entirely
 * while looking plausible in a log. Letters, digits, hyphens, one suffix.
 */
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function normaliseShop(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // A merchant typing just their handle is the common case, so accept it.
  if (!s.includes('.')) s = s + '.myshopify.com';
  return SHOP_RE.test(s) ? s : null;
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'GET only' };

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) {
    console.error('shopify-install: SHOPIFY_CLIENT_ID is not set');
    return { statusCode: 503, body: 'Shopify is not configured yet.' };
  }

  const q = event.queryStringParameters || {};
  const shop = normaliseShop(q.shop);
  if (!shop) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'That does not look like a Shopify store address. It should end in myshopify.com',
    };
  }

  const nonce = crypto.randomBytes(32).toString('base64url');

  /*
   * Host from the request, not from the environment. process.env.URL is always
   * the production site, so a draft deploy testing this would send Shopify a
   * redirect_uri pointing at production, which then fails the exact-match check
   * against what the callback presents. Same lesson as the report worker.
   */
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || h.Host;
  const origin = host ? 'https://' + String(host).replace(/\/$/, '')
                      : (process.env.URL || 'https://madebyhexa.co').replace(/\/$/, '');
  const redirectUri = origin + '/.netlify/functions/shopify-callback';

  const authorize = 'https://' + shop + '/admin/oauth/authorize'
    + '?client_id=' + encodeURIComponent(clientId)
    + '&scope=' + encodeURIComponent(SCOPES)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&state=' + encodeURIComponent(nonce);
  // No grant_options[]: we want an OFFLINE token. A per-user (online) token
  // expires with the merchant's admin session, and the catalogue has to be
  // readable when they are not sitting in front of Shopify.

  /*
   * The cookie carries the nonce and the shop it was issued for, so the
   * callback can prove both. SameSite=Lax survives the top-level redirect back
   * from Shopify; Strict would drop it and break every install. HttpOnly
   * because no script has any reason to read it.
   */
  const cookie = 'hexa_shopify=' + encodeURIComponent(nonce + '.' + shop)
    + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600';

  return {
    statusCode: 302,
    headers: { Location: authorize, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
    body: '',
  };
};

exports.normaliseShop = normaliseShop;
exports.SCOPES = SCOPES;

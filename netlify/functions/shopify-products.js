'use strict';

/*
 * The connected store's catalogue.
 *
 * GET (bearer token)  ->  { shop, products: [{ id, title, price, image, url }] }
 *
 * This is what turns "paste a product link" into "pick a product". The access
 * token stays server side: the browser asks us, we ask Shopify, and the token
 * is read through the service role because RLS on store_connections gives the
 * browser no path to it at all.
 *
 * Only the fields the picker and the research engine need come back. The raw
 * Shopify product object carries inventory, cost, SKUs and supplier notes, and
 * shipping all of that to the browser because it happened to be in the response
 * is how catalogues leak.
 *
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const sb = require('./lib/supabase');
const { getUser } = require('./lib/auth');
const { allow } = require('./lib/ratelimit');

const API_VERSION = '2025-01';
const PAGE = 60;   // enough to fill a picker, small enough to stay fast

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

/* Shopify product -> the shape the composer and the research engine want. */
function slim(p, shop) {
  const variant = (p.variants && p.variants[0]) || null;
  const image = (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || '';
  return {
    id: String(p.id),
    title: p.title || '',
    handle: p.handle || '',
    price: variant && variant.price ? String(variant.price) : '',
    image: image,
    // The public product page, which is what the research engine reads. Built
    // from the handle rather than trusted from anywhere, so it always points at
    // the store we are actually connected to.
    url: 'https://' + shop + '/products/' + encodeURIComponent(p.handle || ''),
    status: p.status || '',
  };
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  if (!sb.configured()) return json(503, { error: 'accounts not configured' });

  const user = await getUser(event);
  if (!user) return json(401, { error: 'Sign in to see your store.' });
  if (!(await allow('shopify-products', event, 300))) {
    return json(429, { error: 'Too many requests. Give it a moment.' });
  }

  const db = sb.admin();
  const q = event.queryStringParameters || {};

  /* Which store. A caller may name one, but the row is always looked up by
   * user_id as well, so naming someone else's shop finds nothing. */
  let query = db.from('store_connections')
    .select('store,access_token,store_name')
    .eq('user_id', user.userId)
    .eq('platform', 'shopify');
  if (q.shop) query = query.eq('store', String(q.shop));

  const { data: store } = await query.order('installed_at', { ascending: false }).limit(1).maybeSingle();
  if (!store) return json(404, { error: 'No Shopify store connected yet.' });

  /*
   * active only, and published. A draft or archived product has no public page
   * for the research engine to read and no business being advertised, so
   * offering it in the picker would only produce a report about a 404.
   */
  const url = 'https://' + store.store + '/admin/api/' + API_VERSION + '/products.json'
    + '?limit=' + PAGE + '&status=active&fields=id,title,handle,image,images,variants,status';

  let products;
  try {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': store.access_token } });
    if (res.status === 401 || res.status === 403) {
      /* The merchant uninstalled or revoked us on the Shopify side. The token is
       * dead, so drop it rather than keep a credential that cannot work and
       * will only confuse the next read. */
      await db.from('store_connections').delete()
        .eq('user_id', user.userId).eq('platform', 'shopify').eq('store', store.store);
      return json(409, {
        error: 'That store is no longer connected to Hexa. Connect it again to pick products.',
        reconnect: true,
      });
    }
    if (!res.ok) {
      console.error('shopify-products: ' + res.status + ' for ' + store.store);
      return json(502, { error: 'Shopify did not answer. Try again in a moment.' });
    }
    const body = await res.json();
    products = (body && body.products) || [];
  } catch (e) {
    console.error('shopify-products: fetch failed for ' + store.store + ': ' + e.message);
    return json(502, { error: 'Could not reach Shopify.' });
  }

  // Best effort, never fatal: it only drives "last used" ordering in the UI.
  db.from('store_connections').update({ last_used_at: new Date().toISOString() })
    .eq('user_id', user.userId).eq('platform', 'shopify').eq('store', store.store)
    .then(function () {}, function () {});

  return json(200, {
    shop: store.store,
    shopName: store.store_name || null,
    products: products.map(function (p) { return slim(p, store.store); }),
  });
};

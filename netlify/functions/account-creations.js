'use strict';

/*
 * GET /.netlify/functions/account-creations
 *
 * Returns the signed-in user's creations, newest first, for the account
 * library. The caller must send `Authorization: Bearer <supabase access token>`;
 * we resolve the user server-side and query the service client filtered to
 * their id, so a user can only ever see their own library.
 */

const { getUser } = require('./lib/auth');
const { allow } = require('./lib/ratelimit');
const { admin, configured } = require('./lib/supabase');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  if (!configured()) return json(503, { error: 'accounts not configured' });

  // Library listing: a real user refreshes it, a scraper walks it.
  if (!(await allow('account-creations', event, 600))) {
    return json(429, { error: 'Too many requests. Give it a minute.' });
  }

  const u = await getUser(event);
  if (!u) return json(401, { error: 'sign in required' });

  /*
   * The order's product rides along, because `type` cannot tell the library
   * apart.
   *
   * A creation stores type: 'video' | 'image', which puts a product photoshoot,
   * a static ad and a poster in one bucket and a UGC creator video, a
   * cinematic spot and a hyper-motion burst in the other. Those are five
   * different things to make and five different things to go looking for, so a
   * library that only knows "image" cannot offer a category at all.
   *
   * The product id is what actually names the kind, and creations already
   * carry order_id, so it is one embedded select rather than a new column and
   * a backfill. catalog/studio-data.json maps the id to a category, in one
   * place, so the page and the studio cannot disagree about what a photoshoot
   * is.
   *
   * order_id is nullable (the comped free ad writes no order), so `product`
   * comes back null for those and the page says nothing rather than guessing.
   */
  const { data, error } = await admin()
    .from('creations')
    .select('id,order_id,type,title,result_urls,thumb_url,status,created_at,orders(product)')
    .eq('user_id', u.userId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('account-creations:', error.message);
    return json(500, { error: 'could not load your library' });
  }

  /* Flattened, so the browser is not reaching through an embedded object for
   * one string. The join shape is PostgREST's business, not the page's. */
  const creations = (data || []).map((c) => {
    const product = c.orders && c.orders.product ? c.orders.product : null;
    delete c.orders;
    return Object.assign(c, { product: product });
  });

  return json(200, { creations: creations });
};

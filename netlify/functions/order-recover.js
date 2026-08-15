'use strict';

/*
 * Rebuild a paid order the browser has lost.
 *
 *   GET ?paid=<stripe checkout session id>  ->  { order: { product, selections, ... } }
 *
 * Stripe sends buyers back to /render.html?paid=<session>, and render.html read
 * the order out of localStorage. When localStorage was empty the page showed
 * "No order in progress. Start a creation in the studio." to somebody whose
 * card had just been charged. That is not an edge case: a different browser
 * finishing the payment, private mode, a cleared site, an iOS in-app browser
 * handing off to Safari, or simply a device swap between the studio and the
 * receipt link all land there.
 *
 * The order does not need reconstructing from anything lossy. create-checkout
 * writes the whole thing into `orders` before redirecting (create-checkout.js:301),
 * product and selections exactly as priced, so this hands back what the server
 * already stored rather than reassembling it from Stripe metadata, which is
 * capped, stringified and carries the style's display name instead of its id.
 *
 * Trust model: the checkout session id IS the credential, the same anchor
 * render-status.js already uses for refunds (its comment: "unguessable, the
 * same trust anchor as the recovery link"). Deliberately NOT gated on a signed
 * in user, because the case being fixed is a browser with no storage, which
 * means no auth session either; requiring a token would refuse exactly the
 * people this exists for. Stripe is asked whether the session was really paid,
 * so an abandoned checkout recovers nothing.
 */

const sb = require('./lib/supabase');
const { allow } = require('./lib/ratelimit');

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });

  const q = event.queryStringParameters || {};
  const sessionId = typeof q.paid === 'string' ? q.paid.trim() : '';
  /* Shaped like a Stripe checkout session and nothing else. Cheap, but it keeps
   * junk out of both the database and the Stripe call. */
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return json(400, { error: 'bad session' });

  // The id is unguessable, so this is about scripted enumeration, not about
  // stopping a buyer refreshing their own recovery link.
  if (!(await allow('recover', event, 60))) {
    return json(429, { error: 'Too many attempts. Give it a moment.' });
  }

  if (!sb.configured()) return json(503, { error: 'orders not configured' });

  const { data: row } = await sb.admin().from('orders')
    .select('product,selections,amount_cents,status')
    .eq('stripe_session_id', sessionId)
    .maybeSingle();
  if (!row) return json(404, { error: 'no order for that session' });

  /*
   * A pending row is the normal state here: the webhook may not have landed
   * yet, and render-create verifies payment itself before it spends anything.
   * So payment is confirmed with Stripe rather than trusted from our own row,
   * and only when Stripe is configured; without it there is nothing to check
   * against and handing the order back would be guessing.
   */
  if (!process.env.STRIPE_SECRET_KEY) return json(503, { error: 'payments not configured' });
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return json(402, { error: 'that checkout was not completed' });
    }
  } catch (e) {
    console.error('order recover: stripe lookup failed:', e.message);
    return json(502, { error: 'could not confirm that payment' });
  }

  const selections = row.selections || {};
  /* The same shape render.js keeps in localStorage, so the page can carry on
   * exactly as if the order had never been lost. title and style are derived
   * from selections rather than stored, matching what the studio writes. */
  return json(200, {
    order: {
      product: row.product,
      selections: selections,
      style: selections.style || null,
      title: selections.styleName || selections.productName || 'Your order',
      price: row.amount_cents != null ? row.amount_cents / 100 : null,
      recovered: true,
    },
  });
};

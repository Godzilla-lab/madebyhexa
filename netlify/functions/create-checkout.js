'use strict';

/*
 * Creates a Stripe Checkout Session for the productized video offer.
 *
 * Two entry points:
 *  - Legacy tiers: the pricing buttons in script.js POST { tier }. One-time
 *    packs (single, triple) create a payment session; monthly plans (starter,
 *    growth) create a subscription session. Success goes to /intake.html.
 *  - Studio orders: studio.js POSTs { order } built by the configurator.
 *    The amount is computed HERE from catalog/pricing.json (the client's
 *    order.price is never trusted) and success goes to /render.html?paid=...
 *    where the render screen picks the full order back up from localStorage.
 *
 * Either way we return { url } and the browser redirects to Stripe's hosted
 * checkout.
 *
 * Required env var (set in Netlify dashboard, NOT committed):
 *   STRIPE_SECRET_KEY        sk_live_... or sk_test_...
 * Optional (use pre-made Stripe Prices instead of inline amounts):
 *   STRIPE_PRICE_SINGLE      price_...   (overrides the inline $59 one-time)
 *   STRIPE_PRICE_TRIPLE      price_...   (overrides the inline $129 one-time)
 *   STRIPE_PRICE_STARTER     price_...   (overrides the inline $119/mo recurring)
 *   STRIPE_PRICE_GROWTH      price_...   (overrides the inline $349/mo recurring)
 */

// Deliverable definitions. amount is in cents. Names avoid em/en dashes on purpose.
// mode: 'payment' is a one-time charge, 'subscription' bills monthly.
const TIERS = {
  single: {
    name: 'Hexa AI Single: 1 finished video',
    description: '1 brand-ready video concept in 9:16, 1:1 and 16:9 with captions and a hook. Delivered within 48 hours.',
    amount: 5900,
    mode: 'payment',
    priceEnv: 'STRIPE_PRICE_SINGLE',
  },
  triple: {
    name: 'Hexa AI Triple: 3 videos (split-test pack)',
    description: '3 different video concepts, each in 9:16, 1:1 and 16:9 with captions and hooks. Delivered within 48 hours.',
    amount: 12900,
    mode: 'payment',
    priceEnv: 'STRIPE_PRICE_TRIPLE',
  },
  starter: {
    name: 'Hexa AI Starter: 4 videos a month',
    description: '4 brand-ready videos every month, each in 9:16, 1:1 and 16:9 with captions and hooks. Free revision on every video. Cancel anytime.',
    amount: 11900,
    mode: 'subscription',
    interval: 'month',
    priceEnv: 'STRIPE_PRICE_STARTER',
  },
  growth: {
    name: 'Hexa AI Growth: 12 videos a month',
    description: '12 brand-ready videos every month, each in 9:16, 1:1 and 16:9 with captions and hooks. Priority 48-hour delivery and free revisions. Cancel anytime.',
    amount: 34900,
    mode: 'subscription',
    interval: 'month',
    priceEnv: 'STRIPE_PRICE_GROWTH',
  },
};

// Studio pricing oracle: catalog/pricing.json via lib/pricing.js. studio.js
// mirrors the same math client-side for display; this copy is authoritative.
const { priceStudioOrder } = require('./lib/pricing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Missing env var: STRIPE_SECRET_KEY');
    return json(503, { error: 'Checkout is not configured yet. Please book a call instead.' });
  }

  let tier;
  let studioOrder = null;
  try {
    const body = JSON.parse(event.body || '{}');
    tier = String(body.tier || '').toLowerCase();
    if (body.order) studioOrder = body.order;
  } catch (_) {
    return json(400, { error: 'Bad request' });
  }

  const origin = (
    event.headers.origin ||
    event.headers.Origin ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'https://madebyhexa.co'
  ).replace(/\/$/, '');

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  // ── Studio order path ──
  if (studioOrder) {
    const priced = priceStudioOrder(studioOrder);
    if (!priced) return json(400, { error: 'Unknown studio product' });

    // Show the buyer what they are buying: the peeked product image (already
    // an absolute https URL) plus the chosen style's thumbnail, made absolute
    // from the site origin. Stripe fetches these server-side, so a localhost
    // or netlify-dev origin would 404; only attach the thumb on public https.
    const sel = studioOrder.selections && typeof studioOrder.selections === 'object' ? studioOrder.selections : {};
    const images = [];
    if (typeof sel.productImage === 'string' && /^https:\/\/[^\s"']{1,2000}$/.test(sel.productImage)) {
      images.push(sel.productImage);
    }
    if (
      typeof sel.stylePreview === 'string' &&
      /^assets\/[A-Za-z0-9_\/.-]+\.(webp|png|jpe?g|avif)$/.test(sel.stylePreview) &&
      /^https:\/\//.test(origin) && !/localhost|127\.0\.0\.1/.test(origin)
    ) {
      images.push(origin + '/' + sel.stylePreview);
    }

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        submit_type: 'pay',
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: priced.amountCents,
            product_data: {
              name: priced.name,
              description: priced.description,
              ...(images.length ? { images: images.slice(0, 2) } : {}),
            },
          },
        }],
        metadata: priced.meta,
        success_url: `${origin}/render.html?paid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/`,
      });
      return json(200, { url: session.url });
    } catch (err) {
      console.error('Stripe studio session create failed:', err && err.message);
      return json(500, { error: 'Could not start checkout. Please try again.' });
    }
  }

  const config = TIERS[tier];
  if (!config) {
    return json(400, { error: 'Unknown tier' });
  }

  const mode = config.mode === 'subscription' ? 'subscription' : 'payment';

  // Use a pre-made Stripe Price if the env var is set, else build the price inline.
  // Subscription tiers add a monthly recurring interval to the inline price.
  const presetPrice = process.env[config.priceEnv];
  const lineItem = presetPrice
    ? { price: presetPrice, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: config.amount,
          ...(mode === 'subscription'
            ? { recurring: { interval: config.interval || 'month' } }
            : {}),
          product_data: { name: config.name, description: config.description },
        },
      };

  try {
    const params = {
      mode,
      line_items: [lineItem],
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: { tier },
      success_url: `${origin}/intake.html?tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/offer#pricing`,
    };
    if (mode === 'subscription') {
      params.subscription_data = { metadata: { tier } };
    } else {
      params.submit_type = 'pay';
    }
    const session = await stripe.checkout.sessions.create(params);
    return json(200, { url: session.url });
  } catch (err) {
    console.error('Stripe session create failed:', err && err.message);
    return json(500, { error: 'Could not start checkout. Please try again or book a call.' });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

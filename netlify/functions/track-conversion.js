'use strict';

/*
 * Server-side conversion tracking for BOTH TikTok (Events API v1.3) and
 * Meta (Conversions API / Graph API). One same-origin call from the browser,
 * fanned out server-to-server so ad blockers and iOS can't drop the events.
 *
 * The browser pixels still fire; this mirrors the key commerce events using the
 * SAME event_id so each platform DEDUPLICATES (browser + server = one count).
 *
 *   CompletePayment / Purchase  verified against Stripe (payment must really be
 *                               'paid') so it cannot be faked by hitting this URL.
 *   AddToCart / InitiateCheckout forwarded from the buy-button click.
 *
 * Each platform activates only when its token is present, so the site is safe to
 * ship before either ad account is ready:
 *   TIKTOK_ACCESS_TOKEN   TikTok Events Manager -> Events API -> generate token
 *   META_ACCESS_TOKEN     Meta Events Manager -> Settings -> Conversions API -> generate token
 *   META_TEST_EVENT_CODE  (optional) Meta Test Events tab, to verify before going live
 *   STRIPE_SECRET_KEY     (already set) used to verify CompletePayment sessions
 */

const crypto = require('crypto');

const TT_PIXEL = 'D8OK0M3C77UBB84C775G';
const TT_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const META_PIXEL = '1665679184667318';
const META_ENDPOINT = 'https://graph.facebook.com/v21.0/' + META_PIXEL + '/events';
const TIER_VALUES = { single: 59, triple: 129, starter: 119, growth: 349 };
const SUPPORTED = ['AddToCart', 'InitiateCheckout', 'CompletePayment'];
// TikTok keeps CompletePayment; Meta's standard purchase event is "Purchase".
const META_EVENT_NAME = { AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout', CompletePayment: 'Purchase' };

function sha256(s) {
  return crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const ttToken = process.env.TIKTOK_ACCESS_TOKEN;
  const metaToken = process.env.META_ACCESS_TOKEN;
  if (!ttToken && !metaToken) return json(200, { ok: false, reason: 'not_configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'bad request' }); }

  const name = body.event;
  if (!SUPPORTED.includes(name)) return json(400, { error: 'unsupported event' });

  const headers = event.headers || {};
  const ip = (headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ua = headers['user-agent'] || '';

  let value;
  let currency = 'USD';
  let contentId = String(body.tier || '').toLowerCase();
  let email = '';

  if (name === 'CompletePayment') {
    // Verify the payment server-side so this event cannot be forged.
    if (!process.env.STRIPE_SECRET_KEY || !body.session_id) return json(200, { ok: false, reason: 'no_session' });
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(body.session_id);
    } catch (_) {
      return json(200, { ok: false, reason: 'session_lookup_failed' });
    }
    if (!session || (session.payment_status !== 'paid' && session.status !== 'complete')) {
      return json(200, { ok: false, reason: 'unpaid' });
    }
    value = (session.amount_total || 0) / 100;
    currency = (session.currency || 'usd').toUpperCase();
    contentId = (session.metadata && session.metadata.tier) || contentId;
    email = (session.customer_details && session.customer_details.email) || '';
  } else {
    value = TIER_VALUES[contentId];
  }

  const eventTime = Math.floor(Date.now() / 1000);
  const eventId = body.event_id ? String(body.event_id) : undefined;
  const url = body.url || '';

  const results = await Promise.all([
    sendTikTok(ttToken, { name, eventTime, eventId, url, ip, ua, value, currency, contentId, email, body }),
    sendMeta(metaToken, { name, eventTime, eventId, url, ip, ua, value, currency, contentId, email, body }),
  ]);

  const tiktok = results[0];
  const meta = results[1];
  return json(200, { ok: !!(tiktok && tiktok.ok) || !!(meta && meta.ok), tiktok, meta });
};

async function sendTikTok(token, c) {
  if (!token) return { skipped: true };
  const user = {};
  if (c.email) user.email = sha256(c.email);
  if (c.ip) user.ip = c.ip;
  if (c.ua) user.user_agent = c.ua;
  if (c.body.ttclid) user.ttclid = c.body.ttclid;
  if (c.body.ttp) user.ttp = c.body.ttp;

  const properties = { content_type: 'product' };
  if (c.contentId) {
    properties.contents = [{ content_id: c.contentId, content_type: 'product', quantity: 1, price: c.value || 0 }];
  }
  if (c.value) { properties.value = c.value; properties.currency = c.currency; }

  const dataEvent = { event: c.name, event_time: c.eventTime, user: user, properties: properties };
  if (c.eventId) dataEvent.event_id = c.eventId;
  if (c.url) dataEvent.page = { url: c.url };

  try {
    const res = await fetch(TT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': token },
      body: JSON.stringify({ event_source: 'web', event_source_id: TT_PIXEL, data: [dataEvent] }),
    });
    const out = await res.json().catch(() => ({}));
    return { ok: out.code === 0, code: out.code, message: out.message };
  } catch (err) {
    console.error('TikTok Events API send failed:', err && err.message);
    return { ok: false, reason: 'send_failed' };
  }
}

async function sendMeta(token, c) {
  if (!token) return { skipped: true };
  const userData = {};
  if (c.email) userData.em = [sha256(c.email)];
  if (c.ip) userData.client_ip_address = c.ip;
  if (c.ua) userData.client_user_agent = c.ua;
  if (c.body.fbp) userData.fbp = c.body.fbp;
  if (c.body.fbc) userData.fbc = c.body.fbc;

  const customData = {};
  if (c.contentId) {
    customData.content_type = 'product';
    customData.content_ids = [c.contentId];
    customData.contents = [{ id: c.contentId, quantity: 1, item_price: c.value || 0 }];
  }
  if (c.value) { customData.value = c.value; customData.currency = c.currency; }

  const dataEvent = {
    event_name: META_EVENT_NAME[c.name] || c.name,
    event_time: c.eventTime,
    action_source: 'website',
    user_data: userData,
    custom_data: customData,
  };
  if (c.eventId) dataEvent.event_id = c.eventId;
  if (c.url) dataEvent.event_source_url = c.url;

  const payload = { data: [dataEvent], access_token: token };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const res = await fetch(META_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (out.error) return { ok: false, code: out.error.code, message: out.error.message };
    return { ok: (out.events_received || 0) > 0, received: out.events_received };
  } catch (err) {
    console.error('Meta Conversions API send failed:', err && err.message);
    return { ok: false, reason: 'send_failed' };
  }
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

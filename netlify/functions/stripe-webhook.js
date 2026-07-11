'use strict';

/*
 * Stripe webhook: the delivery safety net.
 *
 * The render flow works without this (success_url -> render.html?paid=...),
 * but it depends on the customer keeping that tab open. This closes the
 * "paid, closed the tab, saw nothing" case: on checkout.session.completed
 * we email the buyer their order summary and the permanent recovery link,
 * which re-attaches to the same render jobs via the payment-intent stamp
 * in render-create (so the link never double-spends).
 *
 * Register the endpoint in the Stripe dashboard:
 *   https://<site>/.netlify/functions/stripe-webhook
 *   events: checkout.session.completed
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY        already set
 *   STRIPE_WEBHOOK_SECRET    whsec_... from the dashboard endpoint
 *   ZOHO_USER                sender address (shared with auto-reply)
 *   ZOHO_APP_PASSWORD        Zoho app password
 * Optional:
 *   FROM_NAME                display name on the email (default Hexa AI)
 */


function resp(statusCode, body) {
  return { statusCode, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function fmtUsd(cents) {
  return '$' + (Math.round(cents) / 100).toFixed(2).replace(/\.00$/, '');
}

function studioEmail({ session, origin }) {
  const m = session.metadata || {};
  const link = origin + '/render.html?paid=' + encodeURIComponent(session.id);
  const productName = m.studio_product_name || '';
  const style = m.studio_style || '';
  const isVideo = ['photoshoot', 'adpack', 'soul'].indexOf(m.studio_product) === -1;
  const thing = isVideo ? 'film' : (m.studio_product === 'photoshoot' ? 'photoshoot' : 'order');

  const lines = [
    'Payment received: ' + fmtUsd(session.amount_total || 0) + '.',
    '',
    'Your ' + thing + (productName ? ' for ' + productName : '') + ' is rendering now.',
    'Watch it live, and download the finished file, here:',
    '',
    link,
    '',
    'That link is yours: it always reopens this order, even days later.',
    'If a render ever fails, you are not charged for it. Ever.',
    '',
    'Questions? Just reply to this email, a human answers.',
    '',
    'Hexa AI',
  ];
  if (isVideo) {
    lines.push('', 'P.S. Once it lands in your library, you can swap the voice, translate it into 18 languages, or upscale it, each in one click from your account.');
  }

  const summary = [
    style && 'Style: ' + style,
    m.studio_duration && isVideo && 'Length: ' + m.studio_duration + 's, one continuous film',
    m.studio_aspect && 'Format: ' + m.studio_aspect,
  ].filter(Boolean);

  const text = lines.slice(0, 2).concat(summary.length ? summary.concat(['']) : []).concat(lines.slice(2)).join('\n');
  const { bodyHtml } = require('./lib/mail-html');
  return {
    subject: 'Your Hexa ' + thing + ' is rendering' + (productName ? ': ' + productName : ''),
    text,
    html: bodyHtml(text, { [link]: 'Watch it render live' }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, 'POST only');
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('stripe-webhook: missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return resp(503, 'not configured');
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : (event.body || '');

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('stripe-webhook: bad signature:', e.message);
    return resp(400, 'bad signature');
  }

  if (evt.type !== 'checkout.session.completed') return resp(200, { ignored: evt.type });

  const session = evt.data.object;
  const email = session.customer_details && session.customer_details.email;
  const isStudio = !!(session.metadata && session.metadata.studio_product);

  // Make the order row exist and read 'paid' even if the buyer's tab never
  // reopened (checkout wrote it 'pending'; a lost insert is recreated here).
  // Never flips a refunded order back to paid, and never blocks the email.
  if (isStudio) {
    try {
      const sb = require('./lib/supabase');
      const userId = session.client_reference_id ||
        (session.metadata && session.metadata.user_id) || null;
      if (sb.configured() && userId) {
        const db = sb.admin();
        const { data: existing } = await db.from('orders')
          .select('id,status').eq('stripe_session_id', session.id).maybeSingle();
        if (!existing) {
          await db.from('orders').insert({
            user_id: userId,
            stripe_session_id: session.id,
            product: session.metadata.studio_product || null,
            amount_cents: session.amount_total || null,
            status: 'paid',
          });
        } else if (existing.status === 'pending') {
          await db.from('orders').update({ status: 'paid' }).eq('id', existing.id);
        }
      }
    } catch (e) {
      console.error('stripe-webhook: order upsert failed:', e.message);
    }
  }

  // Legacy tier orders get their email from the intake form's auto-reply;
  // this webhook only owns the studio flow.
  if (!isStudio || !email) return resp(200, { ok: true, skipped: !isStudio ? 'not studio' : 'no email' });

  const mailer = require('./lib/mailer');
  if (!mailer.configured()) {
    console.error('stripe-webhook: no mail transport configured (ZOHO_USER/ZOHO_APP_PASSWORD); cannot email', email);
    return resp(200, { ok: false, warning: 'email not configured' });
  }

  const origin = (process.env.URL || 'https://madebyhexa.co').replace(/\/$/, '');
  const { subject, text, html } = studioEmail({ session, origin });

  const transporter = mailer.transport();

  try {
    await transporter.sendMail({
      from: '"' + (process.env.FROM_NAME || 'Hexa AI') + '" <' + mailer.fromAddress() + '>',
      to: email,
      replyTo: mailer.fromAddress(),
      subject,
      text,
      html,
    });
    console.log('stripe-webhook: confirmation sent to', email, 'for session', session.id);
  } catch (e) {
    // Answer 500 so Stripe retries: the email IS the point of this endpoint.
    console.error('stripe-webhook: send failed:', e.message);
    return resp(500, 'email send failed');
  }

  return resp(200, { ok: true });
};

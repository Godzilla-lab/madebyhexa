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

const nodemailer = require('nodemailer');

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
    'If a render ever fails, you are not charged for it.',
    '',
    'Questions? Just reply to this email.',
    '',
    'Hexa AI',
  ];

  const summary = [
    style && 'Style: ' + style,
    m.studio_duration && isVideo && 'Length: ' + m.studio_duration + 's, one continuous film',
    m.studio_aspect && 'Format: ' + m.studio_aspect,
  ].filter(Boolean);

  return {
    subject: 'Your Hexa ' + thing + ' is rendering' + (productName ? ' — ' + productName : ''),
    text: lines.slice(0, 2).concat(summary.length ? summary.concat(['']) : []).concat(lines.slice(2)).join('\n'),
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

  // Legacy tier orders get their email from the intake form's auto-reply;
  // this webhook only owns the studio flow.
  if (!isStudio || !email) return resp(200, { ok: true, skipped: !isStudio ? 'not studio' : 'no email' });

  if (!process.env.ZOHO_USER || !process.env.ZOHO_APP_PASSWORD) {
    console.error('stripe-webhook: ZOHO_USER/ZOHO_APP_PASSWORD not set; cannot email', email);
    return resp(200, { ok: false, warning: 'email not configured' });
  }

  const origin = (process.env.URL || 'https://madebyhexa.co').replace(/\/$/, '');
  const { subject, text } = studioEmail({ session, origin });

  const transporter = nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: process.env.ZOHO_USER, pass: process.env.ZOHO_APP_PASSWORD },
  });

  try {
    await transporter.sendMail({
      from: '"' + (process.env.FROM_NAME || 'Hexa AI') + '" <' + process.env.ZOHO_USER + '>',
      to: email,
      replyTo: process.env.ZOHO_USER,
      subject,
      text,
    });
    console.log('stripe-webhook: confirmation sent to', email, 'for session', session.id);
  } catch (e) {
    // Answer 500 so Stripe retries: the email IS the point of this endpoint.
    console.error('stripe-webhook: send failed:', e.message);
    return resp(500, 'email send failed');
  }

  return resp(200, { ok: true });
};

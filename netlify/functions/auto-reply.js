'use strict';

/*
 * Auto-reply email for the free-sample lead form.
 *
 * Triggered by a Netlify Form-submission outgoing webhook. Verifies the
 * incoming JWS signature against WEBHOOK_SECRET so only Netlify can fire it,
 * then sends a templated email to the lead via Zoho SMTP using nodemailer.
 *
 * Required env vars (set in Netlify dashboard, NOT committed):
 *   ZOHO_USER          e.g. mike@hexaaiagency.com
 *   ZOHO_APP_PASSWORD  app-specific password from Zoho (not the login password)
 *   WEBHOOK_SECRET     random string; same value goes in Netlify form notification
 *   FROM_NAME          optional, defaults to "Mike"
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const REQUIRED_ENV = ['ZOHO_USER', 'ZOHO_APP_PASSWORD', 'WEBHOOK_SECRET'];

function verifyNetlifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (expected.length !== sigB64.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigB64))) return false;
  } catch (_) {
    return false;
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  } catch (_) {
    return false;
  }

  if (!claims.sha256) return false;
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  if (bodyHash !== claims.sha256) return false;

  if (claims.iat && Math.abs(Date.now() / 1000 - claims.iat) > 600) return false;

  return true;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmail({ name, brand }) {
  const firstName = name && name.trim() ? name.trim().split(/\s+/)[0] : 'there';
  const brandLabel = brand && brand.trim() ? brand.trim() : 'your brand';

  const subject = 'Your free Hexa AI sample is on the way';

  const text =
    `Hey ${firstName},\n\n` +
    `Thanks for sending over ${brandLabel}, we got it.\n\n` +
    `Our team is already on it. Within the next 48 hours you'll have a short sample video of your product, sent to this email.\n\n` +
    `If you have a specific vibe, reference clip, or angle you'd like us to try, just hit reply. Totally optional, we'll go with our best judgment if you don't.\n\n` +
    `If you'd rather skip the wait and talk through a full campaign, here's our calendar: https://cal.com/hexaiagency\n\n` +
    `Talk soon,\n` +
    `Mike\n` +
    `Hexa AI · madebyhexa.co\n`;

  const html =
    `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:560px;margin:0 auto;padding:24px;background:#ffffff;">` +
    `<p>Hey ${escapeHtml(firstName)},</p>` +
    `<p>Thanks for sending over <strong>${escapeHtml(brandLabel)}</strong>, we got it.</p>` +
    `<p>Our team is already on it. Within the next 48 hours you'll have a short sample video of your product, sent to this email.</p>` +
    `<p>If you have a specific vibe, reference clip, or angle you'd like us to try, just hit reply. Totally optional, we'll go with our best judgment if you don't.</p>` +
    `<p>If you'd rather skip the wait and talk through a full campaign, here's our calendar:<br>` +
    `<a href="https://cal.com/hexaiagency" style="color:#ff4d6d;">cal.com/hexaiagency</a></p>` +
    `<p>Talk soon,<br>Mike<br>` +
    `<span style="color:#666;">Hexa AI · <a href="https://madebyhexa.co" style="color:#666;">madebyhexa.co</a></span></p>` +
    `</body></html>`;

  return { subject, text, html };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (!process.env.WEBHOOK_SECRET) {
    console.error('Missing env var: WEBHOOK_SECRET');
    return { statusCode: 500, body: 'Misconfigured' };
  }

  const rawBody = event.body || '';
  const headers = event.headers || {};
  const signature = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];

  if (!verifyNetlifySignature(rawBody, signature, process.env.WEBHOOK_SECRET)) {
    console.warn('Invalid or missing signature');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error('Skipping send, missing env vars:', missing.join(', '));
    return { statusCode: 200, body: 'Skipped (misconfigured, see logs)' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return { statusCode: 200, body: 'Bad payload, ignored' };
  }

  const formName = payload.form_name || payload.formName;
  if (formName && formName !== 'free-sample') {
    return { statusCode: 200, body: 'Wrong form, ignored' };
  }

  const data = payload.data || {};
  const botField = data['bot-field'];
  if (botField && String(botField).trim() !== '') {
    console.log('Honeypot filled, treating as spam');
    return { statusCode: 200, body: 'Skipped (honeypot)' };
  }

  const email = (data.email || '').trim();
  const name = data.name || '';
  const brand = data.brand || '';

  if (!email || !/.+@.+\..+/.test(email)) {
    console.warn('No valid email on submission, skipping');
    return { statusCode: 200, body: 'No email' };
  }

  const { subject, text, html } = buildEmail({ name, brand });

  const transporter = nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.ZOHO_USER,
      pass: process.env.ZOHO_APP_PASSWORD,
    },
  });

  const fromName = process.env.FROM_NAME || 'Mike';
  const fromAddress = process.env.ZOHO_USER;

  try {
    await transporter.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: email,
      replyTo: fromAddress,
      subject,
      text,
      html,
    });
    console.log('Auto-reply sent to', email);
  } catch (err) {
    console.error('Send failed:', err && err.message);
    return { statusCode: 500, body: 'Send failed' };
  }

  return { statusCode: 200, body: 'OK' };
};

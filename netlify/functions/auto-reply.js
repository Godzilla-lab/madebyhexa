'use strict';

/*
 * Auto-reply emails for two Netlify forms:
 *   - free-sample   the lead magnet (free sample video request)
 *   - order-intake  a paid order's product/asset intake (after Stripe checkout)
 *
 * Triggered by a Netlify Form-submission outgoing webhook. Verifies the
 * incoming JWS signature against WEBHOOK_SECRET so only Netlify can fire it,
 * then sends a templated email to the customer via Zoho SMTP using nodemailer.
 *
 * Required env vars (set in Netlify dashboard, NOT committed):
 *   ZOHO_USER          e.g. hello@madebyhexa.co
 *   ZOHO_APP_PASSWORD  app-specific password from Zoho (not the login password)
 *   WEBHOOK_SECRET     random string; same value goes in Netlify form notification
 *   FROM_NAME          optional, defaults to "Mike"
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getStore } = require('@netlify/blobs');

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

const TIER_LABELS = {
  single: '1 finished video',
  triple: '3 videos (split-test pack)',
};

function emailShell(inner) {
  return (
    `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:560px;margin:0 auto;padding:24px;background:#ffffff;">` +
    inner +
    `<p>Talk soon,<br>Mike<br>` +
    `<span style="color:#666;">Hexa AI · <a href="https://madebyhexa.co" style="color:#666;">madebyhexa.co</a></span></p>` +
    `</body></html>`
  );
}

const SIGNATURE = `\nTalk soon,\nMike\nHexa AI · madebyhexa.co\n`;

// Free-sample lead: confirm receipt, set the 48h expectation, and gently
// plant the review ask so genuine testimonials accumulate over time.
function buildSampleEmail({ name, brand }) {
  const firstName = name && name.trim() ? name.trim().split(/\s+/)[0] : 'there';
  const brandLabel = brand && brand.trim() ? brand.trim() : 'your brand';

  const subject = 'Your free Hexa AI sample is on the way';

  const text =
    `Hey ${firstName},\n\n` +
    `Thanks for sending over ${brandLabel}, we got it.\n\n` +
    `Our team is already on it. Within the next 48 hours you'll have a short sample video of your product, sent to this email.\n\n` +
    `If you have a specific vibe, reference clip, or angle you'd like us to try, just hit reply. Totally optional, we'll go with our best judgment if you don't.\n\n` +
    `Once it lands, we'd love a quick honest line on what you think. It helps us a lot, and the best ones go on our site (with your okay).\n\n` +
    `If you'd rather skip the wait and talk through a full campaign, here's our calendar: https://cal.com/hexaiagency\n` +
    SIGNATURE;

  const html = emailShell(
    `<p>Hey ${escapeHtml(firstName)},</p>` +
    `<p>Thanks for sending over <strong>${escapeHtml(brandLabel)}</strong>, we got it.</p>` +
    `<p>Our team is already on it. Within the next 48 hours you'll have a short sample video of your product, sent to this email.</p>` +
    `<p>If you have a specific vibe, reference clip, or angle you'd like us to try, just hit reply. Totally optional, we'll go with our best judgment if you don't.</p>` +
    `<p>Once it lands, we'd love a quick honest line on what you think. It helps us a lot, and the best ones go on our site (with your okay).</p>` +
    `<p>If you'd rather skip the wait and talk through a full campaign, here's our calendar:<br>` +
    `<a href="https://cal.com/hexaiagency" style="color:#ff4d6d;">cal.com/hexaiagency</a></p>`
  );

  return { subject, text, html };
}

// Repeat free-sample lead: this email already has a sample on record. Don't
// promise a second free video, acknowledge it and steer them to the packs.
function buildRepeatSampleEmail({ name, brand }) {
  const firstName = name && name.trim() ? name.trim().split(/\s+/)[0] : 'there';
  const brandLabel = brand && brand.trim() ? brand.trim() : 'your brand';

  const subject = 'You already have a Hexa AI sample on the way';

  const text =
    `Hey ${firstName},\n\n` +
    `Looks like you already requested a free sample for ${brandLabel}. It's on the way to this inbox within 48 hours of your first request, no need to ask again.\n\n` +
    `Free samples are one per brand. If you want more than one video, or you want it faster, you can grab a pack and we ship in 48 hours:\n` +
    `https://madebyhexa.co/offer#pricing\n\n` +
    `Want to talk through a full campaign instead? Here's our calendar: https://cal.com/hexaiagency\n` +
    SIGNATURE;

  const html = emailShell(
    `<p>Hey ${escapeHtml(firstName)},</p>` +
    `<p>Looks like you already requested a free sample for <strong>${escapeHtml(brandLabel)}</strong>. It's on the way to this inbox within 48 hours of your first request, no need to ask again.</p>` +
    `<p>Free samples are one per brand. If you want more than one video, or you want it faster, you can grab a pack and we ship in 48 hours:<br>` +
    `<a href="https://madebyhexa.co/offer#pricing" style="color:#ff4d6d;">madebyhexa.co/offer</a></p>` +
    `<p>Want to talk through a full campaign instead? Here's our calendar:<br>` +
    `<a href="https://cal.com/hexaiagency" style="color:#ff4d6d;">cal.com/hexaiagency</a></p>`
  );

  return { subject, text, html };
}

// ── Free-sample dedup (Netlify Blobs) ───────────────────────────────────────
// We key by a hash of the lowercased email so raw addresses aren't stored as
// keys and any email is a valid key. All store access fails OPEN: if Blobs is
// unavailable we treat the lead as new and still send the normal confirmation,
// so a storage hiccup never drops a real lead.
const SAMPLE_STORE = 'free-sample-emails';

function sampleKey(email) {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

async function getSampleStatus(email) {
  try {
    const store = getStore(SAMPLE_STORE);
    const existing = await store.get(sampleKey(email));
    return existing ? 'repeat' : 'new';
  } catch (err) {
    console.warn('Sample dedup store unavailable, failing open:', err && err.message);
    return 'unknown';
  }
}

async function recordSample(email) {
  try {
    const store = getStore(SAMPLE_STORE);
    await store.set(sampleKey(email), String(Date.now()));
  } catch (err) {
    console.warn('Sample dedup record failed:', err && err.message);
  }
}

// Paid order intake: confirm the order is in production after they submitted assets.
function buildOrderEmail({ name, brand, tier }) {
  const firstName = name && name.trim() ? name.trim().split(/\s+/)[0] : 'there';
  const brandLabel = brand && brand.trim() ? brand.trim() : 'your brand';
  const tierLabel = TIER_LABELS[String(tier || '').toLowerCase()] || 'your order';

  const subject = 'Your Hexa AI order is in production';

  const text =
    `Hey ${firstName},\n\n` +
    `Payment received and your details are in, thank you. Your order (${tierLabel}) for ${brandLabel} is now in production.\n\n` +
    `You'll have your brand-ready video delivered to this email within 48 hours, cut for 9:16, 1:1 and 16:9 with captions and a hook.\n\n` +
    `If there's a specific angle, reference, or must-have detail, just hit reply and we'll fold it in. Every order includes a free revision round, so we'll get it right.\n` +
    SIGNATURE;

  const html = emailShell(
    `<p>Hey ${escapeHtml(firstName)},</p>` +
    `<p>Payment received and your details are in, thank you. Your order (<strong>${escapeHtml(tierLabel)}</strong>) for <strong>${escapeHtml(brandLabel)}</strong> is now in production.</p>` +
    `<p>You'll have your brand-ready video delivered to this email within 48 hours, cut for 9:16, 1:1 and 16:9 with captions and a hook.</p>` +
    `<p>If there's a specific angle, reference, or must-have detail, just hit reply and we'll fold it in. Every order includes a free revision round, so we'll get it right.</p>`
  );

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
  const KNOWN_FORMS = ['free-sample', 'free-sample-eco', 'order-intake'];
  if (formName && !KNOWN_FORMS.includes(formName)) {
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
  const tier = data.tier || '';

  if (!email || !/.+@.+\..+/.test(email)) {
    console.warn('No valid email on submission, skipping');
    return { statusCode: 200, body: 'No email' };
  }

  const isOrder = formName === 'order-intake';

  // Free-sample dedup: a repeat email gets a softer reply instead of a fresh
  // confirmation, and the team gets flagged so they don't make a second video.
  const sampleStatus = isOrder ? 'order' : await getSampleStatus(email);
  const isRepeatSample = sampleStatus === 'repeat';

  const { subject, text, html } = isOrder
    ? buildOrderEmail({ name, brand, tier })
    : isRepeatSample
      ? buildRepeatSampleEmail({ name, brand })
      : buildSampleEmail({ name, brand });

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

  // Post-send bookkeeping for free-sample leads only.
  if (!isOrder) {
    if (isRepeatSample) {
      // Internal heads-up to the business inbox (ZOHO_USER), never a personal
      // address. Best-effort: a failure here must not fail the webhook.
      try {
        await transporter.sendMail({
          from: `"Hexa AI" <${fromAddress}>`,
          to: fromAddress,
          subject: `Repeat free-sample request: ${email}`,
          text:
            `${email}${brand ? ` (${brand})` : ''} just requested another free sample.\n\n` +
            `They already have one on record, so this is a duplicate. They got the ` +
            `"already on the way" reply pointing them to the packs. No need to make a ` +
            `second free video unless you want to.\n`,
        });
      } catch (err) {
        console.warn('Internal heads-up failed:', err && err.message);
      }
    } else if (sampleStatus === 'new') {
      // Record only after a successful first send, so a send failure never
      // marks an email as "claimed" without an email actually going out.
      await recordSample(email);
    }
  }

  return { statusCode: 200, body: 'OK' };
};

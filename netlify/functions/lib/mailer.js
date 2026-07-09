/* One outbound-mail transport for every function.
 *
 * Resend when RESEND_API_KEY is set: the domain madebyhexa.co is verified
 * there, so any From address on it works (support@) with no mailbox needed.
 * Falls back to Zoho SMTP (needs the paid Mail Lite plan) when only the
 * ZOHO_* pair is present. Incoming mail is unaffected either way; replies
 * still land in the Zoho inbox.
 *
 * env:
 *   RESEND_API_KEY   re_...            preferred sender
 *   MAIL_FROM        support@madebyhexa.co   From/Reply-To (default below)
 *   ZOHO_USER / ZOHO_APP_PASSWORD      legacy fallback sender
 */

'use strict';

const nodemailer = require('nodemailer');

function configured() {
  return !!(process.env.RESEND_API_KEY || (process.env.ZOHO_USER && process.env.ZOHO_APP_PASSWORD));
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.ZOHO_USER || 'support@madebyhexa.co';
}

function transport() {
  if (process.env.RESEND_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    });
  }
  return nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: process.env.ZOHO_USER, pass: process.env.ZOHO_APP_PASSWORD },
  });
}

module.exports = { configured, fromAddress, transport };

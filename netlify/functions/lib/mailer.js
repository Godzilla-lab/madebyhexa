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
    // Resend over plain HTTPS, not SMTP: an API call finishes in one round
    // trip (SMTP is a multi-step handshake that eats seconds of function
    // time and hangs entirely on networks that block port 465). Same
    // sendMail(message) surface nodemailer callers already use.
    return {
      sendMail: async function (msg) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: msg.from,
            to: Array.isArray(msg.to) ? msg.to : [msg.to],
            subject: msg.subject,
            text: msg.text,
            html: msg.html || undefined,
            reply_to: msg.replyTo || undefined,
            headers: msg.headers || undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error('resend ' + res.status + ': ' + (data.message || JSON.stringify(data).slice(0, 200)));
        }
        return data;
      },
    };
  }
  return nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: process.env.ZOHO_USER, pass: process.env.ZOHO_APP_PASSWORD },
  });
}

module.exports = { configured, fromAddress, transport };

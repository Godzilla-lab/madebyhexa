/* One outbound-mail transport for every function: Zoho SMTP.
 *
 * Chris's decision 2026-07-11: Resend is gone (account deleted); all mail
 * rides the Zoho mailbox. Zoho SMTP requires the paid Mail Lite plan; until
 * that subscription is active, sends fail and the callers are built for it:
 * the drip retries hourly inside each step's grace window, and the Stripe
 * webhook answers 500 so Stripe redelivers the receipt event for days.
 * Everything catches up on its own once SMTP unlocks.
 *
 * Zoho rule worth remembering: the From address must be the authenticated
 * mailbox (ZOHO_USER) or one of its configured aliases, or Zoho refuses the
 * send. fromAddress() therefore defaults to ZOHO_USER.
 *
 * env:
 *   ZOHO_USER / ZOHO_APP_PASSWORD   the sending mailbox + app password
 *   MAIL_FROM                       optional From override (must be an alias)
 */

'use strict';

const nodemailer = require('nodemailer');

/* Master switch: Chris paused ALL outbound mail until the Zoho Mail Lite
 * subscription is paid (2026-07-11). Flip it by setting MAIL_READY=1 in
 * Netlify env (all contexts) and publishing. While off, every sender takes
 * its not-configured path: the drip skips without consuming steps and
 * welcome-now answers 503 so the client retries on a later visit. */
function configured() {
  if (process.env.MAIL_READY !== '1') return false;
  return !!(process.env.ZOHO_USER && process.env.ZOHO_APP_PASSWORD);
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.ZOHO_USER || 'support@madebyhexa.co';
}

function transport() {
  return nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: process.env.ZOHO_USER, pass: process.env.ZOHO_APP_PASSWORD },
  });
}

module.exports = { configured, fromAddress, transport };

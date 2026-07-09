/* Shared between the scheduled drip sender and the public unsubscribe
 * endpoint: HMAC tokens so an unsubscribe link can't be forged or guessed. */

'use strict';

const crypto = require('crypto');

const SITE = 'https://madebyhexa.co';

function unsubToken(userId) {
  return crypto.createHmac('sha256', process.env.WEBHOOK_SECRET || 'hexa')
    .update('drip:' + userId).digest('hex').slice(0, 32);
}

function unsubLink(userId) {
  return SITE + '/.netlify/functions/drip-unsub?u=' + encodeURIComponent(userId) +
    '&t=' + unsubToken(userId);
}

module.exports = { SITE, unsubToken, unsubLink };

/* One-click unsubscribe for the onboarding drip. Lives apart from drip.js
 * because scheduled functions are not reachable over HTTP in production.
 * GET ?u=<userId>&t=<hmac token> */

'use strict';

const { getStore } = require('@netlify/blobs');
const { unsubToken } = require('./lib/drip-links');

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  const q = (event && event.queryStringParameters) || {};
  if (!q.u || !q.t) return { statusCode: 400, body: 'Missing parameters' };
  if (unsubToken(q.u) !== q.t) return { statusCode: 403, body: 'Bad link' };
  try {
    await getStore('drip').set('optout:' + q.u, String(Date.now()));
  } catch (e) {
    return { statusCode: 500, body: 'Try the link again in a minute.' };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<!doctype html><body style="font-family:-apple-system,sans-serif;background:#07050a;color:#fff;display:grid;place-items:center;min-height:90vh;text-align:center;"><div><h2>You are unsubscribed.</h2><p style="color:rgba(255,255,255,0.6);">No more onboarding emails from Hexa. Order receipts still arrive.</p></div></body>',
  };
};

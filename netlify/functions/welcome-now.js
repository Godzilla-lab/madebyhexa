'use strict';

/*
 * Instant welcome: fires Mike's day-0 email the moment an account exists,
 * instead of making the first impression wait for the hourly drip run.
 *
 * POST with the signed-in user's Bearer token (auth.js pings this right
 * after sign-up). Idempotent through the same sent-state the drip uses, so
 * the hourly run and this endpoint can never double-send; a user can only
 * ever trigger their own welcome, once.
 */

const { getUser } = require('./lib/auth');
const { allow } = require('./lib/ratelimit');
const drip = require('./drip');

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const mailer = require('./lib/mailer');
  if (!mailer.configured()) return json(503, { error: 'mail not configured' });

  if (!(await allow('welcome', event, 5))) return json(429, { error: 'slow down' });

  const user = await getUser(event);
  if (!user) return json(401, { error: 'sign in first' });

  const step = drip.STEPS.find((s) => s.key === 'welcome');
  if (await drip.optedOut(user.userId)) return json(200, { sent: false, reason: 'opted out' });
  if (await drip.alreadySent(user.userId, step.key)) return json(200, { sent: false, reason: 'already sent' });

  // the greeting name lives in auth metadata, not on the token
  let fn = '';
  try {
    const sb = require('./lib/supabase');
    const { data } = await sb.admin().auth.admin.getUserById(user.userId);
    fn = String((data && data.user && data.user.user_metadata && data.user.user_metadata.name) || '')
      .trim().split(/\s+/)[0] || '';
  } catch (e) { /* no name, plain greeting */ }
  const niceFn = fn && fn.indexOf('@') === -1 ? fn.charAt(0).toUpperCase() + fn.slice(1) : '';

  try {
    await mailer.transport().sendMail({ to: user.email, ...drip.compose(step, niceFn, user.userId) });
    await drip.markSent(user.userId, step.key);
    console.log('welcome-now: sent to', user.email);
    return json(200, { sent: true });
  } catch (e) {
    console.error('welcome-now: send failed:', e.message);
    return json(502, { error: 'send failed' });
  }
};

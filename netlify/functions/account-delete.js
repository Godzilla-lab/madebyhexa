'use strict';

/*
 * GDPR account deletion (Art. 17): permanently removes the auth user; the
 * profiles/orders/creations rows cascade away with it (schema.sql).
 *
 * POST { confirm: "<account email>" } with Authorization: Bearer <jwt>.
 * The typed email must match the account exactly: deletion is the one action
 * that cannot be undone, so a stray click can never trigger it.
 *
 * Stripe keeps its own customer + payment records (legal retention);
 * generated media on the engine CDN ages out under the engine's retention
 * policy. Both are stated in the privacy policy.
 */

const { getUser } = require('./lib/auth');
const sb = require('./lib/supabase');
const { allow } = require('./lib/ratelimit');

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!sb.configured()) return json(503, { error: 'accounts not configured' });
  if (!(await allow('account-delete', event, 10))) return json(429, { error: 'Too many attempts.' });

  const user = await getUser(event);
  if (!user) return json(401, { error: 'sign in required' });

  let confirm = '';
  try { confirm = String(JSON.parse(event.body || '{}').confirm || ''); } catch (e) {}
  if (!user.email || confirm.trim().toLowerCase() !== user.email.toLowerCase()) {
    return json(400, { error: 'Type your account email exactly to confirm deletion.' });
  }

  try {
    const { error } = await sb.admin().auth.admin.deleteUser(user.userId);
    if (error) throw new Error(error.message);
    console.log('account deleted:', user.userId);
    return json(200, { ok: true });
  } catch (e) {
    console.error('account-delete failed:', e.message);
    return json(500, { error: 'Deletion failed. Try again or email us and we do it by hand.' });
  }
};

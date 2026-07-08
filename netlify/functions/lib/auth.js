'use strict';

/*
 * Resolve the signed-in user for a Netlify function request.
 *
 * The browser sends the Supabase access token as `Authorization: Bearer <jwt>`.
 * getUser() validates it against Supabase Auth (correct regardless of the token
 * signing algorithm) and returns { userId, email } or null. This is one network
 * hop per authenticated call; we can swap to offline JWKS verification later if
 * latency matters. Never trust user-supplied ids in the body — only this.
 */

const { admin, configured } = require('./supabase');

function bearer(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1] : null;
}

async function getUser(event) {
  if (!configured()) return null;
  const token = bearer(event);
  if (!token) return null;
  try {
    const { data, error } = await admin().auth.getUser(token);
    if (error || !data || !data.user) return null;
    return { userId: data.user.id, email: data.user.email || null };
  } catch (e) {
    return null;
  }
}

module.exports = { getUser, bearer };

'use strict';

/*
 * GET /.netlify/functions/account-creations
 *
 * Returns the signed-in user's creations, newest first, for the account
 * library. The caller must send `Authorization: Bearer <supabase access token>`;
 * we resolve the user server-side and query the service client filtered to
 * their id, so a user can only ever see their own library.
 */

const { getUser } = require('./lib/auth');
const { admin, configured } = require('./lib/supabase');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  if (!configured()) return json(503, { error: 'accounts not configured' });

  const u = await getUser(event);
  if (!u) return json(401, { error: 'sign in required' });

  const { data, error } = await admin()
    .from('creations')
    .select('id,order_id,type,title,result_urls,thumb_url,status,created_at')
    .eq('user_id', u.userId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('account-creations:', error.message);
    return json(500, { error: 'could not load your library' });
  }
  return json(200, { creations: data || [] });
};

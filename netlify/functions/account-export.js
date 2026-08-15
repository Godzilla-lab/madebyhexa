'use strict';

const { allow } = require('./lib/ratelimit');

/*
 * GDPR data export (Art. 15/20): everything Hexa stores about the signed-in
 * account, as one downloadable JSON file.
 *
 * GET with Authorization: Bearer <supabase jwt>. The user id comes from the
 * verified token, never from parameters, so an account can only ever export
 * itself. Media files live on the render engine's CDN; their URLs are
 * included via the creations rows.
 */

const { getUser } = require('./lib/auth');
const sb = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'GET only' };
  }
  if (!sb.configured()) {
    return { statusCode: 503, body: JSON.stringify({ error: 'accounts not configured' }) };
  }
  /*
   * A full data export is the most expensive read on the site and the most
   * sensitive: it assembles everything an account holds. Ten an hour is far
   * more than anyone genuinely exercising their data rights needs, and it stops
   * a stolen token being used to pull the same account repeatedly.
   */
  if (!(await allow('account-export', event, 30))) {
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many exports. Try again shortly.' }) };
  }

  const user = await getUser(event);
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'sign in required' }) };
  }

  try {
    const db = sb.admin();
    const [profile, orders, creations] = await Promise.all([
      db.from('profiles').select('id,email,name,created_at').eq('id', user.userId).maybeSingle(),
      db.from('orders').select('id,product,selections,amount_cents,status,refunded_at,created_at')
        .eq('user_id', user.userId).order('created_at', { ascending: false }),
      db.from('creations').select('id,order_id,engine,type,title,prompt,result_urls,thumb_url,status,created_at')
        .eq('user_id', user.userId).order('created_at', { ascending: false }),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      service: 'Hexa Studio (madebyhexa.co)',
      account: profile.data || { id: user.userId, email: user.email },
      orders: orders.data || [],
      creations: creations.data || [],
      notes: [
        'Amounts are in USD cents.',
        'Result URLs point to the generation engine CDN and may expire; download anything you want to keep.',
        'Payment card details are held by Stripe, not by Hexa. Request them via your Stripe receipt emails.',
      ],
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="hexa-account-export.json"',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify(payload, null, 2),
    };
  } catch (e) {
    console.error('account-export failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'export failed, try again' }) };
  }
};

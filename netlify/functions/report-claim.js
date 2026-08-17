'use strict';

/*
 * Exchange an anonymous claim token for ownership of a report.
 *
 * POST { id, claimToken }  with a bearer token -> { claimed, id, title }
 *
 * This is the step the schema has always described and nobody had written.
 * supabase/schema.sql calls claim_token "anonymous handle, exchanged for
 * user_id at sign-in", but the only user_id stamp in the codebase was
 * report-create.js's cache-hit branch, which claims a report somebody ELSE
 * built. A visitor's own free read had no path into their account at all: it
 * lived in tab-scoped sessionStorage and nowhere else, so closing the tab
 * orphaned a row that exists, is finished, and no account can ever see.
 *
 * With this, the tab copy is the fast path and the database row is the
 * guarantee. Losing the tab costs a lookup, not the report.
 *
 * Two rules make this safe, and both are about not trusting the caller:
 *
 *   1. The new owner is resolved from the verified bearer, never from the
 *      body. A body-supplied user_id would let any authenticated caller
 *      redirect somebody else's claim into their own account.
 *   2. The token is compared in constant time, with a length check first,
 *      exactly as report-status.js:82 and render-create.js:1509 do it.
 *
 * Like report-status, a wrong token gets 404 rather than 403: a 403 would
 * confirm the id exists, which is half of what an attacker needs.
 */

const sb = require('./lib/supabase');
const { getUser } = require('./lib/auth');
const { allow } = require('./lib/ratelimit');

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
  if (!sb.configured()) return json(503, { error: 'accounts not configured' });

  /*
   * Tight, unlike the report limits, because this spends nothing and a real
   * person claims one report per sign-in. A caller hammering this is guessing
   * tokens, and 30 tries an hour makes guessing 32 random bytes pointless
   * rather than merely impractical.
   */
  if (!(await allow('report-claim', event, 30))) {
    return json(429, { error: 'Too many attempts. Try again shortly.' });
  }

  const user = await getUser(event);
  if (!user) return json(401, { error: 'sign in first' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'bad json' }); }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const claim = typeof body.claimToken === 'string' ? body.claimToken.trim() : '';
  if (!id) return json(400, { error: 'missing id' });

  const db = sb.admin();
  const { data: row } = await db.from('reports')
    .select('id,user_id,claim_token,product_title')
    .eq('id', id)
    .maybeSingle();
  if (!row) return json(404, { error: 'not found' });

  /*
   * Already theirs. This is the ordinary case on a second call, because the
   * browser fires the claim from onAuthStateChange and again on load of the
   * welcome surface as race recovery. It answers success rather than an error
   * so the page has nothing to special-case.
   */
  if (row.user_id === user.userId) {
    return json(200, { claimed: true, already: true, id: row.id, title: row.product_title || null });
  }

  /*
   * timingSafeEqual throws on buffers of different lengths, so the length check
   * is load-bearing rather than an early-out.
   */
  let allowed = false;
  if (row.claim_token && claim && claim.length === row.claim_token.length) {
    allowed = require('crypto').timingSafeEqual(Buffer.from(claim), Buffer.from(row.claim_token));
  }
  if (!allowed) return json(404, { error: 'not found' });

  /*
   * .is('user_id', null) is what makes this idempotent and unstealable in one
   * clause: a row that already has an owner matches nothing, so a leaked token
   * cannot move a report out of the account that holds it. Because the update
   * returns the rows it touched, an empty result means somebody else got there
   * first, and that is a refusal rather than a success.
   */
  const { data: claimed, error } = await db.from('reports')
    .update({ user_id: user.userId })
    .eq('id', row.id)
    .is('user_id', null)
    .select('id,product_title');

  if (error) {
    console.error('[report-claim] update failed for ' + row.id + ': ' + error.message);
    return json(503, { error: 'could not claim that report' });
  }
  if (!claimed || !claimed.length) return json(404, { error: 'not found' });

  /*
   * The token is left in place rather than revoked. Nulling it would be tidier
   * on paper, but the page that triggers this claim is usually /validate with
   * the report open and report-status polling with claim=<token>; pulling the
   * token out from under an in-flight poll breaks the one screen this whole
   * flow exists to serve. It stays a tab-scoped secret either way, and the
   * .is() guard above already means holding it grants nothing but a read.
   */
  console.log('[report-claim] report ' + row.id + ' claimed by ' + user.userId);
  return json(200, {
    claimed: true,
    already: false,
    id: claimed[0].id,
    title: claimed[0].product_title || null,
  });
};

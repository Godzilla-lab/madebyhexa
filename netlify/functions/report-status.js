'use strict';

/*
 * Poll a validation report.
 *
 * GET ?id=<report id>&claim=<claim token>   anonymous
 * GET ?id=<report id>  with a bearer token  signed in
 *
 * Answers { status, step, payload? }. A report takes seconds on a warm
 * category and minutes on a cold one, so the browser sits on this the way it
 * sits on render-status.
 *
 * Ownership is the whole security surface here. A report id is a uuid in a
 * URL, so it proves nothing: either the caller holds the claim token that was
 * issued when the report was created, or the report belongs to their verified
 * account. Anything else is treated as not found, which is also why a wrong
 * token gets 404 rather than 403: a 403 would confirm the id exists.
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

/*
 * What the UI shows while it waits. The worker writes the key as it goes.
 *
 * The key travels alongside the prose. The page lights its progress list by
 * key, never by matching this text, so wording here can be improved without
 * silently breaking the bar on a deployed page.
 */
/* What report-create charged for a deep report. Must match DEEP_REPORT_CREDITS
 * there and REPORT_CREDITS in the worker: three files that have to agree,
 * because all three can move the same money. */
const REPORT_CREDITS = 1000;

const STEPS = {
  building: 'Reading what your market says',
  harvesting: 'Going out to gather fresh discussion',
  reading: 'Working out the patterns',
  ads: 'Pulling competitor ads and run dates',
  angles: 'Working out the angles',
};

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  if (!sb.configured()) return json(503, { error: 'accounts not configured' });

  // Generous: this is polled every couple of seconds for the length of a cold
  // harvest, which can run minutes. Sized for a real user on a shared address,
  // not for the theoretical minimum.
  if (!(await allow('report-status', event, 3000))) {
    return json(429, { error: 'Too many status checks. Give it a moment.' });
  }

  const q = event.queryStringParameters || {};
  const id = typeof q.id === 'string' ? q.id.trim() : '';
  const claim = typeof q.claim === 'string' ? q.claim.trim() : '';
  if (!id) return json(400, { error: 'missing id' });

  const db = sb.admin();
  const { data: row } = await db.from('reports')
    .select('id,user_id,claim_token,status,step,product_title,product_url,verdict,demand_signal,evidence_count,payload,paid,created_at')
    .eq('id', id)
    .maybeSingle();
  if (!row) return json(404, { error: 'not found' });

  /*
   * Two ways to be allowed to read this, and the claim token is checked with a
   * constant-time compare so the endpoint cannot be used as an oracle to guess
   * a token one byte at a time.
   */
  let allowed = false;
  if (row.claim_token && claim && claim.length === row.claim_token.length) {
    allowed = require('crypto').timingSafeEqual(Buffer.from(claim), Buffer.from(row.claim_token));
  }
  if (!allowed && row.user_id) {
    const user = await getUser(event);
    allowed = !!user && user.userId === row.user_id;
  }
  if (!allowed) return json(404, { error: 'not found' });

  /*
   * A report that stopped moving.
   *
   * The worker refunds on every failure it can see, but it cannot see the one
   * failure that matters most here: its own timeout. A background function is
   * killed at fifteen minutes with no chance to run cleanup, so a run that
   * overruns leaves the row 'building' forever and the customer a thousand
   * credits down with a spinner. Measured 2026-08-14, a deep report on a cold
   * category took 730 seconds and a warm one with the ads leg took 685, so this
   * is a live risk rather than a theoretical one.
   *
   * This is the natural place to catch it, because the browser polls here for
   * exactly as long as the customer is still waiting. Refund first, then mark
   * failed: if the refund throws, the row stays 'building' and the next poll
   * tries again, which is the safe order. Refunding twice is impossible anyway,
   * the ledger's unique index on (ref) for refunds settles that.
   */
  const STALE_MS = 17 * 60 * 1000;   // the 15 minute ceiling, plus slack
  if (row.status === 'building' && Date.now() - new Date(row.created_at).getTime() > STALE_MS) {
    if (row.paid && row.user_id) {
      const { error: refundErr } = await db.rpc('credit_refund', {
        p_user: row.user_id,
        p_amount: REPORT_CREDITS,
        p_ref: 'report:' + row.id,
        p_note: 'Report not delivered: timed out',
      });
      if (refundErr) {
        console.error('[report-status] refund failed for stale report ' + row.id + ': ' + refundErr.message);
        return json(200, { status: 'building', step: STEPS.building, stepKey: 'building' });
      }
      await db.from('reports').update({ paid: false }).eq('id', row.id);
    }
    await db.from('reports').update({ status: 'failed', step: null }).eq('id', row.id);
    console.log('[report-status] marked stale report ' + row.id + ' failed and refunded');
    return json(200, {
      status: 'failed',
      message: 'That one took longer than it should have and we stopped it. Your credits are back on your balance.',
    });
  }

  if (row.status === 'failed') {
    return json(200, {
      status: 'failed',
      message: 'We could not read enough about this product to say anything honest. Nothing was charged.',
    });
  }

  if (row.status !== 'ready') {
    return json(200, {
      status: 'building',
      step: STEPS[row.step] || STEPS.building,
      stepKey: row.step || 'building',
      title: row.product_title || null,
    });
  }

  return json(200, {
    status: 'ready',
    // The page needs this to claim its one free ad, which is keyed to the
    // report rather than to an account.
    id: row.id,
    title: row.product_title,
    url: row.product_url,
    verdict: row.verdict,
    demandSignal: row.demand_signal,
    evidenceCount: row.evidence_count,
    paid: !!row.paid,
    payload: row.payload,
  });
};

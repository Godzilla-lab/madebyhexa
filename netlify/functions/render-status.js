'use strict';

/*
 * Poll endpoint for render.html.
 *
 * GET ?jobs=id1,id2,...  (also accepts legacy ?job=id)
 *
 * Aggregates every segment job and answers in the shape render.js expects:
 *   { status: 'in_progress'|'completed'|'failed',
 *     step: 'research'|'brief'|'generate'|'finish',
 *     pct: 0..100,
 *     result: { url, type, urls: [segment urls in order] } }   when completed
 */

const hf = require('./lib/hf');
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

const DONE = ['completed'];
const DEAD = ['failed', 'canceled', 'cancelled', 'nsfw', 'error'];

/*
 * Engines whose jobs are independent deliverables rather than segments of one
 * film. A pack of twenty ad creatives is twenty products; a film is one product
 * cut into fifteen second pieces that only means anything stitched together.
 *
 * The distinction decides what a single failure costs. Measured on production
 * 2026-08-14: nineteen completed jobs plus one failed job returned zero images
 * and refunded the whole order. Over twenty independent jobs even a modest
 * per-image failure rate makes that the usual outcome rather than the rare one,
 * so most packs would have delivered nothing. Failed work quietly eating a
 * customer's balance is the best documented way to kill a credit product.
 */
const INDEPENDENT_JOB_TYPES = ['ms_image', 'nano_banana_2', 'text2image_soul_v2'];

function isIndependentPack(jobs) {
  return jobs.length > 1 && jobs.every(function (j) {
    return INDEPENDENT_JOB_TYPES.indexOf(String(j && j.job_type)) >= 0;
  });
}

/* ── Persistence + refund on terminal states ─────────────────────
 * The poll carries ?paid=<Stripe session id> (unguessable, the same trust
 * anchor as the recovery link) so terminal states are recorded against the
 * order and its creation. ?creation=<id> is honored only with the dev key,
 * so a hostile client can never write to someone else's library row. All of
 * this is bookkeeping: failures log and never break the poll. */

async function ownedRows(q, event) {
  if (!sb.configured()) return { db: null };
  const db = sb.admin();
  const paid = typeof q.paid === 'string' && q.paid ? q.paid : null;
  if (paid) {
    const { data: order } = await db.from('orders')
      .select('id,user_id,status')
      .eq('stripe_session_id', paid).maybeSingle();
    return { db, order };
  }
  const devKey = process.env.RENDER_DEV_KEY;
  const given = (event.headers && (event.headers['x-render-key'] || event.headers['X-Render-Key'])) || '';
  if (q.creation && devKey && given === devKey) {
    return { db, creationId: q.creation };
  }

  /*
   * Credit renders have no Stripe session to identify them, so the creation id
   * is the handle. It is a client-supplied id, so it proves nothing on its own:
   * the row is loaded and its owner compared against the caller's verified JWT,
   * and a creation belonging to anyone else is treated as if it did not exist.
   * Without that check, guessing a uuid would let someone drive refunds into
   * another account's order.
   */
  if (q.creation) {
    const user = await getUser(event);
    if (!user) return { db };
    const { data: row } = await db.from('creations')
      .select('id,user_id,order_id')
      .eq('id', q.creation).maybeSingle();
    if (!row || row.user_id !== user.userId) return { db };
    if (!row.order_id) return { db, creationId: row.id };
    const { data: order } = await db.from('orders')
      .select('id,user_id,status')
      .eq('id', row.order_id).maybeSingle();
    return { db, creationId: row.id, order: order || undefined };
  }

  return { db };
}

/*
 * Give back credits for the creatives that did not arrive.
 *
 * Refunded at the rate the customer actually paid, not at list price: the
 * original spend row is divided by the number of jobs it bought. A pack buys
 * twenty creatives more cheaply than twenty singles would cost, so refunding
 * the single price on a pack failure would hand back more than was taken.
 *
 * Idempotent through the ledger's unique index on refund refs, keyed per failed
 * job. This runs on a polling endpoint that several browser tabs may call at
 * once, so it will genuinely be asked to refund the same job repeatedly.
 *
 * Returns credits returned by this call, or 0 when there is nothing to refund
 * (an unpaid dev render, no ledger row, or an already settled refund).
 */
async function refundLostCreatives(ctx, jobs, lost) {
  try {
    if (!ctx.db || !lost) return 0;
    const userId = ctx.order && ctx.order.user_id;
    if (!userId) return 0; // dev render or anonymous: nothing was charged

    const { data: spend } = await ctx.db.from('credit_ledger')
      .select('delta')
      .eq('user_id', userId)
      .eq('kind', 'spend')
      .eq('ref', 'order:' + ctx.order.id)
      .maybeSingle();
    if (!spend || !spend.delta) return 0;

    const paidCredits = Math.abs(Number(spend.delta));
    const perCreative = Math.floor(paidCredits / Math.max(1, jobs.length));
    if (!perCreative) return 0;

    const dead = jobs.filter(function (j) { return DEAD.indexOf(String(j.status)) >= 0; });
    const refs = dead.map(function (j) { return 'job:' + j.id; });
    for (const ref of refs) {
      await ctx.db.rpc('credit_refund', {
        p_user: userId,
        p_amount: perCreative,
        p_ref: ref,
        p_note: 'Creative failed to render',
      });
    }

    /*
     * Report what the ledger actually holds rather than what this call tried to
     * write. The refund is idempotent, so on every poll after the first it is a
     * no-op, and counting attempts would tell the customer their credits came
     * back again and again. Summing the rows gives the same true figure every
     * time the pack is polled.
     */
    const { data: rows } = await ctx.db.from('credit_ledger')
      .select('delta').eq('kind', 'refund').in('ref', refs);
    return (rows || []).reduce(function (n, r) { return n + Number(r.delta || 0); }, 0);
  } catch (e) {
    console.error('creative refund failed (will retry on next poll):', e.message);
    return 0;
  }
}

async function recordCompleted(ctx, urls, thumb) {
  try {
    if (!ctx.db) return;
    const patch = {
      status: 'completed',
      result_urls: urls.filter(Boolean),
      thumb_url: thumb || null,
    };
    let updated = null;
    if (ctx.order) {
      const { data } = await ctx.db.from('creations').update(patch)
        .eq('order_id', ctx.order.id).eq('status', 'rendering').select('id');
      updated = data;
    } else if (ctx.creationId) {
      const { data } = await ctx.db.from('creations').update(patch)
        .eq('id', ctx.creationId).eq('status', 'rendering').select('id');
      updated = data;
    }
    // Multi-segment film: hand the finished segments to the stitcher, exactly
    // once (the status='rendering' guard means only the first completing poll
    // gets rows back). Fire-and-forget; a lost invoke just means the customer
    // keeps per-segment delivery, same as before the stitcher existed.
    const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(patch.result_urls[0] || '');
    if (updated && updated.length && isVideo && patch.result_urls.length > 1 && process.env.WEBHOOK_SECRET) {
      // Self-invoke: DEPLOY_URL is this deploy, URL is always production. A
      // draft that called URL would hand its work to the live site's code.
      const base = (process.env.DEPLOY_URL || process.env.DEPLOY_PRIME_URL || process.env.URL || '')
        .replace(/\/$/, '');
      for (const row of updated) {
        await fetch(base + '/.netlify/functions/stitch-master-background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-stitch-key': process.env.WEBHOOK_SECRET },
          body: JSON.stringify({ creationId: row.id }),
        }).catch((e) => console.error('stitch invoke failed:', e.message));
      }
    }
  } catch (e) {
    console.error('record completed failed:', e.message);
  }
}

/* The site's promise: a failed render is never charged. Refund the whole
 * payment (idempotent per session, so repeated polls cannot double-refund)
 * and mark the order + creation. Returns true when the money is on its way
 * back, so the customer-facing message can say so honestly. */
async function refundFailed(ctx, paidSessionId) {
  try {
    if (!ctx.db) return false;
    if (ctx.creationId) {
      await ctx.db.from('creations').update({ status: 'failed' })
        .eq('id', ctx.creationId).eq('status', 'rendering');
      return false; // dev render: nothing was charged
    }
    if (!ctx.order) return false;
    await ctx.db.from('creations').update({ status: 'failed' })
      .eq('order_id', ctx.order.id).eq('status', 'rendering');
    if (ctx.order.status === 'refunded') return true; // already done

    if (!process.env.STRIPE_SECRET_KEY) return false;
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(paidSessionId);
    const pi = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent && session.payment_intent.id;
    if (session.payment_status !== 'paid' || !pi) return false;
    try {
      await stripe.refunds.create(
        { payment_intent: pi },
        { idempotencyKey: 'hexa-refund-' + paidSessionId }
      );
    } catch (e) {
      if (!/already been refunded|charge_already_refunded/i.test(String(e.message))) throw e;
    }
    await ctx.db.from('orders')
      .update({ status: 'refunded', refunded_at: new Date().toISOString() })
      .eq('id', ctx.order.id);
    console.log('refunded failed render, session', paidSessionId);
    return true;
  } catch (e) {
    console.error('refund on failure errored (will retry on next poll):', e.message);
    return false;
  }
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (!hf.configured()) return json(503, { error: 'generation backend not configured' });

  const q = event.queryStringParameters || {};
  /*
   * The id list is an amplifier: every id becomes one upstream call inside a
   * single Promise.all, so ?jobs=<ten thousand ids> turns one cheap request
   * into ten thousand engine calls. Cap it at the largest order we will ever
   * sell (60 creatives), which no honest client can exceed.
   *
   * The rate limit is deliberately loose. This is a polling endpoint: the
   * studio asks every few seconds for the length of a render, and a customer
   * with a slow 20 creative pack open in two tabs is not an attacker.
   */
  const MAX_JOBS_PER_POLL = 60;
  const ids = String(q.jobs || q.job || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean)
    .slice(0, MAX_JOBS_PER_POLL);
  if (!ids.length) return json(400, { error: 'missing jobs' });
  if (!(await allow('status', event, 3000))) {
    return json(429, { error: 'Too many status checks. Give it a moment.' });
  }

  try {
    const jobs = await Promise.all(ids.map(function (id) { return hf.getJob(id); }));

    const failed = jobs.find(function (j) { return DEAD.indexOf(String(j.status)) >= 0; });

    /*
     * Independent pack: settle per creative instead of per order.
     *
     * Nothing is decided until every job has stopped moving, otherwise the
     * first failure would end a pack whose remaining creatives are still on
     * their way. Once they have all settled, whatever rendered is delivered and
     * only the failures are refunded.
     */
    if (failed && isIndependentPack(jobs)) {
      const settled = jobs.every(function (j) {
        return DONE.indexOf(String(j.status)) >= 0 || DEAD.indexOf(String(j.status)) >= 0;
      });
      if (settled) {
        const good = jobs.filter(function (j) { return DONE.indexOf(String(j.status)) >= 0 && j.result_url; });
        const lost = jobs.length - good.length;
        const ctx = await ownedRows(q, event);

        // Nothing survived: this is an ordinary total failure, refund the lot.
        if (!good.length) {
          const refunded = await refundFailed(ctx, q.paid);
          return json(200, {
            status: 'failed',
            refunded: refunded,
            message: refunded
              ? 'Every creative failed to render. Your payment has been refunded automatically.'
              : 'Every creative failed to render. No charge stands for a failed render.',
          });
        }

        const urls = good.map(function (j) { return j.result_url; });
        await recordCompleted(ctx, urls, good[0].thumbnail_url);
        const credits = await refundLostCreatives(ctx, jobs, lost);
        return json(200, {
          status: 'completed',
          step: 'finish',
          pct: 100,
          partial: { delivered: good.length, of: jobs.length, failed: lost, creditsReturned: credits },
          // Said out loud on purpose. A silent refund still produces the
          // support ticket, because people notice the balance move anyway.
          message: lost + (lost === 1 ? ' creative' : ' creatives') + ' failed to render and '
            + (credits ? credits.toLocaleString() + ' credits were returned to your balance.'
                       : 'you were not charged for them.'),
          result: {
            url: urls[0],
            urls: urls,
            type: 'image',
            thumbnail: good[0].thumbnail_url || null,
          },
        });
      }
    }

    if (failed) {
      const ctx = await ownedRows(q, event);
      const refunded = await refundFailed(ctx, q.paid);
      return json(200, {
        status: 'failed',
        refunded: refunded,
        message: refunded
          ? 'Segment render failed (' + failed.status + '). Your payment has been refunded automatically.'
          : 'Segment render failed (' + failed.status + '). No charge stands for a failed render.',
      });
    }

    const done = jobs.filter(function (j) { return DONE.indexOf(String(j.status)) >= 0; });
    if (done.length === jobs.length) {
      const urls = jobs.map(function (j) { return j.result_url; });
      const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(urls[0] || '');
      const ctx = await ownedRows(q, event);
      await recordCompleted(ctx, urls, jobs[0].thumbnail_url);
      return json(200, {
        status: 'completed',
        step: 'finish',
        pct: 100,
        result: {
          url: urls[0],
          urls: urls,
          type: isVideo ? 'video' : 'image',
          thumbnail: jobs[0].thumbnail_url || null,
        },
      });
    }

    // in flight: queued jobs sit in 'brief', running ones in 'generate'
    const running = jobs.some(function (j) { return String(j.status) === 'in_progress'; });
    const pct = Math.round(10 + (done.length / jobs.length) * 80 + (running ? 8 : 0));
    return json(200, {
      status: 'in_progress',
      step: running || done.length ? 'generate' : 'brief',
      pct: Math.min(94, pct),
      segmentsDone: done.length,
      segmentsTotal: jobs.length,
    });
  } catch (e) {
    return json(502, { error: String(e.message), detail: e.detail || null });
  }
};

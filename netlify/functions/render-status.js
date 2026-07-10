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

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

const DONE = ['completed'];
const DEAD = ['failed', 'canceled', 'cancelled', 'nsfw', 'error'];

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
  return { db };
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
      const base = (process.env.URL || '').replace(/\/$/, '');
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
  const ids = String(q.jobs || q.job || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!ids.length) return json(400, { error: 'missing jobs' });

  try {
    const jobs = await Promise.all(ids.map(function (id) { return hf.getJob(id); }));

    const failed = jobs.find(function (j) { return DEAD.indexOf(String(j.status)) >= 0; });
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

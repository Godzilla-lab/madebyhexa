'use strict';

/*
 * Re-roll ONE creative in a delivered ad pack.
 *
 * The pack lands as twenty finished statics. That is a starting point, not a
 * verdict: a headline reads wrong, a concept misses, the buyer wants the same
 * argument said another way. Without this endpoint the only remedy is buying
 * another pack, which makes the "no reject fees" line on the pricing page a
 * lie. With it, every creative in the set is addressable on its own.
 *
 *   POST { creation, index, concept?, headline? }  -> { job: { id }, index, revisionsLeft }
 *   GET  ?creation=<id>&index=<n>&job=<jobId>      -> { status, url? }
 *
 * Why this is not just render-create with a flag: render-create is guarded by a
 * paid Stripe session, and a paid session deliberately REPLAYS its original
 * jobs so a refresh cannot spend twice. Reusing it for a revision would hand
 * back the original twenty every time. So a revision authenticates as the owner
 * of the creation instead, and its spend guard is a counted allowance on the
 * row rather than a payment.
 *
 * The allowance exists because free at the point of use is not free to us: one
 * nano_banana_2 image is about two credits, roughly ten cents. A full pack's
 * worth of re-rolls per pack keeps the promise real and caps the exposure at
 * about a dollar on a twelve dollar order.
 */

const hf = require('./lib/hf');
const sb = require('./lib/supabase');
const { getUser } = require('./lib/auth');
const { allow } = require('./lib/ratelimit');
const { planOrder } = require('./render-create');

const DONE = ['completed'];
const { DEAD, explain } = require('./lib/failure');

/* One pack's worth of re-rolls per pack. Generous enough that nobody hits it
 * doing honest work, finite enough that a scripted loop cannot mine free
 * images out of a single order. */
const REVISION_ALLOWANCE = 20;

/* The same catalogue render-create.js:93 reads, shaped the same way: the file
 * is { pulled_at, engine, items: [...] }, not a bare array, and the
 * review_shaped formats are excluded. A re-roll must not become the way in to
 * a concept the pack itself refuses to render. */
const AD_FORMAT_NAMES = Array.from(new Set(
  require('../../catalog/higgsfield/ad-formats.json').items
    .filter(function (f) { return f && !f.review_shaped; })
    .map(function (f) { return f.name; })
    .filter(Boolean)
));

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/*
 * Resolve the creation the caller is asking about, proving ownership from the
 * validated JWT rather than from anything in the request body. Returns either
 * { ok: false, status, error } or the row plus the order behind it.
 */
async function ownedPack(event, creationId) {
  if (!sb.configured()) return { ok: false, status: 503, error: 'accounts not configured' };
  const user = await getUser(event);
  if (!user) return { ok: false, status: 401, error: 'Sign in to edit this pack.' };
  if (!creationId) return { ok: false, status: 400, error: 'missing creation' };

  const db = sb.admin();
  const { data: creation, error } = await db.from('creations')
    .select('id,user_id,order_id,result_urls,status,revisions_used')
    .eq('id', creationId)
    .maybeSingle();
  if (error) {
    // Most likely cause on a fresh deploy: migration 002 has not been run, so
    // revisions_used does not exist yet. Say so in the log rather than leaving
    // a silent 503.
    console.error('render-revise: creations read failed:', error.message);
    return { ok: false, status: 503, error: 'could not read this creation' };
  }
  if (!creation || creation.user_id !== user.userId) {
    // Same answer for "does not exist" and "is not yours", so this endpoint
    // cannot be used to probe which creation ids are real.
    return { ok: false, status: 404, error: 'not found' };
  }
  if (creation.status !== 'completed' || !(creation.result_urls || []).length) {
    return { ok: false, status: 409, error: 'This set is still rendering. Edits open once it lands.' };
  }

  let order = null;
  if (creation.order_id) {
    const { data: o } = await db.from('orders')
      .select('id,product,selections,status')
      .eq('id', creation.order_id)
      .maybeSingle();
    order = o || null;
  }
  if (!order || order.product !== 'adpack') {
    return { ok: false, status: 400, error: 'Only ad pack creatives can be re-rolled right now.' };
  }

  return { ok: true, db: db, user: user, creation: creation, order: order };
}

function clampIndex(raw, len) {
  const i = parseInt(raw, 10);
  if (!Number.isFinite(i) || i < 0 || i >= len) return null;
  return i;
}

/* Only concepts we actually ship. A free-text concept would let the caller
 * write the prompt, and the brief is the product. */
function validConcept(name) {
  if (!name) return null;
  const wanted = String(name).trim().toLowerCase();
  const hit = AD_FORMAT_NAMES.find(function (n) { return n.toLowerCase() === wanted; });
  return hit || null;
}

async function createRevision(event, body) {
  const ctx = await ownedPack(event, body.creation);
  if (!ctx.ok) return json(ctx.status, { error: ctx.error });

  const urls = ctx.creation.result_urls || [];
  const index = clampIndex(body.index, urls.length);
  if (index === null) return json(400, { error: 'bad index' });

  const used = ctx.creation.revisions_used || 0;
  if (used >= REVISION_ALLOWANCE) {
    return json(429, {
      error: 'You have used all ' + REVISION_ALLOWANCE + ' re-rolls on this pack. ' +
             'A fresh pack starts at $12.',
    });
  }
  if (!(await allow('revise', event, 40))) {
    return json(429, { error: 'Too many edits at once. Give it a minute.' });
  }

  const concept = validConcept(body.concept);
  const headline = typeof body.headline === 'string' ? body.headline.trim().slice(0, 90) : '';
  if (!concept && !headline) {
    return json(400, { error: 'Change the headline or pick a different concept first.' });
  }

  // The selections are the ones the buyer paid on, stored server-side at
  // checkout. Only the revision fields come from this request, so an edit can
  // never smuggle in a different product, image or brief.
  const sel = (ctx.order.selections && typeof ctx.order.selections === 'object') ? ctx.order.selections : {};
  const revised = Object.assign({}, sel, {
    revise: { concept: concept || 'Headline', headline: headline, index: index },
  });

  const plan = await planOrder({ product: 'adpack', title: 'DTC Ad Pack', selections: revised });
  if (!plan || !plan.paramsList || plan.paramsList.length !== 1) {
    return json(500, { error: 'could not plan this revision' });
  }

  let job;
  try {
    job = await hf.createJob(plan.kind, plan.jobType, plan.paramsList[0]);
  } catch (e) {
    if (e.status === 402) return json(402, { error: 'The render backend is out of credits. Nothing was charged.' });
    return json(502, { error: String(e.message), detail: e.detail || null });
  }

  // Counted only after the job exists, so a failure to create never spends an
  // allowance. The reverse (job created, count not written) costs us one image
  // and costs the buyer nothing, which is the right way round.
  await ctx.db.from('creations')
    .update({ revisions_used: used + 1 })
    .eq('id', ctx.creation.id);

  return json(200, {
    job: { id: job.id },
    index: index,
    concept: concept || null,
    revisionsLeft: Math.max(0, REVISION_ALLOWANCE - (used + 1)),
  });
}

/*
 * Poll a revision and, the moment it lands, splice the new image into the
 * stored set at its original slot. The library and the page then agree: the
 * pack the buyer keeps is the pack they edited, not the pack we first sent.
 */
async function pollRevision(event, q) {
  const ctx = await ownedPack(event, q.creation);
  if (!ctx.ok) return json(ctx.status, { error: ctx.error });

  const urls = (ctx.creation.result_urls || []).slice();
  const index = clampIndex(q.index, urls.length);
  if (index === null) return json(400, { error: 'bad index' });
  const jobId = String(q.job || '').trim();
  if (!jobId) return json(400, { error: 'missing job' });

  let job;
  try {
    job = await hf.getJob(jobId);
  } catch (e) {
    return json(502, { error: String(e.message) });
  }

  const status = String(job.status || '');
  if (DEAD.indexOf(status) >= 0) {
    // Nothing was delivered, so the allowance goes back. A failed render must
    // never quietly cost the buyer one of their re-rolls.
    const used = ctx.creation.revisions_used || 0;
    if (used > 0) {
      await ctx.db.from('creations').update({ revisions_used: used - 1 }).eq('id', ctx.creation.id);
    }
    /* A re-roll costs an allowance rather than money, so refundText says what
     * actually came back instead of naming a payment that never moved. */
    const why = explain(status, {
      scope: 'one',
      refundText: used > 0 ? ' Your edit is back in the bank.' : '',
    });
    return json(200, {
      status: 'failed',
      reason: why.kind,
      retryable: why.retryable,
      // One line to fill here, so the two halves are joined.
      message: why.headline + '. ' + why.message,
    });
  }

  if (DONE.indexOf(status) >= 0 && job.result_url) {
    urls[index] = job.result_url;
    const patch = { result_urls: urls };
    if (index === 0 && job.thumbnail_url) patch.thumb_url = job.thumbnail_url;
    await ctx.db.from('creations').update(patch).eq('id', ctx.creation.id);
    return json(200, { status: 'completed', url: job.result_url, index: index });
  }

  return json(200, { status: 'in_progress' });
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (!hf.configured()) return json(503, { error: 'generation backend not configured' });

  try {
    if (event.httpMethod === 'GET') {
      return await pollRevision(event, event.queryStringParameters || {});
    }
    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch (e) { return json(400, { error: 'bad json' }); }
      return await createRevision(event, body);
    }
    return json(405, { error: 'GET or POST only' });
  } catch (e) {
    return json(500, { error: String(e.message) });
  }
};

exports.REVISION_ALLOWANCE = REVISION_ALLOWANCE;

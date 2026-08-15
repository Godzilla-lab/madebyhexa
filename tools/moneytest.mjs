#!/usr/bin/env node
/*
 * The money path, checked against the real handlers.
 *
 *   node tools/moneytest.mjs
 *
 * uitest.mjs drives the browser and uiaudit.mjs measures the pixels; neither
 * can see whether a dead render actually put money back. This does. It swaps
 * lib/hf and lib/supabase for fakes in the require cache, calls the genuine
 * render-status handler, and asserts on two things at once: what the customer
 * is told, and what hit the ledger.
 *
 * The fakes are deliberately literal about the bits that have bitten us:
 * credit_refund is idempotent on `ref` the way the unique index is, and the
 * query builder only answers what was really asked for, so a lookup against
 * the wrong key returns nothing rather than quietly matching.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' };
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${C.g}PASS${C.x}  ${name}`); }
  else { fail++; console.log(`  ${C.r}FAIL${C.x}  ${name}`); if (detail) console.log(`        ${C.d}${detail}${C.x}`); }
}

/* ── The fake database ────────────────────────────────────────────
 * Tables are plain arrays. The builder collects filters and applies them on
 * the terminal call, which is what makes a lookup on the wrong ref return
 * nothing instead of the first row it finds. */
function makeDb(seed, opts) {
  const tables = JSON.parse(JSON.stringify(seed));
  const rpcCalls = [];
  const refunded = new Set(); // stands in for credit_ledger_refund_once
  /* Set false to model a database where migration 013 has not been applied, so
   * the code's fallback can be checked rather than assumed. */
  const hasIdemColumn = !opts || opts.hasIdemColumn !== false;
  let seq = 0;

  function builder(name) {
    const filters = [];
    const rows = () => (tables[name] || []).filter((r) => filters.every((f) => f(r)));
    const api = {
      select() { return api; },
      eq(col, val) { filters.push((r) => r[col] === val); return api; },
      is(col, val) { filters.push((r) => (r[col] === undefined ? null : r[col]) === val); return api; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return api; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
      single() { const r = rows()[0]; return Promise.resolve({ data: r || null, error: r ? null : { message: 'no rows' } }); },
      insert(row) {
        let err = null;
        if (name === 'orders' && row.idempotency_key !== undefined && !hasIdemColumn) {
          // Postgres 42703, the shape PostgREST returns for an unknown column.
          err = { code: '42703', message: `column "idempotency_key" of relation "orders" does not exist` };
        } else if (name === 'orders' && row.idempotency_key) {
          // orders_idempotency_once: unique (user_id, idempotency_key)
          const clash = (tables.orders || []).some((r) =>
            r.user_id === row.user_id && r.idempotency_key === row.idempotency_key);
          if (clash) err = { code: '23505', message: 'duplicate key value violates unique constraint "orders_idempotency_once"' };
        }
        if (name === 'creation_recipes' && opts && opts.noRecipeTable) {
          // Postgres 42P01: relation does not exist, i.e. migration 014 unrun.
          err = { code: '42P01', message: 'relation "public.creation_recipes" does not exist' };
        }
        let made = null;
        if (!err) {
          made = Object.assign({ id: name.slice(0, 2) + '-' + (++seq) }, row);
          tables[name] = tables[name] || [];
          tables[name].push(made);
        }
        const result = Promise.resolve({ data: err ? null : made, error: err });
        const chain = {
          select: () => chain,
          single: () => result,
          maybeSingle: () => result,
          then: (res, rej) => result.then(res, rej),
        };
        return chain;
      },
      update(patch) {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, patch));
        const done = Promise.resolve({ data: hit, error: null });
        return Object.assign(done, api, { select: () => done, eq: (c, v) => { filters.push((r) => r[c] === v); return api.update(patch); } });
      },
      delete() { const hit = rows(); tables[name] = (tables[name] || []).filter((r) => !hit.includes(r)); return api; },
      then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
    };
    return api;
  }

  return {
    tables, rpcCalls, refunded,
    from: (name) => builder(name),
    rpc(fn, args) {
      rpcCalls.push({ fn, args });
      if (fn === 'credit_refund') {
        // The unique index on (kind, ref) is the whole double-refund defence.
        if (refunded.has(args.p_ref)) return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "credit_ledger_refund_once"' } });
        refunded.add(args.p_ref);
        tables.credit_ledger = tables.credit_ledger || [];
        tables.credit_ledger.push({ user_id: args.p_user, kind: 'refund', ref: args.p_ref, delta: args.p_amount });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

/* Install fakes ahead of the handler, so it requires ours rather than the
 * real modules. */
function install({ jobs, db, user, stripeSession, onRefund }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/netlify/functions/') || k.includes('/node_modules/stripe/')) delete require.cache[k];
  }
  const stub = (rel, exports) => {
    const p = require.resolve(join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  if (stripeSession !== undefined) {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    /* Stripe holds its own refund history, and the code sums it before
     * refunding again, so the fake has to remember too or the idempotence
     * test would be checking nothing. */
    const ledger = [];
    const p = require.resolve('stripe');
    require.cache[p] = {
      id: p, filename: p, loaded: true,
      exports: () => ({
        checkout: { sessions: { retrieve: () => stripeSession
          ? Promise.resolve(stripeSession)
          : Promise.reject(new Error('No such checkout.session')) } },
        paymentIntents: { update: () => Promise.resolve({}) },
        refunds: {
          list: () => Promise.resolve({ data: ledger.slice() }),
          create: (args) => {
            if (onRefund) onRefund(args);
            const made = { id: 're_' + (ledger.length + 1), amount: args.amount || (stripeSession.amount_total || 0), status: 'succeeded' };
            ledger.push(made);
            return Promise.resolve(made);
          },
        },
      }),
    };
  }
  let created = 0;
  const hfStub = {
    configured: () => true,
    getJob: (id) => Promise.resolve(jobs[id]),
    // Counting creates is how the double-charge test knows a replay really
    // replayed rather than quietly rendering a second time.
    createJob: () => Promise.resolve({ id: 'hfjob-' + (++created) }),
    createWebProduct: () => Promise.resolve(null),
    getWebProduct: () => Promise.resolve(null),
    uploadImageBytes: () => Promise.resolve(null),
    uploadVideoFromUrl: () => Promise.resolve(null),
    createAvatars: () => Promise.resolve([]),
    photoshootEnhance: () => Promise.resolve(null),
    get engineCreates() { return created; },
  };
  stub('netlify/functions/lib/hf.js', hfStub);
  install.hf = hfStub;
  stub('netlify/functions/lib/supabase.js', { configured: () => true, admin: () => db });
  stub('netlify/functions/lib/auth.js', { getUser: () => Promise.resolve(user), bearer: () => 'tok' });
  stub('netlify/functions/lib/ratelimit.js', { allow: () => Promise.resolve(true), ipOf: () => '1.1.1.1' });
  stub('netlify/functions/lib/blobs-context.js', { connect: () => {} });
  return {
    status: require(join(ROOT, 'netlify/functions/render-status.js')),
    recover: require(join(ROOT, 'netlify/functions/order-recover.js')),
    create: require(join(ROOT, 'netlify/functions/render-create.js')),
  };
}

const USER = { userId: 'user-1' };

function seedCreditOrder(spendDelta = -80) {
  return {
    orders: [{ id: 'order-1', user_id: 'user-1', status: 'paid' }],
    creations: [{ id: 'creation-1', user_id: 'user-1', order_id: 'order-1', status: 'rendering' }],
    credit_ledger: [{ user_id: 'user-1', kind: 'spend', ref: 'order:order-1', delta: spendDelta }],
  };
}

const call = (mod, q) => mod.status.handler({ queryStringParameters: q, headers: { authorization: 'Bearer tok' } });
const recover = (mod, q) => mod.recover.handler({ httpMethod: 'GET', queryStringParameters: q, headers: {} });
const body = (res) => JSON.parse(res.body);

console.log('\n  Money path\n');

/* ── 1. A credit render that dies gives the credits back ────────── */
{
  const db = makeDb(seedCreditOrder(-80));
  const mod = install({ jobs: { 'job-1': { id: 'job-1', job_type: 'marketing_studio_video', status: 'failed' } }, db, user: USER });
  const b = body(await call(mod, { jobs: 'job-1', creation: 'creation-1' }));
  const refund = db.rpcCalls.find((c) => c.fn === 'credit_refund');
  check('a dead credit render refunds the credits', !!refund && refund.args.p_amount === 80,
    'rpc calls: ' + JSON.stringify(db.rpcCalls));
  check('  and says the balance moved', /back in your balance/.test(b.message), b.message);
  check('  and marks the library row failed', db.tables.creations[0].status === 'failed', db.tables.creations[0].status);
  check('  and marks the order refunded', db.tables.orders[0].status === 'refunded', db.tables.orders[0].status);
}

/* ── 2. Polling twice does not refund twice ─────────────────────── */
{
  const db = makeDb(seedCreditOrder(-80));
  const mod = install({ jobs: { 'job-1': { id: 'job-1', job_type: 'marketing_studio_video', status: 'failed' } }, db, user: USER });
  await call(mod, { jobs: 'job-1', creation: 'creation-1' });
  await call(mod, { jobs: 'job-1', creation: 'creation-1' });
  const paid = (db.tables.credit_ledger || []).filter((r) => r.kind === 'refund');
  check('two polls refund once', paid.length === 1, `${paid.length} refund rows`);
}

/* ── 3. A refusal is not an engine fault ────────────────────────── */
{
  const db = makeDb(seedCreditOrder());
  const mod = install({ jobs: { 'job-1': { id: 'job-1', job_type: 'marketing_studio_video', status: 'nsfw' } }, db, user: USER });
  const b = body(await call(mod, { jobs: 'job-1', creation: 'creation-1' }));
  check('a refusal is labelled declined', b.reason === 'declined', String(b.reason));
  check('  and is not offered as retryable', b.retryable === false, String(b.retryable));
  check('  and never prints the engine word at the customer', !/nsfw/i.test(b.message), b.message);
  check('  and does not advise running it again', !/\b(try|run) (it )?again\b/i.test(b.message), b.message);
}
{
  const db = makeDb(seedCreditOrder());
  const mod = install({ jobs: { 'job-1': { id: 'job-1', job_type: 'marketing_studio_video', status: 'error' } }, db, user: USER });
  const b = body(await call(mod, { jobs: 'job-1', creation: 'creation-1' }));
  check('an engine fault stays retryable', b.reason === 'fault' && b.retryable === true, JSON.stringify({ reason: b.reason, retryable: b.retryable }));
  check('  and does advise running it again', /again/i.test(b.message), b.message);
}

/* ── 4. One dead creative does not end a pack still rendering ───── */
{
  const db = makeDb(seedCreditOrder(-40));
  const jobs = {
    a: { id: 'a', job_type: 'ms_image', status: 'failed' },
    b: { id: 'b', job_type: 'ms_image', status: 'in_progress' },
    c: { id: 'c', job_type: 'ms_image', status: 'completed', result_url: 'c.jpg' },
  };
  const mod = install({ jobs, db, user: USER });
  const res = body(await call(mod, { jobs: 'a,b,c', creation: 'creation-1' }));
  check('an unsettled pack keeps reporting progress', res.status === 'in_progress', res.status + ' ' + (res.message || ''));
  check('  and refunds nothing yet', db.rpcCalls.length === 0, JSON.stringify(db.rpcCalls));
  check('  and does not mark the library row failed', db.tables.creations[0].status === 'rendering', db.tables.creations[0].status);
}

/* ── 5. A settled pack delivers what survived and refunds the rest ─ */
{
  const db = makeDb(seedCreditOrder(-40));
  const jobs = {
    a: { id: 'a', job_type: 'ms_image', status: 'failed' },
    b: { id: 'b', job_type: 'ms_image', status: 'completed', result_url: 'b.jpg' },
    c: { id: 'c', job_type: 'ms_image', status: 'completed', result_url: 'c.jpg' },
  };
  const mod = install({ jobs, db, user: USER });
  const res = body(await call(mod, { jobs: 'a,b,c', creation: 'creation-1' }));
  check('a settled pack delivers the survivors', res.status === 'completed' && res.result.urls.length === 2, JSON.stringify(res.result || res));
  check('  and reports the shortfall', res.partial && res.partial.failed === 1, JSON.stringify(res.partial));
  const refund = db.rpcCalls.find((c) => c.fn === 'credit_refund');
  check('  and refunds only the dead one, at the rate paid', !!refund && refund.args.p_amount === 13,
    JSON.stringify(db.rpcCalls.map((c) => c.args)));
}

/* ── 6. Someone else's creation id is not a refund lever ─────────── */
{
  const db = makeDb(seedCreditOrder(-80));
  const mod = install({
    jobs: { 'job-1': { id: 'job-1', job_type: 'marketing_studio_video', status: 'failed' } },
    db, user: { userId: 'attacker' },
  });
  await call(mod, { jobs: 'job-1', creation: 'creation-1' });
  check('a stranger cannot drive a refund on your order', db.rpcCalls.length === 0, JSON.stringify(db.rpcCalls));
  check('  and cannot mark your library row failed', db.tables.creations[0].status === 'rendering', db.tables.creations[0].status);
}

/* ── 7. A paid arrival with no localStorage recovers its order ───── */
{
  const seed = {
    orders: [{
      id: 'order-9', user_id: 'user-1', status: 'pending',
      stripe_session_id: 'cs_test_abc1234567890', amount_cents: 2300,
      product: 'mode:ugc',
      selections: { aspect: '9:16', duration: 30, style: 'golden-hour-ugc', styleName: 'Golden hour UGC', productName: 'Blender' },
    }],
  };
  const db = makeDb(seed);
  // user: null is the point. The browser that lost its order lost its auth
  // session with it, so requiring a token would refuse exactly this case.
  const mod = install({ jobs: {}, db, user: null, stripeSession: { payment_status: 'paid' } });
  const res = await recover(mod, { paid: 'cs_test_abc1234567890' });
  const b = body(res);
  check('a paid session rebuilds its order with nobody signed in',
    res.statusCode === 200 && b.order && b.order.product === 'mode:ugc', res.statusCode + ' ' + res.body);
  check('  with the selections the server priced',
    b.order.selections.duration === 30 && b.order.selections.style === 'golden-hour-ugc',
    JSON.stringify(b.order.selections));
  check('  even while the order row is still pending, since the webhook may lag',
    db.tables.orders[0].status === 'pending', db.tables.orders[0].status);
}

/* ── 8. Recovery is not a way to read other people's orders ─────── */
{
  const db = makeDb({ orders: [{ id: 'o', stripe_session_id: 'cs_test_real123456', product: 'mode:ugc', selections: {} }] });
  const mod = install({ jobs: {}, db, user: null, stripeSession: { payment_status: 'paid' } });
  check('an unknown session recovers nothing',
    (await recover(mod, { paid: 'cs_test_someoneelse00' })).statusCode === 404);
  check('a malformed session is refused before any lookup',
    (await recover(mod, { paid: '../../etc/passwd' })).statusCode === 400);
}

/* ── 9. An abandoned checkout is not a paid order ────────────────── */
{
  const db = makeDb({ orders: [{ id: 'o', stripe_session_id: 'cs_test_unpaid123456', product: 'mode:ugc', selections: {} }] });
  const mod = install({ jobs: {}, db, user: null, stripeSession: { payment_status: 'unpaid' } });
  const res = await recover(mod, { paid: 'cs_test_unpaid123456' });
  check('an unpaid checkout recovers nothing', res.statusCode === 402, res.statusCode + ' ' + res.body);
}

/* ── 9b. A card-paid pack that comes up short is refunded too ───── */
{
  const db = makeDb({
    orders: [{ id: 'order-c', user_id: 'user-1', status: 'paid', stripe_session_id: 'cs_test_card123456' }],
    creations: [{ id: 'creation-c', user_id: 'user-1', order_id: 'order-c', status: 'rendering' }],
  });
  const refundsMade = [];
  const mod = install({
    jobs: {
      a: { id: 'a', job_type: 'ms_image', status: 'failed' },
      b: { id: 'b', job_type: 'ms_image', status: 'failed' },
      c: { id: 'c', job_type: 'ms_image', status: 'completed', result_url: 'c.jpg' },
      d: { id: 'd', job_type: 'ms_image', status: 'completed', result_url: 'd.jpg' },
    },
    db, user: USER,
    // $12.00 for four creatives, two of which died.
    stripeSession: { payment_status: 'paid', amount_total: 1200, payment_intent: 'pi_1' },
    onRefund: (args) => refundsMade.push(args),
  });
  const b = body(await call(mod, { jobs: 'a,b,c,d', paid: 'cs_test_card123456' }));
  check('a short card-paid pack still delivers what survived',
    b.status === 'completed' && b.result.urls.length === 2, JSON.stringify(b.result || b));
  check('  and refunds the dead ones proportionally',
    refundsMade.length === 1 && refundsMade[0].amount === 600,
    JSON.stringify(refundsMade));
  check('  and says it in dollars, not credits',
    /\$6 was refunded to your card/.test(b.message), b.message);
  check('  and reports the cents on the partial block',
    b.partial && b.partial.centsRefunded === 600, JSON.stringify(b.partial));
}

/* ── 9c. Polling a short card pack does not refund again ─────────── */
{
  const db = makeDb({
    orders: [{ id: 'order-c', user_id: 'user-1', status: 'paid', stripe_session_id: 'cs_test_card123456' }],
    creations: [{ id: 'creation-c', user_id: 'user-1', order_id: 'order-c', status: 'rendering' }],
  });
  const refundsMade = [];
  const mod = install({
    jobs: {
      a: { id: 'a', job_type: 'ms_image', status: 'failed' },
      b: { id: 'b', job_type: 'ms_image', status: 'completed', result_url: 'b.jpg' },
    },
    db, user: USER,
    stripeSession: { payment_status: 'paid', amount_total: 1200, payment_intent: 'pi_1' },
    onRefund: (args) => refundsMade.push(args),
  });
  await call(mod, { jobs: 'a,b', paid: 'cs_test_card123456' });
  await call(mod, { jobs: 'a,b', paid: 'cs_test_card123456' });
  await call(mod, { jobs: 'a,b', paid: 'cs_test_card123456' });
  check('three polls refund the card once',
    refundsMade.length === 1 && refundsMade[0].amount === 600, JSON.stringify(refundsMade));
}

/* ── 10. A credit render cannot be charged twice ─────────────────
 *
 * The real scenario: the browser fires the create, and before the answer
 * lands the page is refreshed. Previously the jobs were only saved AFTER the
 * response, so the second attempt looked like a brand new order and spent the
 * balance again. Both attempts now carry the same key. */
{
  const db = makeDb({
    profiles: [{ id: 'user-1' }],
    credit_ledger: [{ user_id: 'user-1', kind: 'grant', ref: 'signup', delta: 50000 }],
  });
  const mod = install({ jobs: {}, db, user: USER });
  const order = { product: 'adsingle', selections: { productName: 'Blender', aspect: '4:5' } };
  const post = (key) => mod.create.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify({ order, idempotencyKey: key }),
  });

  const first = body(await post('key-abc-0001'));
  const second = body(await post('key-abc-0001'));
  const spends = db.rpcCalls.filter((c) => c.fn === 'credit_spend');

  check('the same key charges once', spends.length === 1, `${spends.length} credit_spend calls`);
  check('  and the replay hands back the SAME jobs',
    !!second.jobs && JSON.stringify(second.jobs) === JSON.stringify(first.jobs),
    JSON.stringify({ first: first.jobs, second: second.jobs }));
  check('  and is marked as a replay', second.replay === true, JSON.stringify(second));
  check('  and starts no second render on the engine', install.hf.engineCreates === first.jobs.length,
    `${install.hf.engineCreates} engine creates for ${first.jobs.length} jobs`);
  check('  and opens only one order', (db.tables.orders || []).length === 1, `${(db.tables.orders || []).length} orders`);

  // A different key is a different order, and must still work.
  const third = body(await post('key-abc-0002'));
  check('a different key is a different render',
    !!third.jobs && !third.replay && db.rpcCalls.filter((c) => c.fn === 'credit_spend').length === 2,
    JSON.stringify({ replay: third.replay, spends: db.rpcCalls.filter((c) => c.fn === 'credit_spend').length }));
}

/* ── 11. The library row records the jobs it is made of ──────────── */
{
  const db = makeDb({
    profiles: [{ id: 'user-1' }],
    credit_ledger: [{ user_id: 'user-1', kind: 'grant', ref: 'signup', delta: 50000 }],
  });
  const mod = install({ jobs: {}, db, user: USER });
  const res = body(await mod.create.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify({ order: { product: 'adsingle', selections: { productName: 'Blender' } }, idempotencyKey: 'key-jobs-0001' }),
  }));
  const creation = (db.tables.creations || [])[0];
  check('the creation stores its job ids, so the library can link back to a live render',
    !!creation && creation.job_ids.length === res.jobs.length && creation.job_ids[0] === res.jobs[0].id,
    JSON.stringify(creation && creation.job_ids));
}

/* ── 12. Without migration 013, renders still work ───────────────── */
{
  const db = makeDb({
    profiles: [{ id: 'user-1' }],
    credit_ledger: [{ user_id: 'user-1', kind: 'grant', ref: 'signup', delta: 50000 }],
  }, { hasIdemColumn: false });
  const mod = install({ jobs: {}, db, user: USER });
  const res = body(await mod.create.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify({ order: { product: 'adsingle', selections: { productName: 'Blender' } }, idempotencyKey: 'key-nomig-0001' }),
  }));
  check('a database without migration 013 still renders, guard or no guard',
    !!res.jobs && res.jobs.length > 0, JSON.stringify(res));
}

/* ── 13. What we sent is recorded next to what came back ─────────
 *
 * Otherwise every claim about which engine or format performs better is
 * unverifiable: the outcome is stored and the recipe is not. */
{
  const db = makeDb({
    profiles: [{ id: 'user-1' }],
    credit_ledger: [{ user_id: 'user-1', kind: 'grant', ref: 'signup', delta: 50000 }],
  });
  const mod = install({ jobs: {}, db, user: USER });
  await mod.create.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify({
      order: {
        product: 'adpack',
        selections: {
          link: 'https://example-store.com/products/portable-blender',
          productName: 'Portable Blender',
          headline: 'Blend it. Drink it. Rinse it. Done.',
          angle: { claim: 'Sell the cleanup, not the blending.', persona: 'Busy parents' },
        },
      },
      idempotencyKey: 'key-recipe-0001',
    }),
  });
  const recipe = (db.tables.creation_recipes || [])[0];
  check('the recipe behind a render is recorded', !!recipe, JSON.stringify(db.tables.creation_recipes));
  if (recipe) {
    check('  with the engine that was really called', recipe.engine === 'ms_image', recipe.engine);
    check('  with the prompt that was really sent',
      /Blend it\. Drink it\./.test(recipe.prompt || ''), (recipe.prompt || '').slice(0, 120));
    check('  with the params, and the prompt not duplicated inside them',
      recipe.params && recipe.params.style_id && !recipe.params.prompt,
      JSON.stringify(Object.keys(recipe.params || {})));
    check('  with whether it was grounded', recipe.grounded === false, String(recipe.grounded));
    check('  and traceable back to the angle behind it',
      /Sell the cleanup/.test(recipe.angle_id || ''), recipe.angle_id);
  }
}

/* ── 14. A missing measurement never costs a customer a render ──── */
{
  const db = makeDb({
    profiles: [{ id: 'user-1' }],
    credit_ledger: [{ user_id: 'user-1', kind: 'grant', ref: 'signup', delta: 50000 }],
  }, { noRecipeTable: true });
  const mod = install({ jobs: {}, db, user: USER });
  const res = body(await mod.create.handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify({
      order: { product: 'adsingle', selections: { productName: 'Blender' } },
      idempotencyKey: 'key-norecipe-001',
    }),
  }));
  check('a database without migration 014 still renders', !!res.jobs && res.jobs.length > 0, JSON.stringify(res));
}

console.log(`\n  ${fail === 0 ? C.g : C.r}${pass}/${pass + fail} passed${C.x}\n`);
process.exit(fail === 0 ? 0 : 1);

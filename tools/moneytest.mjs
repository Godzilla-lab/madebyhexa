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
function makeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  const rpcCalls = [];
  const refunded = new Set(); // stands in for credit_ledger_refund_once

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
      update(patch) {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, patch));
        const done = Promise.resolve({ data: hit, error: null });
        return Object.assign(done, api, { select: () => done, eq: (c, v) => { filters.push((r) => r[c] === v); return api.update(patch); } });
      },
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
function install({ jobs, db, user }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/netlify/functions/')) delete require.cache[k];
  }
  const stub = (rel, exports) => {
    const p = require.resolve(join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('netlify/functions/lib/hf.js', {
    configured: () => true,
    getJob: (id) => Promise.resolve(jobs[id]),
  });
  stub('netlify/functions/lib/supabase.js', { configured: () => true, admin: () => db });
  stub('netlify/functions/lib/auth.js', { getUser: () => Promise.resolve(user), bearer: () => 'tok' });
  stub('netlify/functions/lib/ratelimit.js', { allow: () => Promise.resolve(true), ipOf: () => '1.1.1.1' });
  stub('netlify/functions/lib/blobs-context.js', { connect: () => {} });
  return require(join(ROOT, 'netlify/functions/render-status.js'));
}

const USER = { userId: 'user-1' };

function seedCreditOrder(spendDelta = -80) {
  return {
    orders: [{ id: 'order-1', user_id: 'user-1', status: 'paid' }],
    creations: [{ id: 'creation-1', user_id: 'user-1', order_id: 'order-1', status: 'rendering' }],
    credit_ledger: [{ user_id: 'user-1', kind: 'spend', ref: 'order:order-1', delta: spendDelta }],
  };
}

const call = (mod, q) => mod.handler({ queryStringParameters: q, headers: { authorization: 'Bearer tok' } });
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

console.log(`\n  ${fail === 0 ? C.g : C.r}${pass}/${pass + fail} passed${C.x}\n`);
process.exit(fail === 0 ? 0 : 1);

/*
 * report-claim.js, against the four ways it could be wrong.
 *
 *   node tools/claimtest.cjs
 *
 * These are not UI checks, so they do not belong in uitest.mjs, and they cannot
 * wait for a deploy either: every one of them is a case where getting it wrong
 * hands one customer's research to another account, and none of them is visible
 * from the page. So the handler is loaded with its three lib/ dependencies
 * replaced in the require cache, and driven directly.
 *
 * What is being proved:
 *
 *   1. the owner comes from the bearer token, never from the body
 *   2. claiming twice is a no-op, not a second claim or an error
 *   3. a wrong token against an owned row is refused
 *   4. a token of the wrong LENGTH is refused rather than throwing, because
 *      crypto.timingSafeEqual throws on mismatched buffers and the guard in
 *      front of it is the only thing standing between that and a 500
 */

const path = require('node:path');
const Module = require('node:module');

const FN = path.join(__dirname, '..', 'netlify', 'functions');

/* The fixture database: two accounts, and one report belonging to neither. */
let rows;
function reset() {
  rows = [
    { id: 'r-anon', user_id: null, claim_token: 'a'.repeat(43), product_title: 'Portable Blender' },
    { id: 'r-owned', user_id: 'user-B', claim_token: 'b'.repeat(43), product_title: 'Merino Base Layer' },
  ];
}

/* A supabase-shaped stub, small enough to read and honest about the one thing
 * that matters: .is('user_id', null) really does filter, so the idempotency
 * guard is being tested rather than assumed. */
function db() {
  return {
    from() {
      const q = { _eq: {}, _isNull: [], _update: null };
      q.select = () => q;
      q.eq = (col, val) => { q._eq[col] = val; return q; };
      q.is = (col) => { q._isNull.push(col); return q; };
      q.update = (patch) => { q._update = patch; return q; };
      q.maybeSingle = () => {
        const hit = rows.find((r) => Object.entries(q._eq).every(([k, v]) => r[k] === v));
        return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
      };
      /* An update resolves to the rows it touched, which is how the handler
       * learns that somebody else got there first. */
      q.then = (fn) => {
        const matched = rows.filter((r) =>
          Object.entries(q._eq).every(([k, v]) => r[k] === v) &&
          q._isNull.every((c) => r[c] === null));
        matched.forEach((r) => Object.assign(r, q._update));
        return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(fn);
      };
      return q;
    },
  };
}

let BEARER = null;   // what getUser() will resolve to for the next call

function stub(rel, exports) {
  const file = require.resolve(path.join(FN, rel));
  require.cache[file] = new Module(file, null);
  require.cache[file].filename = file;
  require.cache[file].loaded = true;
  require.cache[file].exports = exports;
}

stub('lib/supabase', { admin: db, configured: () => true });
stub('lib/auth', { getUser: async () => BEARER, bearer: () => 'x' });
stub('lib/ratelimit', { allow: async () => true, ipOf: () => 'test' });
stub('lib/blobs-context', { connect: () => {} });

const handler = require(path.join(FN, 'report-claim.js')).handler;

const call = (body, user) => {
  BEARER = user;
  return handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
};

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!ok) { failed++; if (detail) console.log(`        ${detail}`); }
}

(async () => {
  console.log('\n  report-claim\n');
  const A = { userId: 'user-A', email: 'a@example.com' };

  // 1. The body cannot choose the owner.
  reset();
  let res = await call({ id: 'r-anon', claimToken: 'a'.repeat(43), user_id: 'user-B', userId: 'user-B' }, A);
  const owner = rows.find((r) => r.id === 'r-anon').user_id;
  check('owner comes from the bearer, not the body',
    res.statusCode === 200 && owner === 'user-A', `status ${res.statusCode}, owner ${owner}`);

  // 2. Claiming twice changes nothing and does not error.
  res = await call({ id: 'r-anon', claimToken: 'a'.repeat(43) }, A);
  const body2 = JSON.parse(res.body);
  check('a second claim is an idempotent success',
    res.statusCode === 200 && body2.already === true, `status ${res.statusCode}, body ${res.body}`);

  // 3. A different account cannot take it, even holding the real token.
  res = await call({ id: 'r-anon', claimToken: 'a'.repeat(43) }, { userId: 'user-C' });
  check('a claimed report cannot be re-claimed by somebody else',
    res.statusCode === 404 && rows.find((r) => r.id === 'r-anon').user_id === 'user-A',
    `status ${res.statusCode}`);

  // 4. A wrong token of the RIGHT length is refused.
  reset();
  res = await call({ id: 'r-owned', claimToken: 'z'.repeat(43) }, A);
  check('a wrong token is refused', res.statusCode === 404, `status ${res.statusCode}`);

  // 5. A wrong token of the wrong length must not throw. Without the length
  //    guard, timingSafeEqual raises and this is a 500 with a stack trace.
  reset();
  let threw = null;
  try { res = await call({ id: 'r-anon', claimToken: 'short' }, A); }
  catch (e) { threw = e; }
  check('a mismatched-length token is refused, not thrown',
    !threw && res.statusCode === 404, threw ? threw.message : `status ${res.statusCode}`);

  // 6. No bearer at all.
  reset();
  res = await call({ id: 'r-anon', claimToken: 'a'.repeat(43) }, null);
  check('an anonymous caller gets 401', res.statusCode === 401, `status ${res.statusCode}`);

  // 7. An unknown id looks exactly like a wrong token, so the endpoint cannot
  //    be used to confirm which report ids exist.
  reset();
  res = await call({ id: 'r-nope', claimToken: 'a'.repeat(43) }, A);
  check('an unknown id answers 404, same as a wrong token', res.statusCode === 404, `status ${res.statusCode}`);

  console.log(`\n  ${failed ? '\x1b[31m' + failed + ' failed\x1b[0m' : '\x1b[32mall passed\x1b[0m'}\n`);
  process.exit(failed ? 1 : 0);
})();

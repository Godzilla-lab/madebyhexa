/*
 * Static ad prompts, against the one way they invent things about a customer.
 *
 *   node tools/prooftest.cjs
 *
 * Why this exists, measured rather than assumed. On 2026-08-18 nine statics
 * were rendered through the real ms_image path. Five came back carrying social
 * proof nobody supplied: "Alex R. / Verified" with a helpful count, "James R.
 * Verified Buyer" with five stars, five stars and "2,847+ brewers", a five
 * star row with invented milligram figures, and a "TRUSTED BY HOME BAKERS"
 * strip. Three of those five formats are marked review_shaped:false, so the
 * substitution guard never looked at them, and because AD_FORMAT_NAMES is
 * DEFINED as the non-review_shaped list they sit in the pool that fills every
 * default pack. Every one of those prompts already ended with "avoid ... any
 * invented claim or badge".
 *
 * A fabricated endorsement on a real merchant's product is their legal problem
 * and our reputational one, and it is invisible from our side: the pack looks
 * finished. So the prohibition is enumerated, applied to every format when we
 * have nothing real to quote, and asserted here.
 *
 * No credits are spent. planOrder is exported for exactly this, so the prompt
 * is inspected as a string before it ever reaches the engine.
 */

const path = require('node:path');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { planOrder } = require(path.join(FN, 'render-create.js'));

let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  \x1b[32mPASS\x1b[0m  ' + name); return; }
  failed++;
  console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (detail ? '\n        ' + detail : ''));
}

/* A minimal order. No scraping, no network: selections carry the grounding. */
function order(extra) {
  return {
    product: 'adpack',
    selections: Object.assign({
      productName: 'Northbank Cast Iron Skillet',
      productDetail: 'A pre-seasoned cast iron skillet with a machined cooking surface.',
    }, extra || {}),
  };
}

const PROOF_TERMS = [
  'star ratings', 'reviewer names', 'verified', 'review counts',
  'testimonial', 'logos', 'invented',
];

(async () => {
  console.log('\n[static ad prompts] no invented social proof\n');

  /* ── 1. Nothing to quote: every prompt in the pack refuses social proof ── */
  const bare = await planOrder(order());
  const barePrompts = (bare.paramsList || []).map((p) => p.prompt);
  check('a pack plans prompts at all', barePrompts.length > 0, barePrompts.length + ' prompts');

  const missing = barePrompts.filter((p) => !/Render no social proof of any kind/.test(p));
  check('every prompt carries the refusal when there are no real reviews',
    missing.length === 0,
    missing.length + ' of ' + barePrompts.length + ' prompts missing it');

  /* The general clause was already there and was not obeyed, so what is
   * asserted is that the SPECIFIC artifacts are named. */
  const vague = barePrompts.filter((p) => PROOF_TERMS.some((t) => !p.includes(t)));
  check('the refusal names the artifacts, not just "invented claims"',
    vague.length === 0,
    vague.length + ' prompts do not enumerate every artifact');

  /* ── 2. The formats that actually did it are covered ──
   * Not by name: the point of the fix is that it does not depend on having
   * guessed the right three. This asserts they are covered by the blanket. */
  const caught = ['Stat Surround', 'Benefits Checklist', 'Bold Statement'];
  const named = await planOrder(order({ formats: caught.map((n) => ({ name: n })) }));
  const namedPrompts = (named.paramsList || []).map((p) => p.prompt);
  check('the three formats measured inventing proof are covered',
    namedPrompts.length === 3
      && namedPrompts.every((p) => /Render no social proof of any kind/.test(p)),
    namedPrompts.filter((p) => !/Render no social proof/.test(p)).length + ' uncovered');

  /* ── 3. A real review still gets through, quoted, and lifts the blanket ── */
  const REVIEW = 'First egg slid straight off. Did not expect that from raw iron.';
  const withReviews = await planOrder(order({
    reviews: [REVIEW],
    formats: [{ name: 'Star Review' }],
  }));
  const rp = (withReviews.paramsList || []).map((p) => p.prompt);
  check('a real review is quoted verbatim',
    rp.some((p) => p.includes(REVIEW)),
    'the supplied review never reached the prompt');
  check('the blanket refusal lifts once there is something real to quote',
    rp.every((p) => !/Render no social proof of any kind/.test(p)),
    'the refusal would contradict the review we just asked it to render');
  check('a review_shaped format survives when it has a real review to stage',
    !(withReviews.substituted || []).some((x) => x.from === 'Star Review'),
    'Star Review was swapped out despite a real review being supplied');

  /* ── 4. And is still swapped away when there is nothing to stage ── */
  const swapped = await planOrder(order({ formats: [{ name: 'Star Review' }] }));
  check('a review_shaped format is still substituted with no reviews',
    (swapped.substituted || []).some((x) => x.from === 'Star Review'),
    'Star Review survived with nothing real to quote');

  console.log(failed
    ? '\n  \x1b[31m' + failed + ' failed\x1b[0m\n'
    : '\n  \x1b[32mall passed\x1b[0m\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

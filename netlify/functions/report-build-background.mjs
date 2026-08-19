/*
 * Build a validation report, server-side.
 *
 * Invoked fire-and-forget by report-create. Background because a cold category
 * needs roughly sixty throttled Arctic Shift round trips before any synthesis
 * starts, which is minutes: there is no version of that fitting in the ten
 * seconds a synchronous function gets.
 *
 * The schemas, evidence assembly and rendering are imported from
 * research/validate.mjs rather than copied. That file is the CLI, and the two
 * paths must not drift into producing different reports for the same product.
 * esbuild inlines the imports at build time, so nothing needs to exist on disk
 * at runtime.
 *
 * WHERE THE FREE/DEEP GATE LIVES, and why it is here rather than in
 * report-create: whether a category can be answered from memory depends on
 * knowing the category, and knowing the category takes an LLM planning call.
 * So the cheap decision cannot be made before the first spend. What this
 * function does instead is refuse to start the EXPENSIVE half for a visitor who
 * has not signed in:
 *
 *   warm category   -> answer from the corpus, for anyone. Two or three
 *                      queries and cheap worker tokens.
 *   cold + signed in-> harvest properly. Minutes, and real money.
 *   cold + anonymous-> stop, and say so. "Nobody has studied this market with
 *                      us yet, sign in and we will go and do it."
 *
 * That is the honest version of a free tier: the cheap thing is free to
 * everyone, and the thing that costs money asks for an account first.
 *
 * Auth: internal only, x-report-key must match WEBHOOK_SECRET.
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_SECRET, XAI_API_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { resolveProduct } from '../../research/lib/product.mjs';
import { ask, configured as llmConfigured, WORKER, SYNTH } from '../../research/lib/llm.mjs';
import { createCostMeter } from '../../research/lib/cost.mjs';
import { openSupabaseCorpus, normaliseRows } from '../../research/lib/corpus-supabase.mjs';
import { findCompetitorAds, formatVerdict, adDocs } from '../../research/lib/ads.mjs';
import {
  discoverSubreddits, searchPosts, fetchComments, filterRelevant, throttleState,
} from '../../research/lib/reddit.mjs';
import { redditDocs } from '../../research/lib/docs.mjs';
import { reviewDocs } from '../../research/lib/reviews.mjs';
import {
  PLAN_SCHEMA, PICK_SCHEMA, READ_SCHEMA, ANGLES_SCHEMA,
  heuristicPlan, buildEvidence, formatBrief, normaliseLive,
} from '../../research/validate.mjs';

const MIN_RECEIPTS = 3;

/*
 * What a cold market read costs the customer, in credits. Defined here because
 * this is now the only file that charges it: report-create used to take the
 * money up front and could not, because whether a market is warm is not known
 * until the planning call below has run.
 *
 * Measured cost to us on 2026-08-14 with the real xAI rate card: $0.615 for a
 * cold report, of which $0.466 is the Apify competitor-ads pull and $0.149 is
 * tokens. At 500 credits to the dollar this is $2, so it clears cost at about
 * 69% margin and the 2,500 credit welcome grant covers the first two.
 *
 * Only a COLD read is charged. A warm one answers off documents the corpus
 * already holds, for a few cents of synthesis, and billing the cold-harvest
 * price for it was charging for work we do not do. A cached report is never
 * charged either: that work was already paid for by whoever triggered it.
 */
const REPORT_CREDITS = 1000;

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function setStep(client, id, step) {
  try { await client.from('reports').update({ step }).eq('id', id); }
  catch (e) { /* progress labels are cosmetic; never fail the run over one */ }
}

/*
 * Give the credits back.
 *
 * charge() takes the money immediately before the harvest, so every path out
 * of here which does not deliver the report it charged for has to hand the
 * credits back, and this is that path. It is a no-op for a warm read, which
 * was never charged: the `paid` flag on the row is what decides, not the tier.
 *
 * Idempotent on the ledger's unique index over (kind, ref), so calling it twice
 * for the same report refunds once. That matters because a retry, a timeout
 * that still completed, or a second invocation of the same background function
 * are all things that happen in production.
 *
 * Never fatal: a report that failed and also could not be refunded must still
 * be marked failed, or the customer sits on a spinner forever AND is out of
 * pocket. The error is logged loudly so it can be settled by hand.
 */
async function refund(client, id, reason) {
  try {
    const { data: row } = await client.from('reports').select('paid,user_id').eq('id', id).maybeSingle();
    if (!row || !row.paid || !row.user_id) return;
    const { error } = await client.rpc('credit_refund', {
      p_user: row.user_id,
      p_amount: REPORT_CREDITS,
      p_ref: 'report:' + id,
      p_note: 'Report not delivered: ' + reason,
    });
    if (error) throw new Error(error.message);
    await client.from('reports').update({ paid: false }).eq('id', id);
    console.log('[report] ' + id + ' refunded ' + REPORT_CREDITS + ' credits (' + reason + ')');
  } catch (e) {
    console.error('[report] ' + id + ' REFUND FAILED, settle by hand: ' + e.message);
  }
}

/*
 * Take the money, once, immediately before the expensive leg.
 *
 * Two orderings were available and both are wrong in one direction. Charging
 * in report-create, which is what this used to do, bills before anyone knows
 * whether the market is warm, so a read answered entirely from the corpus was
 * charged the price of a harvest. Charging after the harvest means discovering
 * an empty balance only once Apify and xAI have already been paid, which loses
 * the report and the money together.
 *
 * This is the seam between them: the planning call has answered, so we know
 * the category and whether it is cold, and nothing expensive has run yet. A
 * refused charge costs us one worker-tier planning call and stops there.
 *
 * Idempotent on the ledger's unique index over (kind, ref), the same guard
 * refund() relies on, so a retried or double-invoked background function
 * charges once. Returns true when the report may proceed.
 */
async function charge(client, id, userId, reason) {
  if (!userId) return true;                       // anonymous reads are free
  const { error } = await client.rpc('credit_spend', {
    p_user: userId,
    p_amount: REPORT_CREDITS,
    p_ref: 'report:' + id,
    p_note: 'Market read: ' + reason,
  });
  if (error) {
    if (/insufficient credits/i.test(error.message || '')) {
      console.log('[report] ' + id + ' not charged: insufficient credits');
      return false;
    }
    /* Any other ledger error is ours, not theirs. Letting the report run
     * unpaid is the kinder failure: we lose one harvest, they lose nothing,
     * and the log says so loudly enough to be settled by hand. */
    console.error('[report] ' + id + ' CHARGE FAILED, proceeding unpaid: ' + error.message);
    return true;
  }
  await client.from('reports').update({ paid: true }).eq('id', id);
  console.log('[report] ' + id + ' charged ' + REPORT_CREDITS + ' credits (' + reason + ')');
  return true;
}

async function fail(client, id, reason) {
  console.error('[report] ' + id + ' failed: ' + reason);
  await refund(client, id, reason);
  try { await client.from('reports').update({ status: 'failed', step: null }).eq('id', id); }
  catch (e) { /* nothing left to do */ }
  return { statusCode: 200 };
}

/*
 * What the market complains about that nobody is advertising against.
 *
 * This is the one thing here that neither half of the tooling landscape can
 * do. Customer-research tools know what buyers say and cannot see the ads;
 * ad-intelligence tools know what competitors run and cannot see the buyers. We
 * finish a deep report holding both for the same category, in the same object,
 * so the subtraction is available to us and to almost nobody else.
 *
 * The output is deliberately narrow: for each pain and objection we already
 * proved with receipts, how many competitor ads actually address it. A
 * complaint raised by twenty people that appears in one ad out of eighty is a
 * gap. A complaint every competitor already answers is a crowded lane, and
 * saying so is just as useful, because it stops someone spending on a message
 * the market has already saturated.
 *
 * Matching is done by the model rather than by keyword, because "takes ages to
 * dry" and "quick-dry fabric" are the same subject and share no words. It is
 * given ONLY the ids it may cite, exactly like every other synthesis step here,
 * so an ad it invents cannot become a number on the page.
 */
const WHITESPACE_SCHEMA = {
  type: 'object',
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'The customer complaint, copied from the list you were given.' },
          ad_ids: {
            type: 'array', items: { type: 'string' },
            description: 'Ids of competitor ads that ADDRESS this complaint, directly or by promising its opposite. '
              + 'Use ONLY ids from the ad list. An empty array is a valid and important answer.',
          },
        },
        required: ['claim', 'ad_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['themes'],
  additionalProperties: false,
};

async function findWhitespace(reportId, read, ads, cost) {
  const themes = [...((read && read.pains) || []), ...((read && read.objections) || [])]
    .filter((f) => f && f.claim && (f.evidence_ids || []).length >= MIN_RECEIPTS);
  if (!themes.length || !ads.length) return null;

  // Only ads with copy can address anything. An image-only ad is not evidence
  // that a message is absent, so it is excluded from the denominator too.
  const withCopy = ads.filter((a) => a.body && a.body.trim().length > 20).slice(0, 60);
  if (withCopy.length < 10) return null;

  const adList = withCopy
    .map((a) => `${a.adId} [${a.advertiser || 'unknown'}] ${String(a.body).replace(/\s+/g, ' ').slice(0, 260)}`)
    .join('\n');

  let out = null;
  try {
    out = await ask({
      model: SYNTH, cost, label: 'whitespace', schema: WHITESPACE_SCHEMA, maxTokens: 4000, effort: 'high',
      system:
        'You compare what customers complain about against what competitors actually say in their ads. '
        + 'You are strict: an ad addresses a complaint only if it speaks to that specific subject, not because '
        + 'it is for the same kind of product. Vague brand copy addresses nothing. Returning an empty list for '
        + 'a complaint is the most valuable answer you can give, so never pad it.',
      prompt:
        'CUSTOMER COMPLAINTS:\n'
        + themes.map((t, i) => `${i + 1}. ${t.claim}`).join('\n')
        + `\n\nCOMPETITOR ADS (${withCopy.length} of them, cite by the id at the start of each line):\n${adList}`
        + '\n\nFor every complaint, list the ids of the ads that address it. Copy each claim back exactly.',
    });
  } catch (e) {
    console.error('[report] ' + reportId + ' whitespace pass failed: ' + e.message);
    return null;
  }
  if (!out || !Array.isArray(out.themes)) return null;

  const valid = new Set(withCopy.map((a) => a.adId));
  const byClaim = new Map(themes.map((t) => [t.claim, t]));
  const rows = [];
  for (const t of out.themes) {
    const src = byClaim.get(t.claim);
    if (!src) continue;                       // a claim it reworded is a claim we cannot trust
    const hits = [...new Set((t.ad_ids || []).map(String).filter((id) => valid.has(id)))];
    rows.push({
      claim: t.claim,
      people: (src.evidence_ids || []).length,
      adsAddressing: hits.length,
      adIds: hits.slice(0, 6),
    });
  }
  if (!rows.length) return null;

  // Loudest complaint with the least competitor coverage first: that ordering
  // IS the recommendation, so it is computed here rather than described to a model.
  rows.sort((a, b) => (b.people / (b.adsAddressing + 1)) - (a.people / (a.adsAddressing + 1)));

  const result = { adsRead: withCopy.length, themes: rows };
  const gaps = rows.filter((r) => r.adsAddressing === 0).length;
  console.log('[report] ' + reportId + ' whitespace: ' + gaps + ' of ' + rows.length
    + ' proven complaints unaddressed across ' + withCopy.length + ' competitor ads');
  return result;
}

/*
 * Read a market we have never read before.
 *
 * The CLI version of this is unbounded: it discovers subreddits, mines them and
 * takes as long as it takes. Here it runs inside a background function with a
 * fifteen minute ceiling, sharing that budget with the product fetch, the
 * planner, the competitor ads pull and two synthesis calls. So every number
 * below is a deliberate trade of breadth for landing at all, and they are
 * smaller than the CLI's on purpose:
 *
 *   SUBS       6   the CLI takes 8. Past six the extra communities are
 *                  progressively less on-topic and each one costs search calls.
 *   POSTS     30   posts to pull comments from. Comment fetching is the slow
 *                  leg (one throttled call per post), so this is the number
 *                  that actually sets the wall clock.
 *   PER_POST  60   the CLI takes 100. A thread's first sixty comments carry the
 *                  argument; the tail is mostly replies to replies.
 *
 * YouTube is skipped entirely. It needs its own API key, it roughly doubles the
 * retrieval time, and Reddit alone has cleared the twenty record floor on every
 * category measured. It can come back if a category proves too thin without it.
 */
const HARVEST = { SUBS: 5, POSTS: 20, PER_POST: 60, SEARCH_LIMIT: 40 };

/*
 * Measured 2026-08-14, dog harnesses, at SUBS 6 / POSTS 30: 730 seconds, and
 * that run had the competitor ads leg switched off. With it the same report
 * lands near 13 minutes against a 15 minute ceiling, and a report that times
 * out delivers nothing at all after charging for it.
 *
 * So the budget is cut where it costs least. Comment fetching is one throttled
 * call per post and sets the wall clock, which makes POSTS the lever; the
 * corpus keeps every comment either way, and the ranked read-back means the
 * synthesis reads the best 300 lines rather than the first 300, so fewer posts
 * costs breadth of memory rather than quality of this report.
 */

async function harvestCategory(reportId, product, plan, corpus, cost) {
  const terms = (plan.subreddit_terms || []).filter(Boolean);
  if (!terms.length) return [];

  const candidates = await discoverSubreddits(terms, { perTerm: 25, minSubs: 5000 });
  if (!candidates.length) return [];

  /*
   * Ask the model which of these are real, then check its answer anyway.
   *
   * Subreddit discovery is a NAME prefix search, so it is full of false
   * friends: searching "shoe" surfaces r/Shoestring, which is budget travel.
   * Both the model's picks and the heuristic fallback go through
   * filterRelevant, because everything harvested here is written into the
   * corpus under this category, and one off-topic community poisons that
   * category's memory for every future report.
   */
  let picked = null;
  try {
    picked = await ask({
      model: WORKER, cost, label: 'pick-subs', schema: PICK_SCHEMA, maxTokens: 1200,
      system:
        'Pick the subreddits where this product\'s real buyers talk. Prefix search matches NAMES, so the list '
        + 'contains false friends (a "shoe" search surfaces r/Shoestring, a budget travel sub). Exclude those. '
        + 'Prefer communities about the product category or the problem it solves. Return names exactly as given.',
      prompt:
        `Product: ${product.title}\nCategory: ${plan.category}\n\nCandidates:\n`
        + candidates.slice(0, 60).map((s) => `${s.name} (${s.subscribers}) ${s.description}`).join('\n'),
    });
  } catch (e) {
    console.error('[report] ' + reportId + ' sub picking failed, falling back to the relevance gate: ' + e.message);
  }

  const chosen = ((picked && picked.keep) || [])
    .map((n) => candidates.find((c) => c.name.toLowerCase() === String(n).toLowerCase()))
    .filter(Boolean);

  const pool = chosen.length ? chosen : candidates;
  const { kept } = filterRelevant(pool, [plan.category, ...terms]);
  const subs = (kept.length ? kept : pool.slice(0, HARVEST.SUBS))
    .slice(0, HARVEST.SUBS).map((s) => s.name);
  if (!subs.length) return [];

  console.log('[report] ' + reportId + ' harvesting r/' + subs.join(', r/'));

  const posts = await searchPosts(subs, plan.reddit_queries || [], {
    limit: HARVEST.SEARCH_LIMIT, minComments: 2,
  });
  if (!posts.length) return [];

  const topPosts = posts.slice(0, HARVEST.POSTS);
  const comments = await fetchComments(topPosts.map((p) => p.id), { perPost: HARVEST.PER_POST });

  if (throttleState().throttled) {
    console.log('[report] ' + reportId + ' arctic shift throttled us, backed off to '
      + throttleState().gapMs + 'ms between calls');
  }

  /*
   * Write it down before returning. This is the entire point of the corpus, and
   * it is deliberately not fatal: a report the customer is waiting on must not
   * fail because a cache write did, even though losing the write means the next
   * person pays for this category again.
   */
  console.log('[report] ' + reportId + ' harvested ' + posts.length + ' posts, ' + comments.length + ' comments');

  let stored = false;
  try {
    const added = await corpus.addDocs(redditDocs(posts, comments), plan.category);
    await corpus.rememberCategory(plan.category, { subreddits: subs, queries: plan.reddit_queries || [] });
    stored = true;
    console.log('[report] ' + reportId + ' remembered ' + added + ' records for "' + plan.category + '"');
  } catch (e) {
    console.error('[report] ' + reportId + ' corpus write failed: ' + e.message);
  }

  /*
   * Read the harvest back the way a warm category is read, ranked.
   *
   * Handing the raw harvest straight to synthesis looks equivalent and is not.
   * The evidence budget takes the first 300 lines, and a fresh harvest is in
   * whatever order the subreddit search returned, so a broad community drowns
   * the product: measured 2026-08-14 on a Chemex page, where 1,289 harvested
   * records produced a report that said, correctly, "none of the provided posts
   * mention Chemex at all" because the top 300 lines were r/pourover talking
   * about grinders. The warm path never has this problem, because
   * warmRecords ranks by full text match against the plan's own queries.
   *
   * So the cold path now ends by becoming the warm path. Same ranking, same
   * shape, one behaviour to reason about. The raw harvest is the fallback for
   * when the corpus write failed, since unranked evidence still beats none.
   */
  if (stored) {
    try {
      const ranked = normaliseRows(await corpus.warmRecords(plan.category, plan.reddit_queries || []));
      if (ranked.length >= 20) {
        console.log('[report] ' + reportId + ' reading back ' + ranked.length + ' ranked records');
        return ranked;
      }
    } catch (e) {
      console.error('[report] ' + reportId + ' ranked read-back failed: ' + e.message);
    }
  }

  return normaliseLive(topPosts, comments, []);
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const key = req.headers.get('x-report-key') || '';
  if (!process.env.WEBHOOK_SECRET || key !== process.env.WEBHOOK_SECRET) {
    return new Response('nope', { status: 401 });
  }

  let body;
  try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
  const { reportId, url, signedIn } = body || {};
  if (!reportId || !url) return new Response('missing fields', { status: 400 });

  const client = db();
  /*
   * The invoke carries signedIn as a boolean, which was enough while the money
   * was taken in report-create. Charging here needs the account itself, and the
   * row is the authority on who owns the report: an anonymous read claimed at
   * sign-in changes user_id without ever re-invoking this worker.
   */
  const { data: owner } = await client.from('reports')
    .select('user_id').eq('id', reportId).maybeSingle();
  const ownerId = (owner && owner.user_id) || null;

  const corpus = openSupabaseCorpus(client);
  const cost = createCostMeter(url);
  const haveLLM = llmConfigured();
  const t0 = Date.now();

  try {
    /* 1. what is this thing ------------------------------------- */
    /*
     * A missing page is its own answer, and it must be caught here rather than
     * anywhere downstream. resolveProduct already refuses soft 404s (a 200
     * response carrying a "not found" template, which is the norm on hosted
     * storefronts), so an empty title now means either a dead link or a page we
     * genuinely cannot read. Both deserve the same plain sentence instead of a
     * planner call, a harvest and an ads pull spent on a page that is not there.
     */
    const product = await resolveProduct(url, cost);
    if (!product || !product.title) {
      await client.from('reports').update({
        status: 'ready', step: null,
        verdict: 'unreadable', demand_signal: 'unclear', evidence_count: 0,
        payload: {
          gated: false, unreadable: true,
          product: { title: '', url: url },
          message: 'We could not read that page. Either the link is dead or the store hides its product '
            + 'details from us. Check the link opens in a private window, and paste the page for a single '
            + 'product rather than a collection. Nothing was charged.',
        },
      }).eq('id', reportId);
      // Ready, but not a report. Anything that does not deliver findings is
      // refunded, whatever status it wears.
      await refund(client, reportId, 'unreadable product page');
      console.log('[report] ' + reportId + ' unreadable product page: ' + url);
      return { statusCode: 200 };
    }
    await client.from('reports').update({ product_title: product.title }).eq('id', reportId);

    /* 2. plan: category, queries, where its buyers talk ---------- */
    await setStep(client, reportId, 'building');

    /*
     * Show the planner what we already hold.
     *
     * The category is free text from a model, and the warm/cold check is an
     * exact match on it, so left alone the two never meet: measured
     * 2026-08-14, a Gymshark tee planned as "fitness apparel" while the corpus
     * held 2,609 documents under "men's workout T-shirts" and the report went
     * cold with the evidence sitting right there. Every report would have been
     * a cold start forever, and the corpus, which is the expensive asset here,
     * would never have been read once.
     *
     * Handing the planner the list and telling it to reuse an existing name is
     * cheaper and steadier than fuzzy matching afterwards, and it keeps the
     * corpus from splintering into a hundred near-identical categories.
     */
    const { data: knownCats } = await client
      .from('research_categories').select('name,docs').order('docs', { ascending: false }).limit(60);
    const catList = (knownCats || []).map((c) => `${c.name} (${c.docs} held)`).join('\n');

    const plan = !haveLLM ? heuristicPlan(product) : await ask({
      model: WORKER, cost, label: 'plan', schema: PLAN_SCHEMA, maxTokens: 2000,
      system:
        'You plan market research. Given a product, work out where its buyers actually talk and what they would search for.\n' +
        'Reddit search rules you MUST respect: queries are AND-ed, so multi-word queries return nothing. ' +
        'Emit SINGLE-CONCEPT terms of one or two words. Prefer the words buyers use over marketing words. ' +
        'subreddit_terms are name fragments for a prefix search, not topics.\n' +
        /* The category is a corpus key that outlives this report, so a brand
         * name in it makes the harvest unreusable: "allbirds men shoes" was
         * coined on 2026-08-19 and can never serve another shoe brand, which
         * is the whole point of holding a corpus. */
        'The category names a MARKET, not this product and not its brand. Never put the brand or ' +
        'vendor name in it. "sustainable sneakers" is a category; "Allbirds men shoes" is not. ' +
        'Include an audience word (men, women, kids) ONLY when that audience genuinely buys a ' +
        'different product, not merely a different size.' +
        (catList
          ? '\n\nCATEGORIES WE HAVE ALREADY STUDIED:\n' + catList +
            '\nIf this product belongs to one of those markets, return that name EXACTLY as written ' +
            'above, character for character. Only invent a new category name when none of them is ' +
            'the same market. Reusing a name is how we answer from what we already know instead of ' +
            'starting from nothing.'
          : ''),
      prompt:
        `Product: ${product.title}\n` +
        `Vendor: ${product.vendor || 'unknown'}\n` +
        `Type: ${product.type || 'unknown'}\n` +
        `Price: ${product.price ? `${product.price} ${product.currency}` : 'unknown'}\n` +
        `Description: ${(product.description || '').slice(0, 1200)}\n` +
        `URL: ${product.url}`,
    });
    if (!plan || !plan.category) return await fail(client, reportId, 'planning failed');

    /*
     * Second line of defence. Telling the planner to reuse a name works most of
     * the time, not all of it, and one coined synonym is the difference between
     * reading 2,609 held documents and harvesting from scratch. Match on
     * significant word overlap: "fitness apparel" and "men's workout T-shirts"
     * share nothing, but "workout shirts" and "men's workout T-shirts" do, and
     * that is the near-miss this actually catches.
     */
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !['the', 'for', 'and', 'men', 'women', 'best'].includes(w));

    /*
     * Who the market is for, read BEFORE norm() throws that word away.
     *
     * norm() drops "men" and "women" as noise, which is right for scoring
     * overlap and catastrophic as the only reading of the name: on 2026-08-19
     * "allbirds women shoes" and "allbirds men shoes" both reduced to
     * [allbirds, shoes], scored a perfect match, and the women's Tree Breezers
     * were answered from 432 documents harvested about men's shoes. A report
     * built on the wrong people's complaints is worse than no report, because
     * nothing about it looks wrong.
     *
     * Only blocks a match when BOTH names commit to an audience and they
     * disagree. A general corpus still serves a specific product, which is the
     * direction that is actually safe.
     */
    const audience = (s) => {
      const w = String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
      if (w.some((x) => x === 'women' || x === 'womens' || x === 'ladies')) return 'women';
      if (w.some((x) => x === 'men' || x === 'mens' || x === 'mens')) return 'men';
      if (w.some((x) => x === 'kids' || x === 'children' || x === 'toddler' || x === 'baby')) return 'kids';
      return '';
    };

    const wanted = new Set(norm(plan.category));
    const wantedAudience = audience(plan.category);
    if (wanted.size && !(knownCats || []).some((c) => c.name === plan.category)) {
      let best = null;
      for (const c of knownCats || []) {
        const heldAudience = audience(c.name);
        if (wantedAudience && heldAudience && wantedAudience !== heldAudience) continue;
        const have = norm(c.name);
        const shared = have.filter((w) => wanted.has(w)).length;
        const score = shared / Math.max(1, Math.min(have.length, wanted.size));
        if (score >= 0.5 && (!best || score > best.score)) best = { name: c.name, score };
      }
      if (best) {
        console.log('[report] category "' + plan.category + '" matched to held "' + best.name + '"');
        plan.category = best.name;
      }
    }

    await client.from('reports').update({ category: plan.category }).eq('id', reportId);

    /* 3. warm or cold ------------------------------------------- */
    const known = await corpus.categoryStats(plan.category);

    if (!known.warm && !signedIn) {
      /*
       * The gate. Not a failure: this is a real answer, and the most useful
       * moment in the funnel. The visitor learns their market has not been
       * studied yet and that we will go and do it, which is a better reason to
       * make an account than any banner.
       */
      await client.from('reports').update({
        status: 'ready',
        step: null,
        verdict: 'needs_harvest',
        demand_signal: 'unclear',
        evidence_count: known.docs || 0,
        payload: {
          gated: true,
          category: plan.category,
          product: { title: product.title, url: product.url },
          message: 'Sign in free and we will go and read it properly, then save the report to your library.',
        },
      }).eq('id', reportId);
      console.log('[report] ' + reportId + ' gated: cold category "' + plan.category + '", anonymous');
      return { statusCode: 200 };
    }

    /* 4. evidence ----------------------------------------------- */
    await setStep(client, reportId, known.warm ? 'reading' : 'harvesting');

    let records;
    if (known.warm) {
      records = normaliseRows(await corpus.warmRecords(plan.category, plan.reddit_queries || []));
    } else {
      /*
       * Cold and signed in: go and read the market properly.
       *
       * This is the expensive half of the product and the reason the free tier
       * stops at the gate. It is also the compounding one: everything harvested
       * here is written into the corpus under this category, so the next person
       * to ask about this market is served from memory in forty seconds for
       * nothing. We pay for a category once.
       */
      /* The seam. Category known, harvest not started, so this is the last
       * moment a refused charge costs us nothing but the planning call. */
      if (!(await charge(client, reportId, ownerId, plan.category))) {
        await client.from('reports').update({
          status: 'failed', step: null,
          payload: {
            gated: false, category: plan.category,
            product: { title: product.title, url: product.url },
            message: 'Reading a market nobody has studied yet is '
              + REPORT_CREDITS.toLocaleString() + ' credits, and your balance will not cover it. '
              + 'Nothing was charged. Markets we already hold stay free.',
            creditsNeeded: REPORT_CREDITS,
          },
        }).eq('id', reportId);
        console.log('[report] ' + reportId + ' stopped: cold category "' + plan.category + '", no credits');
        return { statusCode: 200 };
      }

      records = await harvestCategory(reportId, product, plan, corpus, cost);
      if (!records.length) {
        /*
         * Nothing found, and that is a real answer rather than an error. A
         * category with no discoverable discussion is usually a category whose
         * terms are wrong, and saying so plainly beats a confident report built
         * on nothing, which is the one unforgivable failure for a product whose
         * whole promise is "based on what people actually said".
         */
        await client.from('reports').update({
          status: 'ready', step: null,
          verdict: 'needs_harvest', demand_signal: 'unclear', evidence_count: 0,
          payload: {
            gated: false, pending_harvest: true, category: plan.category,
            product: { title: product.title, url: product.url },
            message: 'There was not enough real discussion about this category for us to say anything '
              + 'honest. That is usually a sign the market talks about this in words we have not matched '
              + 'yet. Nothing was charged.',
          },
        }).eq('id', reportId);
        await refund(client, reportId, 'harvest found nothing');
        console.log('[report] ' + reportId + ' cold category "' + plan.category + '": harvest found nothing');
        return { statusCode: 200 };
      }
      await setStep(client, reportId, 'reading');
    }

    if (records.length < 20) return await fail(client, reportId, 'only ' + records.length + ' records');

    /*
     * The product's own reviews, folded in as first-party evidence.
     *
     * Everything above this line is about the CATEGORY: what people say about
     * this kind of product, which ads the category runs, what nobody is
     * answering. That is how you find an unclaimed angle, and it is worth what
     * it costs. What it never does is read what THIS product's own buyers
     * wrote, which is the one source that is specifically about the thing being
     * advertised and the one place the objections that actually cost this
     * merchant sales are written down.
     *
     * Added after the record floor rather than before it on purpose: reviews
     * enrich a report that was already going to succeed, and must not be able
     * to rescue a category too thin to read, because that check is what stands
     * between a customer and a confident report built on nothing.
     *
     * Scoped to this report, never written to the shared category corpus. One
     * merchant's review data appearing as generic category evidence in a
     * competitor's report is not a trade we get to make on their behalf.
     */
    const productReviews = Array.isArray(product.reviews) ? product.reviews : [];
    if (productReviews.length) {
      const asRecords = reviewDocs(productReviews, product.url, product.title)
        .map((d) => ({ ...d, sub: '' }));
      records = records.concat(asRecords);
      console.log('[report] ' + reportId + ' +' + asRecords.length + ' first-party reviews');
    }

    const { index, lines } = buildEvidence(records);

    /*
     * One evidence budget for both synthesis calls, and it is smaller than the
     * CLI's on purpose.
     *
     * The CLI sends everything it holds (2,500 lines, ~114k tokens) because its
     * comment is right: the corroboration gate counts how many people raised a
     * theme, so truncating evidence truncates the counts. That reasoning holds
     * for a model that can read it. grok-4.6 cannot, and it does not say so.
     *
     * Measured 2026-08-14, same product, same corpus, in a full worker run
     * (plan, then read, then angles) which is what actually matters:
     *
     *   2500 lines (114k each) -> 0 angles, read thinned to 2 pains / 2 wishes
     *    800 lines  (68k each) -> 0 angles, read thinned FURTHER to 2 / 0 / 2
     *    300 lines  (30k each) -> 3 angles, read healthy at 3 / 3 / 5
     *
     * Note the middle row. A single 800-line angles call on its own produced 4
     * angles when it was the only request in flight, so the ceiling is not
     * per-call size, it is how much this account may spend in a short window.
     * The read burns its budget first and the angles call, running seconds
     * later, gets what is left. Anything measured in isolation here will lie to
     * you; only full-run numbers count.
     *
     * It fails by going quiet rather than erroring, which is the dangerous
     * kind: an empty angles array is indistinguishable from "the evidence did
     * not support any", and that is a sentence this product must only ever say
     * when it is true.
     *
     * The cost is time. Three hundred lines takes ~7 minutes end to end against
     * ~3 for the useless version, which is fine in a background function and
     * would not be anywhere else. If the account's limits are ever raised, walk
     * this number up and re-measure with a FULL run, never a single call.
     *
     * Lines arrive search-ranked with the loudest of the category behind them,
     * so this keeps the strongest evidence rather than an arbitrary slice.
     */
    const EVIDENCE_LINES = 300;
    const evidence = lines.slice(0, EVIDENCE_LINES).join('\n');

    /*
     * Competitor ads, for signed-in reports only.
     *
     * This is the one leg with a price we have actually measured: $0.0058 an
     * ad through Apify, so a 40-ad pull is about $0.23 a report. Everything
     * else here is corpus reads and tokens. That makes it the honest place to
     * draw the paid line, rather than gating something that costs us nothing
     * and calling it premium.
     *
     * It buys two things. The format verdict stops the angles guessing whether
     * video or static wins in this category, because it is derived from how
     * long real competitor ads have actually been running rather than from an
     * opinion. And the ad copy itself becomes corpus documents, so the next
     * report in this category is richer for it even if nobody pays again.
     *
     * Never fatal. A failed ads pull costs us a format verdict, not a report,
     * and formatBrief(null) already says honestly that we could not call it.
     */
    let formats = null;
    let adCount = 0;
    let adRows = [];
    let adsRaw = [];       // full ad objects, kept in memory for the gap analysis
    if (signedIn) {
      // Its own stage on the progress list: an Apify run is the slowest single
      // leg here, and a bar that sits still on "reading" for a minute reads as
      // a hang rather than as work.
      await setStep(client, reportId, 'ads');
      try {
        const found = await findCompetitorAds(
          [plan.category, ...(plan.reddit_queries || []).slice(0, 2)],
          { limit: 40, maxQueries: 2 },
          cost
        );
        if (found && found.ads && found.ads.length) {
          adCount = found.ads.length;
          adsRaw = found.ads;
          formats = formatVerdict(found.ads);
          /*
           * Keep the longest-running ads for the page, not all of them. The
           * duration ladder is the most persuasive thing in the report (nobody
           * keeps paying to run an ad that does not convert), but eighty raw
           * Apify records is a quarter of a megabyte of payload for a list that
           * shows ten rows. Only ads with an evidenced run length are kept: an
           * undated ad has nothing to say on a chart sorted by run length.
           */
          adRows = found.ads
            .filter(function (a) { return a.durationConfidence !== 'none' && a.daysRunning != null; })
            .sort(function (a, b) { return b.daysRunning - a.daysRunning; })
            .slice(0, 12)
            .map(function (a) {
              return {
                advertiser: a.advertiser || '',
                creative: a.creative || '',
                landingDomain: a.landingDomain || '',
                daysRunning: a.daysRunning,
                durationConfidence: a.durationConfidence,
                libraryUrl: a.libraryUrl || '',
              };
            });
          // Feed them back into the corpus so the category keeps compounding.
          try { await corpus.addDocs(adDocs(found.ads), plan.category); }
          catch (e) { console.error('[report] ad docs not stored: ' + e.message); }

          /*
           * Start watching them. Every report we run puts that market under
           * observation, so ads-recheck can turn today's snapshot into a
           * history: which of these were still running in ninety days, and
           * therefore which messages the market actually kept paying for.
           *
           * Never fatal. A report is not worth failing over a tracking row.
           */
          try {
            const rows = found.ads
              .filter((a) => a.adId)
              .map((a) => ({
                source: 'competitor',
                ad_archive_id: String(a.adId),
                category: plan.category,
                advertiser: a.advertiser || null,
                creative: a.creative || null,
                body: a.body ? String(a.body).slice(0, 1000) : null,
                days_running: a.daysRunning ?? null,
                still_live: true,
                last_checked: new Date().toISOString(),
              }));
            if (rows.length) {
              await client.from('tracked_ads').upsert(rows, { onConflict: 'ad_archive_id' });
            }
          } catch (e) {
            console.error('[report] ' + reportId + ' ad tracking not seeded: ' + e.message);
          }
          console.log('[report] ' + reportId + ' ' + adCount + ' competitor ads, format verdict: '
            + (formats && formats.verdict ? formats.verdict + ' (' + formats.confidence + ')' : 'none'));
        } else if (found && found.reason) {
          console.log('[report] ' + reportId + ' competitor ads skipped: ' + found.reason);
        }
      } catch (e) {
        console.error('[report] ' + reportId + ' competitor ads failed: ' + e.message);
      }
    }

    const shared =
      `PRODUCT: ${product.title}\nCATEGORY: ${plan.category}\n` +
      `WHAT IT IS: ${(product.description || '').slice(0, 700)}\n\n` +
      `EVIDENCE (cite by the id at the start of each line, e.g. c12):\n${evidence}`;

    const rules =
      'Rules:\n' +
      '1. Never invent a quote. You cite ids; the renderer pulls the real text.\n' +
      `2. Report a theme only when several different people raised it independently. List EVERY ` +
        `supporting id, not a sample of them, because the report counts them: a theme with fewer ` +
        `than ${MIN_RECEIPTS} is printed as a weak signal, not as a finding. Two loud comments are ` +
        'an anecdote, not a market.\n' +
      '3. Use the buyers\' own words in your claims where you can.\n' +
      '4. Rank by weight of evidence: how many people, how independently, how strongly. Never by ' +
        'how neat the claim sounds.\n' +
      '5. If the evidence is thin, say so plainly instead of padding. "Not enough evidence to call ' +
        'this" is a valid and valuable answer.';

    if (!haveLLM) return await fail(client, reportId, 'no LLM configured');

    /*
     * Both tiers now get angles. Free runs them on the worker model, deep on
     * the synthesis model and with the measured format verdict attached.
     *
     * Angles used to be deep-only, and that quietly broke the free read. The
     * report page leads with a recommendation built from angles[0]: the likely
     * customer, the strongest angle, the line to open with, and the button that
     * makes the ad. With no angles that entire block returns null, so a
     * signed-out visitor got quotes and no answer, which is the exact opposite
     * of the thing we are asking them to trust us with.
     *
     * The cost holds up. Of the $0.615 a deep report costs, $0.466 is the Apify
     * ads pull and only $0.149 is tokens (report-create.js). Ads stay gated, so
     * a free read stays around a quarter of a deep one, and what is behind the
     * sign-in is now a nameable thing (what competitors run, what nobody is
     * saying, video or statics) rather than a blurred half of the answer.
     *
     * formatBrief(null) already handles the missing verdict honestly: it tells
     * the model to mark every angle "both" and forbids claiming one format
     * beats the other. So a free angle never pretends to know something only
     * the ads pull could have told it.
     */
    await setStep(client, reportId, 'angles');
    const jobs = [{
      model: signedIn ? SYNTH : WORKER, cost, label: 'read', schema: READ_SCHEMA,
      maxTokens: 8000, effort: 'high',
      system:
        'You read voice-of-customer evidence and report what the market actually says. You are blunt and specific. ' +
        'The objections section matters most: the reasons people give for NOT buying are the hardest signal to get ' +
        'anywhere else, and they are what the marketing has to beat.\n' + rules,
      prompt: `${shared}\n\nGive the verdict, the ranked pains, the unmet wishes, and the objections.`,
    }, {
      model: signedIn ? SYNTH : WORKER, cost, label: 'angles', schema: ANGLES_SCHEMA, maxTokens: 8000, effort: 'high',
      system:
        'You turn voice-of-customer evidence into ad angles. An angle is a specific claim aimed at a specific ' +
        'buyer, in their register, that the evidence supports. Reject generic marketing angles that any competitor ' +
        'could run. Write hooks the way a real person talks, not the way a brand writes.\n' + rules,
      /*
       * The format brief is not optional, which is not obvious until it bites.
       * ANGLES_SCHEMA's `format` field is described as "Use the format verdict
       * you were given. Do not overrule it." Send the evidence without a
       * verdict and the model is being told to obey an instruction it never
       * received, so rather than invent one it returns an empty array:
       * measured 2026-08-14, 698 records of real evidence produced zero
       * angles purely because this line was missing.
       *
       * formatBrief(null) is the honest form of it, and it is now the normal
       * case rather than a fallback: a free read never runs the ads pull, so it
       * always arrives here with no verdict. It says so, tells the model to
       * mark every angle "both", and forbids claiming one format beats the
       * other. Deep reads pass the measured verdict and nothing else changes.
       */
      prompt:
        `PRODUCT: ${product.title}\nCATEGORY: ${plan.category}\n` +
        `WHAT IT IS: ${(product.description || '').slice(0, 700)}\n\n` +
        `EVIDENCE (cite by the id at the start of each line, e.g. c12):\n${evidence}\n\n` +
        `${formatBrief(formats)}\n\n` +
        'Give 3 to 5 angles, strongest first. For each one write both a video hook and a static headline, ' +
        'so the angle can run in either format.',
    }];

    /*
     * Sequential, not concurrent.
     *
     * The CLI fires read and angles together, which is fine on a desktop with
     * a fresh quota. Here both prompts carry the full evidence set, measured at
     * ~117k tokens each, and sending two of those at once cost us the angles
     * every time: the read came back and the angles call vanished without even
     * reaching the cost meter, which is what a rejected request looks like from
     * inside ask(). Angles are the half that carry the static headline every ad
     * creative is built from, so losing them silently is losing the product.
     *
     * A background function has minutes. Spending an extra one to actually get
     * the angles is not a trade worth thinking about.
     */
    const read = await ask(jobs[0]);
    if (!read) return await fail(client, reportId, 'synthesis returned nothing');

    let angles = null;
    if (jobs[1]) {
      angles = await ask(jobs[1]);
      if (!angles) console.error('[report] ' + reportId + ' angles call failed, shipping the read alone');
    }

    /*
     * Last, because it needs both halves: the proven complaints from the read
     * and the competitor ads from the pull. Runs only when we have real ads, and
     * never fatal, since a report without the gap analysis is still a report.
     */
    const whitespace = adsRaw.length ? await findWhitespace(reportId, read, adsRaw, cost) : null;

    /*
     * Store the evidence index alongside the findings. The renderer resolves
     * cited ids back to real quotes, so without it a stored report would be a
     * set of claims with no receipts, which is exactly the thing this product
     * exists not to be.
     *
     * Two things this has to get right, both of which bit:
     *
     * buildEvidence returns a Map, and JSON.stringify(new Map()) is "{}". Stored
     * straight through, every report kept its claims and silently dropped every
     * receipt behind them. It has to be flattened to a plain object.
     *
     * And only the CITED ids are kept. The full index is every record read (693
     * on the last real run, roughly 190KB of JSON) to serve maybe fifty quotes
     * the page will ever draw. Anything uncited is weight in the row, in the
     * poll response, and in the browser, for text nobody sees.
     */
    const citedIds = new Set();
    for (const group of ['pains', 'wishes', 'objections']) {
      for (const f of (read && read[group]) || []) {
        for (const id of f.evidence_ids || []) citedIds.add(String(id).trim());
      }
    }
    for (const a of (angles && angles.angles) || []) {
      for (const id of a.evidence_ids || []) citedIds.add(String(id).trim());
    }
    const evidenceOut = {};
    for (const id of citedIds) {
      const rec = index.get(id);
      if (rec) evidenceOut[id] = rec;
    }

    const payload = {
      gated: false,
      deep: !!signedIn,
      category: plan.category,
      product: { title: product.title, url: product.url, description: product.description || '' },
      read,
      angles: angles || null,
      evidence: evidenceOut,
      formats: formats || null,
      ads: adRows,
      adsAnalysed: adCount,
      whitespace,
      stats: {
        records: records.length,
        reviews: productReviews.length,
        // Counted over everything read, not over what ended up cited. "Read
        // across N communities" is a claim about the work done, and narrowing
        // it to the quotes that survived would understate it.
        subreddits: new Set(records.map(function (r) { return r.sub || r.channel; }).filter(Boolean)).size,
        corpusDocs: known.docs,
        corpusAgeDays: known.ageDays,
      },
      // Kept for the ledger, never shown: what a report cost us is our number,
      // not the reader's.
      cost: cost.toJSON ? cost.toJSON() : null,
      builtInMs: Date.now() - t0,
    };

    await client.from('reports').update({
      status: 'ready',
      step: null,
      verdict: (read && read.verdict) || null,
      demand_signal: (read && read.demand_signal) || null,
      evidence_count: records.length,
      payload,
    }).eq('id', reportId);

    console.log('[report] ' + reportId + ' ready: ' + plan.category + ', ' + records.length
      + ' records, ' + (signedIn ? 'deep' : 'free') + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    return { statusCode: 200 };
  } catch (e) {
    return await fail(client, reportId, e.message);
  }
};

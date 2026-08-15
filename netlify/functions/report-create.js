'use strict';

/*
 * Start a validation report.
 *
 * POST { url } -> { id, claimToken?, cached? }
 *
 * This function is deliberately thin. It decides who is allowed to ask and
 * whether we already have the answer, then hands the real work to
 * report-build-background, which has minutes rather than the ten seconds a
 * synchronous function gets. A cold category needs roughly sixty throttled
 * harvest calls; there is no version of that which fits here.
 *
 * What it does NOT decide is depth. Whether a category is warm enough to
 * answer from memory depends on knowing the category, and knowing the category
 * takes an LLM planning call. So the free/deep gate lives in the background
 * worker, where that answer exists, and this function's job is to get a row
 * created and a handle back to the browser fast.
 *
 * Anonymous callers are supported on purpose: the free report is the top of the
 * funnel and putting a login in front of it would defeat the point. They get a
 * claim_token instead of a user_id, which the schema already anticipates
 * ("anonymous handle, exchanged for user_id at sign-in").
 */

const crypto = require('crypto');
const sb = require('./lib/supabase');
const peek = require('./product-peek');
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
 * A report already built for this URL is served again rather than rebuilt.
 *
 * This is the main cost control, and it is also just correct: research about a
 * product does not change between two people asking on the same afternoon.
 * It means the expensive path runs once per product rather than once per
 * visitor, which is what makes an anonymous free tier affordable at all.
 *
 * Stale after a fortnight, matching the corpus's own warm window, so a market
 * that has moved gets looked at again.
 */
const CACHE_DAYS = 14;

/* New markets one account may have read in a rolling 24 hours. See the ceiling
 * check in the handler for why this number and not a smaller one. */
const DEEP_DAILY_CAP = 25;

/*
 * What a deep report costs the customer, in credits.
 *
 * Measured cost to us on 2026-08-14 with the real xAI rate card: $0.615 a
 * report, of which $0.466 is the Apify competitor-ads pull and $0.149 is
 * tokens. At 500 credits to the dollar this is $2, so it clears cost at about
 * 69% margin and the 2,500 credit welcome grant covers the first two.
 *
 * Only signed-in reports are charged, because only signed-in reports run the
 * expensive legs: the cold-category harvest and the ads pull. The free report
 * stays genuinely free and is the top of the funnel.
 *
 * A cached report is never charged. The work was already paid for by whoever
 * triggered the build, and billing a second person for a row we are reading
 * out of the database would be charging for nothing.
 */
const DEEP_REPORT_CREDITS = 1000;

async function cachedReport(db, url, wantDeep) {
  const cutoff = new Date(Date.now() - CACHE_DAYS * 86400 * 1000).toISOString();
  let q = db.from('reports')
    .select('id,status,product_title,created_at')
    .eq('product_url', url)
    .eq('status', 'ready')
    .gte('created_at', cutoff);

  /*
   * A signed-in caller is only served a cached DEEP report.
   *
   * Depth is not a property of the URL, it is a property of who asked: the free
   * read stops after the pains and wishes, while the deep one adds competitor
   * ads, the format verdict and the angles. Matching on URL alone means the
   * first anonymous visitor to a product permanently caps everyone who signs in
   * afterwards, and the person who made an account to get the full thing is
   * handed the stub instead, with no way to ask again.
   *
   * The reverse is fine and deliberate: an anonymous caller happily reuses a
   * deep report someone else already paid for, and the gate in the renderer
   * still decides how much of it they see.
   */
  if (wantDeep) q = q.eq('payload->>deep', 'true');

  const { data } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!sb.configured()) return json(503, { error: 'accounts not configured' });

  /*
   * Loose enough that a shared office address never notices, tight enough that
   * a loop cannot spend our LLM balance. Research is the one free thing here
   * that costs real money per run, so this is the only limit on the site set
   * for cost rather than for load.
   */
  if (!(await allow('report', event, 60))) {
    return json(429, { error: 'Too many reports for now. Try again shortly.' });
  }

  let raw;
  try { raw = JSON.parse(event.body || '{}').url; }
  catch (e) { return json(400, { error: 'bad json' }); }
  if (!raw || typeof raw !== 'string') return json(400, { error: 'missing url' });

  // Same SSRF guard the peek uses: this URL is fetched server-side later, so it
  // has to survive the same checks rather than be trusted because it arrived
  // through a different door.
  const target = await peek.guardUrl(raw);
  if (!target) return json(400, { error: 'that does not look like a product page we can read' });

  const db = sb.admin();
  const user = await getUser(event); // null for anonymous, which is allowed

  /*
   * A per-account ceiling on reports that can go deep.
   *
   * Signing in is what unlocks the expensive legs: the cold-category harvest
   * and the Apify competitor ads pull. Priced with the real xAI rates on
   * 2026-08-14, a deep report costs us $0.615 (about $0.47 of it Apify), and
   * before this there was no per-account limit at all, only 60/hour by IP. One
   * verified account could therefore spend roughly $37 an hour of ours.
   *
   * Set where a real user never meets it. Somebody researching their whole
   * catalogue in an afternoon does maybe ten products; twenty-five is generous
   * on top of that, and repeats do not count because a cached URL never
   * reaches this line. It is a ceiling on automated abuse, not on enthusiasm.
   */
  if (user) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await db.from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.userId)
      .gte('created_at', since);
    if ((count || 0) >= DEEP_DAILY_CAP) {
      return json(429, {
        error: 'That is ' + DEEP_DAILY_CAP + ' new markets read in a day, which is as far as we go in one '
          + 'stretch. Your existing reports are all still here, and this resets tomorrow.',
      });
    }
  }

  const hit = await cachedReport(db, target.href, !!user);
  if (hit) {
    /* Someone already paid for this research. Hand it over, and if this caller
     * is signed in, claim it for them so it lands in their library. */
    if (user) {
      await db.from('reports').update({ user_id: user.userId })
        .eq('id', hit.id).is('user_id', null);
    }
    return json(200, { id: hit.id, cached: true, title: hit.product_title || null });
  }

  // Unguessable, and the only thing an anonymous browser holds to get back to
  // its report. 32 bytes because it is a bearer credential in all but name.
  const claimToken = user ? null : crypto.randomBytes(32).toString('base64url');

  const { data: row, error } = await db.from('reports').insert({
    user_id: user ? user.userId : null,
    product_url: target.href,
    claim_token: claimToken,
    status: 'building',
  }).select('id').single();
  if (error || !row) {
    console.error('report insert failed:', error && error.message);
    return json(503, { error: 'could not start the report' });
  }

  /*
   * Charge the deep report, after the row exists and before the worker starts.
   *
   * The order matters in both directions. The row has to come first because
   * its id is the idempotency key the refund uses, and there is no other stable
   * handle for this piece of work. The charge has to land before the worker is
   * invoked, because once the worker starts it spends real money at Apify and
   * xAI, and discovering an empty balance after that has been spent is the one
   * sequence that costs us the report AND the money.
   *
   * A failed charge deletes the row rather than leaving it 'building' forever,
   * so the customer can simply try again once they have topped up.
   */
  if (user) {
    const { error: spendErr } = await sb.admin().rpc('credit_spend', {
      p_user: user.userId,
      p_amount: DEEP_REPORT_CREDITS,
      p_ref: 'report:' + row.id,
      p_note: 'Market read',
    });
    if (spendErr) {
      await db.from('reports').delete().eq('id', row.id);
      if (/insufficient credits/i.test(spendErr.message || '')) {
        return json(402, {
          error: 'A full market read is ' + DEEP_REPORT_CREDITS.toLocaleString() + ' credits and your balance '
            + 'will not cover it. Nothing was charged.',
          creditsNeeded: DEEP_REPORT_CREDITS,
        });
      }
      console.error('report credit spend failed:', spendErr.message);
      return json(503, { error: 'could not charge credits' });
    }
    await db.from('reports').update({ paid: true }).eq('id', row.id);
  }

  /*
   * Awaited, not fire-and-forget. A Lambda freezes the moment the handler
   * returns, so an un-awaited fetch is simply never sent: measured on this
   * stack when the unlock worker only ever ran when invoked by hand. A
   * background function answers 202 immediately, so the wait costs nothing.
   *
   * Host comes from the request rather than the environment, because
   * process.env.URL is always production and a draft posting work at the live
   * site hits a function that does not exist there yet.
   */
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || h.Host;
  const base = host ? 'https://' + String(host).replace(/\/$/, '')
                    : (process.env.DEPLOY_URL || process.env.URL || '').replace(/\/$/, '');
  if (base && process.env.WEBHOOK_SECRET) {
    await fetch(base + '/.netlify/functions/report-build-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-report-key': process.env.WEBHOOK_SECRET },
      body: JSON.stringify({ reportId: row.id, url: target.href, signedIn: !!user }),
    }).catch(function (e) { console.log('[report-create] worker invoke failed:', e.message); });
  }

  return json(200, { id: row.id, claimToken: claimToken || undefined, cached: false });
};

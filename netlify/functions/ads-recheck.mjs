/*
 * Re-measure whether tracked ads are still running.
 *
 * Scheduled daily. For each category we are watching, it asks the Meta Ad
 * Library again and compares what comes back against what we recorded, which
 * turns a snapshot of a market into a history of one.
 *
 * WHY THIS IS THE PERFORMANCE LOOP, AND WHAT IT IS NOT
 *
 * It cannot see spend, click-through, ROAS or conversions. None of that is
 * public, and reading it would need the Meta Marketing API against a customer's
 * own ad account. What is public is when an ad started and whether it is still
 * live, which is a survival signal: nobody keeps paying to run an ad that loses
 * money. An ad alive at ninety days has been judged by the only referee that
 * matters. One killed at six has been judged too.
 *
 * That is already the reasoning behind the format verdict, so applying it to
 * our own creatives is consistent rather than a new claim. The rule that must
 * never be broken: survival is reported as survival. It is not profit and the
 * copy must not imply it is.
 *
 * Cost control is the whole design here. Apify bills per ad, so this walks a
 * small number of categories per run, oldest checked first, rather than
 * everything we have ever seen.
 *
 * env: APIFY_TOKEN (or BRIGHTDATA_API_TOKEN), SUPABASE_URL,
 *      SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { findCompetitorAds } from '../../research/lib/ads.mjs';
import { createCostMeter } from '../../research/lib/cost.mjs';

/*
 * Budgets, in the same spirit as the harvest budgets.
 *
 * At $0.0058 an ad, CATEGORIES x LIMIT is the daily bill: 4 x 40 is about
 * $0.93 a day, or $28 a month, to keep every market we have researched under
 * observation. Raise it when the answer is worth more than that.
 */
const CATEGORIES_PER_RUN = 4;
const LIMIT = 40;

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

export default async () => {
  const client = db();
  const cost = createCostMeter('ads-recheck');

  /*
   * Which markets to look at. Oldest checked first, so attention rotates
   * rather than piling onto whichever category happens to be busiest, and a
   * market nobody has researched recently still gets its history extended.
   */
  const { data: rows, error } = await client
    .from('tracked_ads')
    .select('category,last_checked')
    .not('category', 'is', null)
    .eq('still_live', true)
    .order('last_checked', { ascending: true, nullsFirst: true })
    .limit(400);
  if (error) {
    console.error('[ads-recheck] could not read tracked ads: ' + error.message);
    return new Response('db error', { status: 200 });
  }

  const categories = [];
  for (const r of rows || []) {
    if (r.category && categories.indexOf(r.category) === -1) categories.push(r.category);
    if (categories.length >= CATEGORIES_PER_RUN) break;
  }
  if (!categories.length) {
    console.log('[ads-recheck] nothing to re-check yet');
    return new Response('idle', { status: 200 });
  }

  const now = new Date().toISOString();
  let seenTotal = 0;
  let endedTotal = 0;

  for (const category of categories) {
    let found;
    try {
      found = await findCompetitorAds([category], { limit: LIMIT, maxQueries: 1 }, cost);
    } catch (e) {
      console.error('[ads-recheck] ' + category + ': lookup failed: ' + e.message);
      continue;
    }
    const live = (found && found.ads) || [];
    if (!live.length) {
      console.log('[ads-recheck] ' + category + ': the library returned nothing, leaving records untouched');
      continue;   // an empty answer is a failed lookup, not a dead market
    }

    const liveIds = new Set(live.map((a) => String(a.adId)).filter(Boolean));
    seenTotal += liveIds.size;

    /* Still running: extend the record. daysRunning comes from the library's
     * own start date, so it is measured rather than inferred from our
     * check schedule. */
    for (const ad of live) {
      if (!ad.adId) continue;
      await client.from('tracked_ads').upsert({
        source: 'competitor',
        ad_archive_id: String(ad.adId),
        category,
        advertiser: ad.advertiser || null,
        creative: ad.creative || null,
        body: ad.body ? String(ad.body).slice(0, 1000) : null,
        days_running: ad.daysRunning ?? null,
        still_live: true,
        last_checked: now,
      }, { onConflict: 'ad_archive_id' });
    }

    /*
     * Gone: everything we were watching in this category that the library no
     * longer returns. This is the half that carries the signal, because an ad
     * disappearing is the advertiser telling us it did not earn its place.
     *
     * days_running is deliberately NOT overwritten here: whatever it held at
     * the last sighting is the honest length of the run, and recomputing it
     * from today would silently credit the ad with time it did not run.
     */
    const { data: watched } = await client.from('tracked_ads')
      .select('id,ad_archive_id')
      .eq('category', category)
      .eq('still_live', true);

    const gone = (watched || []).filter((w) => !liveIds.has(String(w.ad_archive_id)));
    if (gone.length) {
      await client.from('tracked_ads')
        .update({ still_live: false, ended_at: now, last_checked: now })
        .in('id', gone.map((g) => g.id));
      endedTotal += gone.length;
    }

    console.log('[ads-recheck] ' + category + ': ' + liveIds.size + ' still running, ' + gone.length + ' ended');
  }

  console.log('[ads-recheck] done. ' + categories.length + ' categories, ' + seenTotal
    + ' live, ' + endedTotal + ' ended, cost $' + cost.total().toFixed(4));
  return new Response('ok', { status: 200 });
};

export const config = {
  // Daily, early, so a run never overlaps the report traffic of a working day.
  schedule: '@daily',
};

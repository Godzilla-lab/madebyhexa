/*
 * Competitor ads: who is advertising in this category, and HOW LONG each ad has
 * been running.
 *
 * Run duration is the whole point. Nobody keeps paying to run an ad that does
 * not convert, so "this creative has been live 180 days" is the strongest
 * public proof-of-performance signal that exists. A 4-day-old ad tells you
 * nothing; a 180-day-old ad tells you the angle works.
 *
 * WHY WE SCRAPE RATHER THAN USE THE OFFICIAL API
 * Meta's `ads_archive` API is explicit: "Ads that did not reach any location in
 * the EU will only return if they are about social issues, elections or
 * politics." A US DTC brand is therefore invisible to the official API. The
 * public Ad Library web UI does show commercial ads with their start dates, but
 * it 403s a plain datacenter request (measured 2026-08-13: 403, 481 bytes). So
 * this needs a real unblocking layer.
 *
 * BACKENDS, in preference order:
 *   1. Bright Data  -- preferred. It is also the safest legal footing available,
 *      since Bright Data won Meta Platforms v. Bright Data (N.D. Cal. 2024) on
 *      logged-off scraping of public data.
 *   2. Apify        -- works today with the token already in .env. Measured
 *      $0.0058/ad on the free plan, which has a $5/month hard cap.
 *
 * THE DATE RULE (non-negotiable, per the plan)
 * We display a duration ONLY when it comes from a reported field or from our own
 * dated snapshots. Never inferred, never estimated. `durationConfidence` carries
 * that provenance all the way to the UI, and a card with no evidenced date
 * simply does not show one.
 *
 * NEVER AUTHENTICATE. Logged-off public scraping is what the Bright Data holding
 * protects. A session cookie forfeits it.
 */

const APIFY_ACTOR = 'apify~facebook-ads-scraper';
const DAY = 86400000;

/* ── which backend ─────────────────────────────────────────────── */

export function backend() {
  if (process.env.BRIGHTDATA_API_TOKEN && process.env.BRIGHTDATA_ADS_DATASET) return 'brightdata';
  if (process.env.APIFY_TOKEN) return 'apify';
  return null;
}

/* ── shared shaping ────────────────────────────────────────────── */

/* The actors drift between camel/snake and top-level/nested, so read across a
 * list of candidate paths rather than trusting one shape. */
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    for (const part of p.split('.')) {
      if (cur && typeof cur === 'object' && part in cur) cur = cur[part];
      else { cur = undefined; break; }
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return '';
}

function parseDate(v) {
  if (!v) return null;
  // Unix seconds or ms.
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/*
 * Normalise one ad and, critically, establish the provenance of its duration.
 *
 *   reported : the source gave us an explicit duration or an end date
 *   observed : we have a real start date and the ad is still live, so
 *              days-running is arithmetic on two facts, not a guess
 *   none     : no trustworthy date. The UI must not render a duration.
 */
export function normaliseAd(raw) {
  const start = parseDate(pick(raw, [
    'startDate', 'start_date', 'startDateFormatted', 'ad_delivery_start_time',
    'snapshot.startDate', 'first_shown_date',
  ]));
  const rawEnd = parseDate(pick(raw, [
    'endDate', 'end_date', 'ad_delivery_stop_time', 'last_shown_date',
  ]));
  const reportedDuration = Number(
    pick(raw, ['runDurationDays', 'run_duration_days', 'totalActiveTime', 'total_active_time'])
  ) || null;

  // `isActive` arrives as a real boolean from Apify and as a string
  // ("ACTIVE"/"active_status") elsewhere, so read both shapes. Coercing the
  // boolean to a string and substring-matching silently made every ad inactive.
  const activeRaw = pick(raw, ['isActive', 'is_active', 'activeStatus', 'active_status']);
  const isActive = activeRaw === true || /^(true|active)$/i.test(String(activeRaw));

  /*
   * Measured 2026-08-13: on a LIVE ad the scraper reports `endDate` as today's
   * date. That is not an end date, it is a read timestamp, and treating it as
   * one would let us claim "reported" provenance for a duration nobody reported.
   * So an end date only counts as reported when the ad has actually stopped.
   */
  const ended = Boolean(rawEnd) && !isActive;
  const end = ended ? rawEnd : null;

  let days = null;
  let confidence = 'none';

  if (reportedDuration && reportedDuration > 0) {
    // totalActiveTime is seconds in Meta's payload; treat implausibly large
    // values as seconds rather than days.
    days = reportedDuration > 3650 ? Math.round(reportedDuration / 86400) : Math.round(reportedDuration);
    confidence = 'reported';
  } else if (start && end) {
    days = Math.max(0, Math.round((end - start) / DAY));
    confidence = 'reported';
  } else if (start) {
    // Still live: days-running is arithmetic on a real start date and today.
    days = Math.max(0, Math.round((Date.now() - start) / DAY));
    confidence = 'observed';
  }

  const creative = creativeType(raw);
  const platforms = (pick(raw, ['publisherPlatform', 'publisher_platform', 'publisher_platforms']) || []);

  return {
    adId: String(pick(raw, ['adArchiveID', 'ad_archive_id', 'adArchiveId', 'id']) || ''),
    network: 'meta',
    pageId: String(pick(raw, ['pageID', 'pageId', 'page_id', 'snapshot.pageId']) || ''),
    advertiser: String(pick(raw, ['pageName', 'page_name', 'snapshot.pageName']) || ''),
    body: String(pick(raw, ['snapshot.body.text', 'snapshot.body', 'body.text', 'ad_creative_bodies.0', 'body']) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 900),
    cta: String(pick(raw, ['snapshot.ctaText', 'ctaText', 'cta_text']) || ''),
    isVideo: creative === 'video',
    creative,                   // 'video' | 'static' | null. null means UNKNOWN.
    deliveryFormat: String(pick(raw, ['snapshot.displayFormat', 'displayFormat', 'display_format']) || '').toUpperCase(),
    platforms: Array.isArray(platforms) ? platforms.map((p) => String(p).toUpperCase()) : [],
    startDate: start ? start.toISOString().slice(0, 10) : null,
    endDate: end ? end.toISOString().slice(0, 10) : null,
    daysRunning: days,
    durationConfidence: confidence,
    isActive,
    landingDomain: domainOf(pick(raw, ['snapshot.linkUrl', 'linkUrl', 'snapshot.caption', 'caption'])),
    libraryUrl: pick(raw, ['url']) ||
      `https://www.facebook.com/ads/library/?id=${pick(raw, ['adArchiveID', 'ad_archive_id', 'id'])}`,
  };
}

/*
 * Is this ad a video or a static? Returns null when we genuinely cannot tell,
 * and null is load-bearing: the format verdict counts only typed ads, so an
 * unknown must never be silently bucketed as a static.
 *
 * `displayFormat` is NOT the answer. Measured on a real pull, 21 of 30 ads came
 * back DCO and 2 came back DPA -- those are delivery modes (dynamic creative,
 * dynamic product ads), not creative types, so reading displayFormat alone
 * throws away two thirds of the sample. The creative type actually lives in the
 * media arrays: `snapshot.videos`, `snapshot.images`, and for DCO/DPA the
 * per-variation `snapshot.cards`, each card carrying either a videoHdUrl/
 * videoSdUrl or only an image url.
 */
export function creativeType(raw) {
  const snap = raw.snapshot || raw;
  const videos = Array.isArray(snap.videos) ? snap.videos : [];
  const images = Array.isArray(snap.images) ? snap.images : [];
  const cards = Array.isArray(snap.cards) ? snap.cards : [];

  const hasVideo = (o) => Boolean(
    o && (o.videoHdUrl || o.videoSdUrl || o.video_hd_url || o.video_sd_url ||
          o.watermarkedVideoHdUrl || o.watermarkedVideoSdUrl)
  );
  const hasImage = (o) => Boolean(
    o && (o.originalImageUrl || o.resizedImageUrl || o.original_image_url ||
          o.resized_image_url || o.imageCrops)
  );

  if (videos.length || cards.some(hasVideo)) return 'video';
  if (images.length || cards.some(hasImage)) return 'static';

  // Last resort: displayFormat, but only when it actually names a creative type.
  const df = String(snap.displayFormat || snap.display_format || '').toUpperCase();
  if (df === 'VIDEO') return 'video';
  if (df === 'IMAGE') return 'static';
  return null;
}

function domainOf(v) {
  const s = String(v || '');
  if (!s) return '';
  // A bare display domain (the common `caption` shape) needs no parsing.
  if (!s.includes('/') && s.includes('.')) return s.toLowerCase().replace(/^www\./, '');
  try {
    let u = new URL(s.startsWith('http') ? s : `https://${s}`);
    // Unwrap Meta's l.facebook.com?u=<encoded> redirector.
    if (/facebook\.com$/.test(u.hostname) && u.searchParams.get('u')) {
      u = new URL(u.searchParams.get('u'));
    }
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/* ── backend: Apify ────────────────────────────────────────────── */

async function fetchApify(query, { country = 'US', limit = 40, newerThan } = {}, cost) {
  const token = process.env.APIFY_TOKEN;
  const search = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country,
    q: query,
    search_type: 'keyword_unordered',
    media_type: 'all',
  });

  const input = {
    startUrls: [{ url: `https://www.facebook.com/ads/library/?${search}` }],
    resultsLimit: limit,
    activeStatus: 'active',
  };
  if (newerThan) input.onlyAdsNewerThan = newerThan;

  const res = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${token}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  );

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    // The free plan's $5 monthly cap surfaces here; say so plainly rather than
    // returning an empty result that looks like "no competitors".
    if (/usage hard limit|monthly usage/i.test(text)) {
      throw new Error('Apify monthly usage limit reached. Top up, or switch to Bright Data.');
    }
    throw new Error(`Apify ${res.status}: ${text}`);
  }

  const items = await res.json();
  if (cost) cost.charge('apify.fb-ads-item', Array.isArray(items) ? items.length : 0);
  return Array.isArray(items) ? items : [];
}

/* ── backend: Bright Data ──────────────────────────────────────── */

async function fetchBrightData(query, { country = 'US', limit = 40 } = {}, cost) {
  const res = await fetch(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${process.env.BRIGHTDATA_ADS_DATASET}&include_errors=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ keyword: query, country, num_of_results: limit }]),
    }
  );
  if (!res.ok) throw new Error(`Bright Data ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const body = await res.json();
  // Dataset triggers are async: this returns a snapshot id to collect.
  if (body && body.snapshot_id) {
    return { pending: true, snapshotId: body.snapshot_id };
  }
  if (cost) cost.charge('brightdata.ads-record', Array.isArray(body) ? body.length : 0);
  return Array.isArray(body) ? body : [];
}

/* ── public API ────────────────────────────────────────────────── */

/*
 * Find competitor ads for a category. Returns ads sorted by how long they have
 * been running, because that ordering IS the insight -- the top of this list is
 * what the market has already proven works.
 */
export async function findCompetitorAds(queries, opts = {}, cost) {
  const which = backend();
  if (!which) {
    return { ads: [], backend: null, reason: 'no ad backend configured (set BRIGHTDATA_API_TOKEN or APIFY_TOKEN)' };
  }

  const seen = new Map();
  const errors = [];

  for (const q of queries.slice(0, opts.maxQueries || 3)) {
    try {
      const raw = which === 'brightdata'
        ? await fetchBrightData(q, opts, cost)
        : await fetchApify(q, opts, cost);

      if (raw && raw.pending) {
        errors.push(`Bright Data returned snapshot ${raw.snapshotId} (async collection not wired yet)`);
        continue;
      }

      for (const item of raw) {
        const ad = normaliseAd(item);
        if (!ad.adId || seen.has(ad.adId)) continue;
        if (!ad.body && !ad.advertiser) continue;
        seen.set(ad.adId, ad);
      }
    } catch (e) {
      errors.push(e.message);
      break;                    // a cap or auth failure will not fix itself
    }
  }

  const ads = [...seen.values()].sort((a, b) => {
    // Evidenced durations first, longest-running at the top.
    if ((b.daysRunning || 0) !== (a.daysRunning || 0)) return (b.daysRunning || 0) - (a.daysRunning || 0);
    return a.durationConfidence === 'none' ? 1 : -1;
  });

  return { ads, backend: which, errors, advertisers: groupByAdvertiser(ads) };
}

/*
 * Per-advertiser view. `distinctStarts` is the creative-treadmill signal: many
 * launch dates means they are burning through creative, which is both a sign of
 * a real budget and the exact pain the studio sells against.
 */
export function groupByAdvertiser(ads) {
  const map = new Map();
  for (const ad of ads) {
    const key = ad.pageId || ad.advertiser;
    if (!key) continue;
    const cur = map.get(key) || {
      advertiser: ad.advertiser, pageId: ad.pageId, domain: ad.landingDomain,
      ads: 0, videoAds: 0, starts: new Set(), longestRun: 0, longestConfidence: 'none',
    };
    cur.ads++;
    if (ad.isVideo) cur.videoAds++;
    if (ad.startDate) cur.starts.add(ad.startDate);
    if ((ad.daysRunning || 0) > cur.longestRun && ad.durationConfidence !== 'none') {
      cur.longestRun = ad.daysRunning;
      cur.longestConfidence = ad.durationConfidence;
    }
    map.set(key, cur);
  }
  return [...map.values()]
    .map((a) => ({ ...a, distinctStarts: a.starts.size, starts: undefined }))
    .sort((a, b) => b.longestRun - a.longestRun || b.ads - a.ads);
}

/* ── the format verdict ────────────────────────────────────────── */

/*
 * Should this category be run as video or as statics?
 *
 * Pure data, no model. The weak signal is the raw split of all ads; the strong
 * signal is the split AMONG THE WINNERS, because duration is the proof of what
 * advertisers keep paying for. If 62% of all ads are static but 80% of the
 * 90-day-plus ads are video, the answer is video, and the raw split is shown
 * only for contrast.
 *
 * Two rules keep this honest:
 *   - Untyped ads are excluded, never bucketed. `creativeType` returns null when
 *     it cannot tell, and a ratio computed over guesses is worse than no ratio.
 *   - Below the minimum sample there is NO verdict. The report says it does not
 *     have enough competitor evidence to call a format, which is a real answer.
 *
 * Scoped to one network on purpose. TikTok's library is video-native, so mixing
 * it in would manufacture a video verdict out of nothing but where we looked.
 * The static-versus-video battleground is Meta.
 */
export function formatVerdict(ads, {
  network = 'meta',
  minTyped = 20,
  minLong = 8,
  longDays = 90,
  midDays = 60,
} = {}) {
  const pool = ads.filter((a) => (a.network || 'meta') === network);
  const typed = pool.filter((a) => a.creative === 'video' || a.creative === 'static');
  const dated = typed.filter((a) => a.durationConfidence !== 'none' && a.daysRunning != null);

  const share = (list) => {
    const v = list.filter((a) => a.creative === 'video').length;
    const s = list.filter((a) => a.creative === 'static').length;
    return { video: v, static: s, total: v + s, videoShare: v + s ? v / (v + s) : null };
  };

  const past60 = dated.filter((a) => a.daysRunning >= midDays);
  const past90 = dated.filter((a) => a.daysRunning >= longDays);

  // Prefer the 90-day cohort; drop to 60 only if 90 is too thin to read.
  const cohortDays = past90.length >= minLong ? longDays : midDays;
  const cohort = cohortDays === longDays ? past90 : past60;

  // Duration-weighted: an ad running 200 days counts 200x an ad running 1 day.
  const weight = { video: 0, static: 0 };
  for (const a of dated) {
    if (a.creative === 'video' || a.creative === 'static') weight[a.creative] += a.daysRunning || 0;
  }
  const weightTotal = weight.video + weight.static;

  const out = {
    network,
    sample: {
      ads: pool.length,
      typed: typed.length,
      untyped: pool.length - typed.length,
      dated: dated.length,
      past60: past60.length,
      past90: past90.length,
    },
    raw: share(typed),
    longRunners: { ...share(cohort), cohortDays },
    durationWeighted: {
      videoDays: weight.video,
      staticDays: weight.static,
      videoShare: weightTotal ? weight.video / weightTotal : null,
    },
    byPlatform: platformSplit(typed),
    verdict: null,
    confidence: null,
    reason: '',
    bundle: null,
  };

  if (typed.length < minTyped || past60.length < minLong) {
    out.reason = `not enough competitor evidence to call a format: ${typed.length} ads with a known creative type (need ${minTyped}) and ${past60.length} running past ${midDays} days (need ${minLong})`;
    return out;
  }

  const s = out.longRunners.videoShare;
  if (s === null) {
    out.reason = 'no long-running ads with a known creative type';
    return out;
  }

  out.verdict = s >= 0.65 ? 'video' : s <= 0.35 ? 'static' : 'both';

  // Confidence is about how hard the evidence leans, and how much of it there is.
  const margin = Math.abs(s - 0.5) * 2;
  if (typed.length >= 40 && out.longRunners.total >= 15 && margin >= 0.3) out.confidence = 'strong';
  else if (out.longRunners.total >= minLong && margin >= 0.15) out.confidence = 'moderate';
  else out.confidence = 'thin';

  out.bundle = out.verdict === 'video' ? 'research_film'
    : out.verdict === 'static' ? 'research_ad_pack'
      : 'full_launch';

  const pct = Math.round(s * 100);
  out.reason = `of the ${out.longRunners.total} ads running ${cohortDays}+ days here, ${out.longRunners.video} are video and ${out.longRunners.static} are static (${pct}% video)`;
  return out;
}

/* Meta reports the placements an ad was delivered to, which is a second, weaker
 * cut on the same question: a category that lives on Instagram behaves
 * differently from one that lives in the Facebook feed. */
function platformSplit(typed) {
  const map = {};
  for (const ad of typed) {
    for (const p of ad.platforms || []) {
      const cur = map[p] || { video: 0, static: 0 };
      cur[ad.creative]++;
      map[p] = cur;
    }
  }
  for (const [p, v] of Object.entries(map)) {
    const t = v.video + v.static;
    map[p] = { ...v, total: t, videoShare: t ? v.video / t : null };
  }
  return map;
}

/* Corpus rows, so ad snapshots accumulate into the dated history Meta itself
 * does not keep for commercial ads. Snapshotting from day one is what makes
 * `observed` durations trustworthy later. */
export function adDocs(ads) {
  return ads.map((ad) => ({
    source: 'ad', kind: 'post', externalId: ad.adId,
    channel: ad.advertiser,
    text: [ad.body, ad.cta].filter(Boolean).join(' | '),
    score: ad.daysRunning || 0,
    url: ad.libraryUrl,
    createdUtc: ad.startDate ? Math.floor(new Date(ad.startDate).getTime() / 1000) : 0,
  }));
}

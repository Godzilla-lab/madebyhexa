/*
 * Reddit voice-of-customer via Arctic Shift (public archive mirror, no auth).
 *
 * Probed live 2026-08-13, and the constraints below are measured, not assumed:
 *   - archive lag is 0 to 1 hour, so this is effectively live
 *   - `query` REQUIRES a `subreddit` or `author` scope; global search is refused
 *   - comments/search has NO `query` param -- pull by `link_id` instead
 *   - multi-word queries AND together and go empty fast
 *     ("wool runner comfort sizing" -> 0 hits, "comfort" -> plenty)
 *   - heavy queries answer {"data":null,"error":"Timeout. Maybe slow down a bit"}
 *   - `fields` works and cuts the payload ~20x, but `permalink` is NOT a field
 *
 * So the shape of a good query plan is: resolve a subreddit set first, then fire
 * MANY NARROW single-concept queries across it in parallel, then pull the comment
 * trees of whatever actually got discussed.
 */

const BASE = 'https://arctic-shift.photon-reddit.com/api';
const UA = 'hexa-validate/1.0 (+https://madebyhexa.co)';
const REQ_MS = 30000;

const POST_FIELDS = 'id,title,selftext,score,num_comments,subreddit,created_utc';
const SUB_FIELDS = 'display_name,subscribers,public_description,over18';
const COMMENT_FIELDS = 'body,score,author';

/* ── transport ─────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Arctic Shift is a free, volunteer-run service with a dynamic limit based on
 * load, so the client throttles itself rather than discovering the limit the
 * hard way. Measured: firing ~60 queries at concurrency 6 earns a sustained
 * {"error":"Too many requests"} that takes minutes to clear, and every request
 * in that window silently returns nothing.
 *
 * MIN_GAP_MS serialises the actual sends; the concurrency pools above it just
 * control how many are queued. On a rate-limit signal the gap widens for the
 * whole client and decays back down, so one hot spell does not poison the run.
 */
const MIN_GAP_MS = 220;
const MAX_GAP_MS = 4000;
let currentGap = MIN_GAP_MS;
let sendChain = Promise.resolve();

function scheduled(fn) {
  const run = sendChain.then(async () => {
    await sleep(currentGap);
    return fn();
  });
  // Keep the chain alive even when a link rejects.
  sendChain = run.then(() => {}, () => {});
  return run;
}

function penalise() {
  currentGap = Math.min(MAX_GAP_MS, Math.max(currentGap * 2, 600));
}
function relax() {
  currentGap = Math.max(MIN_GAP_MS, currentGap * 0.8);
}

/* Overload has three spellings here: HTTP 429, a 200 body of
 * {"error":"Timeout. Maybe slow down a bit"}, and {"error":"Too many requests"}.
 * All three mean back off. A parameter error means stop. */
const isOverload = (s) => /timeout|slow down|too many requests|rate/i.test(s || '');

async function get(path, params, tries = 4) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${path}?${qs}`;

  for (let attempt = 0; attempt < tries; attempt++) {
    const outcome = await scheduled(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQ_MS);
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
        if (res.status === 429) return { retry: true };
        if (!res.ok) return { data: [] };
        const body = await res.json();
        if (body.error) {
          return isOverload(body.error) ? { retry: true } : { data: [] };
        }
        return { data: body.data || [] };
      } catch {
        return { retry: true };
      } finally {
        clearTimeout(timer);
      }
    });

    if (!outcome.retry) {
      relax();
      return outcome.data;
    }
    penalise();
    // Jitter so parallel workers do not all come back at the same instant.
    await sleep(currentGap * (attempt + 1) + Math.random() * 400);
  }
  return [];
}

/* Exposed so the CLI can report whether it got throttled during a run. */
export function throttleState() {
  return { gapMs: Math.round(currentGap), throttled: currentGap > MIN_GAP_MS };
}

/* Bounded-concurrency map. Arctic Shift is free and we want to stay a good
 * citizen, so this caps in-flight requests rather than firing everything. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ── stage 1: which subreddits ─────────────────────────────────── */

/*
 * Prefix search is the only discovery Arctic Shift offers, and it matches on
 * NAME not topic, so it returns false friends (a "shoe" probe surfaces
 * r/Shoestring, a budget-travel sub). Caller filters for relevance; this just
 * finds candidates and gives back the size and blurb needed to judge them.
 */
export async function discoverSubreddits(terms, { perTerm = 25, minSubs = 5000 } = {}) {
  const found = new Map();

  await pool([...new Set(terms)], 4, async (term) => {
    const rows = await get('subreddits/search', {
      subreddit_prefix: term,
      limit: perTerm,
      fields: SUB_FIELDS,
    });
    for (const s of rows) {
      const name = s.display_name;
      if (!name || found.has(name)) continue;
      const subs = s.subscribers || 0;
      if (subs < minSubs) continue;
      if (s.over18) continue;
      found.set(name, {
        name,
        subscribers: subs,
        description: (s.public_description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        matchedTerm: term,
      });
    }
  });

  return [...found.values()].sort((a, b) => b.subscribers - a.subscribers);
}

/*
 * Lexical relevance gate.
 *
 * Prefix search matches NAMES, so a "men shoes" probe happily returns
 * r/mentalhealth (it starts with "men"). Measured: that one sub contributed
 * French-language domestic-violence threads to a footwear report, and because
 * every run writes to the corpus, one bad pick poisons the category's memory
 * permanently. So this runs on BOTH paths -- it is the last line of defence
 * before anything is trusted or stored, including when a model did the picking.
 *
 * Deliberately lexical, not semantic: it is free, it is deterministic, and the
 * failure it catches is itself lexical.
 */
export function relevanceScore(sub, categoryTerms) {
  const hay = `${sub.name} ${sub.description}`.toLowerCase();
  const terms = [...new Set(
    categoryTerms
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  )];
  if (!terms.length) return { hits: 0, ratio: 0, matched: [] };

  const matched = terms.filter(
    // Whole-word-ish: "men" must not match "mental", but "shoe" may match "shoes".
    (term) => new RegExp(`\\b${term}`, 'i').test(hay)
  );
  return { hits: matched.length, ratio: matched.length / terms.length, matched };
}

/*
 * Keep a subreddit if it matches AT LEAST ONE meaningful category term.
 *
 * This used to require a ratio of the terms (20%), which quietly inverted the
 * gate's purpose: the better the planner got at generating terms, the more
 * terms there were, and the harder it became for any single subreddit to clear
 * the bar. Measured on a real run, "men's workout T-shirts" dropped r/Fitness,
 * r/GYM, r/bodybuilding and r/malefashionadvice -- the four best communities in
 * the category -- and mined only r/Gymshark, because each matched one term out
 * of many and one-of-many is below a fifth.
 *
 * An absolute threshold is the right shape because the failure this gate exists
 * to stop is total non-overlap, not partial overlap. r/mentalhealth surfacing
 * on a "men shoes" probe matches ZERO terms once short words are filtered out,
 * so it is still caught, while a genuinely on-topic community that matches one
 * strong term now survives.
 */
export function filterRelevant(subs, categoryTerms, { minHits = 1 } = {}) {
  const kept = [];
  const dropped = [];
  for (const s of subs) {
    const { hits, ratio, matched } = relevanceScore(s, categoryTerms);
    const row = { ...s, relevance: ratio, hits, matched };
    (hits >= minHits ? kept : dropped).push(row);
  }
  // Strongest topical overlap first, so a truncated pick keeps the best.
  kept.sort((a, b) => b.hits - a.hits || b.subscribers - a.subscribers);
  return { kept, dropped };
}

/* ── stage 2: what got said ────────────────────────────────────── */

function permalink(post) {
  return `https://reddit.com/r/${post.subreddit}/comments/${post.id}/`;
}

/*
 * Cross-product of subreddits x single-concept queries, run in parallel and
 * deduped by post id. `afterDays` scopes recency; pass 0 for all time.
 */
export async function searchPosts(subreddits, queries, {
  limit = 25,
  afterDays = 540,
  minComments = 2,
  concurrency = 4,
} = {}) {
  const jobs = [];
  for (const sub of subreddits) {
    for (const q of queries) jobs.push({ sub, q });
  }

  const after = afterDays > 0
    ? Math.floor(Date.now() / 1000) - afterDays * 86400
    : null;

  const seen = new Map();
  await pool(jobs, concurrency, async ({ sub, q }) => {
    const params = { subreddit: sub, query: q, limit, fields: POST_FIELDS };
    if (after) params.after = after;
    const rows = await get('posts/search', params);
    for (const p of rows) {
      if (!p.id || seen.has(p.id)) continue;
      if ((p.num_comments || 0) < minComments) continue;
      seen.set(p.id, {
        id: p.id,
        subreddit: p.subreddit,
        title: p.title || '',
        body: (p.selftext || '').slice(0, 1200),
        score: p.score || 0,
        comments: p.num_comments || 0,
        created: p.created_utc || 0,
        url: permalink(p),
        matchedQuery: q,
      });
    }
  });

  return [...seen.values()].sort(
    (a, b) => (b.score + b.comments * 2) - (a.score + a.comments * 2)
  );
}

/* ── stage 3: the actual voice of the customer ─────────────────── */

/*
 * The comment tree is where the real language lives -- the post is the topic,
 * the comments are the opinions. `link_id` needs the t3_ prefix.
 */
export async function fetchComments(postIds, { perPost = 60, concurrency = 3, minChars = 40 } = {}) {
  const results = await pool(postIds, concurrency, async (id) => {
    const rows = await get('comments/search', {
      link_id: `t3_${id}`,
      limit: perPost,
      fields: COMMENT_FIELDS,
    });
    return rows
      .filter((c) => {
        const b = (c.body || '').trim();
        if (b.length < minChars) return false;
        if (b === '[removed]' || b === '[deleted]') return false;
        // Automod and bot boilerplate is noise, never signal.
        if (/I am a bot|automatically removed|contact the moderators/i.test(b)) return false;
        return true;
      })
      .map((c) => ({
        postId: id,
        body: c.body.replace(/\s+/g, ' ').trim().slice(0, 900),
        score: c.score || 0,
        author: c.author || '',
      }))
      .sort((a, b) => b.score - a.score);
  });

  return results.flat();
}

/* Convenience: how much conversation exists at all. Cheap, and it is what the
 * "instant read" stat tile shows before any LLM runs. */
export function corpusStats(posts, comments) {
  const subs = new Set(posts.map((p) => p.subreddit));
  const newest = posts.reduce((m, p) => Math.max(m, p.created || 0), 0);
  return {
    posts: posts.length,
    comments: comments.length,
    subreddits: subs.size,
    subredditList: [...subs],
    newestUnix: newest,
  };
}

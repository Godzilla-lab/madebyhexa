#!/usr/bin/env node
/*
 * Hexa Validate -- Phase 1 CLI.
 *
 *   node research/validate.mjs <product-url> [options]
 *
 *   --out <file>     write the report here (default research/out/<slug>.md)
 *   --subs <n>       how many subreddits to mine        (default 6)
 *   --posts <n>      how many posts to read comments on (default 18)
 *   --youtube        also mine YouTube comments (slow: yt-dlp, ~30s/video)
 *   --json           also write the raw evidence corpus as .json
 *   --quiet          less console noise
 *
 * The point of this phase is to judge the OUTPUT, not to ship a surface. If the
 * report it writes is not obviously worth money, nothing downstream matters.
 *
 * Anti-fabrication: the model never writes a quote. It cites evidence by id,
 * and renderCitation() resolves those ids against the real corpus. An id that
 * does not exist is dropped, so a hallucinated quote cannot reach the page.
 */

import './lib/env.mjs';         // must run before any module reads a key

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveProduct, unlockerConfigured } from './lib/product.mjs';
import { discoverSubreddits, searchPosts, fetchComments, corpusStats, throttleState, filterRelevant } from './lib/reddit.mjs';
import * as youtube from './lib/youtube.mjs';
import { ask, askAll, configured as llmConfigured, WORKER, SYNTH, providerLabel } from './lib/llm.mjs';
import { createCostMeter } from './lib/cost.mjs';
/*
 * Document builders come from docs.mjs, which has no database dependency.
 *
 * openCorpus is NOT imported here on purpose. It lives in corpus.mjs, which
 * imports node:sqlite at module scope, and this file is also imported by the
 * Netlify worker for its schemas and helpers. A static import would drag
 * SQLite into that function bundle (measured 2026-08-14: node:sqlite appeared
 * in report-build-background.zip), where it is never used, is an experimental
 * Node API, and would take the whole function down at cold start on any
 * runtime that does not ship it. The CLI loads it dynamically instead, at the
 * one point it actually needs a local corpus.
 */
import { redditDocs, youtubeDocs } from './lib/docs.mjs';
import { findCompetitorAds, adDocs, backend as adsBackend, formatVerdict } from './lib/ads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── args ──────────────────────────────────────────────────────── */

function parseArgs(argv) {
  /*
   * Defaults are deliberately wide. Reddit retrieval is free and every record
   * is written to the corpus once and reused forever, so a wider first pass
   * costs one slow cold run and pays back on every warm run after it. The whole
   * argument of the report is weight of evidence, and you cannot weigh what you
   * never pulled.
   */
  const opt = { subs: 10, posts: 45, youtube: false, json: false, quiet: false, out: '', fresh: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fresh') opt.fresh = true;
    // Ads are the only metered leg in a run, so testing the free half of the
    // pipeline should not have to spend the ad budget to do it.
    else if (a === '--no-ads') opt.ads = false;
    else if (a === '--youtube') opt.youtube = true;
    else if (a === '--json') opt.json = true;
    else if (a === '--quiet') opt.quiet = true;
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--subs') opt.subs = Number(argv[++i]) || opt.subs;
    else if (a === '--posts') opt.posts = Number(argv[++i]) || opt.posts;
    else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    else rest.push(a);
  }
  opt.url = rest[0];
  return opt;
}

const slug = (s) =>
  (s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/* ── schemas ───────────────────────────────────────────────────── */

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    product_name: { type: 'string' },
    category: { type: 'string', description: 'Plain-language category, e.g. "magnesium supplements"' },
    subreddit_terms: {
      type: 'array', items: { type: 'string' },
      description: 'Single words to prefix-search for subreddits. Name fragments, not topics. 4 to 8.',
    },
    reddit_queries: {
      type: 'array', items: { type: 'string' },
      description: 'SINGLE-CONCEPT search terms, one or two words max. Multi-word queries AND together and return nothing. 8 to 14.',
    },
    youtube_queries: { type: 'array', items: { type: 'string' } },
    buyer_personas: { type: 'array', items: { type: 'string' } },
  },
  required: ['product_name', 'category', 'subreddit_terms', 'reddit_queries', 'youtube_queries', 'buyer_personas'],
  additionalProperties: false,
};

const PICK_SCHEMA = {
  type: 'object',
  properties: {
    keep: {
      type: 'array',
      items: { type: 'string' },
      description: 'Subreddit names where this product\'s actual buyers talk. Exclude name-collision false friends.',
    },
  },
  required: ['keep'],
  additionalProperties: false,
};

/*
 * A finding must be corroborated, not merely sourced.
 *
 * One person saying something is an anecdote, and an anecdote dressed up as a
 * market finding is the exact failure this engine exists to avoid. So the model
 * is asked for EVERY id it saw supporting a theme, not a token two or three,
 * and the renderer then enforces MIN_RECEIPTS independently. Asking wide here
 * is what makes the gate downstream meaningful: a theme that only ever had two
 * mentions cannot pass it no matter how confidently it is written.
 */
const finding = (extra = {}) => ({
  type: 'object',
  properties: {
    claim: { type: 'string', description: 'One sentence, in plain language.' },
    evidence_ids: {
      type: 'array', items: { type: 'string' },
      description:
        'EVERY id from the evidence list that supports this, not a sample. Use ONLY ids you were ' +
        'given. Report a theme only if several different people raised it independently; if you ' +
        'can cite fewer than three ids, the theme is an anecdote and does not belong here.',
    },
    ...extra,
  },
  required: ['claim', 'evidence_ids', ...Object.keys(extra)],
  additionalProperties: false,
});

/* How many independent receipts a claim needs before it is stated as a finding.
 * Below this it is a lead, not a conclusion. */
const MIN_RECEIPTS = 3;

const READ_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'One paragraph: is there real demand, and what should they lead with.' },
    demand_signal: { type: 'string', enum: ['strong', 'moderate', 'weak', 'unclear'] },
    pains: { type: 'array', items: finding() },
    wishes: { type: 'array', items: finding() },
    objections: { type: 'array', items: finding() },
  },
  required: ['verdict', 'demand_signal', 'pains', 'wishes', 'objections'],
  additionalProperties: false,
};

/*
 * An angle has to arrive ready to become a real order, in either format.
 *
 * `hook` feeds the video path (custom hook + selections.directions, both already
 * consumed by render-create.js). `headline` feeds the static path: Product
 * Photoshoot reads selections.directions as free text and runs it through
 * hf.photoshootEnhance, so no new schema is needed there either.
 *
 * `format` is inherited from the deterministic format verdict rather than
 * invented per angle -- the model is told which format the category's winners
 * use, and does not get to overrule the arithmetic.
 */
const ANGLES_SCHEMA = {
  type: 'object',
  properties: {
    angles: {
      type: 'array',
      items: finding({
        hook: { type: 'string', description: 'The opening line of the video, in the customer\'s own register. How a person talks, not how a brand writes.' },
        headline: { type: 'string', description: 'The primary on-image line if this runs as a static ad. Short enough to read at a glance.' },
        format: { type: 'string', enum: ['video', 'static', 'both'], description: 'Use the format verdict you were given. Do not overrule it.' },
        persona: { type: 'string', description: 'Who specifically this is aimed at, as a person, not a segment.' },
        why_it_works: { type: 'string' },
      }),
    },
  },
  required: ['angles'],
  additionalProperties: false,
};

/* ── heuristic fallback planner ────────────────────────────────── */

const STOP = new Set(
  ('the a an and or for with without your our this that these those from into out ' +
   'best new buy shop sale free size color colour pack set of in on at to by is are ' +
   'it its as be all more most you we they i'
  ).split(/\s+/)
);

/*
 * Used when there is no model available. Nowhere near as good as the planner --
 * it cannot tell a category from a brand name -- but it keeps the retrieval
 * layer independently runnable and testable, which is worth a lot on its own.
 */
function heuristicPlan(product) {
  const words = `${product.title} ${product.type} ${product.tags.join(' ')}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

  const uniq = [...new Set(words)];
  const terms = uniq.slice(0, 6);

  return {
    product_name: product.title,
    category: uniq.slice(0, 3).join(' ') || 'unknown',
    subreddit_terms: terms,
    reddit_queries: [...new Set([...terms, 'recommend', 'worth it', 'quality', 'sizing', 'returned'])].slice(0, 12),
    youtube_queries: [`${product.title} review`],
    buyer_personas: [],
    _heuristic: true,
  };
}

/* ── evidence index ────────────────────────────────────────────── */

/*
 * Build an id -> record map the model cites against. Ids are short and stable
 * (c12, p3) so they are cheap in tokens and easy to validate on the way back.
 */
/*
 * Takes normalised records so the live path and the corpus path build the same
 * index: { kind, text, sub, score, url }. Ids are short and stable (c12, p3) so
 * they are cheap in tokens and easy to validate on the way back.
 */
function buildEvidence(records) {
  const index = new Map();
  const lines = [];
  const counters = { post: 0, comment: 0, youtube: 0, review: 0 };
  const prefix = { post: 'p', comment: 'c', youtube: 'y', review: 'v' };

  for (const r of records) {
    if (!r.text) continue;
    const kind = r.kind === 'post' ? 'post'
      : r.source === 'youtube' ? 'youtube'
      : r.source === 'reviews' ? 'review'
      : 'comment';
    const id = `${prefix[kind]}${counters[kind]++}`;
    /*
     * source rides along so the renderer can attribute a quote correctly. A
     * review is not a forum comment and must never be drawn as one: the reader
     * is being asked to trust these receipts, and "r/" in front of something a
     * customer wrote on their own product page would be a lie in the one place
     * this product cannot afford one.
     */
    const rec = {
      id, kind, text: r.text, sub: r.sub || '',
      score: r.score || 0, url: r.url || '', source: r.source || '',
    };
    index.set(id, rec);
    const where = kind === 'youtube' ? `youtube ${rec.score} likes`
      : kind === 'review' ? 'review on the product page'
      : `r/${rec.sub} ${rec.score}pts`;
    lines.push(`${id} [${where}] ${rec.text}`);
  }

  return { index, lines };
}

/* Live retrieval shapes -> the normalised record shape above. */
function normaliseLive(posts, comments, ytComments) {
  const out = [];
  for (const p of posts) {
    out.push({ kind: 'post', source: 'reddit', text: p.title, sub: p.subreddit, score: p.score, url: p.url });
  }
  for (const c of comments) {
    const post = posts.find((p) => p.id === c.postId);
    out.push({
      kind: 'comment', source: 'reddit', text: c.body,
      sub: post ? post.subreddit : '', score: c.score, url: post ? post.url : '',
    });
  }
  for (const c of ytComments) {
    out.push({
      kind: 'comment', source: 'youtube', text: c.body,
      sub: c.videoTitle, score: c.likes, url: `https://www.youtube.com/watch?v=${c.videoId}`,
    });
  }
  return out;
}

/* Corpus rows -> the same normalised record shape. */
function normaliseCorpus(rows) {
  return rows.map((r) => ({
    kind: r.kind, source: r.source,
    text: r.kind === 'post' ? String(r.text).split('\n')[0] : r.text,
    sub: r.channel, score: r.score, url: r.url,
  }));
}

/* Resolve cited ids to real records, dropping anything invented. */
function resolveCitations(ids, index) {
  const out = [];
  for (const id of ids || []) {
    const rec = index.get(String(id).trim());
    if (rec) out.push(rec);
  }
  return out;
}

/* ── report rendering ──────────────────────────────────────────── */

/*
 * House style: no em dashes, no en dashes, anywhere in copy we author.
 *
 * Models reach for them constantly, so this is enforced at the render layer
 * rather than asked for in a prompt and hoped for. Applied ONLY to text the
 * model wrote (claims, hooks, headlines, the verdict). Quoted evidence is
 * never touched: a quote that has been tidied is no longer a quote, and the
 * whole report rests on the quotes being exactly what the person said.
 */
function voice(s) {
  return String(s || '')
    // A dash between numbers is a range, not punctuation: "$10-$20" must become
    // "$10 to $20", never "$10, $20", which would change what the sentence says.
    .replace(/(\d)\s*[—–]\s*(\$?\d)/g, '$1 to $2')
    .replace(/\s*[—–]\s*/g, ', ')             // otherwise it is an aside: use a comma
    .replace(/,\s*,/g, ',')                   // no doubled commas
    .replace(/\s+([,.!?;:])/g, '$1')          // no space before punctuation
    .replace(/([,;:])\s*,/g, '$1')
    .trim();
}

function quoteBlock(rec) {
  const text = rec.text.length > 320 ? `${rec.text.slice(0, 317)}...` : rec.text;
  const where = rec.kind === 'youtube'
    ? `YouTube, ${rec.score} likes`
    : `r/${rec.sub}, ${rec.score} points`;
  return `> ${text}\n>\n> [${where}](${rec.url})`;
}

/*
 * Competitor ads, ranked by how long they have been running.
 *
 * The ordering IS the insight: nobody keeps paying to run an ad that does not
 * convert, so the top of this list is what the market has already proven. The
 * bar is a length-and-opacity cue rather than a new colour scale, so a 180-day
 * ad reads instantly against a 4-day one without breaking the single-accent
 * brand. Ads with no evidenced date show no duration at all -- that is the
 * date rule, enforced at the render layer.
 */
function renderAds(ads) {
  if (!ads) return '';
  if (!ads.ads.length) {
    const why = ads.reason || (ads.errors && ads.errors[0]);
    return why
      ? `## Who is advertising and what is working\n\nNot available on this run: ${why}\n`
      : '';
  }

  const evidenced = ads.ads.filter((a) => a.durationConfidence !== 'none');
  const longest = Math.max(...evidenced.map((a) => a.daysRunning || 0), 1);

  const parts = ['## Who is advertising and what is working\n'];
  parts.push(
    'Sorted by how long each ad has been running. Nobody keeps paying to run an ad that ' +
    'does not convert, so the ads at the top are the ones the market has already proven.\n'
  );

  for (const ad of evidenced.slice(0, 10)) {
    const filled = Math.max(1, Math.round((ad.daysRunning / longest) * 24));
    const bar = '█'.repeat(filled) + '·'.repeat(24 - filled);
    const conf = ad.durationConfidence === 'observed' ? ' (still live)' : '';
    parts.push(
      `**${ad.advertiser || 'Unknown advertiser'}** · ${ad.isVideo ? 'video' : 'image'}` +
      `${ad.landingDomain ? ` · ${ad.landingDomain}` : ''}\n\n` +
      `\`${bar}\` **${ad.daysRunning} days**${conf}${ad.startDate ? ` · since ${ad.startDate}` : ''}\n`
    );
    if (ad.body) parts.push(`> ${ad.body.slice(0, 300)}\n`);
    parts.push(`[View in Ad Library](${ad.libraryUrl})\n`);
  }

  const undated = ads.ads.length - evidenced.length;
  if (undated) {
    parts.push(`\n*${undated} more ads found without a verifiable run date, so no duration is claimed for them.*\n`);
  }

  if (ads.advertisers?.length) {
    parts.push('\n### Who is burning through creative\n');
    parts.push('Many launch dates means they are replacing ads constantly. That is a real budget, and it is the exact pain this studio removes.\n');
    parts.push('| Advertiser | Ads live | Launch dates | Longest run |\n|---|---|---|---|');
    for (const g of ads.advertisers.slice(0, 6)) {
      parts.push(`| ${g.advertiser || '?'} | ${g.ads} | ${g.distinctStarts} | ${g.longestRun ? `${g.longestRun}d` : 'unknown'} |`);
    }
    parts.push('');
  }

  return `${parts.join('\n')}\n`;
}

/*
 * Two rules run here, and the second is the one that makes the report worth
 * paying for.
 *
 *   no receipt, no claim   -- an id the model invented resolves to nothing and
 *                             the finding disappears with it
 *   no corroboration,      -- a claim carried by one or two voices is an
 *   no conclusion             anecdote. It is held back as a weak signal and
 *                             labelled as one, never printed as a finding
 *
 * Findings are ordered by how many people independently raised them, so the
 * strongest-evidenced theme leads. The corroboration line is printed on every
 * finding because it is also the persuasion: "31 people across 5 communities"
 * is a harder claim to wave away than a single well-chosen quote.
 */
function renderSection(title, items, index, { note = '' } = {}) {
  if (!items || !items.length) return '';

  const scored = items
    .map((item) => {
      const cites = resolveCitations(item.evidence_ids, index);
      const communities = new Set(cites.map((c) => c.sub).filter(Boolean));
      return { item, cites, communities };
    })
    .filter((f) => f.cites.length > 0)
    .sort((a, b) => b.cites.length - a.cites.length);

  const strong = scored.filter((f) => f.cites.length >= MIN_RECEIPTS);
  const weak = scored.filter((f) => f.cites.length < MIN_RECEIPTS);
  if (!strong.length && !weak.length) return '';

  const parts = [`## ${title}\n`];
  if (note) parts.push(`${note}\n`);

  strong.forEach((f, i) => {
    const { item, cites, communities } = f;
    parts.push(`### ${i + 1}. ${voice(item.claim)}\n`);
    parts.push(
      `*${cites.length} people raised this independently` +
      `${communities.size > 1 ? ` across ${communities.size} communities` : ''}.*\n`
    );
    if (item.persona) parts.push(`**Who it is for:** ${voice(item.persona)}\n`);
    if (item.why_it_works) parts.push(`${voice(item.why_it_works)}\n`);
    if (item.hook) parts.push(`**Video hook:** "${voice(item.hook)}"\n`);
    if (item.headline) parts.push(`**Static headline:** "${voice(item.headline)}"\n`);
    if (item.format) parts.push(`**Run it as:** ${item.format}\n`);
    // Show the highest-scoring receipts; the count above carries the rest.
    const best = [...cites].sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const c of best.slice(0, 3)) parts.push(`${quoteBlock(c)}\n`);
  });

  if (weak.length) {
    parts.push('**Weaker signals**\n');
    parts.push(
      `Raised by fewer than ${MIN_RECEIPTS} people each, so treat these as leads to watch ` +
      'rather than conclusions to act on.\n'
    );
    for (const f of weak) {
      parts.push(`- ${voice(f.item.claim)} *(${f.cites.length} mention${f.cites.length === 1 ? '' : 's'})*`);
    }
    parts.push('');
  }

  return `${parts.join('\n')}\n`;
}

/*
 * Video or static? This is the section that tells the buyer which format to run,
 * and it is pure arithmetic -- no model writes these numbers.
 *
 * The raw split is shown for contrast only. The call follows the long-runners,
 * because an ad that has been paid for continuously for 90 days is evidence and
 * a freshly launched one is not. Below the sample gate there is no verdict, and
 * saying so is a real answer rather than a failure.
 */
function renderFormatVerdict(fv) {
  if (!fv || !fv.sample.typed) return '';

  const parts = ['## Video or static?\n'];
  const pct = (n) => (n === null ? '?' : `${Math.round(n * 100)}%`);

  if (!fv.verdict) {
    parts.push(`We are not calling a format for this category yet: ${fv.reason}.\n`);
    parts.push(
      `What we do have: ${fv.raw.video} video and ${fv.raw.static} static ads ` +
      `(${pct(fv.raw.videoShare)} video) out of ${fv.sample.ads} found.\n`
    );
    return `${parts.join('\n')}\n`;
  }

  const winner = fv.verdict === 'both' ? 'Run both' : `Run ${fv.verdict}`;
  parts.push(`**${winner}.** Confidence: ${fv.confidence}.\n`);
  parts.push(`${fv.reason[0].toUpperCase()}${fv.reason.slice(1)}.\n`);

  const bar = (share, width = 24) => {
    const v = Math.round((share || 0) * width);
    return `${'█'.repeat(v)}${'·'.repeat(width - v)}`;
  };

  parts.push(
    '```\n' +
    `winners (${fv.longRunners.cohortDays}+ days)  ${bar(fv.longRunners.videoShare)}  ${pct(fv.longRunners.videoShare)} video  (${fv.longRunners.total} ads)\n` +
    `all ads                ${bar(fv.raw.videoShare)}  ${pct(fv.raw.videoShare)} video  (${fv.raw.total} ads)\n` +
    `days-of-spend weighted ${bar(fv.durationWeighted.videoShare)}  ${pct(fv.durationWeighted.videoShare)} video\n` +
    '```\n'
  );

  if (fv.sample.untyped) {
    parts.push(
      `*${fv.sample.untyped} ad${fv.sample.untyped === 1 ? '' : 's'} had no readable creative type and ` +
      'are excluded from these ratios rather than guessed at.*\n'
    );
  }
  return `${parts.join('\n')}\n`;
}

/* The format verdict is arithmetic, so it is handed to the angles model as a
 * fact to work within rather than a question to answer. */
function formatBrief(fv) {
  if (!fv || !fv.verdict) {
    return 'FORMAT: not enough competitor evidence to call video vs static for this category. ' +
      'Set every angle\'s format to "both" and do not claim one works better.';
  }
  return `FORMAT (measured, not your call): ${fv.reason}. The winning format here is ` +
    `"${fv.verdict}" at ${fv.confidence} confidence. Set each angle's format accordingly.`;
}

function renderReport({ product, plan, stats, read, angles, ads, formats, index, cost, timings, useMemory }) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const out = [];

  out.push(`# Validation report: ${product.title || plan?.product_name || product.url}\n`);
  out.push(`*${plan?.category || 'uncategorised'} · generated ${now} UTC*\n`);

  out.push('## What we read\n');
  out.push(
    `| | |\n|---|---|\n` +
    `| Reddit posts | ${stats.posts.toLocaleString()} |\n` +
    `| Reddit comments | ${stats.comments.toLocaleString()} |\n` +
    `| Subreddits | ${stats.subreddits} |\n` +
    `| YouTube comments | ${stats.youtube.toLocaleString()} |\n` +
    `| Product read via | \`${product.source}\` |\n`
  );
  out.push(`\nCommunities: ${stats.subredditList.map((s) => `r/${s}`).join(', ') || 'none'}\n`);
  out.push(
    useMemory
      ? '*Answered from the corpus we already hold for this category, so this run cost no scraping at all.*\n'
      : '*First look at this category, so this run harvested fresh and wrote it all to memory.*\n'
  );

  if (read?.verdict) {
    out.push(`## Verdict\n`);
    out.push(`**Demand signal: ${read.demand_signal}**\n`);
    out.push(`${voice(read.verdict)}\n`);
  }

  out.push(renderFormatVerdict(formats));

  out.push(renderSection('What people actually say', read?.pains, index));
  out.push(renderSection('What they wish existed', read?.wishes, index));
  out.push(
    renderSection('Objections you have to beat', read?.objections, index, {
      note: 'These are the reasons people give for not buying. This is the section nobody else produces.',
    })
  );
  out.push(renderAds(ads));

  out.push(
    renderSection('The angles', angles?.angles, index, {
      note: 'Each angle is backed by what real buyers said, and where possible by an ad that has been running long enough to prove it converts.',
    })
  );

  // No model available: the evidence is still the product. Show the loudest of
  // it raw rather than shipping an empty report.
  if (!read && !angles) {
    const top = [...index.values()]
      .filter((r) => r.kind !== 'post' && r.text.length > 80)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);
    if (top.length) {
      out.push('## Loudest things people said\n');
      out.push('*No synthesis in this run (no API key), so this is the raw signal, ranked by score.*\n');
      for (const rec of top) out.push(`${quoteBlock(rec)}\n`);
    }
  }

  out.push('---\n');
  out.push('## Run detail\n');
  out.push('```');
  out.push(`product resolution : ${product.trail.map((t) => `${t.tier}${t.ok ? '=ok' : t.skipped ? '=skipped' : '=miss'}`).join(' -> ')}`);
  out.push(`unlocker available : ${unlockerConfigured() ? 'yes' : 'no (set BRIGHTDATA_API_TOKEN + BRIGHTDATA_UNLOCKER_ZONE)'}`);
  out.push(`models             : ${providerLabel()}`);
  for (const [k, v] of Object.entries(timings)) out.push(`${k.padEnd(19)}: ${v}`);
  out.push(cost.report().trim());
  out.push('```');

  return out.filter(Boolean).join('\n');
}

/* ── main ──────────────────────────────────────────────────────── */

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt.url) {
    console.error('usage: node research/validate.mjs <product-url> [--subs 6] [--posts 18] [--youtube] [--json] [--out file.md]');
    process.exit(1);
  }

  const log = (...a) => { if (!opt.quiet) console.log(...a); };
  const cost = createCostMeter(opt.url);
  const timings = {};
  const t0 = Date.now();
  const mark = (k, from) => { timings[k] = `${((Date.now() - from) / 1000).toFixed(1)}s`; };

  /*
   * Assembled at runtime so the bundler cannot follow it.
   *
   * A literal dynamic import is not enough: esbuild resolves the specifier and
   * hoists the module in anyway, which put "import { DatabaseSync } from
   * node:sqlite" at the top of report-build-background's bundle (measured
   * 2026-08-14, line 83) and therefore ran it at every cold start of a worker
   * that never touches SQLite. Building the path in a variable leaves the
   * import for the runtime, where only the CLI ever reaches it.
   */
  const corpusModule = './lib/' + 'corpus.mjs';
  const { openCorpus } = await import(corpusModule);
  const corpus = openCorpus();
  const before = corpus.totals();
  log(`\n  memory: ${before.docs.toLocaleString()} records, ${before.categories} categories, ${before.reports} reports`);

  /* 1. product ------------------------------------------------- */
  let t = Date.now();
  log(`  reading ${opt.url}`);
  // A repeat URL never re-pays for unblocking.
  const cached = opt.fresh ? null : corpus.getProduct(opt.url);
  const product = cached || await resolveProduct(opt.url, cost);
  if (cached) log('    (from product cache)');
  mark('product', t);
  if (!product.title) {
    console.error('  ! could not read that page at all.');
    console.error(`    trail: ${product.trail.map((x) => `${x.tier}=${x.ok ? 'ok' : x.skipped ? 'skipped' : 'miss'}`).join(' -> ')}`);
    if (!unlockerConfigured()) {
      console.error('    tier 3 is off. Set BRIGHTDATA_API_TOKEN and BRIGHTDATA_UNLOCKER_ZONE to rescue blocked origins.');
    }
    process.exit(2);
  }
  log(`    "${product.title}"  (via ${product.source})`);

  const haveLLM = llmConfigured();
  if (!haveLLM) {
    log('  ! ANTHROPIC_API_KEY not set: running retrieval only, no synthesis.');
    log('    You still get the raw evidence, which is worth reading on its own.');
  }

  /* 2. plan ---------------------------------------------------- */
  t = Date.now();
  const plan = !haveLLM ? heuristicPlan(product) : await ask({
    model: WORKER, cost, label: 'plan', schema: PLAN_SCHEMA, maxTokens: 2000,
    system:
      'You plan market research. Given a product, work out where its buyers actually talk and what they would search for.\n' +
      'Reddit search rules you MUST respect: queries are AND-ed, so multi-word queries return nothing. ' +
      'Emit SINGLE-CONCEPT terms of one or two words. Prefer the words buyers use over marketing words. ' +
      'subreddit_terms are name fragments for a prefix search, not topics.',
    prompt:
      `Product: ${product.title}\n` +
      `Vendor: ${product.vendor || 'unknown'}\n` +
      `Type: ${product.type || 'unknown'}\n` +
      `Price: ${product.price ? `${product.price} ${product.currency}` : 'unknown'}\n` +
      `Description: ${(product.description || '').slice(0, 1200)}\n` +
      `URL: ${product.url}`,
  });
  mark('plan', t);
  if (!plan) { console.error('  ! planning failed'); process.exit(4); }
  log(`    category: ${plan.category}`);

  /* 3. is this category already warm? --------------------------- */
  const known = corpus.categoryStats(plan.category);
  const useMemory = known.warm && !opt.fresh;

  if (useMemory) {
    log(`    category is WARM: ${known.docs.toLocaleString()} docs already held, ` +
        `last harvested ${known.ageDays.toFixed(1)}d ago`);
  } else if (known.docs) {
    log(`    category seen before (${known.docs} docs) but ${opt.fresh ? 'forced fresh' : 'stale or thin'}: harvesting`);
  } else {
    log('    category is COLD: first look, going deeper');
  }

  let records = [];
  let subs = known.subreddits || [];
  let posts = [];
  let comments = [];
  let yt = { videos: [], comments: [] };

  if (useMemory) {
    /* The whole speed argument: a warm category answers from local FTS in
     * milliseconds instead of ~60 throttled HTTP round trips. */
    t = Date.now();
    const hits = new Map();
    for (const q of plan.reddit_queries) {
      for (const row of corpus.search(q, { category: plan.category, limit: 120 })) {
        hits.set(`${row.source}:${row.external_id}`, row);
      }
    }
    // Top up with the loudest of the category so a narrow query set cannot
    // starve the report.
    for (const row of corpus.byCategory(plan.category, { limit: 600 })) {
      hits.set(`${row.source}:${row.external_id}`, row);
    }
    records = normaliseCorpus([...hits.values()]);
    mark('retrieval(memory)', t);
    log(`    ${records.length} records from memory`);
  } else {
    /* 3b. subreddits ------------------------------------------- */
    t = Date.now();
    if (subs.length && !opt.fresh) {
      log(`    reusing remembered subreddits: ${subs.map((s) => `r/${s}`).join(', ')}`);
    } else {
      const candidates = await discoverSubreddits(plan.subreddit_terms, { perTerm: 25, minSubs: 5000 });
      log(`    found ${candidates.length} candidate subreddits`);

      const picked = !haveLLM ? null : await ask({
        model: WORKER, cost, label: 'pick-subs', schema: PICK_SCHEMA, maxTokens: 1200,
        system:
          'Pick the subreddits where this product\'s real buyers talk. Prefix search matches NAMES, so the list ' +
          'contains false friends (a "shoe" search surfaces r/Shoestring, a budget travel sub). Exclude those. ' +
          'Prefer communities about the product category or the problem it solves. Return names exactly as given.',
        prompt:
          `Product: ${product.title}\nCategory: ${plan.category}\n\nCandidates:\n` +
          candidates.slice(0, 60).map((s) => `${s.name} (${s.subscribers.toLocaleString()}) ${s.description}`).join('\n'),
      });

      const chosen = (picked?.keep || [])
        .map((n) => candidates.find((c) => c.name.toLowerCase() === String(n).toLowerCase()))
        .filter(Boolean);

      // The relevance gate runs on the model's picks too, not just the
      // heuristic ones. Everything here gets written to the corpus, and one bad
      // sub poisons a category's memory for good.
      const pool = chosen.length ? chosen : candidates;
      const terms = [plan.category, ...plan.subreddit_terms];
      const { kept, dropped } = filterRelevant(pool, terms);
      if (dropped.length) {
        log(`    dropped as off-topic: ${dropped.slice(0, 6).map((s) => `r/${s.name}`).join(', ')}`);
      }
      subs = (kept.length ? kept : pool.slice(0, opt.subs)).slice(0, opt.subs).map((s) => s.name);

      if (!kept.length) {
        log('    ! nothing passed the relevance gate; the category terms are probably wrong');
      }
    }
    mark('subreddits', t);
    log(`    mining ${subs.map((s) => `r/${s}`).join(', ')}`);

    /* 4. retrieval (the parallel part) --------------------------- */
    t = Date.now();
    posts = await searchPosts(subs, plan.reddit_queries, { limit: 40, minComments: 2 });
    log(`    ${posts.length} discussed posts`);

    const topPosts = posts.slice(0, opt.posts);
    [comments, yt] = await Promise.all([
      fetchComments(topPosts.map((p) => p.id), { perPost: 100 }),
      opt.youtube
        ? youtube.mineCategory(plan.youtube_queries.slice(0, 2), { maxVideos: 4, commentsPerVideo: 80 })
        : Promise.resolve({ videos: [], comments: [] }),
    ]);
    mark('retrieval', t);
    log(`    ${comments.length} reddit comments, ${yt.comments.length} youtube comments`);

    if (throttleState().throttled) {
      log(`    (arctic shift throttled us; backed off to ${throttleState().gapMs}ms between calls)`);
    }

    /* Write what we just learned into memory, so this is the last time we
     * pay for it. This is the whole point of the corpus. */
    const added = corpus.addDocs(
      [...redditDocs(posts, comments), ...youtubeDocs(yt.comments)],
      plan.category
    );
    corpus.rememberCategory(plan.category, { subreddits: subs, queries: plan.reddit_queries });
    log(`    remembered ${added.toLocaleString()} new records for "${plan.category}"`);

    records = normaliseLive(topPosts, comments, yt.comments);
  }

  if (!records.length) {
    console.error('  ! no conversation found. The category terms are probably too narrow.');
    process.exit(5);
  }

  /* 4b. competitor ads ------------------------------------------ */
  // Runs regardless of warm/cold: ad creative turns over constantly, so a
  // cached ad set goes stale far faster than voice-of-customer does.
  t = Date.now();
  let ads = { ads: [], advertisers: [], backend: adsBackend(), errors: [] };
  let formats = null;
  if (opt.ads !== false) {
    ads = await findCompetitorAds(
      [plan.category, ...(plan.reddit_queries || []).slice(0, 2)],
      { limit: 40, maxQueries: 2 },
      cost
    );
    if (ads.ads.length) {
      corpus.addDocs(adDocs(ads.ads), plan.category);
      const evidenced = ads.ads.filter((a) => a.durationConfidence !== 'none');
      log(`    ${ads.ads.length} competitor ads, ${evidenced.length} with evidenced run dates`);
      formats = formatVerdict(ads.ads);
      log(formats.verdict
        ? `    format verdict: ${formats.verdict} (${formats.confidence}) -- ${formats.reason}`
        : `    format verdict: none -- ${formats.reason}`);
    } else if (ads.reason) {
      log(`    competitor ads skipped: ${ads.reason}`);
    } else if (ads.errors?.length) {
      log(`    competitor ads unavailable: ${ads.errors[0]}`);
    }
  }
  mark('ads', t);

  /* 5. synthesis (sections in parallel) ------------------------- */
  t = Date.now();
  const stats = useMemory
    ? {
        posts: records.filter((r) => r.kind === 'post').length,
        comments: records.filter((r) => r.kind !== 'post').length,
        subreddits: new Set(records.map((r) => r.sub).filter(Boolean)).size,
        subredditList: [...new Set(records.map((r) => r.sub).filter(Boolean))].slice(0, 12),
        youtube: records.filter((r) => r.source === 'youtube').length,
      }
    : { ...corpusStats(posts, comments), youtube: yt.comments.length };
  const { index, lines } = buildEvidence(records);
  /* Send the whole corpus we hold, not a sample of it. The corroboration gate
   * counts how many people raised a theme, so truncating the evidence would
   * quietly truncate the counts that the gate and the report both depend on.
   * Both frontier models here take 1M-token context; this cap is well inside it. */
  const evidence = lines.slice(0, 2500).join('\n').slice(0, 600000);

  const shared =
    `PRODUCT: ${product.title}\nCATEGORY: ${plan.category}\n` +
    `WHAT IT IS: ${(product.description || '').slice(0, 700)}\n\n` +
    `EVIDENCE (cite by the id at the start of each line, e.g. c12):\n${evidence}`;

  /*
   * Rule 2 is the one doing the real work. The model is told to weigh, not to
   * sample: a theme earns its place by how many DIFFERENT people raised it, and
   * every supporting id must be listed because the renderer counts them to
   * decide whether the claim is a finding or a weak signal.
   */
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

  const [read, angles] = !haveLLM ? [null, null] : await askAll([
    {
      model: SYNTH, cost, label: 'read', schema: READ_SCHEMA, maxTokens: 8000, effort: 'high',
      system:
        'You read voice-of-customer evidence and report what the market actually says. You are blunt and specific. ' +
        'The objections section matters most: the reasons people give for NOT buying are the hardest signal to get ' +
        'anywhere else, and they are what the marketing has to beat.\n' + rules,
      prompt: `${shared}\n\nGive the verdict, the ranked pains, the unmet wishes, and the objections.`,
    },
    {
      model: SYNTH, cost, label: 'angles', schema: ANGLES_SCHEMA, maxTokens: 8000, effort: 'high',
      system:
        'You turn voice-of-customer evidence into ad angles. An angle is a specific claim aimed at a specific ' +
        'buyer, in their register, that the evidence supports. Reject generic marketing angles that any competitor ' +
        'could run. Write hooks the way a real person talks, not the way a brand writes.\n' + rules,
      prompt:
        `${shared}\n\n${formatBrief(formats)}\n\n` +
        'Give 3 to 5 angles, strongest first. For each one write both a video hook and a static headline, ' +
        'so the angle can run in either format.',
    },
  ]);
  mark('synthesis', t);
  timings.total = `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  /* 6. write ---------------------------------------------------- */
  const md = renderReport({ product, plan, stats, read, angles, ads, formats, index, cost, timings, useMemory });
  const outDir = path.join(HERE, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = opt.out || path.join(outDir, `${slug(product.title)}.md`);
  fs.writeFileSync(outPath, md);

  // Reports are memory too: the next product in this category starts here.
  // Cache under the URL the user pasted as well as the one we landed on, or a
  // redirect makes every repeat run miss the cache and re-pay for resolution.
  corpus.cacheProduct(product, plan.category);
  if (product.url !== opt.url) corpus.cacheProduct({ ...product, url: opt.url }, plan.category);
  corpus.saveReport({
    productUrl: product.url,
    productTitle: product.title,
    category: plan.category,
    markdown: md,
    findings: { read, angles },
    costUsd: cost.total(),
  });

  if (opt.json) {
    const jsonPath = outPath.replace(/\.md$/, '') + '.evidence.json';
    fs.writeFileSync(jsonPath, JSON.stringify({ product, plan, stats, posts: topPosts, comments, youtube: yt, read, angles, cost: cost.toJSON() }, null, 2));
    log(`    evidence -> ${path.relative(process.cwd(), jsonPath)}`);
  }

  const after = corpus.totals();
  corpus.close();

  log(cost.report());
  log(`  memory now: ${after.docs.toLocaleString()} records (+${(after.docs - before.docs).toLocaleString()})`);
  log(`\n  report -> ${path.relative(process.cwd(), outPath)}  (${timings.total})\n`);
}

/*
 * Run main() only when this file IS the command being run.
 *
 * Without this guard, importing anything from here executes the whole CLI:
 * it would open the local SQLite corpus, write a markdown file and call
 * process.exit. The serverless report worker needs the schemas and the pure
 * rendering helpers below, and reusing them is the only way the two paths
 * cannot drift into producing different reports for the same product.
 */
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    console.error(`\nfailed: ${e.message}\n`);
    process.exit(1);
  });
}

/*
 * The pure half: schemas, normalisation and rendering. No IO, no corpus, no
 * network, so both the CLI and the background worker can share them.
 */
export {
  PLAN_SCHEMA,
  PICK_SCHEMA,
  READ_SCHEMA,
  ANGLES_SCHEMA,
  heuristicPlan,
  buildEvidence,
  normaliseLive,
  normaliseCorpus,
  resolveCitations,
  voice,
  renderReport,
  renderFormatVerdict,
  formatBrief,
};

/*
 * Dev fixture server: the site, plus fake versions of the Netlify functions.
 *
 * The studio and the report renderer are the two hardest things in this repo to
 * look at, because both only exist after a backend call. The report needs a
 * finished research run (about $0.62 and a couple of minutes of real spend) and
 * the studio needs a live product-peek. That made every change to either one a
 * guess, which is how the home page ended up quoting prices the code disagreed
 * with.
 *
 * So: one server, no dependencies, serving the real files with stubbed
 * endpoints behind them. Everything downstream is the real thing. The only
 * fiction is the data.
 *
 *   node tools/devstub.mjs              -> http://localhost:8901
 *   node tools/devstub.mjs --port 9000
 *
 * Flip what the stub returns without restarting, which is the point of doing
 * this as a server rather than as fixtures inside the test driver:
 *
 *   /__stub/full        signed-in report: angles, competitor ads, whitespace
 *   /__stub/anon        anonymous report: angles, NO competitor legs
 *   /__stub/building    never finishes, so the progress UI can be watched
 *   /__stub             what mode am I in
 *
 * Never deployed: _redirects blocks /tools/* with a forced 301. Nothing here
 * should ever be imported by production code.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8901;

/* One mutable knob. A restart per scenario is the kind of friction that stops
 * anyone checking the anonymous case at all, which is exactly the case that was
 * broken. */
let MODE = 'full';

/* ── the fixture ──────────────────────────────────────────────
 *
 * Shaped exactly like a real stored payload, because the renderer resolves
 * evidence by id and silently drops anything it cannot find. A fixture that
 * cheats here would hide the one bug the id-resolution is there to catch.
 */

const EVIDENCE = {
  c1: { text: 'Cleaning the thing takes longer than making the smoothie. I stopped using mine after a month.',
        sub: 'BuyItForLife', url: 'https://reddit.com/r/BuyItForLife/comments/x1/', score: 214 },
  c2: { text: 'Honestly the only blender I still use is the one I can rinse in ten seconds. Everything else lives in the cupboard.',
        sub: 'Cooking', url: 'https://reddit.com/r/Cooking/comments/x2/', score: 168 },
  c3: { text: 'Six parts to wash. Six. For one drink.',
        sub: 'Frugal', url: 'https://reddit.com/r/Frugal/comments/x3/', score: 133 },
  c4: { text: 'Bought one off a TikTok ad and the motor died in five weeks. Never again without reviews.',
        sub: 'BuyItForLife', url: 'https://reddit.com/r/BuyItForLife/comments/x4/', score: 97 },
  c5: { text: 'Every one of these ads shows fruit flying in slow motion and none of them show it actually blending ice.',
        sub: 'Cooking', url: 'https://reddit.com/r/Cooking/comments/x5/', score: 88 },
  c6: { text: 'I want one I can take to work and drink straight out of. That is the whole product.',
        sub: 'Fitness', url: 'https://reddit.com/r/Fitness/comments/x6/', score: 76 },
  // First-party: the merchant's own reviews, which carry the objections that
  // are actually costing THIS product sales.
  v0: { text: 'Love the thing but the gasket traps pulp and I have to pick it out with a cocktail stick every single time.',
        source: 'reviews', url: 'https://example-store.com/products/portable-blender', score: 4 },
  v1: { text: 'Third one I have owned. This is the only one where the lid has not cracked yet, six months in.',
        source: 'reviews', url: 'https://example-store.com/products/portable-blender', score: 2 },
};

const READ = {
  verdict: 'This category is bought on convenience and lost on cleanup. The people who stop using a portable blender almost never blame the blending; they blame the washing up.',
  pains: [
    { claim: 'Cleaning it takes longer than using it.', evidence_ids: ['c1', 'c2', 'c3', 'v0'] },
    { claim: 'Too many parts for one drink.', evidence_ids: ['c3', 'c2'] },
  ],
  wishes: [
    { claim: 'One they can drink straight out of and rinse in seconds.', evidence_ids: ['c6', 'c2', 'c1'] },
  ],
  objections: [
    { claim: 'They expect the motor to die within weeks.', evidence_ids: ['c4', 'c5', 'v1'] },
  ],
};

const ANGLES = { angles: [
  { claim: 'Sell the cleanup, not the blending.',
    hook: 'It is not the smoothie that stops you. It is the six parts in the sink.',
    headline: 'Blend it. Drink it. Rinse it. Done.',
    format: 'video',
    persona: 'Busy people who want a quick smoothie without the washing up.',
    evidence_ids: ['c1', 'c2', 'c3'] },
  { claim: 'Answer the dead-motor fear head on.',
    hook: 'Everyone thinks these die in a month. Here is ours after a year.',
    headline: 'Still going after 400 blends.',
    format: 'video',
    persona: 'People burned by a cheap blender bought off an ad.',
    evidence_ids: ['c4', 'c5'] },
]};

/* The competitor legs. Split out because the whole point of `anon` mode is that
 * these are absent, and that case now has to look deliberate rather than
 * broken. */
const COMPETITOR_LEGS = {
  formats: {
    verdict: 'video', confidence: 'high',
    reason: 'The competitor ads surviving past 90 days in this category are almost all video, and the statics churn out inside a fortnight',
    sample: { typed: 41, untyped: 3 },
    longRunners: { cohortDays: 90, videoShare: 0.79, total: 19 },
    raw: { videoShare: 0.61, total: 41 },
    durationWeighted: { videoShare: 0.74 },
  },
  whitespace: {
    adsRead: 41,
    themes: [
      { claim: 'Cleaning it takes longer than using it.', people: 9, adsAddressing: 0 },
      { claim: 'They expect the motor to die within weeks.', people: 6, adsAddressing: 0 },
      { claim: 'It is small enough to carry everywhere.', people: 7, adsAddressing: 14 },
    ],
  },
  ads: [
    { advertiser: 'BlendJet', creative: 'video', landingDomain: 'blendjet.com', daysRunning: 214, durationConfidence: 'observed' },
    { advertiser: 'Ninja', creative: 'video', landingDomain: 'ninjakitchen.com', daysRunning: 168, durationConfidence: 'reported' },
    { advertiser: 'PopBabies', creative: 'image', landingDomain: 'popbabies.com', daysRunning: 41, durationConfidence: 'observed' },
  ],
  adsAnalysed: 41,
};

function payload() {
  const base = {
    product: { title: 'Portable Blender', url: 'https://example-store.com/products/portable-blender' },
    category: 'portable blenders',
    stats: { records: 486, subreddits: 4, reviews: 27 },
    evidence: EVIDENCE,
    read: READ,
    angles: ANGLES,
    deep: MODE === 'full',
  };
  return MODE === 'anon' ? base : { ...base, ...COMPETITOR_LEGS };
}

/* ── plumbing ─────────────────────────────────────────────── */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    // Never cache anything here. A stale studio.js during a design pass wastes
    // more time than the whole server saves.
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const json = (res, obj) => send(res, 200, JSON.stringify(obj));

async function serveStatic(res, urlPath) {
  // Clean URLs, matching how Netlify serves this site: /validate -> validate.html
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  // Refuse to serve outside the repo, even from a dev tool.
  if (!file.startsWith(ROOT)) return send(res, 403, 'no');

  let hit = await stat(file).catch(() => null);
  if (!hit || hit.isDirectory()) {
    const guess = file.replace(/\/$/, '') + '.html';
    if (await stat(guess).catch(() => null)) file = guess;
    else return send(res, 404, 'not found: ' + rel, 'text/plain');
  }
  send(res, 200, await readFile(file), TYPES[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/__stub')) {
    const want = p.split('/')[2];
    if (want && ['full', 'anon', 'building', 'partial', 'feeddown'].includes(want)) MODE = want;
    return send(res, 200,
      `<!doctype html><meta charset=utf-8><title>stub: ${MODE}</title>` +
      `<body style="font:16px system-ui;background:#0a0608;color:#fff;padding:40px">` +
      `<h1>Stub mode: <b style="color:#ff4d6d">${MODE}</b></h1>` +
      `<p><a style="color:#ff7a8e" href="/__stub/full">full</a> (signed-in: angles + competitor ads)<br>` +
      `<a style="color:#ff7a8e" href="/__stub/anon">anon</a> (free read: angles, no competitor legs)<br>` +
      `<a style="color:#ff7a8e" href="/__stub/building">building</a> (never finishes, watch the progress UI)<br>` +
      `<a style="color:#ff7a8e" href="/__stub/partial">partial</a> (a pack that delivers 19 of 20, with the refund note)<br>` +
      `<a style="color:#ff7a8e" href="/__stub/feeddown">feeddown</a> (render-status 502s: the poll must give up, not spin)</p>` +
      `<p><a style="color:#ff7a8e" href="/">back to the site</a></p>`,
      'text/html; charset=utf-8');
  }

  if (p.includes('/report-create')) { req.resume(); return json(res, { id: 'stub-1', claimToken: 'tok' }); }

  if (p.includes('/report-status')) {
    if (MODE === 'building') return json(res, { status: 'building', step: 'Finding what customers care about', stepKey: 'harvesting' });
    return json(res, {
      id: 'stub-1', status: 'ready', title: 'Portable Blender',
      url: 'https://example-store.com/products/portable-blender',
      evidenceCount: 486, adsAnalysed: MODE === 'anon' ? 0 : 41,
      payload: payload(),
    });
  }

  if (p.includes('/product-peek')) {
    return json(res, {
      ok: true, url: url.searchParams.get('url') || 'https://example-store.com/products/portable-blender',
      title: 'Portable Blender', siteName: 'example-store.com',
      price: '49.99', currency: 'USD', image: null, guessed: false,
    });
  }

  /* Echoes the shop back into the title, so the domain normalisation in
   * studio.js is observable end to end instead of asserted from the regex. */
  if (p.includes('/shopify-install')) {
    return send(res, 200,
      `<!doctype html><meta charset=utf-8><title>INSTALL-OK shop=${url.searchParams.get('shop') || 'NONE'}</title>ok`,
      'text/html; charset=utf-8');
  }

  if (p.includes('/render-create')) { req.resume(); return json(res, { jobs: [{ id: 'job-1' }] }); }

  /* The render screen's finished state was unreachable here.
   *
   * This stub answered { status: 'done' } with no result, but render-status
   * documents { status: 'in_progress' | 'completed' | 'failed' } and render.js
   * only reveals on `status === 'completed' && s.result`. So the page polled
   * forever and the delivery UI, which is the entire point of render.html,
   * could never be looked at. A fixture that disagrees with its own backend is
   * worse than no fixture: it invents a bug that production does not have.
   *
   * `building` holds it mid-render on purpose, the same way report-status does,
   * so the progress UI can be watched. The step must be one of render.js's
   * STEPS or setStep gets an index of -1 and lights nothing. */
  if (p.includes('/render-status')) {
    if (MODE === 'building') {
      return json(res, { status: 'in_progress', step: 'generate', pct: 62, segmentsTotal: 2, segmentsDone: 1 });
    }
    /* The progress feed is down while the render itself may be fine. Netlify
     * answers a function timeout with an HTML body, not JSON, which is exactly
     * why the page's r.json() rejects rather than returning an error object. */
    if (MODE === 'feeddown') {
      return send(res, 502, '<html><body>502 Bad Gateway</body></html>', 'text/html; charset=utf-8');
    }
    /* A pack where some creatives died. Shape copied from render-status.js:304:
     * still `completed` with a full result, plus `partial` and the message that
     * names the refund. The delivered set is genuinely short of `of`, because
     * that is the case the delivery copy has to survive. */
    if (MODE === 'partial') {
      const urls = Array.from({ length: 19 }, () => '/assets/film/seg-01.jpg');
      return json(res, {
        status: 'completed',
        step: 'finish',
        pct: 100,
        partial: { delivered: 19, of: 20, failed: 1, creditsReturned: 45 },
        message: '1 creative failed to render and 45 credits were returned to your balance.',
        result: { url: urls[0], urls, type: 'image', thumbnail: null },
      });
    }
    return json(res, {
      status: 'completed',
      step: 'finish',
      pct: 100,
      jobs: [{ id: 'job-1', status: 'completed' }],
      result: { url: '/assets/film/hero-loop.mp4', type: 'video', urls: ['/assets/film/hero-loop.mp4'] },
    });
  }
  /* The account library. Three rows on purpose: a finished video, a finished
   * image set and one still rendering, because the card renderer branches on
   * all three and the pending branch is the one with no result_urls to read.
   *
   * There is deliberately no empty-library switch here: account.js fetches this
   * with no query string, so a flag on the page URL could never reach it. The
   * first-run states are driven by intercepting this response in the harness. */
  if (p.includes('/account-creations')) {
    return json(res, { creations: [
      { id: 'c1', type: 'video', status: 'completed', title: '', job_ids: ['job-1'],
        result_urls: ['/assets/film/hero-loop.mp4'], created_at: '2026-08-14T10:00:00Z' },
      { id: 'c2', type: 'image', status: 'completed', title: 'Kitchen set', job_ids: ['job-2'],
        result_urls: ['/assets/film/seg-01.jpg'], created_at: '2026-08-13T10:00:00Z' },
      { id: 'c3', type: 'video', status: 'processing', title: '', job_ids: ['job-3'],
        result_urls: [], created_at: '2026-08-15T09:00:00Z' },
    ] });
  }

  if (p.includes('/.netlify/functions/')) { req.resume(); return json(res, { ok: true, stub: true }); }

  serveStatic(res, p).catch(() => send(res, 500, 'stub error', 'text/plain'));
});

server.listen(PORT, () => {
  console.log(`
  Hexa dev stub on http://localhost:${PORT}   (mode: ${MODE})

  Home            http://localhost:${PORT}/
  Report          http://localhost:${PORT}/validate?url=https://example-store.com/products/portable-blender
  Goal chooser    http://localhost:${PORT}/index.html?open=choose
  Switch modes    http://localhost:${PORT}/__stub
`);
});

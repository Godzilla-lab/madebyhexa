/*
 * UI tests: drive the real pages in a real browser.
 *
 * Everything here exists because screenshots lie by omission. A section can
 * render perfectly and still be broken, because the thing that is broken is
 * what happens when you click it. Half the flows in this app were "verified"
 * by looking at them, and the parts that had never been clicked were the parts
 * that were wrong.
 *
 *   node tools/devstub.mjs &        # must be running first
 *   node tools/uitest.mjs           # the checks
 *   node tools/uitest.mjs --shots   # also write captures at 3 widths
 *   node tools/uitest.mjs --only 7  # one check, by number
 *
 * puppeteer-core, not puppeteer: it ships no browser and drives the Chrome
 * already installed. node_modules here is already 104M and this repo publishes
 * from ".", so a bundled Chromium is not a cost worth paying for a dev tool.
 */

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8901';
const SHOTS = path.join(ROOT, '.uitest');
const WIDTHS = [[390, 844, 'mobile'], [768, 1024, 'tablet'], [1440, 900, 'desktop']];

const args = process.argv.slice(2);
const WANT_SHOTS = args.includes('--shots');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

/* Resolved, not hardcoded: this has to keep working on someone else's machine
 * and fail with a sentence rather than a stack trace. */
const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const CHROME = process.env.CHROME || CHROMES.find((p) => existsSync(p));

const results = [];
let browser;

function record(n, name, ok, detail) {
  results.push({ n, name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${String(n).padStart(2)}. ${name}${ok || !detail ? '' : '\n        ' + detail}`);
}

/*
 * Every check gets a fresh page and its own timeout. A hung page used to take
 * the whole run down with it and cost two minutes of wall clock, so a check
 * that stalls is a failed check, not a stopped suite.
 */
async function check(n, name, fn, ms = 25000) {
  if (ONLY && String(n) !== ONLY) return;
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  let timer;
  try {
    await Promise.race([
      fn(page),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after ' + ms + 'ms')), ms); }),
    ]);
    record(n, name, true);
  } catch (e) {
    record(n, name, false, e.message);
    if (WANT_SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `fail-${n}.png`) }).catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    await page.close().catch(() => {});
  }
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* Text of the whole page, normalised, for copy assertions. */
const textOf = (page, sel = 'body') =>
  page.$eval(sel, (n) => n.innerText.replace(/\s+/g, ' ').trim());

async function go(page, url) {
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  // studio.js is deferred and fetches its catalogue; wait for the work it does
  // rather than for an arbitrary sleep.
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the checks ───────────────────────────────────────────── */

async function run() {
  console.log(`\n  Hexa UI checks  ${BASE}\n`);

  await check(1, 'ICP: anyone with a product, Shopify named first', async (page) => {
    await go(page, '/');
    const t = await textOf(page, '.c-hero-copy');
    assert(/anyone selling a product/i.test(t), 'hero kicker does not name the broad ICP');
    assert(/Shopify.*Amazon.*Etsy/i.test(t), 'sub does not name Shopify first then the others');
  });

  await check(2, 'Positioning: H1, sub and microcopy', async (page) => {
    await go(page, '/');
    const h1 = await textOf(page, 'h1');
    assert(/Turn your products/i.test(h1) && /into ads/i.test(h1), 'H1 is not the positioning line: ' + h1);
    const t = await textOf(page, '.c-hero-copy');
    assert(/researches your product/i.test(t), 'sub missing the research promise');
    assert(/No prompting\. No video editing\. No marketing expertise required\./i.test(t), 'microcopy missing');
  });

  await check(3, 'No jargon anywhere the user can see', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.vd-call', { timeout: 20000 });
    const t = (await textOf(page)).toLowerCase();
    const banned = ['icp', 'sentiment analysis', 'competitive intelligence', 'market intelligence',
      'product intelligence', 'creative strategy', 'prompt engineering', 'ugc framework',
      'hook mechanism', 'consumer sentiment'];
    const hits = banned.filter((b) => t.includes(b));
    assert(!hits.length, 'jargon on the report: ' + hits.join(', '));
  });

  await check(4, 'Shopify connect normalises whatever they paste', async (page) => {
    await go(page, '/');
    await page.click('#entry-tab-shopify');
    await page.waitForSelector('#entry-shopify:not([hidden])');
    await page.type('#shop-domain', 'https://admin.shopify.com/store/my-shop/');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('#shop-go'),
    ]);
    const title = await page.title();
    assert(title.includes('shop=my-shop.myshopify.com'), 'sent the wrong shop: ' + title);
  });

  await check(5, 'A pasted link still peeks the product', async (page) => {
    await go(page, '/');
    await page.type('#composer-link', 'https://example-store.com/products/portable-blender');
    await page.waitForFunction(
      () => (document.querySelector('#composer-product-name') || {}).textContent,
      { timeout: 15000 });
  });

  await check(6, 'Onboarding: the question, three ways in, one CTA', async (page) => {
    await go(page, '/');
    const t = await textOf(page, '.c-hero-copy');
    assert(/what are you selling/i.test(t), 'the framing question is missing');
    const tabs = await page.$$eval('.entry-tab', (n) => n.map((x) => x.textContent.trim()));
    assert(tabs.length === 3, 'expected 3 ways in, found ' + tabs.length + ': ' + tabs.join(' | '));
    const cta = await page.$eval('#composer-go', (n) => n.textContent.trim());
    assert(/create my ad/i.test(cta), 'CTA is "' + cta + '", should be Create my ad');
  });

  await check(7, 'Adaptive onboarding: both branches are real', async (page) => {
    await go(page, '/');
    await page.type('#composer-link', 'https://example-store.com/products/portable-blender');
    await page.click('#composer-go');
    await page.waitForSelector('#peek-next:not([hidden])', { timeout: 20000 });
    const t = await textOf(page, '#peek-next');
    assert(/figure out the best way to advertise/i.test(t), 'the question is missing: ' + t);
    // Branch B first: it stays on the page, so it is cheap to check.
    await page.click('#peek-next-skip');
    await page.waitForSelector('.chooser-headline', { timeout: 10000 });
    // Branch A: reload and take the other one.
    await go(page, '/');
    await page.type('#composer-link', 'https://example-store.com/products/portable-blender');
    await page.click('#composer-go');
    await page.waitForSelector('#peek-next:not([hidden])', { timeout: 20000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('#peek-next-go'),
    ]);
    assert(/\/validate/.test(page.url()), 'Yes did not go to the read: ' + page.url());
  });

  /* The multi-source engine is not built: only comments and competitor ads are
   * wired. So the check that matters is not "are all six sources there" but
   * "does the page claim a source we never read". Overclaiming is the failure
   * mode a half-built research product actually has. */
  await check(8, 'The report claims only the sources it really reads', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.vd-call', { timeout: 20000 });
    const t = (await textOf(page)).toLowerCase();
    const unwired = ['verified reviews', 'review sites', 'trustpilot', 'amazon reviews',
      'across social', 'social listening', 'tiktok comments', 'instagram comments'];
    const lies = unwired.filter((s) => t.includes(s));
    assert(!lies.length, 'claims a source we do not read: ' + lies.join(', '));
    assert(/comment|customer/i.test(t), 'does not say where the findings came from');
  });

  await check(9, 'What we found, with no duplicate rows', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.vd-found', { timeout: 20000 });
    const labels = await page.$$eval('.found-label', (n) => n.map((x) => x.textContent.trim()));
    assert(labels.length >= 2, 'only ' + labels.length + ' findings');
    const claims = await page.$$eval('.found-claim', (n) => n.map((x) => x.textContent.trim().toLowerCase()));
    assert(new Set(claims).size === claims.length, 'a finding is printed twice: ' + claims.join(' // '));
  });

  await check(10, 'Progress speaks the merchant\'s language', async (page) => {
    await page.goto(BASE + '/__stub/building', { waitUntil: 'domcontentloaded' });
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('#vd-progress:not([hidden])', { timeout: 15000 });
    const t = await textOf(page, '#vd-progress');
    assert(/figuring out what sells/i.test(t), 'missing the working headline');
    assert(/1 to 3 minutes/i.test(t), 'missing the duration expectation');
    assert(!/crawl|api|token|embed/i.test(t), 'plumbing language in the progress UI: ' + t);
    await page.goto(BASE + '/__stub/full', { waitUntil: 'domcontentloaded' });
  });

  await check(11, 'Answers come before the working', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.vd-call', { timeout: 20000 });
    const t = await textOf(page, '.vd-call');
    for (const want of ['your likely customer', 'their biggest problem', 'your strongest angle', 'open with']) {
      assert(t.toLowerCase().includes(want), 'recommendation missing "' + want + '"');
    }
    const order = await page.evaluate(() => {
      const call = document.querySelector('.vd-call');
      const ev = document.querySelector('#vd-evidence');
      return call.compareDocumentPosition(ev) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    assert(order, 'the evidence is above the recommendation');
  });

  /* The report has to answer the merchant's actual question, which is not
   * "what did you find" but "should I put money behind this". */
  await check(12, 'Research lands as a decision, not a document', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.str-grid', { timeout: 20000 });
    const t = (await textOf(page)).toLowerCase();
    assert(t.includes('is this worth advertising'), 'never answers whether to advertise it');
    /* Each reading needs a reason next to it; a verdict with no reason is an
     * opinion, and the whole product claims not to have those. */
    const reasons = await page.$$eval('.str-why', (n) => n.map((x) => x.textContent.trim()));
    const words = await page.$$eval('.str-word', (n) => n.map((x) => x.textContent.trim()));
    assert(reasons.length === words.length && reasons.every(Boolean),
      words.length + ' readings but ' + reasons.filter(Boolean).length + ' reasons');
    for (const q of ['your likely customer', 'their biggest problem', 'your strongest angle',
      'open with', 'should you run video or images']) {
      assert(t.includes(q), 'unanswered question: ' + q);
    }
  });

  await check(13, 'One recommendation, the rest behind a link', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.vd-call', { timeout: 20000 });
    const calls = await page.$$('.vd-call');
    assert(calls.length === 1, 'expected one recommendation, found ' + calls.length);
    assert(await page.$('#vd-angles'), 'the other angles section is missing');
  });

  await check(14, 'Headings are questions a merchant would ask', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.vd-call', { timeout: 20000 });
    const heads = await page.$$eval('h2', (n) => n.map((x) => x.textContent.trim().toLowerCase()));
    for (const want of ['what we found', 'is this worth advertising?', 'what competitors are doing']) {
      assert(heads.some((h) => h.includes(want)), 'missing plain heading: ' + want);
    }
    const old = heads.filter((h) => /whitespace|corroborat|signal|corpus|taxonom/.test(h));
    assert(!old.length, 'internal vocabulary in a heading: ' + old.join(', '));
  });

  await check(15, 'Let Hexa choose leads the chooser', async (page) => {
    await go(page, '/index.html?open=choose');
    await page.waitForSelector('.goal-tile-lead', { timeout: 15000 });
    const t = await textOf(page, '.goal-tile-lead');
    assert(/recommended/i.test(t), 'the default is not marked Recommended');
    assert(/let hexa choose/i.test(t), 'the lead tile is not Let Hexa choose');
  });

  await check(16, 'Every goal opens the right product', async (page) => {
    const expect = [
      ['let hexa choose', 'Auto'],
      ['stop scrolling', 'Hyper'],
      ['real customer', 'UGC'],
      ['look premium', 'Cinematic'],
      ['show the product', 'Unboxing'],
      ['how it works', 'Tutorial'],
    ];
    for (const [label, want] of expect) {
      await go(page, '/index.html?open=choose');
      await page.waitForSelector('.goal-tile', { timeout: 15000 });
      const clicked = await page.evaluate((l) => {
        const t = [...document.querySelectorAll('.goal-tile')]
          .find((x) => x.textContent.toLowerCase().includes(l));
        if (!t) return false;
        t.click();
        return true;
      }, label);
      assert(clicked, 'no goal tile matching "' + label + '"');
      await page.waitForFunction(() => {
        const el = document.querySelector('#config-title');
        return el && el.textContent && el.textContent !== 'Your ad';
      }, { timeout: 10000 });
      const title = await page.$eval('#config-title', (n) => n.textContent);
      assert(new RegExp(want, 'i').test(title),
        '"' + label + '" opened "' + title + '", expected something like ' + want);
    }
  }, 60000);

  await check(17, 'Styles are grouped by how they read, not by our stack', async (page) => {
    await go(page, '/index.html?open=choose');
    await page.waitForSelector('.chooser-lib', { timeout: 15000 });
    await page.click('.chooser-lib > summary');
    const groups = await page.$$eval('.chooser-group', (n) => n.map((x) => x.textContent.toLowerCase()));
    assert(groups.some((g) => g.includes('authentic')), 'no perception grouping found: ' + groups.join(' | '));
    const stack = groups.filter((g) => /creator videos|premium spots|photo sets/.test(g));
    assert(!stack.length, 'old engine-family group names survive: ' + stack.join(', '));
  });

  await check(18, 'The recommendation can be interrogated', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.call-why', { timeout: 20000 });
    await page.click('.call-why > summary');
    const t = await textOf(page, '.call-why');
    assert(/\d+ separate customer comments/i.test(t), 'no evidence count in the explanation: ' + t);
    assert(/view sources/i.test(t), 'no route to the sources');
  });

  await check(19, 'Scores are words, not numbers nobody can read', async (page) => {
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.str-grid', { timeout: 20000 });
    const words = await page.$$eval('.str-word', (n) => n.map((x) => x.textContent.trim()));
    assert(words.length, 'no strength readings rendered');
    for (const w of words) assert(!/^\d+$/.test(w), 'a bare score leaked through: ' + w);
    assert(await page.$('.str-det'), 'the detail disclosure is missing');
  });

  await check(20, 'A chosen angle survives into the order', async (page) => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.setItem('hexa-angle', JSON.stringify({
        v: 1, ts: Date.now(), url: 'https://example-store.com/products/portable-blender',
        product: 'mode:ugc', claim: 'Sell the cleanup, not the blending.',
        hook: 'It is not the smoothie that stops you. It is the six parts in the sink.',
        headline: 'Blend it. Drink it. Rinse it. Done.', format: 'video',
        persona: 'Busy people who want a quick smoothie without the washing up.', receipts: 3,
      }));
    });
    await go(page, '/#composer');
    await page.waitForSelector('.chooser-headline', { timeout: 20000 });
    const head = await textOf(page, '.chooser-headline');
    assert(/how should we make it/i.test(head), 'chooser did not adapt to the report: ' + head);
    await page.evaluate(() => {
      [...document.querySelectorAll('.goal-tile')]
        .find((x) => x.textContent.toLowerCase().includes('real customer')).click();
    });
    /* The drawer has two textareas: the product description and the creative
     * direction. Picking the first one made this fail against working code,
     * which is its own lesson about assertions that are only nearly specific. */
    await page.waitForSelector('#config-body textarea', { timeout: 10000 });
    const notes = await page.$$eval('#config-body .config-step', (steps) => {
      const step = steps.find((s) => /creative direction/i.test(s.textContent));
      const box = step && step.querySelector('textarea');
      return box ? box.value : '';
    });
    assert(/six parts in the sink/i.test(notes), 'the hook did not reach the brief: "' + notes + '"');
  }, 40000);

  /* Arriving from a read is a different conversation from arriving cold: the
   * what is already decided, so the chooser may only ask the how. Check 20
   * proves the brief survives; this proves the question changes. */
  await check(21, 'Coming from a read, the chooser asks a different question', async (page) => {
    await go(page, '/index.html?open=choose');
    await page.waitForSelector('.chooser-headline', { timeout: 15000 });
    const cold = await textOf(page, '.chooser-headline');
    assert(/what do you want the ad to do/i.test(cold), 'cold start asks: ' + cold);

    await page.evaluate(() => {
      localStorage.setItem('hexa-angle', JSON.stringify({
        v: 1, ts: Date.now(), url: 'https://example-store.com/products/portable-blender',
        product: 'mode:ugc', claim: 'Sell the cleanup, not the blending.',
        hook: 'It is not the smoothie that stops you. It is the six parts in the sink.',
        headline: 'Blend it. Drink it. Rinse it. Done.', format: 'video',
        persona: 'Busy people who want a quick smoothie without the washing up.', receipts: 3,
      }));
    });
    await go(page, '/index.html?open=choose');
    await page.waitForSelector('.chooser-headline', { timeout: 15000 });
    const warm = await textOf(page, '.chooser-headline');
    assert(/how should we make it/i.test(warm), 'warm start still asks: ' + warm);
    assert(cold !== warm, 'the chooser asks the same question either way');
    await page.evaluate(() => localStorage.removeItem('hexa-angle'));
  }, 40000);

  await check(22, 'The free read is complete on its own', async (page) => {
    await page.goto(BASE + '/__stub/anon', { waitUntil: 'domcontentloaded' });
    await go(page, '/validate?url=https://example-store.com/products/portable-blender');
    await page.waitForSelector('.vd-call', { timeout: 20000 });
    const t = await textOf(page);
    assert(/your strongest angle/i.test(t), 'a signed-out read has no recommendation');
    assert(/make this ad/i.test(t), 'a signed-out read cannot make anything');
    assert(await page.$('.vd-unlock'), 'nothing offers the competitor legs');
    assert(!(await page.$('.vd-gate-veil')), 'the old blur gate is back');
    await page.goto(BASE + '/__stub/full', { waitUntil: 'domcontentloaded' });
  });

  /* Not one of the 22, but it is the only section on the page that is a game
   * rather than a paragraph, and a game that has never been played is not
   * shipped. The thesis check matters most: if the wrong answers are not the
   * ones competitors actually run, the section argues nothing. */
  await check(24, 'Guess the angle plays, and the wrong answers are real ads', async (page) => {
    await go(page, '/');
    await page.waitForSelector('.guess-option', { timeout: 15000 });
    const opts = await page.$$('.guess-option');
    assert(opts.length === 3, 'expected 3 angles, found ' + opts.length);

    await opts[0].click();
    await page.waitForSelector('.guess-result', { timeout: 10000 });
    const t = await textOf(page, '#guess-stage');
    assert(/customers? raised it/i.test(t), 'no customer counts in the reveal');
    assert(/competitor ads? says? it/i.test(t), 'no competitor counts in the reveal');
    assert(await page.$('.guess-result.is-winner'), 'nothing is marked as the evidence-backed answer');
    assert(await page.$('.guess-result.is-picked'), 'their own pick is not marked');

    /* The whole argument: at least one angle nobody raised is one competitors
     * are buying. Without that, this is a trivia question. */
    const rows = await page.$$eval('.guess-result', (n) => n.map((x) => x.innerText));
    const loserWithAds = rows.some((r) => !/Your pick/.test(r) &&
      /(\d+) customers? raised it/.test(r) && /([1-9]\d*) competitor ads? says? it/.test(r) &&
      Number(r.match(/(\d+) customers? raised it/)[1]) <= 2);
    assert(loserWithAds, 'no weak angle that competitors are actually running');

    /* Honesty constraint from the plan: no invented pick statistics until real
     * picks have been counted. */
    assert(!/% of (people|visitors|marketers)/i.test(t), 'invented social proof in the reveal');

    await page.click('.guess-again');
    await page.waitForSelector('.guess-option', { timeout: 10000 });
    const next = await textOf(page, '.guess-product-name');
    assert(next, 'Try another product did not load a second product');
  });

  /* Layout, asserted. A horizontal scrollbar is a bug, not a judgement call. */
  await check(23, 'No horizontal overflow at any width', async (page) => {
    const pages = ['/', '/validate?url=https://example-store.com/products/portable-blender'];
    const bad = [];
    for (const url of pages) {
      for (const [w, h, label] of WIDTHS) {
        await page.setViewport({ width: w, height: h });
        await go(page, url);
        if (url.includes('validate')) await page.waitForSelector('.vd-call', { timeout: 20000 });
        await sleep(400);
        const over = await page.evaluate(() => {
          const d = document.documentElement;
          return d.scrollWidth - d.clientWidth;
        });
        if (over > 1) bad.push(`${url} @${label} overflows by ${over}px`);
        if (WANT_SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          const name = (url === '/' ? 'home' : 'report') + '-' + label + '.png';
          await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
        }
      }
    }
    assert(!bad.length, bad.join('\n        '));
  }, 90000);
}

/* ── go ───────────────────────────────────────────────────── */

if (!CHROME) {
  console.error('\n  No Chrome found. Set CHROME=/path/to/chrome and try again.\n');
  process.exit(2);
}

try {
  await fetch(BASE, { method: 'HEAD' });
} catch {
  console.error(`\n  Nothing is serving ${BASE}. Start it first:\n\n    node tools/devstub.mjs &\n`);
  process.exit(2);
}

browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--disable-gpu', '--hide-scrollbars', '--disable-remote-fonts', '--no-first-run'],
});

try {
  await run();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} passed` +
  (WANT_SHOTS ? `, captures in .uitest/` : '') + '\n');
process.exit(failed.length ? 1 : 0);

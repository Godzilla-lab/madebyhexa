/*
 * Design audit: measure the things people usually eyeball.
 *
 * Written after a review found three collisions, a 300px dead column and a
 * price block a line taller than its neighbours, all on a page that had been
 * looked at many times. Eyes skip what they expect to be fine, so the checks
 * that can be arithmetic are arithmetic here, and the captures are only for
 * the judgement that is genuinely left over.
 *
 *   node tools/devstub.mjs &
 *   node tools/uiaudit.mjs
 */

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8901';
const OUT = path.join(ROOT, '.uitest/audit');
/* touch: true drives `@media (pointer: coarse)`, which is where the 44px
 * floors live. Without it headless reports a fine pointer, the rules never
 * apply, and the audit reports failures that no real phone would ever see. */
const WIDTHS = [
  [390, 844, 'mobile', true],
  [768, 1024, 'tablet', true],
  [1440, 900, 'desktop', false],
];
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p));

const findings = [];
const note = (where, width, rule, detail) => findings.push({ where, width, rule, detail });

/*
 * Runs inside the page. Everything measured here is a defect that has a number:
 * text sitting on top of other text, siblings that do not line up, tap targets
 * too small to hit, and content hidden behind the floating CTA.
 */
function audit() {
  const out = [];
  /*
   * Chrome keeps a real box for the contents of a CLOSED <details>: display is
   * still "block" and getBoundingClientRect returns full width and height. So
   * every collapsed FAQ answer sits at the same coordinates as every other one
   * and naive overlap detection reports the whole accordion as a pile-up. That
   * false positive is worse than no check, because it buries the true ones.
   */
  const inClosedDetails = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.tagName === 'DETAILS' && !n.open) return true;
    }
    return false;
  };
  const vis = (el) => {
    if (inClosedDetails(el)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const rect = (el) => el.getBoundingClientRect();

  for (const sec of document.querySelectorAll('main > section, main > div > section')) {
    if (!vis(sec)) continue;
    const id = sec.id || sec.className.split(' ')[0] || 'section';

    // 1. Collision: leaf text boxes that overlap each other.
    const leaves = [...sec.querySelectorAll('h1,h2,h3,h4,p,span,li,figcaption,button,a')]
      .filter((n) => vis(n) && n.textContent.trim() && !n.querySelector('h1,h2,h3,h4,p,span,li,button,a'))
      .slice(0, 90);
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = rect(leaves[i]), b = rect(leaves[j]);
        if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue;
        // Absolutely positioned overlays are a deliberate technique; only flag
        // boxes that are both in normal flow.
        if (getComputedStyle(leaves[i]).position !== 'static' || getComputedStyle(leaves[j]).position !== 'static') continue;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 4 && oy > 4) {
          out.push({ sec: id, rule: 'collision',
            detail: `"${leaves[i].textContent.trim().slice(0, 28)}" overlaps "${leaves[j].textContent.trim().slice(0, 28)}" by ${Math.round(ox)}x${Math.round(oy)}px` });
          i = leaves.length; break;
        }
      }
    }

    // 2. Alignment: sibling cards in one row should share a bottom edge.
    for (const track of sec.querySelectorAll('.pack-track, .goal-grid, .chain-list, .str-grid, .c-proof-row, .more-grid')) {
      const kids = [...track.children].filter(vis);
      if (kids.length < 2) continue;
      const rows = new Map();
      for (const k of kids) {
        const key = Math.round(rect(k).top / 8) * 8;
        rows.set(key, [...(rows.get(key) || []), k]);
      }
      for (const [, row] of rows) {
        if (row.length < 2) continue;
        const bottoms = row.map((k) => Math.round(rect(k).bottom));
        const spread = Math.max(...bottoms) - Math.min(...bottoms);
        if (spread > 12) {
          out.push({ sec: id, rule: 'alignment',
            detail: `${track.className.split(' ')[0]}: ${row.length} cards in a row differ by ${spread}px at the bottom` });
        }
      }
    }

    // 3. Tap targets, but only where there is a thumb. 44px is the floor on a
    //    touch screen; a mouse hits a 25px chip without complaint.
    for (const t of (matchMedia('(pointer: coarse)').matches ? sec.querySelectorAll('button, a, input, summary') : [])) {
      if (!vis(t)) continue;
      const r = rect(t);
      if (r.height < 44 && r.height > 0 && t.offsetParent !== null) {
        const label = (t.textContent || t.getAttribute('aria-label') || '').trim().slice(0, 26);
        if (label) out.push({ sec: id, rule: 'tap-target', detail: `"${label}" is ${Math.round(r.height)}px tall` });
      }
    }
  }

  /*
   * 4. The float CTA hiding content you cannot scroll clear of.
   *
   * A fixed bar overlaps SOMETHING at every scroll position; that is what fixed
   * means, and flagging it is noise. The defect is content in the last
   * screenful, which no amount of scrolling can move out from under the bar.
   * Measured at max scroll for exactly that reason.
   */
  const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 4;
  const float = atBottom ? document.querySelector('.float-cta') : null;
  if (float && vis(float)) {
    const f = rect(float);
    for (const n of document.querySelectorAll('main p, main li, main h2, main h3')) {
      if (!vis(n)) continue;
      const r = rect(n);
      if (r.bottom > f.top && r.top < f.bottom && r.right > f.left && r.left < f.right) {
        out.push({ sec: 'float-cta', rule: 'obscured',
          detail: `covers "${n.textContent.trim().slice(0, 40)}"` });
        break;
      }
    }
  }

  // Dedupe: one instance of each defect per section is enough to act on.
  const seen = new Set();
  return out.filter((o) => {
    const k = o.sec + o.rule + o.detail;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--disable-gpu', '--hide-scrollbars', '--disable-remote-fonts'],
});

mkdirSync(OUT, { recursive: true });
/* render.html needs an order before it shows anything: boot() bails to "No
 * order in progress" without one, which is why this page went unaudited. The
 * studio normally leaves the order in localStorage, but readOrder() also
 * accepts it in the URL, so a link alone is enough to drive the real screen.
 * `jobs` puts it on the live path, where devstub's render-status completes it. */
const RENDER_ORDER = encodeURIComponent(JSON.stringify({
  product: 'mode:ugc',
  title: 'Hexa Studio: ugc',
  price: 15,
  style: 'golden-hour-ugc',
  selections: {
    link: 'https://example-store.com/products/portable-blender',
    productName: 'Portable Blender',
    styleName: 'Golden Hour UGC',
    aspect: '9:16', duration: 15, quality: '720p',
  },
}));

/*
 * account.html needs a signed-in session before it renders anything: account.js
 * waits on HexaAuth.ready() and bounces to login without a user. auth.js builds
 * HexaAuth from supabase-js against the live project, which a design audit has
 * no business talking to, so the session is faked here instead of adding a
 * bypass to the site: block auth.js, install the same surface account.js uses,
 * and let devstub answer the library call.
 *
 * client.rpc is part of that surface. Without it initCredits returns early and
 * the whole credits panel, balance, ledger and top-up, goes unmeasured.
 */
function session({ emptyLibrary = false } = {}) {
  return async function signedIn(page) {
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.endsWith('/auth.js') || u.includes('/vendor/supabase.js')) return r.abort();
    // account.js sends no query string, so the empty case can only be forced here.
    if (emptyLibrary && u.includes('account-creations')) {
      return r.respond({ status: 200, contentType: 'application/json', body: '{"creations":[]}' });
    }
    r.continue();
  });
  await page.evaluateOnNewDocument(() => {
    const user = { id: 'u_audit', email: 'audit@example.com' };
    const rpc = (name) => Promise.resolve(
      name === 'my_credit_balance' ? { data: 13500 } : { data: [
        { kind: 'grant', delta: 2500, created_at: '2026-08-01T10:00:00Z' },
        { kind: 'purchase', delta: 13500, created_at: '2026-08-12T10:00:00Z' },
        { kind: 'spend', delta: -4500, created_at: '2026-08-14T10:00:00Z' },
      ] });
    window.HexaAuth = {
      ready: () => Promise.resolve(user),
      user: () => user,
      email: () => user.email,
      name: () => 'Chris Example',
      accessToken: () => 'audit-token',
      requireAuth: () => {},
      signOut: () => Promise.resolve(),
      onChange: () => {},
      /* initBrand builds a supabase query chain off client.from(...). Without a
       * chainable stub it throws during boot, and because that throw is inside
       * a promise the page looks fine while a section quietly never inits. */
      client: {
        rpc,
        from: () => {
          const q = {};
          for (const m of ['select', 'is', 'eq', 'order', 'limit', 'upsert', 'insert', 'update', 'maybeSingle', 'single']) q[m] = () => q;
          q.then = (fn) => Promise.resolve({ data: null, error: null }).then(fn);
          return q;
        },
      },
    };
  });
  };
}

const PAGES = [
  ['/', 'home'],
  ['/validate?url=https://example-store.com/products/portable-blender', 'report'],
  [`/render.html?order=${RENDER_ORDER}&jobs=job-1`, 'render'],
  ['/account.html', 'account', session()],
  ['/account.html?welcome=1', 'account-welcome', session({ emptyLibrary: true })],
];

for (const [url, name, prep] of PAGES) {
  for (const [w, h, label, touch] of WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch });
    // Pages behind a session stub what they need before anything loads.
    if (prep) await prep(page);
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    if (url.includes('account.html')) await page.waitForSelector('.cr-card, #acct-welcome:not([hidden]), #acct-empty:not([hidden])', { timeout: 20000 }).catch(() => {});
    if (url.includes('validate')) await page.waitForSelector('.vd-call', { timeout: 20000 }).catch(() => {});
    // The delivered state is the one worth measuring: reveal() adds .done once
    // the poll completes, so without this the audit sees the progress frame.
    if (url.includes('render.html')) await page.waitForSelector('#stage-frame.done', { timeout: 20000 }).catch(() => {});
    // Let the reveal observers fire, so nothing is measured mid-transition.
    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 900));
    });
    for (const f of await page.evaluate(audit)) note(`${name}/${f.sec}`, label, f.rule, f.detail);
    await page.screenshot({ path: path.join(OUT, `${name}-${label}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();

const byRule = findings.reduce((m, f) => ((m[f.rule] = (m[f.rule] || 0) + 1), m), {});
console.log(`\n  Design audit  ${findings.length} findings\n`);
for (const rule of Object.keys(byRule).sort()) {
  console.log(`  ${rule.toUpperCase()}  (${byRule[rule]})`);
  for (const f of findings.filter((x) => x.rule === rule)) {
    console.log(`    ${f.where} @${f.width}\n      ${f.detail}`);
  }
  console.log('');
}
console.log(`  captures in .uitest/audit/\n`);

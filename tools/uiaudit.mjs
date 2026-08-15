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

  /*
   * 5. Contrast, against the WCAG AA floor.
   *
   * This is the one design rule with a number behind it rather than an
   * opinion, which is exactly why it belongs in an audit instead of a review.
   * 4.5:1 for body text, 3:1 for large text (18.66px bold, or 24px).
   *
   * Two honest limits, both enforced by skipping rather than guessing:
   * text over a background IMAGE, gradient or video cannot be composited to a
   * single colour, and a wrong number here would be worse than no number. The
   * site puts white text over dark video in several heroes, so this skips a
   * real part of the page and says so rather than inventing a pass.
   */
  const lum = (r, g, b) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  /*
   * Walk up for the background this text is actually read against. Returns a
   * LIST of candidate colours, because a gradient has no single answer, and
   * the caller scores the worst of them.
   *
   * A gradient used to return null, which quietly excused the largest button
   * on the home page: "Create my ad" is white on a pink gradient, so the site's
   * primary CTA was the one thing the contrast rule never looked at. Solid
   * colour stops are parseable, so they get measured. A gradient over a photo
   * or a video still returns null, and that is a real hole rather than a pass.
   */
  const backdrop = (el) => {
    for (let n = el; n && n !== document.documentElement.parentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      const img = s.backgroundImage;
      if (img && img !== 'none') {
        // Only *-gradient(...) is resolvable; url() over a photo is not.
        if (!/gradient\(/.test(img) || /url\(/.test(img)) return null;
        const stops = (img.match(/rgba?\([^)]*\)/g) || []).map(parse)
          .filter((c) => c && c.a >= 0.95);
        if (stops.length) return stops;
        return null; // a translucent gradient over something unknown
      }
      const c = parse(s.backgroundColor);
      if (c && c.a >= 0.95) return [c];
      if (c && c.a > 0) return null; // a translucent layer we cannot resolve
    }
    return null;
  };
  for (const el of document.querySelectorAll('main *, footer *, header *')) {
    if (!vis(el)) continue;
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (txt.length < 3) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const cands = backdrop(el);
    if (!fg || !cands || !cands.length) continue;
    /* Fully transparent text is not unreadable text: it is the standard
     * background-clip:text trick, where the gradient behind IS the letterform.
     * Scoring it gives a meaningless 1.00:1 against its own fill. */
    if (fg.a === 0 || s.webkitBackgroundClip === 'text' || s.backgroundClip === 'text') continue;
    // Score every candidate and keep the worst: text has to be readable over
    // the whole of a gradient, not just over the end that happens to suit it.
    let ratio = Infinity, bg = cands[0];
    for (const c of cands) {
      // Composite the text colour onto its backdrop; alpha is how --text-faint
      // and friends are actually written, so ignoring it would measure nothing.
      const mix = {
        r: fg.a * fg.r + (1 - fg.a) * c.r,
        g: fg.a * fg.g + (1 - fg.a) * c.g,
        b: fg.a * fg.b + (1 - fg.a) * c.b,
      };
      const L1 = lum(mix.r, mix.g, mix.b), L2 = lum(c.r, c.g, c.b);
      const r = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (r < ratio) { ratio = r; bg = c; }
    }
    const px = parseFloat(s.fontSize);
    const bold = (parseInt(s.fontWeight, 10) || 400) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    const floor = large ? 3 : 4.5;
    if (ratio < floor) {
      /* Name the two colours. A ratio on its own says a rule was broken but
       * not by what, and the same number turns up from several different
       * tokens, so without this every fix starts with the same hunt. */
      const sel = el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : '');
      out.push({ sec: el.closest('section')?.id || 'page', rule: 'contrast',
        detail: `${ratio.toFixed(2)}:1 (needs ${floor}:1) ${s.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}) at ${Math.round(px)}px  ${sel.slice(0, 60)}  "${txt.slice(0, 24)}"` });
    }
  }

  /*
   * 6. Accessible names and stable layout. The measurable subset of the Vercel
   * web interface guidelines: a control with no text and no label is unusable
   * by a screen reader, and an <img> with no dimensions moves the page under
   * the reader's thumb while it loads.
   */
  for (const el of document.querySelectorAll('button, a, input, select, textarea')) {
    if (!vis(el)) continue;
    const name = (el.textContent || '').trim() ||
      el.getAttribute('aria-label') || el.getAttribute('title') ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent.trim()) ||
      el.closest('label')?.textContent.trim() ||
      (el.getAttribute('aria-labelledby') &&
        document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim()) ||
      (el.tagName === 'INPUT' && ['hidden', 'submit', 'button'].includes(el.type) ? 'n/a' : '');
    if (!name) {
      out.push({ sec: el.closest('section')?.id || 'page', rule: 'no-accessible-name',
        detail: `<${el.tagName.toLowerCase()}${el.type ? ' type=' + el.type : ''}${el.className ? ' class="' + String(el.className).split(' ')[0] + '"' : ''}> has no text, label or aria-label` });
    }
  }
  for (const img of document.querySelectorAll('img')) {
    if (!vis(img)) continue;
    if (!img.getAttribute('width') || !img.getAttribute('height')) {
      out.push({ sec: img.closest('section')?.id || 'page', rule: 'img-no-dimensions',
        detail: `${(img.getAttribute('src') || '').split('/').pop().slice(0, 40)} has no width/height, so it shifts layout as it loads` });
    }
    if (img.getAttribute('alt') === null) {
      out.push({ sec: img.closest('section')?.id || 'page', rule: 'img-no-alt',
        detail: `${(img.getAttribute('src') || '').split('/').pop().slice(0, 40)} has no alt (use alt="" if decorative)` });
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

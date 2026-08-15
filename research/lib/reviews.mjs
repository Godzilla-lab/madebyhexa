/*
 * Reviews on the product's own page.
 *
 * Every other source in this pipeline is about the CATEGORY: what people say
 * about portable blenders in general, which ads the category runs, what the
 * category complains about. Useful, and it is how you find an angle nobody
 * else has taken. But it never once reads what THIS product's own buyers said.
 *
 * That is the gap this closes. A merchant's own reviews are the only
 * first-party voice-of-customer we can get, they are where the objections that
 * actually cost them sales are written down, and the words in them are the
 * words their next customer is going to use.
 *
 * No new fetch and no new spend: product.mjs already has the HTML in hand by
 * the time it calls this, at whichever tier finally answered.
 *
 * Three ways in, in order of how much we can trust them:
 *
 *   1. JSON-LD  schema.org Review nodes. Structured, unambiguous, and what
 *      Shopify plus every serious review app emits for Google. If it is here,
 *      it is right.
 *   2. Microdata  itemprop="review" blocks, the older convention.
 *   3. Review-app containers  Judge.me, Loox, Yotpo, Stamped and Okendo all
 *      render predictable class names. Last because a class name is a guess
 *      about someone else's markup and it can go stale without warning.
 *
 * Anything that does not look like a human sentence is dropped rather than
 * guessed at. A report that quotes navigation furniture as customer evidence
 * is worse than a report with no reviews in it, and this pipeline's whole
 * claim is that every finding carries a real receipt.
 */

/* Long enough to be an opinion, short enough not to be an article. Tuned
 * against real Shopify pages: under ~25 chars is "Great!" and over ~1200 is
 * almost always page copy that leaked past the selector. */
const MIN_CHARS = 25;
const MAX_CHARS = 1200;
const MAX_REVIEWS = 60;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function clean(s) {
  return decodeEntities(String(s || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Is this a person talking, or is it furniture?
 *
 * Review-app markup puts buttons, star labels and "verified buyer" badges in
 * the same containers as the review body, so length alone lets a lot of junk
 * through. A real review has sentence punctuation and at least a few words.
 */
function looksHuman(text) {
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) return false;
  if (text.split(/\s+/).length < 6) return false;
  // Wall-to-wall capitals is a heading, not a sentence.
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) return false;
  // Some terminal punctuation, or at least a comma: opinions have rhythm.
  if (!/[.!?,]/.test(text)) return false;
  // Obvious page furniture.
  if (/^(add to cart|write a review|verified (buyer|purchase)|sort by|show more|read more)\b/i.test(text)) return false;
  return true;
}

function rating(v) {
  const n = Number(typeof v === 'object' && v ? v.ratingValue ?? v.value : v);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : null;
}

/* ── 1. JSON-LD ─────────────────────────────────────────────── */

function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }

    const stack = [parsed];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) { stack.push(...node); continue; }
      for (const key of ['@graph', 'review', 'reviews', 'itemListElement']) {
        if (node[key]) stack.push(...(Array.isArray(node[key]) ? node[key] : [node[key]]));
      }
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      if (!types.some((t) => String(t).toLowerCase() === 'review')) continue;

      const text = clean(node.reviewBody || node.description || '');
      if (!looksHuman(text)) continue;
      out.push({
        text,
        rating: rating(node.reviewRating),
        author: clean(typeof node.author === 'object' && node.author ? node.author.name : node.author).slice(0, 60),
        date: String(node.datePublished || '').slice(0, 10),
        via: 'json-ld',
      });
    }
  }
  return out;
}

/* ── 2. Microdata ───────────────────────────────────────────── */

function fromMicrodata(html) {
  const out = [];
  const re = /<([a-z]+)[^>]+itemprop=["']review["'][^>]*>([\s\S]{0,4000}?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_REVIEWS) {
    const block = m[2];
    const body = (block.match(/itemprop=["']reviewBody["'][^>]*>([\s\S]*?)</i) || [])[1];
    const text = clean(body || block);
    if (!looksHuman(text)) continue;
    const rv = (block.match(/itemprop=["']ratingValue["'][^>]*content=["']([\d.]+)["']/i) || [])[1];
    out.push({ text, rating: rating(rv), author: '', date: '', via: 'microdata' });
  }
  return out;
}

/* ── 3. Review apps ─────────────────────────────────────────── */

/*
 * Class names, which means guessing about someone else's markup. Kept last and
 * kept narrow: these are the containers the five common Shopify review apps
 * put the review BODY in, not their outer wrappers, because the wrappers pull
 * in star widgets and reply forms too.
 */
const APP_PATTERNS = [
  /class=["'][^"']*\bjdgm-rev__body\b[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/div>/gi,      // Judge.me
  /class=["'][^"']*\byotpo-review-content\b[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/div>/gi, // Yotpo
  /class=["'][^"']*\bstamped-review-content-body\b[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/div>/gi, // Stamped
  /class=["'][^"']*\bloox-review(?:-text)?\b[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/div>/gi, // Loox
  /class=["'][^"']*\boke-review-content\b[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/div>/gi,   // Okendo
  /class=["'][^"']*\bspr-review-content-body\b[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/div>/gi, // Shopify Product Reviews
];

function fromReviewApps(html) {
  const out = [];
  for (const re of APP_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) && out.length < MAX_REVIEWS) {
      const text = clean(m[1]);
      if (looksHuman(text)) out.push({ text, rating: null, author: '', date: '', via: 'review-app' });
    }
  }
  return out;
}

/*
 * Everything we can find on the page, best-evidence first and deduplicated.
 *
 * Never throws. This runs inside product resolution, and a product page that
 * happens to have unparseable review markup must still resolve as a product.
 */
export function extractReviews(html) {
  if (!html || typeof html !== 'string') return [];
  let found = [];
  try {
    found = [...fromJsonLd(html), ...fromMicrodata(html), ...fromReviewApps(html)];
  } catch {
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const r of found) {
    // Same review is routinely emitted as both JSON-LD and app markup.
    const key = r.text.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= MAX_REVIEWS) break;
  }
  return out;
}

/*
 * Corpus documents, in the shape docs.mjs already defines.
 *
 * source 'reviews' rather than 'reddit' so the report can say where a quote
 * came from, and so a receipt on the product's own page is never presented as
 * if a stranger in a forum said it.
 *
 * A star rating is not a score in the corpus sense: an upvote count means other
 * people agreed with the comment, a 5-star rating means one person liked the
 * product. Low ratings carry the objections, which is the thing worth reading,
 * so a 1-star review is weighted UP here rather than down.
 */
export function reviewDocs(reviews, productUrl, productTitle) {
  return (reviews || []).map((r, i) => ({
    source: 'reviews',
    kind: 'review',
    externalId: `${productUrl}#r${i}`,
    channel: productTitle || 'product page',
    text: r.text,
    score: r.rating == null ? 1 : Math.max(1, Math.round(6 - r.rating)),
    url: productUrl,
    createdUtc: 0,
  }));
}

# Handoff: the research-led pivot

Written for whoever picks this up next. Read this before touching the home page,
the report renderer, or anything that quotes a price.

---

## 1. What this product is now

Hexa used to be a done-for-you AI video agency selling to creators. It is now a
self-serve tool selling to **anyone with a product** (Shopify merchants are the
biggest slice, but the entry never assumes Shopify).

The whole pitch is one sentence: **we find out what your market wants, then make
the ad from what we found.** Research is the product; the ad is the deliverable.

The chain, end to end:

```
product link / photos / Shopify catalogue
  -> read the product page
  -> read what customers say        (Reddit corpus + the product's own reviews)
  -> read what competitors run      (Meta Ad Library via Apify, with run dates)
  -> call the format                (video or statics, measured)
  -> find the angle                 (loudest complaint no competitor answers)
  -> make the ad                    (first one free)
```

Everything on the site should serve that chain. If a section argues for creator
audience growth, video runtime as a headline feature, or "our custom pipeline",
it is left over from the old business and should go.

---

## 2. Run it locally in 30 seconds

The report and the studio both only exist after a backend call, which used to
make every change to them a guess. There is now a fixture server:

```bash
node tools/devstub.mjs &     # site + stubbed Netlify functions on :8901
```

| URL | What |
|---|---|
| `http://localhost:8901/` | home |
| `http://localhost:8901/validate?url=https://example-store.com/products/portable-blender` | the report |
| `http://localhost:8901/index.html?open=choose` | the goal chooser |
| `http://localhost:8901/__stub` | switch fixture mode |

Fixture modes matter. `full` = signed-in report with competitor legs. `anon` =
the free read, which has angles but **no** competitor data. `building` = never
finishes, so the progress UI can be watched. The anonymous case is the one that
was silently broken for months; check it whenever you touch the renderer.

### Tests

```bash
node tools/uitest.mjs            # 24 functional checks, real clicks in real Chrome
node tools/uitest.mjs --only 7   # one check
node tools/uitest.mjs --shots    # + captures at 390/768/1440
node tools/uiaudit.mjs           # design audit: collision, alignment, tap targets
```

Both use `puppeteer-core` (a devDependency) driving the Chrome already installed,
resolved from a candidate list. Not `puppeteer`, which bundles its own Chromium
into a `node_modules` that is already 104M, and this repo publishes from `.`.

**Keep these green.** They exist because a screenshot cannot tell you that a
button does the wrong thing, and half the flows here had only ever been looked
at.

---

## 3. Sources of truth (get these wrong and you charge the wrong amount)

Prices live in **three places that must agree**:

1. `catalog/pricing.json`, `retail_usd` per product. **This is authoritative.**
   `netlify/functions/lib/pricing.js` reads it and computes the real charge.
2. `studio.js`, where `MODE_CONFIG` and `PRODUCTS` mirror it for display only.
3. `index.html`, which must never hardcode money. Bind to `data-price`,
   `data-price-base`, `data-price-credits`, `data-price-extra`,
   `data-price-lo/hi`.

**Stripe needs no changes when prices move.** `create-checkout.js` builds
`price_data` with `unit_amount` per session, so there are no Price IDs to sync
for studio orders. (The `STRIPE_PRICE_*` env vars belong to the old $59/$129
offer funnel on `offer.html`, which is separate.)

Current: `$9` scroll-stopping, `$15` creator, `$25` premium, `+$8` per extra 15s,
500 credits to the dollar. Verify after any change:

```bash
node -e "const{priceStudioOrder}=require('./netlify/functions/lib/pricing.js');
console.log(priceStudioOrder({product:'mode:ugc',selections:{duration:30}}))"
# expect amountCents: 2300
```

The home page previously said `+$12` in two places and quoted a `$12 to $29`
range when the code said `8` and `$9 to $22`. It drifted because it was typed
twice. Do not type prices.

---

## 4. Hard rules

- **Never deploy without Chris saying yes.** Draft deploys count as deploys.
- **No em dashes or en dashes in shipped copy.** `validate.js`'s `voice()`
  strips them from model output; everything else is on you. Sweep before
  finishing: `grep -n '—\|–' index.html validate.html *.css`
- **`publish = "."` means every file in the working tree ships.** `.gitignore`
  does not protect you: the Netlify CLI deploys the *directory*, not the git
  tree. `.env`, `research/`, `supabase/` and the internal `.md` files are held
  back by forced 301s in `_redirects` and nothing else. **Anything you add to
  the root holding a credential needs a line in `_redirects` the same day.**
  The real fix is to stop publishing from the repo root; nobody has done it.
- **Never invent proof.** No fabricated metrics, no "62% of people pick wrong"
  until picks are actually counted. This matters more here than on a normal
  product, because the entire pitch is "we do not guess".

---

## 5. What changed this session

**Free research was broken.** `report-build-background.mjs` skipped the angles
synthesis unless signed in, so `recommendation()` returned null and a signed-out
visitor got quotes and no answer. Angles now run for everyone on the cheaper
model; the Apify pull stays gated. Cost holds: of $0.615 for a deep report,
$0.466 is Apify and only $0.149 is tokens.

**The gate stopped being a blur.** It hid conclusions we had already reached,
and on a free read the blurred sections were mostly empty anyway. It is now
`unlockCard()` in `validate.js`: a named offer for the competitor legs we have
genuinely not run.

**Report reads as answers, not a document.** `summarySection` (what we found),
answers-first `recommendation`, `strengthSection` (Demand/Competition/
Opportunity as words with the numbers under a disclosure), plain-language
headings, and a "Why are you saying this?" fold.

**Studio speaks in outcomes.** The chooser opens on "What do you want the ad to
do?" with six goals (`GOALS` in `studio.js`), `Let Hexa choose` leading. The
style library is folded away and regrouped by perception ("Feels authentic",
"Looks expensive") instead of by engine family.

**Onboarding.** "What are you selling?" plus three equal entry tabs (link,
photos, Shopify). Photos were previously a text link at the bottom.

**Guess the angle** (`#guess`, data in `catalog/guess-angles.json`). Real
product, three angles, and the wrong answers are what competitors actually
advertise. Every number is from a real read.

**Point 8, first leg: the product's own reviews.** `research/lib/reviews.mjs`
extracts them from JSON-LD, microdata and six review apps, off HTML already in
memory. Reviews get their own kind in `buildEvidence` and their own attribution
in the renderer, because a review must never be drawn as `r/something`.

**Deleted:** the creator case study, the "custom pipeline" spec section, the
guided-start quiz band. **Rewrote:** proof bar, done-for-you (now framed by who
it is for), pricing, closer.

---

## 6. Outstanding, roughly in priority order

1. **The money path has never actually run.** Checkout, render and the credit
   debit are all stubbed in tests. The pricing oracle is unit-verified but no
   real order has gone through at the new prices.
2. **`offer.html` and `offer-eco.html` still sell the entire old offer**:
   creator positioning, $59/$129 tiers. They are live ad landing pages, so they
   currently contradict the site.
3. **Untested and unaudited pages:** `render.html` (where people watch their ad
   build), `account.html`, login, intake, thanks, order-confirmed. Only `/` and
   `/validate` have been driven.
4. **Point 8 remaining legs:**
   - *YouTube.* `research/lib/youtube.mjs` works but shells out to
     `python3 -m yt_dlp`, so it cannot run on Netlify. Right route: the offline
     harvester writes into the shared Supabase corpus, which every report
     already reads. The corpus is source-agnostic, so nothing downstream changes.
   - *Competitor landing pages.* The ads pull already returns `landingDomain`
     per ad. Fetching those and extracting their claims would tell us what
     competitors *say*, not just which ads survive longest, and would strengthen
     `findWhitespace` directly.
5. **`account.html:453`** still says "your film".

---

## 7. Traps that already cost time

- **Element screenshots lie.** `element.screenshot()` captures content still
  below the fold, which the `data-reveal` system has correctly hidden. Twice
  this looked like a layout bug and was not. Verify by scrolling the element
  into view and reading computed opacity.
- **The audit has a matching blind spot:** it skips zero-opacity elements as
  "not visible", so it cannot distinguish "hidden pending reveal" from "broken,
  never shows". Worth fixing.
- **Closed `<details>` keeps a full-size box in Chrome.** `display` is still
  `block` and `getBoundingClientRect()` returns real dimensions, so naive
  overlap detection reports every collapsed FAQ answer as a collision.
  `uiaudit.mjs` filters for this; do not remove that filter.
- **Headless Chrome reports `pointer: fine`** unless you set
  `hasTouch/isMobile`, so `@media (pointer: coarse)` rules never apply and 44px
  tap-target floors look broken when they are not.
- **`timeout(1)` does not exist on macOS.** Give any browser launch its own
  watchdog; a hung one costs two minutes.
- **Grid columns outliving their content.** The pricing track was
  `repeat(4, 1fr)` after dropping to three cards, leaving a dead column and
  277px cards in a 1400px viewport. Same class of bug as the old spec section's
  300px dead column. When you remove a card, check the track.
- **Reusing a Chrome `--user-data-dir` between runs** hangs the launch.

---

## 8. Conventions worth matching

Comments in this repo explain **why**, not what, and frequently record what was
measured and when ("measured 2026-08-14, 698 records produced zero angles purely
because this line was missing"). That habit is the reason several non-obvious
bugs were findable at all. Keep it.

`validate.css` owns the report components (`.vd-call`, `.ev-card`, `.fmt-card`).
The home page loads it so its worked example uses the *real* components rather
than lookalikes. That stops the styling drifting; it does **not** stop the copy
drifting, and it already did once. If you change report wording, check the home
page sample too.

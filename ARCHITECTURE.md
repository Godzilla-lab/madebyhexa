# Hexa: what we built, and how we build it

Internal document. Not served publicly (blocked in `_redirects`).
Last written 2026-08-14 against the working tree at commit `c048b03`.

---

## 1. What this is now

It started as a static portfolio for AI-generated brand content. It is now a
self-serve product with three connected halves:

1. **Validate.** Paste a product link and get back what the market actually
   says about that category, which competitor ads have survived long enough to
   count as proof, and the angles worth running. Evidence-backed, not vibes.
2. **Create.** Pick an angle and a format, and the same link is turned into a
   finished video or a pack of static ads on real generation engines.
3. **Deliver.** The result lands in a permanent library tied to an account,
   with credits, revisions, post-render actions and a receipt trail.

The one-line pitch that shapes every technical decision: **help a seller work
out what will sell, then make it.** Everything below is in service of that.

Public site: `madebyhexa.co`. Hosting is Netlify (static publish plus
functions), the database and auth are Supabase (EU/Frankfurt), payment is
Stripe, and generation runs on Higgsfield.

---

## 2. Shape of the system

```
  browser                        netlify functions                 outside
  ────────────────────────────   ─────────────────────────────    ──────────────
  index.html   (studio)          product-peek        ───────────► product page /
   studio.js                     report-create                     Bright Data /
   script.js                       └► report-build-background ───► Higgsfield
                                  report-status                    scraper
  validate.html (research)        render-create       ───────────► Higgsfield API
   validate.js                    render-status                    Apify (Meta
                                  render-revise                    Ad Library)
  render.html  (progress)         stitch-master-background          xAI /
   render.js                      create-checkout     ───────────► Stripe
                                  stripe-webhook      ◄───────────
  account.html (library)          account-creations                Zoho SMTP
   account.js                     account-export / -delete
                                  shopify-install / -callback  ──► Shopify OAuth
  login.html   (auth)             shopify-products
   auth.js                        drip / welcome-now / drip-unsub
                                  ads-recheck (scheduled)
                                  track-conversion    ───────────► Meta / TikTok
                                        │
                                        ▼
                                   Supabase (EU)
                        profiles, orders, creations, reports,
                        credit_ledger, research_docs, ad_survival,
                        store_connections, brand_profiles
```

Rough scale: about 18k lines of front-end JS/CSS/HTML, 7.5k lines of Netlify
functions, 3.7k lines of research engine, 1.2k lines of SQL.

---

## 3. Front of house

No build step anywhere. Plain HTML, CSS and ES5-flavoured JS served straight
off Netlify. That is a deliberate constraint: the site has to be editable at
2am without a toolchain, and every page is one file you can open.

| Surface | Files | What it is |
|---|---|---|
| Home / studio | `index.html`, `studio.js`, `studio.css` | The studio **is** the homepage. Composer hero at the top, everything below it sells. `/studio.html` 301s here. |
| Research | `validate.html`, `validate.js`, `validate.css` | Paste link, watch the progress list, read the report. Chosen angles are handed to the studio through `localStorage` (`hexa-angle`, 1 hour TTL). |
| Render | `render.html`, `render.js`, `render.css` | Post-payment progress screen. Polls `render-status`, shows real stage names. |
| Account | `account.html`, `account.js` | Library, credit balance and ledger, Shopify connection, settings, GDPR export/delete. |
| Auth | `login.html`, `auth.js`, `nav-auth.js` | Supabase auth with codes instead of magic links, branded email templates in `supabase/email-templates/`. |
| Offer pages | `offer.html`, `offer-eco.html` | Paid-traffic landing pages, message-matched per campaign, tracked separately. |
| Legal / support | `terms`, `privacy`, `refund`, `thanks`, `order-confirmed`, `intake`, `deck` | Real pages, not filler. `/deck` is the investor deck. |

The studio renders every rail from `catalog/studio-data.json`, which is a live
export from the generation backend rather than hand-written copy. Each control
maps one to one onto a generation parameter, so what the customer picks is
literally what the engine receives.

---

## 4. The generation backend

### The engine adapter (`netlify/functions/lib/hf.js`)

One small client for Higgsfield's `/developer/v2alpha` surface, with a
three-tier auth ladder:

1. Long-lived Cloud API key (`HF_KEY_ID` + `HF_KEY_SECRET`), no expiry.
2. OAuth token with self-refresh. The 24h token in env goes stale by tomorrow,
   so the client mints new ones against Clerk with a refresh token and stores
   the newest grant in Netlify Blobs, so every function instance shares it.
3. The static env token, as a last resort.

The rule this encodes: **nobody should ever have to paste a fresh Higgsfield
token again.** A 401 re-mints and retries once, so a revoked token is a hiccup
rather than an outage.

### Orders to jobs (`render-create.js`, 1.5k lines)

The studio composes an order, this turns it into real jobs. Notable behaviour:

- **Length beyond the engine's ceiling.** One engine output caps at 15
  seconds. Longer orders are split into 15s segments with one continuous
  storyboard, one prompt per segment, and the same avatar, setting and voice
  locked across all of them, then stitched server-side into one file by
  `stitch-master-background.js`. Nobody else in this lane sells that.
- **ffmpeg is not bundled.** A CLI deploy would ship this Mac's binary, which
  is useless on Netlify's Linux. The function verifies whatever it finds with
  `-version` and self-installs the pinned Linux build to `/tmp` when needed.
- **Static ad packs** use Higgsfield's DTC Ads formats from
  `catalog/higgsfield/ad-formats.json`. The `style_id` is the point: passing it
  reproduces the exact layout of Higgsfield's published sample with the
  customer's product in it, which makes a preview on our site an honest promise
  rather than decoration.
- **Review-shaped formats are quarantined.** 11 of the 39 formats stage a
  fabricated testimonial (invented reviewer, rating, helpful count). Publishing
  fabricated endorsements is the customer's legal problem, so those unlock only
  when real review text is supplied. The remaining 28 comfortably cover a 20
  creative pack.
- **Spending is gated.** The endpoint refuses unless the request carries a dev
  key or a Stripe session that is genuinely paid and whose amount covers the
  server-priced order. Job ids are stamped onto the payment intent's metadata,
  so replaying a session returns the same jobs instead of spending twice.

### Polling (`render-status.js`)

Aggregates every segment into one status, step and percentage. The important
distinction it makes: a film is one product cut into pieces (one failure kills
the deliverable), but a 20 creative ad pack is 20 independent products.
Measured on production 2026-08-14: nineteen completed jobs plus one failure
returned zero images and refunded the whole order. Over twenty jobs, even a
modest failure rate makes that the usual outcome, so independent job types
now deliver what succeeded and refund only the rest.

### After delivery

- `render-revise.js`: free re-rolls on a delivered set, with the allowance
  counted server-side (`creations.revisions_used`), because "no reject fees" on
  the pricing page still costs us about two credits an image.
- Post-render actions: revoice, translate, upscale, priced flat because they
  run on one finished clip.

---

## 5. The research engine (Hexa Validate)

This is the newest and largest piece, and the one that differentiates the
product. It lives in `research/` as a CLI and is imported by the Netlify
worker, so both paths cannot drift into producing different reports.

```
research/
  validate.mjs        the CLI: resolve -> plan -> retrieve -> synthesise -> report
  lib/product.mjs     URL -> product facts, cheapest-first ladder
  lib/reddit.mjs      Arctic Shift: subreddit discovery, search, comment trees
  lib/youtube.mjs     yt-dlp search + comment mining
  lib/ads.mjs         Meta Ad Library competitors, ranked by days running
  lib/corpus.mjs      the memory (SQLite + FTS5, local)
  lib/corpus-supabase.mjs  the same memory in Postgres, for production
  lib/llm.mjs         model routing: cheap workers, expensive synthesis
  lib/cost.mjs        per-run cost meter
```

### The product URL ladder

Cheapest first, and we only pay when the free tiers fail:

1. Shopify `/products.json`: free, instant, covers most DTC.
2. Direct fetch: free, covers about two thirds.
3. Higgsfield's scraper: already paid for, reads pages we cannot.
4. Bright Data Web Unlocker: new spend, only for what 1 to 3 could not read.
5. Wayback: last resort.

About a third of real DTC storefronts refuse a datacenter fetch (measured:
oura.com 403, ridge.com 403, vessi.com refused). The unlocker gets all three to
200. It takes 5 to 20 seconds, which is why it never sits inside the 10 second
paste request: callers either race it with a small budget or run it in the
background and let the existing poll collect the result. Results are cached per
URL in Blobs, so a page is unlocked once for everybody.

### The memory, which is the whole cost story

Everything the engine reads is written to the corpus once and reused forever.
Measured on the same category, 2026-08-13:

| | Cold (first look) | Warm (category already held) |
|---|---|---|
| Retrieval | 596s, ~500 throttled requests | **0.5s, zero network** |
| Synthesis | 68s | 68s |
| Total | 626s | **82s** |

The second seller in a category is therefore nearly free to research. That fact
is what makes an anonymous free tier affordable at all, and it decides the
free/deep gate:

- warm category: answer from the corpus, for anyone, cheaply.
- cold and signed in: go and harvest properly. Minutes, and real money.
- cold and anonymous: stop and say so honestly.

Production runs on Postgres full text search (`research_docs`, migration 004)
rather than SQLite, because a serverless filesystem is not somewhere to keep
growing state. The `tsv` column is generated, so it cannot drift from `text`.

### Two rules that make a report worth paying for

**No receipt, no claim.** The model never writes a quote. It cites evidence by
id (`c12`, `p3`) and the renderer resolves those ids against the real corpus.
An id that does not exist is dropped, and a finding with no surviving evidence
is not drawn at all. This is enforced twice, in the CLI renderer and again in
`validate.js`, so a malformed or over-confident payload cannot put an
unsupported claim in front of a customer.

**No corroboration, no conclusion.** A claim needs at least 3 independent
supporting records to print as a finding. Below that it appears under "weaker
signals", labelled as a lead. Each finding carries its own count ("31 people
raised this independently across 5 communities"), which is also the
persuasion: a count is harder to wave away than one well-chosen quote.

### The format verdict, computed not guessed

"Video or static?" is arithmetic with no model involved:

- The weak signal is the raw split of all ads.
- The strong signal is the split among ads past 90 days, because duration is
  proof of what advertisers keep paying for.
- Untyped ads are excluded, never bucketed. A ratio over guesses is worse than
  no ratio. Reading `displayFormat` alone would have thrown away two thirds of
  a real sample (21 of 30 came back `DCO`, a delivery mode, not a creative
  type); the real type lives in `snapshot.cards[]`.
- Below the sample gate (20 typed ads, 8 past 60 days) there is no verdict and
  the report says so. That is an answer, not a failure.

### The date rule

Run duration is the core proof signal, so it carries provenance: `reported`
(explicit duration or end date), `observed` (real start date on a live ad, so
days-running is arithmetic on two facts), or `none`, in which case the UI shows
no duration at all. Never inferred, never estimated.

### The gap analysis

At the end of a deep report we hold both what the market complains about and
what competitors advertise, for the same category, in the same object. So we
can subtract: a complaint raised by twenty people that appears in one ad out of
eighty is a gap worth attacking, and a complaint every competitor already
answers is a crowded lane worth avoiding. Customer-research tools cannot see
the ads; ad-intelligence tools cannot see the buyers. Almost nobody can do this
subtraction.

### Why it is a background function

`report-create.js` is deliberately thin: decide who may ask, check whether we
already have the answer, create a row, hand back a handle. The real work goes
to `report-build-background.mjs` (1.2k lines), which has minutes rather than
the ten seconds a synchronous function gets. `report-status.js` is polled by
the browser and turns the worker's `step` column into the line the visitor
reads, because a progress bar with nothing behind it is how people conclude a
page has hung and leave.

Reports are cached for 14 days per URL: research about a product does not
change between two people asking on the same afternoon, so the expensive path
runs once per product rather than once per visitor.

### The survival loop (`ads-recheck.mjs`, scheduled)

Daily, for a small number of categories at a time (4 categories x 40 ads is
about $0.93 a day), we ask the Ad Library again and record whether tracked ads
are still running. It cannot see spend, CTR or ROAS: none of that is public.
It can see survival, which is the same reasoning the format verdict already
uses, now turned on our own output. **Survival is reported as survival and
never as profit**, and the copy has to say so.

---

## 6. Money

### Two credit denominations, do not confuse them

- **Higgsfield credits** are our cost side. `catalog/pricing.json` records the
  measured cost per job and the rate ($0.052/credit on the current top-up plan,
  used as a conservative floor).
- **Hexa credits** are what the customer buys. 1 credit = $0.002, so 500
  credits to the dollar. Deliberately fine grained because large numbers read
  as more generous, with the dollar figure always shown at purchase, since
  hiding the second conversion is the documented way credit products lose
  trust.

### The pricing oracle

`catalog/pricing.json` is the single source of truth: per item engine, measured
cost in credits, cost in dollars, retail, margin and ETA. 18 priced items, from
a $9 hyper-motion clip at 80% margin to $22 cinematic at 60%.
`netlify/functions/lib/pricing.js` turns an order into an authoritative charge.
`studio.js` mirrors the same maths for display only; the client's price is
never trusted. `create-checkout.js` reprices server-side before it creates a
Stripe session.

### The ledger (migration 003)

A ledger, not a balance column. Balance is the sum of the rows, which makes a
refund a new row instead of a read-modify-write, makes "why is my balance 400"
answerable, and survives two renders finishing at once. Kinds: `grant`,
`purchase`, `spend`, `refund`, `adjust`.

Charging happens at create, not on completion, because that is when the engine
bills us (measured 2026-08-14: DTC Ads charges the moment a job is accepted).
Mirroring that is honest, and it forces the refund path to exist, which it must
anyway: **failed generations quietly eating a customer's allowance is the
single best documented way to kill a credit product.**

The rules that protect money live in the database, not the application, because
application code cannot make a decision and an insert atomic across two
concurrent webhook deliveries and the database can:

- unique index on `(kind, ref)` so a refund happens once,
- unique index on `ref where kind = 'purchase'`, so Stripe retrying a webhook
  (its own schedule, a timeout that actually succeeded, a manual replay) cannot
  grow a balance every time Stripe gets nervous,
- `credit_spend` / `credit_refund` / `credit_purchase` as `security definer`
  RPCs, because RLS forbids every browser-side write to the ledger: an account
  that could insert its own rows could grant itself credits.

### Checkout and delivery

`create-checkout.js` handles legacy tiers, studio orders and credit packs.
EU digital goods rules mean the buyer has to actively waive the 14 day
withdrawal right before instant delivery, rendered by Stripe as an un-pre-ticked
required checkbox.

`stripe-webhook.js` is the delivery safety net. The happy path works without it
(success URL to `render.html?paid=...`), but that depends on the customer
keeping a tab open. The webhook closes the "paid, closed the tab, saw nothing"
case by emailing the order summary and a permanent recovery link, which
re-attaches to the same jobs through the payment-intent stamp so it can never
double-spend.

---

## 7. Data and accounts

Supabase, EU region. Every table has RLS on. The browser anon key plus a user's
JWT can only ever touch that user's own rows; functions use the service role
key for privileged writes, and it never ships to the browser.

| Table | Holds |
|---|---|
| `profiles` | One row per auth user, auto-created by trigger on signup, which also writes the welcome credit grant. |
| `orders` | One row per checkout: pending, paid, refunded, failed. |
| `creations` | The permanent library. Job ids, engine, type, prompt, result URLs, revision count. |
| `reports` | Validation output: product, verdict, demand signal, format verdict, full payload, evidence count, step, and a `claim_token`. |
| `credit_ledger` | Append-only credit movements. |
| `research_docs` | The shared corpus with a generated tsvector. |
| `ad_survival` | Ads we recommended and competitor ads, re-measured over time. |
| `store_connections` | OAuth tokens from connected stores. |
| `brand_profiles` | Tone, audience, banned words, per account. |

Two design notes worth keeping:

**Anonymous reports get a `claim_token`, not a user id.** The free report is
the top of the funnel and a login in front of it would defeat the point. The
token is exchanged for a user id at sign-in, which is what makes "sign in to
keep this" work without regenerating anything.

**Brand memory holds voice, never claims.** Tone, vocabulary and audience shape
how something is said. What is actually true about the product still comes from
the product page and the research, because a brand memory that could assert
"clinically proven" would launder an unevidenced claim into every creative we
make.

### The store token, and a security lesson worth writing down

`store_connections` holds a merchant access token: the most sensitive thing
this system stores, since it reads a real catalogue, does not expire on its
own, and is useless to us but valuable to anyone else. Platform is a **column,
not a table name**, so adding the second platform is a row value rather than a
migration against live credentials.

The first design gave the table no SELECT policy at all, on the theory that
"the browser reads a view without the token". Measured against a real session
on 2026-08-14, that broke both things the owner actually needs: the view
returned 0 rows and no error (a security_invoker view inherits the caller's row
visibility, and with no SELECT policy there is nothing to see), and delete
returned 204 having removed nothing (Postgres has to see a row to evaluate a
DELETE's WHERE clause). Both were the same mistake: **row-level security was
being used to hide a column.** Migration 012 fixes it properly, with RLS
deciding rows and column-level GRANTs deciding columns, leaving `access_token`
out of the grant so "select access_token" is refused by the privilege system
before any policy is consulted. That is a stronger guarantee than the view gave
us, because it holds for every query shape.

Migrations 010 and 011 are the same instinct applied to everything Supabase's
advisor flagged: pin every function's `search_path`, drop the orphan table from
an earlier draft (verified empty first), revoke public execute on trigger
functions, and replace the last `security definer` function a signed-in user
could call with a plain DELETE policy, because "safe because the body is
written correctly" is weaker than "the database will not permit anything else".

---

## 8. Integrations, and what each one is for

| Vendor | Used for | State (measured 2026-08-13/14) |
|---|---|---|
| Higgsfield | All generation, plus a product scraper tier | Live, self-refreshing tokens |
| Supabase | Auth, database, RLS | Live, EU |
| Stripe | Checkout, webhooks, refunds | Live |
| Apify | Meta Ad Library pulls | Working. 30 ads in 25.6s for $0.174, $0.0058/ad |
| Bright Data | Web Unlocker for blocked product pages | Zone configured, $0.0015/call. No Meta Ad Library dataset exists on the account (checked all 1,737), so it does not replace Apify on the ads leg |
| xAI / agentrouter / Anthropic | Report synthesis | `lib/llm.mjs` picks the first configured provider: Anthropic, then agentrouter, then xAI. Currently running xAI. A direct `ANTHROPIC_API_KEY` is still the one worth having: reference path, published rate card, no third party in the middle of customer research |
| Arctic Shift (Reddit) | Voice of customer | Free, no auth, about an hour behind live |
| yt-dlp | YouTube comment mining | Free, no API key |
| Shopify | Catalogue browsing instead of pasting links | OAuth built, `read_products` only |
| Zoho SMTP | All outbound mail | Configured, currently paused |
| Meta / TikTok | Server-side conversion tracking | `track-conversion.js` |

### Shopify, specifically

`shopify-install.js` does three things: validate the shop is a real Shopify
hostname, mint a nonce, redirect to consent. The hostname regex matters more
than it looks: the value is interpolated into a redirect URL, so a loose check
is an open redirect. The nonce is set as a signed HttpOnly cookie and checked
in `shopify-callback.js`, because without one anybody could hand a signed-in
user a crafted callback and attach their store to the victim's account.

Scope is `read_products` and nothing else. Every extra word on a consent screen
costs installs, and staying at read_products keeps us clear of Shopify's
protected customer data rules entirely.

Pasting a link stays the primary way in and always will be. A store connection
is a convenience on top, never a requirement.

---

## 9. Operational posture

**Runtime is pinned.** `NODE_VERSION = 22` in `netlify.toml`, not left to
Netlify's rolling default, because the research CLI uses `node:sqlite` (Node 22
only) and the functions lean on `fetch`, `structuredClone` and top-level await.
An unpinned runtime means a cold start can fail on a builtin that is simply not
there, and the first sign would be a background worker that never reports.

**Exposure is explicitly blocked.** `_redirects` 301s every internal path to
`/`: `leads/`, `comments/`, `transcripts/`, `tools/`, `netlify/`, the strategy
markdown files, and both `supabase/*` and `research/*`. `schema.sql` was being
served at 200 on 2026-08-13, which meant table names, columns and the RLS
policies standing between the anon key and customer rows were public. Migrations
leak the same thing one diff at a time. `catalog/*` is blocked except the three
files the browser genuinely needs, so pricing margins, prompt recipes and raw
engine exports stay private.

**Images go through the CDN.** Scraped product images are multi-hundred-KB cold
PNGs on CloudFront that take 10s+ to load. `product-peek` rewrites them to
`/.netlify/images?...` so the browser gets a small cached webp, with the hosts
allowlisted in `netlify.toml`.

**Asset weight is checked before every deploy.** Raw video exports once burned
through Netlify credits and got the site suspended. The verified recipe is CRF
25 to 26 for video and WebP q82 for stills, and hero clips sit around 2MB.

**Rate limiting** (`lib/ratelimit.js`) sits in front of every function that
costs money or scrapes.

**Ownership checks return 404, not 403.** A report id is a uuid in a URL and
proves nothing, so a caller either holds the claim token or owns the row. A 403
would confirm the id exists.

---

## 10. How we work

These are the standing rules, and they are why the codebase reads the way it
does.

1. **Measure before you price, and record the date.** No rate, cost or margin
   ships until a real run has produced it. Comments carry the measurement and
   the day it was taken ("measured 2026-08-14"), so a stale number is visibly
   stale rather than quietly wrong.
2. **The comment records the reasoning, not the mechanics.** Every non-obvious
   file opens with why it exists, what it refuses to do, and what would break
   if someone changed it. The migrations are the clearest case: each one argues
   its case before it writes a line of SQL. This is the actual design document,
   and it is why an agent picking the repo up cold can be useful in minutes.
3. **Cheapest tier first, pay only when free fails.** The product ladder, the
   corpus, the report cache and the ads budget are all the same pattern.
4. **Long work goes to a background function.** Anything past ten seconds gets
   a row, a step column and a poll, so the customer sees progress instead of a
   spinner with nothing behind it.
5. **Money rules live in the database.** Uniqueness and constraints, not
   application checks, because only the database can be atomic across
   concurrent deliveries.
6. **Never let bookkeeping break delivery, and never let a failure charge
   silently.** Persisting a library row, writing a progress label or logging a
   cost may fail quietly. A spend that did not deliver must always refund.
7. **No claim without a receipt.** Enforced in the renderer, twice.
8. **Investigate, do not interrogate.** Check the running code and the site,
   make the routine call, and only ask when either answer would be unsafe or
   waste real work.
9. **Never deploy without an explicit yes.** Draft deploys count as deploys.
10. **No em dashes or en dashes in shipped copy.** Models reach for them
    constantly, so `validate.js` strips them at the render layer rather than
    trusting a prompt to behave.

---

## 11. State of play

**Live on `madebyhexa.co`:** the studio and homepage, auth and accounts, the
library, Stripe checkout, the render backend including multi-segment stitching,
post-render actions, the product peek, offer pages and legal pages.

**Built and in the working tree, not yet committed:** this is the large batch.
The validation engine (`research/`, `validate.*`, `report-create`,
`report-build-background`, `report-status`), the credit system (`credit-packs`,
ledger migrations, top-up flow in the account page), Shopify connect
(`shopify-install`, `shopify-callback`, `shopify-products`), the Bright Data
unlocker, `render-revise`, `ads-recheck`, and migrations 001 through 012. The
last commit on `main` is `c048b03`.

**Paused on purpose:** all outbound mail. `mailer.js` refuses to send unless
`MAIL_READY=1`, which is unset while the Zoho subscription is pending. The drip
does not burn steps while paused.

**Known gaps:**

- Synthesis, not scraping, is now the bottleneck. A warm report is 82s, of
  which 68s is a single model call over 110k tokens of evidence. The sections
  already run in parallel; streaming them to the page as they land is what
  turns time-to-complete back into time-to-first-insight, and it is the
  remaining work before the under-60s target is met.
- No `ANTHROPIC_API_KEY` is set, so reports currently synthesise on xAI.
- Apify's free cap is roughly 862 ads a month, about 28 reports at 30 ads each.
  Pointing the Bright Data unlocker at the public Ad Library directly is priced
  per request rather than per ad, and is the next thing worth testing.
- Higgsfield credit balance needs topping up before any volume of real renders.

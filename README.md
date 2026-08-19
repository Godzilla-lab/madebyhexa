# Hexa

Paste a product link. Hexa reads that product's market, decides the angle and
the format from what it finds, and makes the ad around it.

Live at [madebyhexa.co](https://madebyhexa.co).

The order matters and is the whole product: **research first, ad last.** Every
other tool in this space starts at "describe your video", which moves the guess
from the merchant to a prompt box. Nothing here is written until the evidence
says what to write.

## How a read actually runs

```
browser ──▶ report-create ──▶ report-build-background ──▶ report-status ──▶ browser
             thin: rate limit,      the real work,             polling
             cache, insert row      minutes not seconds
```

1. **Resolve the product.** Title, price, description, images, scraped from the
   page. An unreadable page is its own answer and stops here.
2. **Plan.** One LLM call names the market and the search terms. The category is
   a corpus key that outlives the report, so it may never contain a brand name.
3. **Warm or cold.** `research_categories` is checked. Warm means we already
   hold the discussion and answer from memory in seconds for almost nothing.
   Cold means going and reading it: subreddit discovery, throttled harvest,
   competitor ads from the public ad library.
4. **Synthesise.** Pains and wishes with receipts, the format verdict, and the
   angles: what buyers keep raising that no competitor ad answers.

Cold harvests are written back into the corpus, so a market is paid for once
and every later reader is served warm.

## Money

Credits, at 500 to the dollar. A new account is granted 2,500.

**Only a cold read is charged** (1,000 credits), and the charge happens in
`report-build-background`, at the seam where the category is known and nothing
expensive has run yet. This is deliberate: `report-create` cannot know whether
a market is warm, because that answer needs the planning call. Charging there
billed the cold-harvest price for reads answered entirely from memory.

Warm reads are free. Cached reports are never charged. Every path that fails to
deliver refunds, idempotently, on the ledger's unique index over `(kind, ref)`.

## Layout

```
*.html *.css *.js         the site. No build step, no framework, no bundler.
netlify/functions/        the backend. report-*, render-*, stripe-webhook, drip.
netlify/functions/lib/    shared: supabase, auth, ratelimit, mailer, blobs.
research/                 the engine. validate.mjs plus lib/ (llm, corpus,
                          reddit, ads, product, reviews, cost).
supabase/migrations/      schema, RLS and the credit ledger functions.
catalog/                  studio data, presets, credit packs, showcase.
tools/                    test suites and audits. Run these before shipping.
assets/                   media. Check the weight before every deploy.
```

## Running it

```bash
npm install
netlify dev            # pages and functions together, on :8888
```

Functions need the environment. `.env.example` lists every variable; `.env` is
gitignored and must stay that way.

`LLM_PROVIDER` pins the model chain. Set it to `xai` (the provider NAME, not a
key) or leave it unset to fall back to whichever provider keys exist. An
unrecognised value is logged loudly and ignored rather than thrown, because
this once took the whole engine offline at import.

## Before you ship

```bash
node tools/promptcheck.mjs     # prompt and provider contracts
node tools/moneytest.mjs       # pricing, credits, refunds
node tools/criticcheck.mjs     # the second read before the engine
node tools/uiaudit.mjs         # contrast, targets, layout
```

Then check the site itself: no JS errors, no 4xx, no horizontal overflow at
390px and 1440px, and no em or en dashes anywhere in shipped copy.

Deploying is `netlify deploy` followed by promoting that deploy, because the
plan blocks `--prod`. **Never deploy without being asked.**

## Conventions worth knowing before editing

- **The comments are the design record.** Where a value looks arbitrary, the
  comment above it usually says what was measured and what broke last time.
  `--text-faint` is 0.50 because 0.40 measured 3.74:1 and failed AA. Read
  before changing.
- **No em or en dashes in shipped copy.** Grep before finishing. The research
  engine sanitises them out of model output too.
- **Strict CSP.** `script-src 'self'`, so inline `<script>` is refused. New
  script goes in a real file.
- **Cost lives on the button that spends it**, never as a separate line beside
  it, and never on a tile where nothing is being committed to yet.

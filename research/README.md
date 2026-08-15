# Hexa Validate: the research engine

Paste a product URL, get back what the market actually says about that category,
which competitor ads are proven winners, and the angles to run.

```bash
node research/validate.mjs <product-url> [--subs 10] [--posts 45] [--no-ads] [--youtube] [--fresh] [--json]
```

The core job: **help a seller identify what will sell, and how to run the ads.**
Everything here is in service of that.

---

## Vendor state, measured 2026-08-13

Everything below was probed live against the real accounts, not read off a
pricing page.

| Leg | Vendor | State |
|---|---|---|
| Synthesis | agentrouter.org | **Working** on `gpt-5.6-sol`, including structured outputs. Its `claude-opus-5` and `claude-opus-4-8` answer "Budget pool quota has been exhausted" (their pool, not ours), so no Claude through it today. It also rejects any client that does not identify as the Claude Code CLI. |
| Meta competitor ads | Apify | **Working.** 30 ads in 25.6s for $0.174, all with evidenced run dates. |
| Blocked product pages | Bright Data | Token authenticates but the account has **zero zones**, so the unlocker cannot run yet. |
| Product scraping tier | Higgsfield | **Self-healing.** Mints its own token; see below. |

### Higgsfield tokens rotate themselves, and nothing here needs a human

The bare `HIGGSFIELD_TOKEN` in `.env` expires in about 24 hours, so a static
value is stale by tomorrow. That is not a Higgsfield problem, it was a gap in
this CLI: `netlify/functions/lib/hf.js` had already solved it, and
`lib/higgsfield.mjs` was not using the same answer.

It does now. The installed `higgsfield` CLI keeps its own Clerk session alive,
so `higgsfield auth token` mints a fresh token on demand, and that chain is
fully separate from `HIGGSFIELD_REFRESH_TOKEN`, so using it can never revoke
production's rotation. Order is: API key (never expires), then CLI-minted
token, then the static env token as a last resort. A 401 re-mints and retries
once, so a revoked token stops being an outage.

**Nobody should ever be asked to paste a fresh Higgsfield token again.**

Note the tier's real limit: Higgsfield's scraper is not a universal unblocker.
It returns `"No product images passed validation"` on pages it cannot pull
product images from, so it complements the ladder rather than ending it.

### The one thing that still needs a human

**Create a Web Unlocker zone** in the Bright Data control panel, then set
`BRIGHTDATA_UNLOCKER_ZONE` to its name. The token is already valid and in
`.env`, but `get_active_zones` returns `[]`, which is why the tier is dark.
Also grant the token permissions: `/customer/balance` currently answers
"Your API key lacks the required permissions for this action."

### Bright Data has no Meta Ad Library scraper

Checked all **1,737** datasets on the account. There is a Facebook Pages
scraper, Facebook Comments, Facebook Marketplace, Facebook Reels and a Google
Ads Transparency set, but **nothing for the Meta Ad Library**. So Bright Data
does not replace Apify on the ads leg the way the plan assumed. Two real
options, and the second is the one worth testing next:

1. Stay on Apify. Measured $0.0058/ad, so the $5/month free cap is ~862 ads,
   which is roughly 28 reports at 30 ads each.
2. Point the Bright Data **Web Unlocker** at the public Ad Library ourselves
   once a zone exists. Same legal footing, and priced per request rather than
   per ad, which is likely much cheaper at volume.

### Model provider routing

`lib/llm.mjs` picks the first configured provider and the rest of the engine
never learns which one is live:

| Order | Env | Worker / synthesis |
|---|---|---|
| 1 | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` / `claude-opus-5` |
| 2 | `AGENTROUTER_API_KEY` | `gpt-5.6-sol` for both |
| 3 | `XAI_API_KEY` | `grok-4-fast` / `grok-4` |

A direct `ANTHROPIC_API_KEY` is still the one worth having: it is the reference
path, it is the only one with a published rate card we can price a report
against, and it does not route customer research through a third party.

### Free, no key, already working

| Source | Status |
|---|---|
| Reddit (Arctic Shift) | Working. ~1 hour behind live, global coverage, no auth. |
| YouTube (yt-dlp) | Working. Search and comments, no API key. |
| Shopify `/products.json` | Working. Full catalog on any Shopify store. |
| TikTok ad library | Open unauthenticated, client not written yet. |

---

## How it is put together

```
research/
  validate.mjs        the CLI: resolve -> plan -> retrieve -> synthesise -> report
  lib/
    product.mjs       URL -> product facts, via a cheapest-first ladder
    higgsfield.mjs    HF marketing-studio product scraper (a ladder tier)
    reddit.mjs        Arctic Shift: subreddit discovery, search, comment trees
    youtube.mjs       yt-dlp search + comment mining
    ads.mjs           Meta Ad Library competitors, ranked by days running
    corpus.mjs        the memory (SQLite + FTS5)
    llm.mjs           model routing: cheap workers, expensive synthesis
    cost.mjs          per-run cost meter
  corpus.db           the memory itself (gitignored)
  out/                generated reports (gitignored)
```

### The product-URL ladder

Cheapest first, and we only pay when the free tiers fail:

1. Shopify `/products.json`: free, instant, covers most DTC
2. Direct fetch: free, covers about two thirds
3. **Higgsfield scraper**: already paid for, reads pages we cannot
4. Bright Data Web Unlocker: new spend, only for what 1 to 3 could not read
5. Wayback: last resort

Every run prints the trail it took, so a failure is diagnosable rather than mysterious.

### The memory (the RAG)

Everything the engine reads is written to `corpus.db` once and reused forever.
Measured on the same product, same category, 2026-08-13:

| | Cold (first look) | Warm (category already held) |
|---|---|---|
| Retrieval | 596s, ~500 throttled requests | **0.5s, zero network** |
| Synthesis | 68s | 68s |
| Total | 625.9s | **82.3s** |

Retrieval is the part memory removes, and it removes essentially all of it:
1,159 records came back in half a second. The second seller in a category is
therefore nearly free to research, which is the cost story as much as the speed
one.

**Synthesis is now the bottleneck, not scraping.** 68s of the 82s warm run is
one model call over 110k tokens of evidence. The plan's answer is already half
built (the report sections run in parallel via `askAll`) and the rest of it is
streaming them to the page as they land, so time-to-first-insight stops being
time-to-complete. Until that ships, a warm report is 82s and does not yet meet
the under-60s speed gate.

A **relevance gate** runs before anything is stored. Prefix search matches names,
so a "men shoes" probe returns r/mentalhealth, and because every run writes to
memory, one bad pick would poison a category permanently. The gate runs on the
model's picks too, not just the heuristic ones.

The gate keeps any subreddit matching **at least one** meaningful category term.
It used to require a ratio of the terms (20%), which quietly inverted its
purpose: the better the planner got at generating terms, the more terms there
were, and the harder it became for any one community to clear the bar. Measured
on a real run, "men's workout T-shirts" dropped r/Fitness, r/GYM, r/bodybuilding
and r/malefashionadvice, the four best communities in the category, and mined
only r/Gymshark. An absolute threshold is the right shape because the failure
this gate exists to stop is total non-overlap, not partial overlap. After the
fix the same run mines seven communities and still drops r/gymselfies.

### Anti-fabrication, and the corroboration gate

Two rules, and the second is what makes a report worth paying for.

**No receipt, no claim.** The model never writes a quote. It cites evidence by
id (`c12`, `p3`), and the renderer resolves those ids against the real corpus.
An id that does not exist is dropped, and a finding with no surviving evidence
is not rendered at all.

**No corroboration, no conclusion.** One person saying something is an
anecdote, and an anecdote dressed as a market finding is exactly the failure
this engine exists to prevent. A claim needs at least `MIN_RECEIPTS` (3)
independent supporting records to be printed as a finding. Below that it is
held back under "Weaker signals" and labelled as a lead, not a conclusion.
Findings are ordered by how many people raised them, and each one prints its
own corroboration count ("31 people raised this independently across 5
communities"), which is also the persuasion: a count is much harder to wave
away than a single well-chosen quote.

This is why the retrieval defaults are wide (`--subs 10 --posts 45`, 100
comments per post) and why the whole held corpus is sent to synthesis rather
than a sample. The gate counts mentions, so truncating the evidence would
quietly truncate the counts the gate depends on.

### The format verdict

The report has to answer "video or static?", so `formatVerdict()` in
`lib/ads.mjs` computes it as pure arithmetic with no model involved:

- The **weak** signal is the raw split of all ads.
- The **strong** signal is the split among the winners, the ads past 90 days,
  because duration is proof of what advertisers keep paying for. If 62% of all
  ads are static but 80% of the long-runners are video, the answer is video.
- Untyped ads are **excluded, never bucketed**. `creativeType()` returns `null`
  when it genuinely cannot tell, and a ratio computed over guesses is worse
  than no ratio.
- Below the sample gate (20 typed ads, 8 past 60 days) there is **no verdict**,
  and the report says so. That is a real answer, not a failure.

Reading `displayFormat` alone would have thrown away two thirds of the sample:
measured on a real pull, 21 of 30 ads came back `DCO` and 2 came back `DPA`,
which are delivery modes, not creative types. The creative type actually lives
in `snapshot.cards[]`, each card carrying either a video url or only an image.

### The date rule

Ad run duration is the core proof signal, so it carries its provenance:

- `reported`: the source gave an explicit duration or an end date
- `observed`: a real start date on a still-live ad, so days-running is
  arithmetic on two facts
- `none`: no trustworthy date, and **the UI shows no duration at all**

Never inferred, never estimated.

---

## Cost

Every run prints what it cost, broken down by vendor, with a `?` against any
rate not yet confirmed with the vendor:

```
  cost: $0.0143  (https://example.com/products/thing)
      claude-haiku-4-5      18,204 in / 1,120 out    $0.0238
    ? brightdata.unlocker   1 call                   $0.0015
```

Free legs cost nothing and say so. The point is that no price ships until real
runs have measured real costs.

-- ─────────────────────────────────────────────────────────────
-- research corpus: the voice-of-customer memory behind a validation report.
--
-- Ported from research/corpus.db (SQLite + FTS5), which works for the CLI but
-- cannot be read by a Netlify function: the file is not there at runtime, and
-- a serverless filesystem is not somewhere to keep growing state anyway.
--
-- The whole speed argument lives here. A category we have harvested before
-- answers from an index in milliseconds; a cold one needs roughly sixty
-- throttled Arctic Shift round trips and takes minutes. That difference is why
-- report building has to be a background function, and why this table is worth
-- having at all: the second report in a category is nearly free.
--
-- Postgres full text search replaces FTS5. `tsv` is a generated column, so it
-- can never drift from `text` the way a trigger-maintained index can.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.research_docs (
  id           bigserial primary key,
  source       text not null,               -- reddit | ad | youtube
  kind         text not null,               -- post | comment
  external_id  text not null,
  category     text not null,
  channel      text,                        -- subreddit, page, or channel
  text         text not null,
  score        integer not null default 0,
  url          text,
  created_utc  bigint,
  harvested_at bigint,
  tsv          tsvector generated always as (to_tsvector('english', text)) stored,
  -- The dedup key the CLI already uses: source:external_id. Re-harvesting a
  -- category must top it up, not duplicate it.
  constraint research_docs_source_external_key unique (source, external_id)
);

create index if not exists research_docs_tsv_idx
  on public.research_docs using gin (tsv);

-- "The loudest of this category", which tops up a narrow query set so a thin
-- search cannot starve a report.
create index if not exists research_docs_category_score_idx
  on public.research_docs (category, score desc);

-- One row per category we have ever looked at: the warm/cold signal.
create table if not exists public.research_categories (
  name           text primary key,
  first_seen     bigint,
  last_harvested bigint,
  docs           integer not null default 0,
  subreddits     jsonb  not null default '[]'::jsonb,
  queries        jsonb  not null default '[]'::jsonb
);

/*
 * Warm means: enough material, harvested recently enough to still be true.
 * 150 docs and 14 days, matching the CLI's thresholds exactly so a report
 * built server-side makes the same warm/cold call as one built locally.
 */
create or replace function public.research_category_warm(p_category text)
returns table (docs integer, age_days double precision, warm boolean)
language sql
stable
security definer set search_path = public
as $$
  select
    c.docs,
    case when c.last_harvested is null then null
         else (extract(epoch from now()) - c.last_harvested) / 86400.0 end,
    coalesce(c.docs, 0) >= 150
      and c.last_harvested is not null
      and (extract(epoch from now()) - c.last_harvested) / 86400.0 < 14
  from public.research_categories c
  where c.name = p_category;
$$;

/*
 * Search one category. websearch_to_tsquery takes ordinary phrasing rather
 * than tsquery syntax, so a planner-written query like "shirt fits shoulders"
 * needs no escaping and cannot throw on punctuation.
 */
create or replace function public.research_search(
  p_category text,
  p_query    text,
  p_limit    integer default 120
)
returns setof public.research_docs
language sql
stable
security definer set search_path = public
as $$
  select *
    from public.research_docs
   where category = p_category
     and tsv @@ websearch_to_tsquery('english', p_query)
   order by ts_rank(tsv, websearch_to_tsquery('english', p_query)) desc, score desc
   limit greatest(1, least(coalesce(p_limit, 120), 600));
$$;

-- ─────────────────────────────────────────────────────────────
-- Internal data. Nothing here is customer owned and nothing should be
-- readable from a browser: it is harvested public discussion we paid to
-- collect, and the corpus is the moat. RLS on with no policy means only the
-- service role reaches it. Same lockdown reasoning as the credit functions:
-- SECURITY DEFINER routines must not be callable by anon or authenticated.
-- ─────────────────────────────────────────────────────────────

alter table public.research_docs       enable row level security;
alter table public.research_categories enable row level security;

revoke all on function public.research_category_warm(text)        from public, anon, authenticated;
revoke all on function public.research_search(text, text, integer) from public, anon, authenticated;

grant execute on function public.research_category_warm(text)        to service_role;
grant execute on function public.research_search(text, text, integer) to service_role;

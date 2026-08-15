-- ─────────────────────────────────────────────────────────────
-- Ad survival: did the thing we recommended actually keep running?
--
-- This is the honest version of a performance loop, and it is worth being
-- precise about what it can and cannot know.
--
-- It CANNOT see spend, CTR, ROAS or conversions. Those are private to the
-- advertiser and appear nowhere public. Reading them needs the Meta Marketing
-- API and the customer's own ad account, which is a later, larger thing.
--
-- What it CAN see is the public Meta Ad Library, which publishes when an ad
-- started and whether it is still live. That gives a survival signal: nobody
-- keeps paying to run an ad that loses money, so an ad still running at ninety
-- days has been judged by the only referee that matters, and one killed at six
-- days has too.
--
-- We already sell that reasoning: the format verdict is computed from how long
-- competitor ads survive. This table simply turns the same measure on our own
-- output, which makes it consistent rather than a new claim to defend.
--
-- Two sources feed it:
--   'ours'       an ad built from an angle we recommended
--   'competitor' an ad seen while researching a category
--
-- Competitor rows are the reason this is useful before we have a single
-- customer running ads: re-checking them over time turns a snapshot of a
-- category into a history of it.
--
-- NEVER present days_running as profit. It is survival, and the copy that
-- shows it has to say so.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.tracked_ads (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('ours', 'competitor')),
  ad_archive_id text not null,             -- Meta's public ad id
  category      text,                      -- ties survival back to a market
  advertiser    text,
  creative      text,                      -- video | static | unknown
  body          text,                      -- copy, for matching ours to theirs
  angle_claim   text,                      -- the angle this came from, when ours
  report_id     uuid references public.reports (id) on delete set null,
  first_seen    timestamptz not null default now(),
  last_checked  timestamptz,
  started_at    timestamptz,               -- as reported by the library
  ended_at      timestamptz,               -- first check where it was gone
  days_running  integer,
  still_live    boolean not null default true,
  unique (ad_archive_id)
);

create index if not exists tracked_ads_recheck_idx
  on public.tracked_ads (still_live, last_checked nulls first);
create index if not exists tracked_ads_category_idx
  on public.tracked_ads (category, source);

alter table public.tracked_ads enable row level security;

-- No browser reads this directly. Survival is reported through a report
-- payload, where it arrives with the wording that explains what it means; a
-- raw days_running column invites exactly the misreading the header warns
-- against.
create policy "tracked_ads: service role only"
  on public.tracked_ads for all
  to service_role
  using (true) with check (true);

-- ─────────────────────────────────────────────────────────────
-- What survived, per category.
--
-- The number the angle ranker wants: of the ads we have watched in this market,
-- how many were still running after the cohort window. Ninety days matches the
-- cohort the format verdict already uses, so the two agree.
-- ─────────────────────────────────────────────────────────────

create or replace function public.category_survival(p_category text, p_days int default 90)
returns table (source text, watched bigint, survived bigint)
language sql
stable
security definer set search_path = public
as $$
  select
    source,
    count(*)::bigint as watched,
    count(*) filter (where coalesce(days_running, 0) >= p_days)::bigint as survived
  from public.tracked_ads
  where category = p_category
  group by source;
$$;

revoke all on function public.category_survival(text, int) from public, anon, authenticated;
grant execute on function public.category_survival(text, int) to service_role;

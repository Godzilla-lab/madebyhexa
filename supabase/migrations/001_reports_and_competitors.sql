-- Run this in the Supabase SQL editor. Additive only: it creates two new
-- tables and touches nothing that already exists.

-- ─────────────────────────────────────────────────────────────
-- reports: the validation engine's per-account output.
--
-- The category corpus is shared infrastructure and lives outside Postgres; what
-- belongs to a person is the REPORT they generated: the product they pasted,
-- the verdict, the angles, the format call and the ad evidence behind it.
-- Anonymous free snapshots have a null user_id and are claimed on sign-in,
-- which is what makes "sign in to keep this" work without regenerating.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles (id) on delete cascade,
  product_url   text not null,
  product_title text,
  category      text,
  verdict       text,
  demand_signal text,            -- strong | moderate | weak | unclear
  format_verdict jsonb,          -- the deterministic video/static call + its numbers
  payload       jsonb,           -- full rendered report: pains, wishes, objections, angles
  evidence_count integer not null default 0,
  paid          boolean not null default false,
  claim_token   text unique,     -- anonymous handle, exchanged for user_id at sign-in
  status        text not null default 'building', -- building | ready | failed
  created_at    timestamptz not null default now()
);

create index if not exists reports_user_id_created_idx
  on public.reports (user_id, created_at desc);
create index if not exists reports_category_idx
  on public.reports (category);

alter table public.reports enable row level security;

-- Same shape as creations: the owner reads their own, writes are service-role
-- only. An anonymous report (user_id null) is readable by nobody through the
-- browser; it is fetched server-side by its claim_token until it is claimed.
create policy "reports: owner can read"
  on public.reports for select
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- tracked_competitors: the accumulating ad-duration moat, per account.
--
-- Meta keeps no history for commercial ads, so a duration we did not observe
-- ourselves cannot be recovered later. Snapshotting from the day a user signs
-- up is what makes "we have been watching this advertiser for you" true.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.tracked_competitors (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  page_id      text not null,
  advertiser   text,
  domain       text,
  category     text,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (user_id, page_id)
);

create index if not exists tracked_competitors_user_idx
  on public.tracked_competitors (user_id, created_at desc);

alter table public.tracked_competitors enable row level security;

create policy "tracked_competitors: owner can read"
  on public.tracked_competitors for select
  using (auth.uid() = user_id);

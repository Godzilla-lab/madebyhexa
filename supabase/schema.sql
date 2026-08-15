-- Hexa SaaS schema: profiles, orders, creations.
--
-- Apply in the Supabase project SQL editor (EU / Frankfurt project).
-- Every table has Row-Level Security ON: the browser anon key + a user's JWT
-- can only ever touch that user's own rows. Netlify functions use the
-- service-role key, which bypasses RLS for privileged writes (webhook
-- fulfilment, cross-user ops). Never ship the service-role key to the browser.

-- ─────────────────────────────────────────────────────────────
-- profiles: one row per auth user, created automatically on signup.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  email              text,
  name               text,
  stripe_customer_id text unique,
  created_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user can read and update only their own profile. Inserts happen via the
-- trigger below (service role), never from the browser.
create policy "profiles: owner can read"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: owner can update"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create a profile whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- orders: one row per Stripe checkout, owned by a user.
-- Written 'pending' at checkout creation, marked 'paid' by the webhook,
-- 'refunded' when a render fails and we refund.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  stripe_session_id text unique,
  product           text,
  selections        jsonb not null default '{}'::jsonb,
  amount_cents      integer,
  status            text not null default 'pending', -- pending | paid | refunded | failed
  refunded_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists orders_user_id_created_idx
  on public.orders (user_id, created_at desc);

alter table public.orders enable row level security;

-- Read-only for the owner; all writes go through the service role (functions).
create policy "orders: owner can read"
  on public.orders for select
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- creations: the permanent library. One row per rendered piece.
-- result_urls point at Higgsfield's CDN in v1 (stored=false); a later phase
-- re-hosts into Supabase Storage and flips stored=true.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.creations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  order_id     uuid references public.orders (id) on delete set null,
  job_ids      text[] not null default '{}',
  engine       text,
  type         text,            -- video | image
  title        text,
  prompt       text,
  result_urls  text[] not null default '{}',
  thumb_url    text,
  stored       boolean not null default false,
  status       text not null default 'rendering', -- rendering | completed | failed
  created_at   timestamptz not null default now()
);

create index if not exists creations_user_id_created_idx
  on public.creations (user_id, created_at desc);

alter table public.creations enable row level security;

-- The owner can read their whole library; writes are service-role only.
create policy "creations: owner can read"
  on public.creations for select
  using (auth.uid() = user_id);

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

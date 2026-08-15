-- ─────────────────────────────────────────────────────────────
-- Brand memory: the things a customer should only ever tell us once.
--
-- Without this, every order starts from nothing and the merchant re-types the
-- same tone, the same audience and the same banned words into the creative
-- direction box, or more likely does not bother and gets generic copy. The
-- competitor review in the strategy doc found persistent brand context is now
-- table stakes, and it is: an ad that has to be told the brand voice every time
-- is an ad that mostly will not have it.
--
-- PER ACCOUNT, with room for per product.
--
-- The primary customer is a merchant with one brand, so a single row per
-- account is the honest default: simplest to fill in, simplest to apply, and
-- it cannot be wrong for them. Agencies running several brands need finer
-- grain, so `scope` is nullable and reserved for that: null means "everything
-- this account makes", and a value means "only this store or product line".
-- Adding that later is a new row, not a migration against existing data.
--
-- WHAT THIS IS NOT: a place to put claims. Tone, vocabulary and audience shape
-- how something is said. What is actually true about the product still comes
-- from the product page and the research, because a brand memory that could
-- assert "clinically proven" would launder an unevidenced claim into every
-- creative we make.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.brand_profiles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  -- null = the account's default brand. A value scopes it to one store or
  -- product line, for agencies running more than one.
  scope         text,
  brand_name    text,
  audience      text,             -- who they sell to, in their own words
  tone          text,             -- how it should sound
  words_use     text,             -- vocabulary that is theirs
  words_avoid   text,             -- vocabulary that is not, and never is
  offer         text,             -- a standing offer worth repeating
  notes         text,             -- anything else that shapes the writing
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- One default profile per account. A second "null scope" row would make
-- "which brand applies" ambiguous, and ambiguity here means creatives that
-- silently pick the wrong voice.
create unique index if not exists brand_profiles_default_once
  on public.brand_profiles (user_id) where scope is null;

create unique index if not exists brand_profiles_scope_once
  on public.brand_profiles (user_id, scope) where scope is not null;

alter table public.brand_profiles enable row level security;

-- Unlike a store token, there is nothing secret in here: it is the customer's
-- own words about their own brand, and they need to read and edit it directly.
-- So the owner gets full access, scoped to their own rows.
create policy "brand_profiles: owner reads"
  on public.brand_profiles for select
  using (auth.uid() = user_id);
create policy "brand_profiles: owner writes"
  on public.brand_profiles for insert
  with check (auth.uid() = user_id);
create policy "brand_profiles: owner updates"
  on public.brand_profiles for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "brand_profiles: owner deletes"
  on public.brand_profiles for delete
  using (auth.uid() = user_id);

-- Keep updated_at honest, since the UI shows "saved" against it.
create or replace function public.touch_brand_profile()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists brand_profiles_touch on public.brand_profiles;
create trigger brand_profiles_touch
  before update on public.brand_profiles
  for each row execute function public.touch_brand_profile();

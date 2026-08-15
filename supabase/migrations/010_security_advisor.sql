-- ─────────────────────────────────────────────────────────────
-- Everything Supabase's security advisor flagged, and one thing it did not.
--
-- Four separate problems, listed here because the reasons differ and only some
-- of them were real:
--
--   1. touch_brand_profile has a mutable search_path. Mine, and a genuine
--      oversight: every other function in this schema pins it and this one did
--      not.
--
--   2. shopify_stores, my_shopify_stores and disconnect_shopify are orphans
--      from the first draft of 007, which was applied before it was rewritten
--      to be platform agnostic. An unused table whose whole purpose was holding
--      merchant access tokens is a liability, not clutter: it is a second place
--      a credential could land and nothing would ever read it. Verified empty
--      (0 rows) before dropping.
--
--   3. handle_new_user and rls_auto_enable are SECURITY DEFINER and executable
--      by anyone. Both are trigger functions: nothing should ever call them
--      directly, and handle_new_user in particular writes the signup credit
--      grant.
--
--   4. disconnect_store is also flagged, and is correct as it stands. See the
--      note against it below.
-- ─────────────────────────────────────────────────────────────

-- ── 1. Pin the search path ───────────────────────────────────
--
-- Without this the function resolves now() and its own table through whatever
-- search_path the caller had at the time. That is how a function gets pointed
-- at an attacker's shadow schema. Every other function here already sets it;
-- this one was written as a plain trigger and missed.

create or replace function public.touch_brand_profile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── 2. Drop the orphaned first draft ─────────────────────────
--
-- Order matters: the function and view first, then the table they depend on.

drop function if exists public.disconnect_shopify(text);
drop view if exists public.my_shopify_stores;
drop table if exists public.shopify_stores;

-- ── 2b. Say the quiet part explicitly ────────────────────────
--
-- research_docs never had an "enable row level security" line in any migration,
-- and yet the anon key reads zero of its 4,913 rows. The reason is
-- rls_auto_enable, a DDL event trigger that exists in the database but in none
-- of our schema files, so nothing in this repository records that the corpus is
-- protected or why.
--
-- That is a bad way to hold a security property. The corpus is the asset the
-- whole product compounds on, and its protection currently depends on a trigger
-- we did not write, cannot see in review, and would not notice being dropped.
-- These statements are no-ops today and are here so the guarantee survives the
-- trigger.
--
-- No policies are added deliberately: RLS with no policy denies everything
-- except the service role, which is exactly right for a table only the server
-- ever reads.

alter table public.research_docs       enable row level security;
alter table public.research_categories enable row level security;

-- ── 3. Trigger functions are not an API ──────────────────────
--
-- handle_new_user fires on auth.users insert and writes the profile row and the
-- welcome credit grant. rls_auto_enable fires on DDL. Neither has any business
-- being reachable over PostgREST, which exposes anything executable by anon or
-- authenticated as an RPC endpoint.
--
-- Triggers do not need EXECUTE granted to the calling role: they run as the
-- function owner when the trigger fires, so revoking here removes the endpoint
-- without affecting the trigger.

revoke all on function public.handle_new_user()  from public, anon, authenticated;
revoke all on function public.rls_auto_enable()  from public, anon, authenticated;

-- ── 4. Why disconnect_store stays as it is ───────────────────
--
-- The advisor flags every SECURITY DEFINER function that signed-in users can
-- execute, which is the right thing for it to do and the wrong conclusion here.
-- This one MUST be callable by a signed-in user: it is how a merchant removes
-- their own store, and refusing that would mean the only way to revoke us is on
-- the platform's side.
--
-- It is safe because it takes no user id. It filters on auth.uid() internally,
-- so the only row it can ever delete is the caller's own, whatever arguments
-- they pass. Same reasoning as my_credit_balance and my_credit_history.
--
-- Restated here rather than left implicit, so the next person reading the
-- advisor output does not "fix" it by revoking the grant and quietly breaking
-- disconnection.
--
-- (no change)

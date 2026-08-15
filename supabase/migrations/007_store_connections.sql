-- ─────────────────────────────────────────────────────────────
-- Connected stores.
--
-- One row per (account, platform, store). Holds the access token a platform
-- hands back at the end of its OAuth install, which is the single most
-- sensitive thing this system stores: it reads a real merchant's catalogue, it
-- does not expire on its own, and it is useless to us but valuable to anyone
-- else.
--
-- PLATFORM IS A COLUMN, NOT A TABLE NAME, and that is deliberate.
--
-- Pasting a product link is the primary way in and always will be: the product
-- resolver reads Shopify, Amazon, Etsy, WooCommerce, BigCommerce or a plain
-- product page through five fallback tiers, with no integration and no consent
-- screen. A store connection is a convenience on top of that for people who
-- want to pick from a catalogue instead of copying URLs.
--
-- So the second platform we add must be a row value, not a migration against a
-- table holding live merchant credentials. Shopify is simply first, because it
-- is the largest and we hold the Partner account.
--
-- The security rules here are tighter than anywhere else in the schema:
--
--   the token column is never exposed to the browser at all. There is no owner
--   select policy on this table; the browser reads a view that omits the token,
--   so even a careless "select *" from client code cannot leak it.
--
--   every write is service role. The token arrives inside a Netlify function
--   and never travels back out.
--
-- Scope is minimal per platform, on purpose. If a future feature needs more, it
-- gets a new scope string, a new install, and a fresh consent screen the
-- merchant actually reads, rather than a quiet widening of what we already
-- hold.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.store_connections (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,
  -- Checked rather than free text: a typo'd platform would silently create a
  -- connection nothing ever reads. New platforms extend this list explicitly.
  platform     text not null check (platform in ('shopify', 'woocommerce', 'bigcommerce', 'etsy', 'amazon')),
  store        text not null,             -- shopify: something.myshopify.com
  access_token text not null,             -- service role only, never selected by a browser
  refresh_token text,                     -- platforms whose tokens expire (Shopify offline tokens do not)
  expires_at   timestamptz,
  scope        text,                      -- what the merchant actually granted
  store_name   text,                      -- display name, for the picker
  installed_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, platform, store)
);

create index if not exists store_connections_user_idx
  on public.store_connections (user_id, platform);

alter table public.store_connections enable row level security;

-- No owner select policy, by design. See the note above: the browser uses the
-- view, the service role uses the table.
create policy "store_connections: service role writes"
  on public.store_connections for all
  to service_role
  using (true) with check (true);

-- ─────────────────────────────────────────────────────────────
-- The browser's view of a connection: everything except the credential.
-- ─────────────────────────────────────────────────────────────

create or replace view public.my_store_connections
with (security_invoker = true) as
  select id, platform, store, store_name, scope, installed_at, last_used_at
    from public.store_connections
   where user_id = auth.uid();

grant select on public.my_store_connections to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Disconnecting.
--
-- A merchant can revoke on the platform side at any time, but they must also be
-- able to do it from here, and doing it here has to actually delete the token
-- rather than hide it. security definer so it can write the base table,
-- filtered on auth.uid() so it can only ever delete the caller's own row.
-- ─────────────────────────────────────────────────────────────

create or replace function public.disconnect_store(p_platform text, p_store text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_deleted int;
begin
  delete from public.store_connections
   where user_id = auth.uid()
     and platform = p_platform
     and store = p_store;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.disconnect_store(text, text) from public, anon;
grant execute on function public.disconnect_store(text, text) to authenticated;

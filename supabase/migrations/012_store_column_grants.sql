-- ─────────────────────────────────────────────────────────────
-- Let the owner see their connection without ever seeing the token.
--
-- The design in 007 was "no SELECT policy at all, the browser reads a view".
-- That kept access_token unreadable, and it also broke both things the owner
-- actually needs. Measured 2026-08-14 against a real signed-in session:
--
--   my_store_connections returned 0 rows and no error, because a
--   security_invoker view inherits the caller's row visibility, and with no
--   SELECT policy the caller can see nothing. The account page would have
--   read "Not connected" for a store that was, in fact, connected.
--
--   delete returned 204 and removed nothing. Postgres has to be able to see a
--   row to evaluate the WHERE clause of a DELETE against it, so a DELETE
--   policy alone matches zero rows. Disconnect would have silently done
--   nothing while reporting success.
--
-- Both are the same mistake: row-level security was used to hide a COLUMN.
-- Postgres has a proper tool for that, and this is it.
--
--   RLS decides which ROWS you may touch      -> the policy below
--   GRANT decides which COLUMNS you may read  -> the column list below
--
-- access_token and refresh_token are simply left out of the grant, so
-- "select access_token" is refused by the privilege system before any policy is
-- consulted. That is a stronger guarantee than the view was giving us: it holds
-- for every query shape, not just the ones that go through the view.
-- ─────────────────────────────────────────────────────────────

-- Table-wide select is what Supabase grants by default. Remove it, then hand
-- back exactly the columns that are safe, and no others.
revoke select on public.store_connections from anon, authenticated;

grant select (id, user_id, platform, store, scope, store_name, installed_at, last_used_at)
  on public.store_connections to authenticated;

-- Rows: your own, and only your own.
create policy "store_connections: owner reads own"
  on public.store_connections for select
  to authenticated
  using (auth.uid() = user_id);

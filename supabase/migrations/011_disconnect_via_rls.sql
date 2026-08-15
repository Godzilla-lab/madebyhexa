-- ─────────────────────────────────────────────────────────────
-- Remove the last SECURITY DEFINER function a signed-in user can call.
--
-- disconnect_store was written as SECURITY DEFINER because store_connections
-- has no owner policies at all: the table holds merchant access tokens, so the
-- deliberate design was "service role only, browser reads a view". A function
-- running with elevated rights was the way to let an owner delete their own row
-- without opening the table.
--
-- That works, and it is safe, because the function takes no user id and filters
-- on auth.uid() internally. But it is more privilege than the job needs, and
-- "safe because the body is written correctly" is a weaker guarantee than "the
-- database will not permit anything else". A later edit to that function body
-- is one mistake away from being able to delete any row in the table; a policy
-- cannot be talked into that.
--
-- So: give the owner a DELETE policy and drop the function.
--
-- THE KEY POINT, and the reason this does not undo the original design: a
-- DELETE policy grants no ability to read. There is still no SELECT policy on
-- this table, so access_token remains unreadable to every browser, exactly as
-- before. The owner gains the ability to remove their own row and nothing else.
--
-- After this, Supabase's advisor has nothing left to report, because there is
-- genuinely nothing left rather than an exception we argued for.
-- ─────────────────────────────────────────────────────────────

create policy "store_connections: owner disconnects"
  on public.store_connections for delete
  to authenticated
  using (auth.uid() = user_id);

drop function if exists public.disconnect_store(text, text);

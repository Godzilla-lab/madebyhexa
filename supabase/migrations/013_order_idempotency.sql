-- ─────────────────────────────────────────────────────────────
-- One credit render, one charge.
--
-- The card path has never been able to double charge: a Stripe checkout
-- session is a receipt the server recognises a second time, so render-create
-- replays the original jobs instead of making new ones. The credit path had no
-- equivalent. Its entire double-charge defence was a single localStorage write
-- in the browser (render.js), which happened AFTER the create round trip
-- returned. So a refresh while the request was in flight, a storage quota
-- error, or private mode with storage disabled all charged the balance twice
-- and produced two renders of the same thing.
--
-- The fix is a client-generated key written before the request and recorded on
-- the order, with the uniqueness decided by Postgres rather than by a check in
-- application code. A partial index rather than a plain unique column so the
-- thousands of existing rows, and every card order, keep a null here without
-- colliding with each other.
--
-- Scoped per user, not global: keys are random, but a key is only ever meant
-- to identify one person's repeat submission, and a global unique index would
-- let one account's key deny another's.
-- ─────────────────────────────────────────────────────────────

alter table public.orders
  add column if not exists idempotency_key text;

create unique index if not exists orders_idempotency_once
  on public.orders (user_id, idempotency_key)
  where idempotency_key is not null;

-- ─────────────────────────────────────────────────────────────
-- The welcome allowance nobody actually received.
--
-- 003 gave every new account 2,500 credits, written by the handle_new_user
-- trigger on auth.users. That trigger is correct and stays as it is. What it
-- cannot do is reach backwards: it fires on INSERT, and every account on this
-- project was created before the migration that installed it.
--
-- The result went unnoticed for a month because nothing announces it. Measured
-- 2026-08-19: credit_ledger held zero rows, and credit_balance returned 0 for
-- all six accounts. Since report-create charges 1,000 credits for a signed-in
-- market read, every signed-in read this project has ever attempted was
-- refused for insufficient funds, while the anonymous path kept working. The
-- product was strictly worse for the people who made an account, which is the
-- exact opposite of what the funnel is for.
--
-- Idempotent twice over, because a backfill that cannot be re-run safely is a
-- backfill nobody dares run: the where-not-exists skips anyone already
-- granted, and credit_ledger_one_grant_per_user would reject a duplicate even
-- if that check were wrong.
--
-- Reads auth.users rather than public.profiles on purpose. profiles is written
-- by the same trigger, so an account that missed one may have missed both, and
-- auth.users is the only table that definitely holds every account. The
-- foreign key to profiles means a row with no profile is skipped rather than
-- failing the migration, which is why the join is there.
-- ─────────────────────────────────────────────────────────────

insert into public.credit_ledger (user_id, delta, kind, ref, note)
select p.id, 2500, 'grant', 'signup:' || p.id::text, 'Welcome credits'
  from public.profiles p
  join auth.users u on u.id = p.id
 where not exists (
         select 1 from public.credit_ledger l
          where l.user_id = p.id and l.kind = 'grant'
       )
on conflict do nothing;

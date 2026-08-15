-- ─────────────────────────────────────────────────────────────
-- credit_ledger: every credit movement, append only.
--
-- A ledger rather than a balance column on profiles. Balance is the sum of
-- the rows, which makes a refund a new row instead of a read-modify-write, and
-- makes "why is my balance 400" answerable. A single mutable integer cannot
-- survive two renders finishing at once, and cannot be audited after the fact
-- when a customer disputes a charge.
--
-- Denomination: 1 credit = $0.002, so a 20 creative ad pack is 6,000 credits
-- and a 15s film is 7,000. Deliberately fine grained, because large numbers
-- read as more generous than their dollar equivalent. The dollar figure still
-- has to be shown at purchase: hiding the second conversion (credits to actual
-- output) is the documented way these models lose trust.
--
-- Kinds:
--   grant    one free allowance for a new account
--   purchase credits bought with money
--   spend    charged when a render is created
--   refund   returned when a render failed to deliver
--   adjust   manual correction, always with a note
--
-- Why spend-then-refund rather than hold-then-commit: the engine bills us at
-- create, not on completion (measured 2026-08-14, DTC Ads charges 0.5 credits
-- the moment the job is accepted). Mirroring that is honest, and the refund
-- path has to exist regardless because a failed creative must never be a
-- silent charge. Failed generations eating a customer's allowance is the
-- single best documented way to kill a credit product.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.credit_ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  delta      bigint not null,           -- signed: negative spends, positive adds
  kind       text   not null check (kind in ('grant', 'purchase', 'spend', 'refund', 'adjust')),
  ref        text,                      -- job id, creation id, or stripe session
  note       text,
  created_at timestamptz not null default now(),
  constraint credit_ledger_delta_not_zero check (delta <> 0)
);

create index if not exists credit_ledger_user_created_idx
  on public.credit_ledger (user_id, created_at desc);

-- One free allowance per account, ever. A uniqueness rule in the database
-- rather than a check in application code, because the grant is written by a
-- signup trigger that can fire again on a replayed auth event.
create unique index if not exists credit_ledger_one_grant_per_user
  on public.credit_ledger (user_id) where kind = 'grant';

-- A given job is refunded at most once. render-status is a polling endpoint:
-- the browser calls it every few seconds and several tabs may call it at once,
-- so without this a failed pack would refund on every poll until the balance
-- was absurd.
create unique index if not exists credit_ledger_refund_once
  on public.credit_ledger (ref) where kind = 'refund';

alter table public.credit_ledger enable row level security;

-- Owners read their own history; every write goes through the service role.
-- A browser that could insert rows could grant itself credits.
create policy "credit_ledger: owner can read"
  on public.credit_ledger for select
  using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- Balance and movement helpers.
-- ─────────────────────────────────────────────────────────────

create or replace function public.credit_balance(p_user uuid)
returns bigint
language sql
stable
security definer set search_path = public
as $$
  select coalesce(sum(delta), 0)::bigint
    from public.credit_ledger
   where user_id = p_user;
$$;

/*
 * Charge a render. Returns the balance left, or raises when there is not
 * enough.
 *
 * The advisory lock is the point of this function. Two renders started in the
 * same second would both read the old balance, both decide it is sufficient,
 * and both insert, spending credits the customer does not have. Serialising
 * per user for the length of the transaction makes the check and the insert
 * one step. It locks on the user, so unrelated customers never wait.
 */
create or replace function public.credit_spend(
  p_user   uuid,
  p_amount bigint,
  p_ref    text,
  p_note   text default null
)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  v_balance bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'credit_spend: amount must be positive, got %', p_amount;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 0));

  select coalesce(sum(delta), 0) into v_balance
    from public.credit_ledger where user_id = p_user;

  if v_balance < p_amount then
    raise exception 'insufficient credits: have %, need %', v_balance, p_amount
      using errcode = 'P0001';
  end if;

  insert into public.credit_ledger (user_id, delta, kind, ref, note)
  values (p_user, -p_amount, 'spend', p_ref, p_note);

  return v_balance - p_amount;
end;
$$;

/*
 * Return credits for something that did not deliver.
 *
 * Idempotent by design: a repeat call for the same ref hits the unique index,
 * is swallowed, and returns the balance unchanged. render-status polls, so
 * "refund the failed segment" will genuinely be asked several times for the
 * same job, and it must be safe every time.
 */
create or replace function public.credit_refund(
  p_user   uuid,
  p_amount bigint,
  p_ref    text,
  p_note   text default null
)
returns bigint
language plpgsql
security definer set search_path = public
as $$
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'credit_refund: amount must be positive, got %', p_amount;
  end if;

  begin
    insert into public.credit_ledger (user_id, delta, kind, ref, note)
    values (p_user, p_amount, 'refund', p_ref, p_note);
  exception when unique_violation then
    null; -- already refunded; nothing to undo and nothing to complain about
  end;

  return public.credit_balance(p_user);
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Lock the money functions to the service role.
--
-- This is the most important block in the file. All three functions are
-- SECURITY DEFINER, which means they run as their owner and ignore row level
-- security, and PostgREST publishes every function in the public schema as a
-- callable endpoint. Left at the default grants, any logged-in user could POST
-- to /rest/v1/rpc/credit_refund with their own user id and any amount they
-- liked and mint themselves credits forever. RLS on the table does not save us,
-- because SECURITY DEFINER is precisely what bypasses it.
--
-- So: no execute for anon or authenticated. Credits move only through the
-- Netlify functions, which hold the service role key and price the order
-- server-side. Revoking from public as well as the two roles covers the default
-- grant that execute privileges start with.
-- ─────────────────────────────────────────────────────────────

revoke all on function public.credit_spend(uuid, bigint, text, text)  from public, anon, authenticated;
revoke all on function public.credit_refund(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.credit_balance(uuid)                    from public, anon, authenticated;

grant execute on function public.credit_spend(uuid, bigint, text, text)  to service_role;
grant execute on function public.credit_refund(uuid, bigint, text, text) to service_role;
grant execute on function public.credit_balance(uuid)                    to service_role;

/*
 * What a signed-in browser is allowed to ask: its own balance, nothing else.
 * No user id parameter, so there is nothing to tamper with. auth.uid() comes
 * from the verified JWT, so this cannot be pointed at another account.
 */
create or replace function public.my_credit_balance()
returns bigint
language sql
stable
security invoker set search_path = public
as $$
  select coalesce(sum(delta), 0)::bigint
    from public.credit_ledger
   where user_id = auth.uid();
$$;

grant execute on function public.my_credit_balance() to authenticated;

-- ─────────────────────────────────────────────────────────────
-- New account allowance.
--
-- 2,500 credits, which is five single creatives at 500 each. Sized on purpose
-- so it cannot reach a 7,000 credit film: a free image costs us about 2.6
-- cents, a free film costs us $4.16. Same generosity on the page, roughly a
-- thirtieth of the cost.
-- ─────────────────────────────────────────────────────────────

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

  -- Welcome allowance. on conflict covers the unique grant index, so a
  -- replayed signup event tops nobody up twice.
  insert into public.credit_ledger (user_id, delta, kind, ref, note)
  values (new.id, 2500, 'grant', 'signup:' || new.id::text, 'Welcome credits')
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- Buying credits.
--
-- The ledger already had every other movement: the signup grant, spends, and
-- refunds. The one thing missing was money coming in, which meant a balance
-- could only ever go down. This adds the guard that makes topping up safe.
--
-- Stripe retries a webhook until it gets a 2xx, and will happily deliver the
-- same checkout.session.completed several times: on its own retry schedule,
-- after a timeout that actually succeeded, or when the endpoint is replayed by
-- hand from the dashboard. Without a uniqueness rule, each delivery inserts
-- another 'purchase' row and the customer's balance grows every time Stripe
-- gets nervous.
--
-- The rule lives here rather than in the function for the same reason the
-- refund rule does: application code cannot make a decision and an insert
-- atomic across two concurrent webhook deliveries, and the database can. The
-- webhook writes ref = 'stripe:<session id>' and lets the constraint decide.
-- ─────────────────────────────────────────────────────────────

create unique index if not exists credit_ledger_purchase_once
  on public.credit_ledger (ref) where kind = 'purchase';

-- ─────────────────────────────────────────────────────────────
-- credit_purchase: add bought credits, exactly once.
--
-- security definer because the caller is the Stripe webhook running as the
-- service role, and because RLS on credit_ledger deliberately forbids every
-- browser-side write: an account that could insert its own rows could grant
-- itself credits.
--
-- Returns the new balance. A duplicate delivery is not an error: it returns
-- the balance unchanged, so the webhook answers 200 and Stripe stops retrying,
-- which is the behaviour that actually ends the retry loop.
-- ─────────────────────────────────────────────────────────────

create or replace function public.credit_purchase(
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
  if p_amount <= 0 then
    raise exception 'credit_purchase: amount must be positive, got %', p_amount;
  end if;
  if p_ref is null or length(trim(p_ref)) = 0 then
    raise exception 'credit_purchase: a ref is required so a replayed webhook cannot double credit';
  end if;

  insert into public.credit_ledger (user_id, delta, kind, ref, note)
  values (p_user, p_amount, 'purchase', p_ref, p_note)
  on conflict do nothing;

  select coalesce(sum(delta), 0)::bigint into v_balance
    from public.credit_ledger where user_id = p_user;
  return v_balance;
end;
$$;

-- Same lockdown as every other money-moving function: reachable only by the
-- service role. PostgREST exposes anything executable by 'authenticated', so a
-- missing revoke here would let any signed-in user mint credits by calling
-- /rest/v1/rpc/credit_purchase with a ref they made up.
revoke all on function public.credit_purchase(uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function public.credit_purchase(uuid, bigint, text, text) to service_role;

-- ─────────────────────────────────────────────────────────────
-- my_credit_history: the account page's statement.
--
-- security invoker, so it reads through the owner-only RLS policy already on
-- credit_ledger and can never return another account's rows. Capped because a
-- statement is for reading, not for exporting.
-- ─────────────────────────────────────────────────────────────

create or replace function public.my_credit_history(p_limit int default 50)
returns table (created_at timestamptz, delta bigint, kind text, note text)
language sql
stable
security invoker set search_path = public
as $$
  select created_at, delta, kind, note
    from public.credit_ledger
   where user_id = auth.uid()
   order by created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

grant execute on function public.my_credit_history(int) to authenticated;

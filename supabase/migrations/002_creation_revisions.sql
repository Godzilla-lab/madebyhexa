-- ─────────────────────────────────────────────────────────────
-- 002: per-creative revisions on a delivered set.
--
-- The ad pack delivers twenty creatives in one pass. A buyer will always want
-- to change a headline or re-roll a concept that missed, and the pricing page
-- promises no reject fees, so revisions have to be free at the point of use.
-- Free at the point of use is not free to us (about two credits an image), so
-- the budget is counted here rather than trusted to the browser.
--
-- revisions_used is incremented server-side by render-revise, which refuses
-- once it passes the allowance. Nothing about it is writable from the client:
-- creations has no owner-write policy, only owner-read.
--
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────

alter table public.creations
  add column if not exists revisions_used integer not null default 0;

comment on column public.creations.revisions_used is
  'Re-rolls spent on this delivered set. Capped server-side in render-revise.';

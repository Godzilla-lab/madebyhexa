-- ─────────────────────────────────────────────────────────────
-- reports.step: what the worker is doing right now.
--
-- A cold category takes minutes (roughly sixty throttled harvest calls before
-- any synthesis starts), and a progress bar with nothing behind it is how
-- people conclude a page has hung and leave. The worker writes a step as it
-- moves; report-status turns it into the line the visitor reads.
--
-- Values: building | harvesting | reading | angles. Deliberately not a check
-- constraint: adding a stage to the pipeline should not require a migration,
-- and an unknown value degrades to the generic "reading your market" line
-- rather than breaking the poll.
-- ─────────────────────────────────────────────────────────────

alter table public.reports
  add column if not exists step text;

-- ─────────────────────────────────────────────────────────────
-- What we actually sent, so "what works best" can be answered rather than
-- asserted.
--
-- Today every claim about which engine, which format or which prompt style
-- performs better is a claim we cannot check. The creations table records the
-- OUTCOME (completed, failed) and the delivered urls, but not the recipe: the
-- engine, the params, the grounding, the prompt that was written, or whether
-- the prompt came from the model or from the beat-sheet fallback. Two renders
-- that behaved completely differently are indistinguishable afterwards.
--
-- Deliberately starting empty. This table earns its answers over time; nothing
-- in the product may claim a format or engine performs better until there are
-- rows here that say so. That is the same rule the research engine holds
-- itself to, applied to our own decisions.
--
-- Columns, and why each one is worth the write:
--
--   engine        the job type actually called. Two products can share one
--                 engine and one product can move between engines, so the
--                 catalogue price is not a reliable stand-in.
--   params        the params sent, minus the prompt. This is what makes a
--                 quality or resolution change measurable instead of a guess.
--   prompt        the first segment's prompt. The whole set would be mostly
--                 duplication; the opener is where the difference lives.
--   prompt_source 'agent' when a model wrote it, 'template' when the beat
--                 sheet did. Until now these were indistinguishable after the
--                 fact, which is exactly how the agent could be switched off
--                 in production for months without anyone noticing.
--   grounded      whether the render was actually about the real product.
--   grounded_by   web_product | image_reference | input_video | null
--   angle_id      the report angle behind it, when there was one, so an
--                 angle's real-world outcome is traceable back to the
--                 evidence that produced it.
--
-- One row per creation, so the creation id is the key rather than a surrogate.
-- On delete cascade: a deleted creation should not leave its recipe behind.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.creation_recipes (
  creation_id   uuid primary key references public.creations (id) on delete cascade,
  engine        text,
  params        jsonb not null default '{}'::jsonb,
  prompt        text,
  prompt_source text check (prompt_source in ('agent', 'template', 'unknown')),
  grounded      boolean,
  grounded_by   text,
  angle_id      text,
  created_at    timestamptz not null default now()
);

create index if not exists creation_recipes_engine_idx
  on public.creation_recipes (engine, created_at desc);

alter table public.creation_recipes enable row level security;

-- Owners can read the recipe behind their own creation. Everything is written
-- by the service role: a browser that could insert here could fabricate the
-- evidence this table exists to hold.
create policy "creation_recipes: owner can read"
  on public.creation_recipes for select
  using (
    exists (
      select 1 from public.creations c
       where c.id = creation_recipes.creation_id
         and c.user_id = auth.uid()
    )
  );

/*
 * Move the local research corpus into Supabase.
 *
 * research/corpus.db is SQLite with FTS5, which the CLI reads off disk. A
 * Netlify function has no such file, so the corpus has to live in Postgres
 * before a report can be built server-side. This copies it across and can be
 * re-run safely: docs upsert on (source, external_id), the dedup key the CLI
 * already uses, so a re-run tops up rather than duplicates.
 *
 * Nothing is deleted from either side. The SQLite file stays authoritative for
 * the CLI until the serverless path is proven.
 *
 * Usage:
 *   node research/port-corpus.mjs --dry     count and show what would move
 *   node research/port-corpus.mjs           actually write
 *
 * env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service role: this writes to
 * tables that have RLS on with no policy, so an anon key silently writes zero
 * rows).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env the same way the netlify functions do locally.
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  const i = s.indexOf('=');
  if (i > 0) process.env[s.slice(0, i)] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const DRY = process.argv.includes('--dry');
const DB = process.env.HEXA_CORPUS_DB || path.join(ROOT, 'research', 'corpus.db');
const BATCH = 500; // rows per insert; keeps each request well under any body cap

function die(msg) { console.error('  ! ' + msg); process.exit(1); }

const { createClient } = require('@supabase/supabase-js');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) die('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
const db = createClient(url, key, { auth: { persistSession: false } });

// node:sqlite, same as research/lib/corpus.mjs. Built into Node 22, so this
// script adds no dependency to a repo that deliberately has almost none.
const { DatabaseSync } = require('node:sqlite');

if (!fs.existsSync(DB)) die('no corpus at ' + DB);
const src = new DatabaseSync(DB, { readOnly: true });

const docCount = src.prepare('select count(*) n from docs').get().n;
const cats = src.prepare('select * from categories').all();
console.log('corpus  : ' + DB);
console.log('docs    : ' + docCount.toLocaleString());
console.log('cats    : ' + cats.length + ' (' + cats.map((c) => c.name).join(', ') + ')');
console.log('target  : ' + url);
console.log(DRY ? '\nDRY RUN, nothing will be written\n' : '');

/* Categories first: a doc without its category row would be searchable but
 * would read as cold, so the report would re-harvest material we already hold. */
const catRows = cats.map((c) => ({
  name: c.name,
  first_seen: c.first_seen ?? null,
  last_harvested: c.last_harvested ?? null,
  docs: src.prepare('select count(*) n from docs where category = ?').get(c.name).n,
  subreddits: safeJson(c.subreddits, []),
  queries: safeJson(c.queries, []),
}));

function safeJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

for (const c of catRows) {
  console.log('  category ' + c.name.padEnd(26) + c.docs + ' docs, ' + (c.subreddits.length) + ' subs');
}

if (!DRY) {
  const { error } = await db.from('research_categories').upsert(catRows, { onConflict: 'name' });
  if (error) die('category upsert failed: ' + error.message);
  console.log('  categories written\n');
}

/* Docs in batches. The embedding column is deliberately dropped: it is null for
 * every row in the source (0 of 3,041 populated) and the Postgres side does
 * lexical search, so carrying an empty vector column would be dead weight. */
const rows = src.prepare(
  'select source, kind, external_id, category, channel, text, score, url, created_utc, harvested_at from docs'
).all();

let written = 0;
let skipped = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH)
    .filter((r) => r.text && String(r.text).trim())    // a doc with no text cannot be evidence
    .map((r) => ({
      source: r.source,
      kind: r.kind,
      external_id: String(r.external_id),
      category: r.category,
      channel: r.channel || null,
      text: String(r.text),
      score: Number(r.score) || 0,
      url: r.url || null,
      created_utc: r.created_utc ?? null,
      harvested_at: r.harvested_at ?? null,
    }));
  skipped += Math.min(BATCH, rows.length - i) - batch.length;
  if (DRY || !batch.length) { written += batch.length; continue; }

  const { error } = await db.from('research_docs')
    .upsert(batch, { onConflict: 'source,external_id', ignoreDuplicates: false });
  if (error) die('doc upsert failed at row ' + i + ': ' + error.message);
  written += batch.length;
  process.stdout.write('\r  docs ' + written.toLocaleString() + '/' + rows.length.toLocaleString());
}
console.log('\r  docs ' + written.toLocaleString() + '/' + rows.length.toLocaleString()
  + (skipped ? ' (' + skipped + ' empty skipped)' : ''));

if (DRY) { console.log('\ndry run complete, nothing written'); process.exit(0); }

/* Verify rather than assume. An upsert that silently wrote nothing because of
 * RLS looks exactly like success from the client. */
const { count, error: cErr } = await db.from('research_docs')
  .select('id', { count: 'exact', head: true });
if (cErr) die('verification query failed: ' + cErr.message);
console.log('\nverified: ' + (count ?? 0).toLocaleString() + ' docs now in Supabase');

const probe = catRows[0];
if (probe) {
  const { data, error } = await db.rpc('research_search', {
    p_category: probe.name, p_query: 'quality', p_limit: 3,
  });
  if (error) console.log('search probe failed: ' + error.message);
  else {
    console.log('search probe ("quality" in ' + probe.name + '): ' + (data || []).length + ' hits');
    for (const d of (data || []).slice(0, 2)) {
      console.log('  [' + d.score + '] ' + String(d.text).replace(/\s+/g, ' ').slice(0, 90));
    }
  }
}

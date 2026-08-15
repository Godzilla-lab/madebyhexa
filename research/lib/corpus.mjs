/*
 * The corpus: the engine's memory.
 *
 * Chris's ask was "a RAG for our AI so we don't keep forgetting." This is it.
 * Everything the engine reads gets written here once and is reusable forever,
 * which buys three things at the same time:
 *
 *   SPEED   a warm category answers from local FTS in milliseconds instead of
 *           ~60 throttled HTTP round trips
 *   COST    the second seller in a category costs almost nothing to research
 *   SAFETY  Arctic Shift going down stops being an outage, because we hold our
 *           own copy of what we already read
 *
 * Storage is `node:sqlite` (built into Node 22, no dependency) with FTS5 for
 * ranked full-text retrieval. The schema is deliberately Postgres-shaped so
 * Phase 2 can lift it into Supabase without a rewrite: same tables, same
 * columns, `docs_fts` becomes a tsvector column plus a GIN index.
 *
 * Vectors are deliberately NOT here yet. The plan is explicit: start with FTS
 * and add pgvector only when semantic matching earns its cost. `embedding` is
 * reserved on `docs` so adding it later is a migration, not a redesign.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(HERE, '..', 'corpus.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,          -- reddit | youtube | ad
  kind          TEXT NOT NULL,          -- post | comment
  external_id   TEXT NOT NULL,          -- reddit id, youtube comment hash, ad id
  category      TEXT NOT NULL,
  channel       TEXT,                   -- subreddit, or youtube video title
  text          TEXT NOT NULL,
  score         INTEGER DEFAULT 0,
  url           TEXT,
  created_utc   INTEGER DEFAULT 0,
  harvested_at  INTEGER NOT NULL,
  embedding     BLOB,                   -- reserved: pgvector lands here later
  UNIQUE (source, external_id, category)
);

CREATE INDEX IF NOT EXISTS docs_category_idx ON docs (category, source, score DESC);
CREATE INDEX IF NOT EXISTS docs_harvest_idx  ON docs (category, harvested_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts
  USING fts5(text, content='docs', content_rowid='id', tokenize='porter unicode61');

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO docs_fts(rowid, text) VALUES (new.id, new.text);
END;

-- One row per category we have ever looked at: the warm/cold signal.
CREATE TABLE IF NOT EXISTS categories (
  name           TEXT PRIMARY KEY,
  first_seen     INTEGER NOT NULL,
  last_harvested INTEGER NOT NULL,
  subreddits     TEXT,                  -- JSON array, the picked set worth reusing
  queries        TEXT                   -- JSON array, the query plan worth reusing
);

-- Reports are memory too: the second report in a category starts from the first.
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY,
  product_url   TEXT NOT NULL,
  product_title TEXT,
  category      TEXT NOT NULL,
  markdown      TEXT NOT NULL,
  findings      TEXT,                   -- JSON: the structured read + angles
  cost_usd      REAL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_category_idx ON reports (category, created_at DESC);

-- Product resolution cache, so re-running a URL never re-pays the unlocker.
CREATE TABLE IF NOT EXISTS products (
  url        TEXT PRIMARY KEY,
  title      TEXT,
  category   TEXT,
  facts      TEXT NOT NULL,             -- JSON
  source     TEXT,
  fetched_at INTEGER NOT NULL
);
`;

const now = () => Math.floor(Date.now() / 1000);

/* FTS5 treats a lot of punctuation as syntax, so user text has to be quoted
 * before it can be used as a MATCH term. Each word becomes its own quoted
 * token and they are OR-ed, which is what we want for recall. */
function ftsQuery(raw) {
  const words = String(raw)
    .toLowerCase()
    .replace(/["^*():]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2);
  if (!words.length) return null;
  return words.map((w) => `"${w}"`).join(' OR ');
}

export function openCorpus(dbPath = process.env.HEXA_CORPUS_DB || DEFAULT_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  const insertDoc = db.prepare(`
    INSERT OR IGNORE INTO docs
      (source, kind, external_id, category, channel, text, score, url, created_utc, harvested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    db,
    path: dbPath,

    /*
     * Write everything we just read. Returns how many rows were genuinely new,
     * which is the honest measure of whether a harvest was worth running.
     */
    addDocs(docs, category) {
      if (!docs.length) return 0;
      const ts = now();
      let added = 0;
      db.exec('BEGIN');
      try {
        for (const d of docs) {
          if (!d.text || !d.externalId) continue;
          const res = insertDoc.run(
            d.source, d.kind, String(d.externalId), category,
            d.channel || '', d.text, d.score || 0, d.url || '',
            d.createdUtc || 0, ts
          );
          added += res.changes;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return added;
    },

    /* Ranked retrieval. This is the call that replaces ~60 HTTP requests on a
     * warm category, and it is the reason a second report is nearly free. */
    search(query, { category = null, limit = 200, minScore = null, source = null } = {}) {
      const match = ftsQuery(query);
      if (!match) return [];
      const where = ['docs_fts MATCH ?'];
      const args = [match];
      if (category) { where.push('d.category = ?'); args.push(category); }
      if (source)   { where.push('d.source = ?');   args.push(source); }
      if (minScore != null) { where.push('d.score >= ?'); args.push(minScore); }
      args.push(limit);

      return db.prepare(`
        SELECT d.source, d.kind, d.external_id, d.channel, d.text, d.score, d.url, d.created_utc,
               bm25(docs_fts) AS rank
        FROM docs_fts
        JOIN docs d ON d.id = docs_fts.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY rank, d.score DESC
        LIMIT ?
      `).all(...args);
    },

    /* Everything we hold for a category, best-scoring first. Used when the
     * category is warm enough that we do not need to search at all. */
    byCategory(category, { limit = 400, kind = null } = {}) {
      const where = ['category = ?'];
      const args = [category];
      if (kind) { where.push('kind = ?'); args.push(kind); }
      args.push(limit);
      return db.prepare(`
        SELECT source, kind, external_id, channel, text, score, url, created_utc
        FROM docs WHERE ${where.join(' AND ')}
        ORDER BY score DESC LIMIT ?
      `).all(...args);
    },

    /* The warm/cold decision, and what the UI shows as the "instant read". */
    categoryStats(category) {
      const row = db.prepare(`
        SELECT COUNT(*) AS docs,
               SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END) AS comments,
               COUNT(DISTINCT channel) AS channels,
               MAX(harvested_at) AS last_harvested,
               MAX(created_utc) AS newest
        FROM docs WHERE category = ?
      `).get(category) || {};
      const meta = db.prepare('SELECT * FROM categories WHERE name = ?').get(category);
      const ageDays = row.last_harvested ? (now() - row.last_harvested) / 86400 : null;
      return {
        category,
        docs: row.docs || 0,
        comments: row.comments || 0,
        channels: row.channels || 0,
        lastHarvested: row.last_harvested || 0,
        ageDays,
        // Warm means: enough to answer from, and recent enough to trust.
        warm: (row.docs || 0) >= 150 && ageDays != null && ageDays < 14,
        subreddits: meta?.subreddits ? JSON.parse(meta.subreddits) : [],
        queries: meta?.queries ? JSON.parse(meta.queries) : [],
      };
    },

    /* Remember the plan that worked, so a repeat run skips re-planning. */
    rememberCategory(category, { subreddits = [], queries = [] } = {}) {
      const ts = now();
      db.prepare(`
        INSERT INTO categories (name, first_seen, last_harvested, subreddits, queries)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          last_harvested = excluded.last_harvested,
          subreddits     = excluded.subreddits,
          queries        = excluded.queries
      `).run(category, ts, ts, JSON.stringify(subreddits), JSON.stringify(queries));
    },

    saveReport({ productUrl, productTitle, category, markdown, findings, costUsd }) {
      db.prepare(`
        INSERT INTO reports (product_url, product_title, category, markdown, findings, cost_usd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(productUrl, productTitle || '', category, markdown,
             JSON.stringify(findings || {}), costUsd || 0, now());
    },

    priorReports(category, limit = 3) {
      return db.prepare(`
        SELECT product_title, product_url, findings, created_at
        FROM reports WHERE category = ? ORDER BY created_at DESC LIMIT ?
      `).all(category, limit);
    },

    /* Product cache: a repeat URL never re-pays for unblocking. */
    cacheProduct(facts, category, maxAgeDays = 30) {
      db.prepare(`
        INSERT INTO products (url, title, category, facts, source, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title, category = excluded.category,
          facts = excluded.facts, source = excluded.source, fetched_at = excluded.fetched_at
      `).run(facts.url, facts.title || '', category || '', JSON.stringify(facts), facts.source || '', now());
      void maxAgeDays;
    },

    getProduct(url, maxAgeDays = 30) {
      const row = db.prepare('SELECT facts, fetched_at FROM products WHERE url = ?').get(url);
      if (!row) return null;
      if ((now() - row.fetched_at) / 86400 > maxAgeDays) return null;
      try { return JSON.parse(row.facts); } catch { return null; }
    },

    totals() {
      const d = db.prepare('SELECT COUNT(*) AS n FROM docs').get();
      const c = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
      const r = db.prepare('SELECT COUNT(*) AS n FROM reports').get();
      return { docs: d?.n || 0, categories: c?.n || 0, reports: r?.n || 0 };
    },

    close() { db.close(); },
  };
}

/* Shape the retrieval layers into corpus rows. Kept here so every producer
 * writes the same shape and dedupe actually works. */
/* Retrieval shapes to documents. Defined in docs.mjs, which has no database
 * dependency, so the Netlify worker can build documents without pulling
 * node:sqlite into its bundle. Re-exported here because this is where every
 * existing caller looks for them. */
export { redditDocs, youtubeDocs } from './docs.mjs';

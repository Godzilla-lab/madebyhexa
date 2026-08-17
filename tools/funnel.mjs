#!/usr/bin/env node
/*
 * Read the funnel counters.
 *
 *   node tools/funnel.mjs              every day on record
 *   node tools/funnel.mjs --days 7     the last week
 *
 * The store holds one blob per event (see netlify/functions/funnel.js for why
 * it is shaped that way), keyed `event/YYYY-MM-DD/label/uuid`, so counting is
 * listing a prefix. Nothing here is derived or estimated: every number printed
 * is a count of objects that exist.
 *
 * Needs NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN, or NETLIFY_API_TOKEN, in the
 * environment or in .env. Reading counts touches no customer data.
 */

import { getStore } from '@netlify/blobs';
import { readFileSync } from 'node:fs';

const EVENTS = ['gate-seen', 'gate-clicked', 'signup-completed', 'free-ad-viewed'];

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch { /* no .env is fine when the vars are already exported */ }

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
if (!siteID || !token) {
  console.error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN (or NETLIFY_API_TOKEN) first.');
  process.exit(1);
}

const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 0;
const since = days
  ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  : '0000-00-00';

const store = getStore({ name: 'funnel', siteID, token });

/* event -> day -> label -> count */
const counts = new Map();
for (const name of EVENTS) {
  const { blobs } = await store.list({ prefix: name + '/' });
  for (const b of blobs) {
    const [, day, label] = b.key.split('/');
    if (!day || day < since) continue;
    if (!counts.has(name)) counts.set(name, new Map());
    const byDay = counts.get(name);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const byLabel = byDay.get(day);
    byLabel.set(label, (byLabel.get(label) || 0) + 1);
  }
}

let anything = false;
const totals = new Map();
for (const name of EVENTS) {
  const byDay = counts.get(name);
  if (!byDay) continue;
  anything = true;
  console.log('\n' + name);
  for (const day of [...byDay.keys()].sort()) {
    const byLabel = byDay.get(day);
    const dayTotal = [...byLabel.values()].reduce((a, b) => a + b, 0);
    totals.set(name, (totals.get(name) || 0) + dayTotal);
    const parts = [...byLabel.entries()].map(([l, n]) => l + ' ' + n).join(', ');
    console.log('  ' + day + '  ' + String(dayTotal).padStart(5) + '   ' + parts);
  }
}

if (!anything) {
  console.log('No events recorded yet.');
  process.exit(0);
}

console.log('\ntotals');
for (const name of EVENTS) {
  console.log('  ' + name.padEnd(18) + String(totals.get(name) || 0).padStart(6));
}

/* The two rates worth arguing about, printed only when both sides exist, so a
 * ratio is never shown against a zero it would misrepresent. */
const seen = totals.get('gate-seen') || 0;
const clicked = totals.get('gate-clicked') || 0;
const signed = totals.get('signup-completed') || 0;
if (seen && clicked) console.log('\n  gate click rate   ' + ((clicked / seen) * 100).toFixed(1) + '%');
if (clicked && signed) console.log('  click to account  ' + ((signed / clicked) * 100).toFixed(1) + '%');

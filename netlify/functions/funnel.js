'use strict';

/*
 * Count a funnel event.
 *
 * POST { event, label } -> 204
 *
 * One blob per event rather than a counter blob per name, because Netlify
 * Blobs has no atomic increment: a read-modify-write counter loses events
 * whenever two browsers land in the same moment, and a funnel measured with a
 * lossy counter is worse than no funnel, since it looks authoritative. Writing
 * a uniquely-keyed object is atomic by construction, so the count is exact and
 * comes from listing a prefix.
 *
 * Read it with `node tools/funnel.mjs`.
 *
 * Nothing identifying is stored. No ip, no user agent, no user id, no product
 * name: the event name and a category label, and that is the whole record.
 * These numbers exist to compare two designs, not to follow a person, and a
 * store that cannot identify anybody needs no consent banner in front of it.
 */

const { allow } = require('./lib/ratelimit');
const crypto = require('crypto');

/* The only events this accepts. An allowlist rather than free text, so a
 * flood cannot fill the store with junk keys and so a typo in a call site
 * fails loudly here instead of quietly creating a second metric that looks
 * real. */
const EVENTS = [
  'gate-seen',
  'gate-clicked',
  'signup-completed',
  'free-ad-viewed',
];

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  // Unauthenticated by nature, like any beacon. Generous, because a real
  // browsing session fires a handful of these and the cost of one write is
  // nothing; tight enough that a loop cannot fill the store.
  if (!(await allow('funnel', event, 600))) return { statusCode: 204, body: '' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'bad json' }; }

  const name = String(body.event || '');
  if (EVENTS.indexOf(name) < 0) return { statusCode: 400, body: 'unknown event' };
  const label = String(body.label || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32).toLowerCase() || 'none';

  const day = new Date().toISOString().slice(0, 10);
  try {
    const { getStore } = require('@netlify/blobs');
    await getStore('funnel').set(
      name + '/' + day + '/' + label + '/' + crypto.randomUUID(),
      String(Date.now())
    );
  } catch (e) {
    // Blobs unavailable is not the page's problem. Log and answer success:
    // a beacon that returns an error teaches nothing and retries nothing.
    console.error('[funnel] could not record ' + name + ': ' + e.message);
  }

  return { statusCode: 204, body: '' };
};

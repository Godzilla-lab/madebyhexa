'use strict';

/* Netlify Blobs context for Lambda-compat (v1) functions.
 *
 * Functions written as `exports.handler = (event) => ...` do NOT get the
 * Blobs environment automatically (only the newer v2 signature does), so a
 * bare getStore() throws MissingBlobsEnvironmentError and everything built
 * on Blobs silently degrades: token rotations stop persisting (which
 * eventually revokes the Higgsfield chain), rate limits fail open, and the
 * peek scrape memory never hits. connectLambda(event) hydrates the context
 * from the invocation event. Call this first in every handler that touches
 * Blobs directly or through lib/hf.js / lib/ratelimit.js.
 */
exports.connect = function (event) {
  try {
    require('@netlify/blobs').connectLambda(event);
  } catch (e) {
    // Blobs stay best-effort: a failure here must never take a request down.
  }
};

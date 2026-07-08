'use strict';

/*
 * Supabase server client for Netlify functions.
 *
 * admin() returns a service-role client that BYPASSES Row-Level Security — use
 * it only in trusted server code (webhook fulfilment, owner-checked writes).
 * The service-role key must never reach the browser; the browser uses the anon
 * (publishable) key + the user's JWT so RLS keeps each user to their own rows.
 */

const { createClient } = require('@supabase/supabase-js');

function configured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

let _admin = null;
function admin() {
  if (!configured()) return null;
  if (!_admin) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _admin;
}

module.exports = { admin, configured };

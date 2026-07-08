'use strict';

/*
 * One-shot: move the Higgsfield CLI login into the backend so functions can
 * refresh their own access token forever (see netlify/functions/lib/hf.js).
 *
 *   node tools/hf-seed-token.js <oauth_client_id> [--local-only]
 *
 * <oauth_client_id> is the CLI's public PKCE client id. To read it: run
 * `higgsfield auth login`, copy client_id=... from the browser address bar,
 * then close the tab (no need to finish signing in).
 *
 * What it does, in order:
 *   1. reads the CLI's stored grant from ~/.config/higgsfield/credentials.json
 *   2. performs one real refresh against Clerk to prove the pair works
 *   3. writes HIGGSFIELD_TOKEN (fresh), HIGGSFIELD_REFRESH_TOKEN and
 *      HIGGSFIELD_OAUTH_CLIENT_ID into .env, and via `netlify env:set`
 *      into production (skipped with --local-only)
 *   4. if the refresh token rotated, writes the new pair back to the CLI's
 *      credentials file (with a .bak) so `higgsfield` keeps working too
 *
 * Prints statuses only. Never prints token material.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLIENT_ID = (process.argv[2] || '').trim();
const LOCAL_ONLY = process.argv.includes('--local-only');
const TOKEN_URL = process.env.HIGGSFIELD_OAUTH_TOKEN_URL || 'https://clerk.higgsfield.ai/oauth/token';
const CREDS_PATH = path.join(os.homedir(), '.config', 'higgsfield', 'credentials.json');
const ENV_PATH = path.join(__dirname, '..', '.env');

if (!CLIENT_ID || CLIENT_ID.startsWith('-')) {
  console.error('usage: node tools/hf-seed-token.js <oauth_client_id> [--local-only]');
  console.error('       (client_id: run `higgsfield auth login`, copy client_id=... from the browser URL)');
  process.exit(1);
}

function setEnvLine(content, key, value) {
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  return re.test(content) ? content.replace(re, line) : content.trimEnd() + '\n' + line + '\n';
}

(async () => {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  if (!creds.refresh_token) {
    console.error('no refresh_token in CLI credentials; run `higgsfield auth login` first');
    process.exit(1);
  }
  console.log('1/4 CLI credentials loaded');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    client_id: CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    console.error('2/4 refresh FAILED (HTTP ' + res.status + '):', JSON.stringify(d).slice(0, 200));
    console.error('    wrong client_id, or the CLI session was revoked; `higgsfield auth login` and retry');
    process.exit(1);
  }
  const rotated = !!d.refresh_token && d.refresh_token !== creds.refresh_token;
  const newRefresh = d.refresh_token || creds.refresh_token;
  console.log('2/4 refresh works (expires_in ' + (d.expires_in || '?') + 's, refresh token ' +
    (rotated ? 'ROTATES' : 'is reusable') + ')');

  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  env = setEnvLine(env, 'HIGGSFIELD_TOKEN', d.access_token);
  env = setEnvLine(env, 'HIGGSFIELD_REFRESH_TOKEN', newRefresh);
  env = setEnvLine(env, 'HIGGSFIELD_OAUTH_CLIENT_ID', CLIENT_ID);
  fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });
  let step3 = '.env updated';
  if (!LOCAL_ONLY) {
    for (const [k, v] of [
      ['HIGGSFIELD_TOKEN', d.access_token],
      ['HIGGSFIELD_REFRESH_TOKEN', newRefresh],
      ['HIGGSFIELD_OAUTH_CLIENT_ID', CLIENT_ID],
    ]) {
      execFileSync('netlify', ['env:set', k, v], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    step3 += ' + Netlify env set (3 vars, all contexts)';
  }
  console.log('3/4 ' + step3);

  if (rotated) {
    fs.copyFileSync(CREDS_PATH, CREDS_PATH + '.bak');
    const updated = { ...creds, access_token: d.access_token, refresh_token: newRefresh };
    if (d.expires_in) updated.expires_at = new Date(Date.now() + d.expires_in * 1000).toISOString();
    fs.writeFileSync(CREDS_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 });
    console.log('4/4 rotated pair written back to CLI credentials (.bak kept)');
    console.log('    NOTE: rotation means backend and CLI now share one chain; if the CLI');
    console.log('    ever errors with 401, run `higgsfield auth login` (backend is unaffected).');
  } else {
    console.log('4/4 no rotation: CLI credentials untouched, backend refreshes independently');
  }
  console.log('done. production functions now mint their own Higgsfield tokens.');
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });

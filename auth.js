/* ═════ Hexa client auth ═════
 * Thin wrapper over supabase-js (self-hosted UMD at /vendor/supabase.js, which
 * must load first). Exposes window.HexaAuth for the studio, nav, and pages.
 *
 * The URL + publishable key are public by design (the publishable key is meant
 * to ship in the browser; RLS keeps every user to their own rows). The secret
 * key lives only in Netlify functions, never here.
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://xsfxsnqmhaogfsgdjjeg.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_6Yux-E7l44XvZZCHl88VbQ_k0n6vINO';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('HexaAuth: supabase-js not loaded. Include /vendor/supabase.js before auth.js');
    return;
  }

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });

  var _session = null;
  var _loaded = false;
  var readyResolve;
  var _ready = new Promise(function (res) { readyResolve = res; });

  function user() { return _session && _session.user ? _session.user : null; }
  function emit() { window.dispatchEvent(new CustomEvent('hexa-auth', { detail: { user: user() } })); }
  function base() { return location.origin; }

  client.auth.getSession().then(function (r) {
    _session = (r && r.data && r.data.session) || null;
    _loaded = true;
    readyResolve();
    emit();
    welcomePing();
    claimReport();
    countSignup();
  });
  client.auth.onAuthStateChange(function (_evt, session) {
    _session = session || null;
    emit();
    welcomePing();
    claimReport();
    countSignup();
  });

  /*
   * signup-completed, counted once, wherever the account was actually made.
   *
   * Here rather than in login.js for the same reason the claim is here: Google
   * comes back by redirect and touches no form handler, so a counter on the
   * submit path would undercount every OAuth signup and quietly make the email
   * flow look better than it is.
   *
   * The label is the only interesting dimension: did this account come from a
   * report gate or from a cold visit. That is the comparison the whole funnel
   * was built to settle.
   */
  function countSignup() {
    var u = user();
    if (!u || !u.created_at) return;
    // Brand new only. A returning customer signing in on Tuesday is not a
    // signup, and five minutes covers the slowest code round trip.
    if (Date.now() - new Date(u.created_at).getTime() > 5 * 60 * 1000) return;
    var flag = 'hexa-signup-counted-' + u.id;
    try { if (localStorage.getItem(flag)) return; localStorage.setItem(flag, '1'); } catch (e) {}
    var from = 'cold';
    try { from = JSON.parse(sessionStorage.getItem('hexa.report') || 'null') ? 'report' : 'cold'; }
    catch (e) {}
    if (window.hexaTrack) window.hexaTrack('signup-completed', from);
  }

  /*
   * Hand the anonymous report to the account that just signed in.
   *
   * This lives here, on the auth state change, rather than in a login.js
   * success handler, because Google sign-in comes back by redirect and runs no
   * success handler at all: hanging the claim off the form would leave every
   * OAuth signup with an orphaned report. Both doors pass through here.
   *
   * The guard matters as much as the call. This file loads on nearly every
   * page, so without it the ordinary case (a returning customer with no
   * pending report) would fire a guaranteed-404 POST on every sign-in and
   * every token refresh. No stored handle, no request.
   *
   * A stored entry with no claim token belongs to a report that was already
   * created while signed in, so there is nothing to exchange there either.
   */
  var claimed = {};
  function claimReport() {
    if (!_session) return;
    var saved;
    try { saved = JSON.parse(sessionStorage.getItem('hexa.report') || 'null'); }
    catch (e) { return; }
    if (!saved || !saved.id || !saved.claim) return;
    if (claimed[saved.id]) return;
    claimed[saved.id] = true;

    fetch('/.netlify/functions/report-claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + _session.access_token,
      },
      // No user id in this body on purpose: the server takes the owner from
      // the bearer token and nothing else.
      body: JSON.stringify({ id: saved.id, claimToken: saved.claim }),
    }).then(function (r) {
      // A refused claim is final, so it is not retried. A transport failure is
      // not, so it is: clearing the flag lets the next auth event try again.
      if (!r.ok && r.status >= 500) throw new Error('report-claim ' + r.status);
    }).catch(function () {
      delete claimed[saved.id];
    });
  }

  /* The instant welcome email: any page that sees a session on an account
   * younger than 2 days pings welcome-now once. The server is idempotent
   * (same sent-state as the hourly drip), the flag here just saves calls. */
  function welcomePing() {
    var u = user();
    if (!u || !u.created_at || !_session) return;
    if (Date.now() - new Date(u.created_at).getTime() > 2 * 86400000) return;
    var flag = 'hexa-welcomed-' + u.id;
    try { if (localStorage.getItem(flag)) return; localStorage.setItem(flag, '1'); } catch (e) {}
    fetch('/.netlify/functions/welcome-now', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + _session.access_token },
    }).then(function (r) {
      // mail paused or send failed: clear the flag so a later visit retries
      if (!r.ok) throw new Error('welcome-now ' + r.status);
    }).catch(function () {
      try { localStorage.removeItem(flag); } catch (e) {}
    });
  }

  window.HexaAuth = {
    client: client,
    ready: function () { return _ready; },
    loaded: function () { return _loaded; },
    user: user,
    session: function () { return _session; },
    accessToken: function () { return _session ? _session.access_token : null; },
    email: function () { var u = user(); return u ? u.email : null; },
    name: function () {
      var u = user();
      if (!u) return null;
      return (u.user_metadata && (u.user_metadata.name || u.user_metadata.full_name)) || u.email;
    },

    /* Fire cb(user) now (once session is known) and on every change. */
    onChange: function (cb) {
      window.addEventListener('hexa-auth', function (e) { cb(e.detail.user); });
      _ready.then(function () { cb(user()); });
    },

    signUpEmail: function (email, password, name) {
      return client.auth.signUp({
        email: email,
        password: password,
        options: { data: name ? { name: name } : {}, emailRedirectTo: base() + '/account.html' },
      });
    },
    signInEmail: function (email, password) {
      return client.auth.signInWithPassword({ email: email, password: password });
    },
    signInMagicLink: function (email, next) {
      return client.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: base() + (next || '/account.html') },
      });
    },
    signInGoogle: function (next) {
      return client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: base() + (next || '/account.html') },
      });
    },
    resetPassword: function (email) {
      return client.auth.resetPasswordForEmail(email, { redirectTo: base() + '/account.html' });
    },
    /* Six-digit email codes (the templates carry a code, not a link).
     * type 'signup' activates a new account, 'recovery' starts a password
     * reset; both return a live session on success. */
    verifyEmailCode: function (email, code, type) {
      return client.auth.verifyOtp({ email: email, token: String(code || '').trim(), type: type });
    },
    resendSignupCode: function (email) {
      return client.auth.resend({ type: 'signup', email: email });
    },
    signOut: function () { return client.auth.signOut(); },
    /* Revoke every session on every device (stolen laptop, shared machine). */
    signOutEverywhere: function () { return client.auth.signOut({ scope: 'global' }); },

    /* ── Account settings ── */
    updateName: function (name) {
      return client.auth.updateUser({ data: { name: String(name || '').trim() } });
    },
    updatePassword: function (password) {
      return client.auth.updateUser({ password: password });
    },
    /* Sends a confirmation link to the new address; the change applies when
     * the user clicks it, so a typo can never lock anyone out. */
    updateEmail: function (email) {
      return client.auth.updateUser(
        { email: String(email || '').trim() },
        { emailRedirectTo: base() + '/account.html' }
      );
    },

    /* Guard a page/action: if not signed in, bounce to login with a return path. */
    requireAuth: function (next) {
      if (user()) return true;
      var n = next || (location.pathname + location.search);
      location.href = '/login.html?next=' + encodeURIComponent(n);
      return false;
    },
  };
})();

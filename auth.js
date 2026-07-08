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
  });
  client.auth.onAuthStateChange(function (_evt, session) {
    _session = session || null;
    emit();
  });

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
    signOut: function () { return client.auth.signOut(); },

    /* Guard a page/action: if not signed in, bounce to login with a return path. */
    requireAuth: function (next) {
      if (user()) return true;
      var n = next || (location.pathname + location.search);
      location.href = '/login.html?next=' + encodeURIComponent(n);
      return false;
    },
  };
})();

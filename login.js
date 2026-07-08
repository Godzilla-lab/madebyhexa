/* Login / signup page logic. Depends on window.HexaAuth (auth.js). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // Safe return path: same-origin relative only (no open redirect).
  function safeNext() {
    var raw = new URLSearchParams(location.search).get('next') || '/account.html';
    if (raw.charAt(0) !== '/' || raw.charAt(1) === '/') return '/account.html';
    return raw;
  }
  var NEXT = safeNext();

  var els = {
    kicker: $('auth-kicker'), title: $('auth-title'), sub: $('auth-sub'),
    form: $('auth-form'), name: $('auth-name'), fieldName: $('field-name'),
    email: $('auth-email'), password: $('auth-password'), fieldPassword: $('field-password'),
    error: $('auth-error'), note: $('auth-note'), submit: $('auth-submit'),
    google: $('auth-google'), magic: $('auth-magic'), forgot: $('auth-forgot'),
    toggle: $('auth-toggle'), toggleText: $('toggle-text'),
  };

  var mode = 'signin'; // signin | signup

  function showError(msg) {
    els.note.hidden = true;
    els.error.textContent = msg;
    els.error.hidden = false;
  }
  function showNote(msg) {
    els.error.hidden = true;
    els.note.textContent = msg;
    els.note.hidden = false;
  }
  function clearMsgs() { els.error.hidden = true; els.note.hidden = true; }

  function setMode(m) {
    mode = m;
    clearMsgs();
    var signup = m === 'signup';
    els.fieldName.hidden = !signup;
    els.kicker.textContent = signup ? 'Get started' : 'Welcome back';
    els.title.textContent = signup ? 'Create your account' : 'Sign in to Hexa';
    els.sub.textContent = signup
      ? 'Start creating, and keep every film and photoshoot in one place.'
      : 'Your films and photoshoots, all in one place.';
    els.submit.textContent = signup ? 'Create account' : 'Sign in';
    els.password.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    els.toggleText.textContent = signup ? 'Already have an account?' : 'New to Hexa?';
    els.toggle.textContent = signup ? 'Sign in' : 'Create an account';
    els.forgot.style.display = signup ? 'none' : '';
  }

  function busy(on, label) {
    els.submit.disabled = on;
    els.google.disabled = on;
    if (label) els.submit.textContent = label;
  }

  function niceError(err) {
    var m = (err && err.message) || 'Something went wrong. Try again.';
    if (/Email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the link.';
    if (/Invalid login credentials/i.test(m)) return 'That email and password do not match.';
    if (/already registered/i.test(m)) return 'That email already has an account. Try signing in.';
    if (/provider is not enabled/i.test(m)) return 'Google sign-in is not enabled yet. Use email for now.';
    return m;
  }

  // Already signed in? Skip the form.
  window.HexaAuth.ready().then(function () {
    if (window.HexaAuth.user()) location.replace(NEXT);
  });

  els.toggle.addEventListener('click', function () { setMode(mode === 'signin' ? 'signup' : 'signin'); });

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearMsgs();
    var email = (els.email.value || '').trim();
    var password = els.password.value || '';
    if (!email) { showError('Enter your email.'); return; }
    if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }

    if (mode === 'signup') {
      busy(true, 'Creating account…');
      window.HexaAuth.signUpEmail(email, password, (els.name.value || '').trim()).then(function (r) {
        busy(false); els.submit.textContent = 'Create account';
        if (r.error) { showError(niceError(r.error)); return; }
        if (r.data && r.data.session) { location.replace(NEXT); return; }
        showNote('Almost there. Check ' + email + ' for a confirmation link to activate your account.');
      });
    } else {
      busy(true, 'Signing in…');
      window.HexaAuth.signInEmail(email, password).then(function (r) {
        busy(false); els.submit.textContent = 'Sign in';
        if (r.error) { showError(niceError(r.error)); return; }
        location.replace(NEXT);
      });
    }
  });

  els.google.addEventListener('click', function () {
    clearMsgs();
    busy(true);
    window.HexaAuth.signInGoogle(NEXT).then(function (r) {
      // On success the browser redirects to Google; we only get here on error.
      busy(false);
      if (r && r.error) showError(niceError(r.error));
    });
  });

  els.magic.addEventListener('click', function () {
    clearMsgs();
    var email = (els.email.value || '').trim();
    if (!email) { showError('Enter your email above first, then tap magic link.'); els.email.focus(); return; }
    els.magic.disabled = true;
    window.HexaAuth.signInMagicLink(email, NEXT).then(function (r) {
      els.magic.disabled = false;
      if (r.error) { showError(niceError(r.error)); return; }
      showNote('Sign-in link sent to ' + email + '. Open it on this device.');
    });
  });

  els.forgot.addEventListener('click', function () {
    clearMsgs();
    var email = (els.email.value || '').trim();
    if (!email) { showError('Enter your email above first.'); els.email.focus(); return; }
    els.forgot.disabled = true;
    window.HexaAuth.resetPassword(email).then(function (r) {
      els.forgot.disabled = false;
      if (r.error) { showError(niceError(r.error)); return; }
      showNote('Password reset link sent to ' + email + '.');
    });
  });

  // Deep link to signup: /login.html?mode=signup
  if (new URLSearchParams(location.search).get('mode') === 'signup') setMode('signup');
})();

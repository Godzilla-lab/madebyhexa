/* Login / signup page logic. Depends on window.HexaAuth (auth.js).
 *
 * Flows (no links, no magic): every email carries a numeric code.
 *   signin        email + password
 *   signup        name + email + password -> code screen -> account
 *   forgot        email -> code screen -> new password -> account
 * The code screens verify via Supabase OTP, so the session starts right
 * here on the page; nobody has to leave for their inbox and click.
 */
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
  var CODE_MINUTES = 15; // keep in sync with the Supabase OTP expiry setting
  var CODE_LEN = 8;       // Supabase mints 8 digit email codes for this project

  /*
   * The report this visitor left behind, if they came from the gate.
   *
   * Read-only here, and only for the title: the screen needs a name to put in
   * front of somebody so the signup is visibly about their product rather
   * than about our database. The claim token in the same entry is never read
   * on this page and never goes anywhere near a URL; the exchange happens in
   * auth.js the moment a session exists.
   */
  function pendingReport() {
    var s;
    try { s = JSON.parse(sessionStorage.getItem('hexa.report') || 'null'); }
    catch (e) { return null; }
    return s && s.id ? s : null;
  }
  var REPORT = pendingReport();

  var els = {
    kicker: $('auth-kicker'), title: $('auth-title'), sub: $('auth-sub'),
    trust: $('auth-trust'),
    visualKicker: $('auth-visual-kicker'), visualLine: $('auth-visual-line'),
    form: $('auth-form'), name: $('auth-name'), fieldName: $('field-name'),
    email: $('auth-email'), fieldEmail: $('field-email'),
    password: $('auth-password'), fieldPassword: $('field-password'),
    code: $('auth-code'), fieldCode: $('field-code'),
    newpass: $('auth-newpass'), fieldNewpass: $('field-newpass'),
    error: $('auth-error'), note: $('auth-note'), submit: $('auth-submit'),
    google: $('auth-google'), or: document.querySelector('.auth-or'),
    forgot: $('auth-forgot'), resend: $('auth-resend'), back: $('auth-back'),
    toggleRow: $('auth-toggle-row'), toggle: $('auth-toggle'), toggleText: $('toggle-text'),
  };

  var state = 'signin'; // signin | signup | signup-code | forgot | forgot-code | newpass
  var codeEmail = '';   // the address the current code went to

  function showError(msg) { els.note.hidden = true; els.error.textContent = msg; els.error.hidden = false; }
  function showNote(msg) { els.error.hidden = true; els.note.textContent = msg; els.note.hidden = false; }
  function clearMsgs() { els.error.hidden = true; els.note.hidden = true; }

  /*
   * `signup-report` is a voice, not a seventh state.
   *
   * Everything about the mechanics is identical to `signup`: same fields, same
   * Supabase call, same code screen. What changes is that this person did not
   * come here wanting an account, they came here wanting an ad, and the screen
   * has to say so. Layering it as copy rather than as another state keeps the
   * six-way machine below untouched, which is where the bugs would be.
   *
   * The submit says "create", not "email me a link". A link opens wherever the
   * mail app decides, and the report is held in tab-scoped sessionStorage: a
   * link that lands in a different browser loses the exact thing this screen
   * is promising to keep. The code arrives in the same tab.
   */
  var COPY = {
    'signin':      { kicker: 'Welcome back', title: 'Sign in to Hexa', sub: 'Your films and photoshoots, all in one place.', submit: 'Sign in' },
    'signup':      { kicker: 'Get started', title: 'Create your account', sub: 'Start creating, and keep every film and photoshoot in one place.', submit: 'Create account' },
    'signup-report': {
      kicker: 'Almost there',
      title: 'Create your free account',
      sub: '',   // written from the product name below
      submit: 'Create my free account',
    },
    'signup-code': { kicker: 'Check your email', title: 'Enter your code', sub: '', submit: 'Verify and continue' },
    'forgot':      { kicker: 'Reset password', title: 'Get a reset code', sub: 'Tell us your account email and we send you a code.', submit: 'Send code' },
    'forgot-code': { kicker: 'Check your email', title: 'Enter your code', sub: '', submit: 'Verify code' },
    'newpass':     { kicker: 'Almost done', title: 'Set a new password', sub: 'You are signed in. Pick a new password to finish.', submit: 'Save and continue' },
  };

  function setState(s) {
    state = s;
    clearMsgs();
    var fromReport = REPORT && (s === 'signup' || s === 'signup-code');
    var c = (s === 'signup' && REPORT) ? COPY['signup-report'] : COPY[s];
    els.kicker.textContent = c.kicker;
    els.title.textContent = c.title;
    els.sub.textContent = c.sub ||
      (s === 'signup-code' || s === 'forgot-code'
        ? 'We emailed a code to ' + codeEmail + '. It expires in ' + CODE_MINUTES + ' minutes.'
        : (s === 'signup' && REPORT
            ? (REPORT.title
                ? 'Your read of ' + REPORT.title + ' is saved. Make the account and we build the ad.'
                : 'Your report is saved. Make the account and we build the ad.')
            : c.sub));
    els.submit.textContent = c.submit;

    /* The promises show while the account is being made and stay up on the
     * code screen, which is the screen people abandon: it is the moment they
     * most need reminding what the digits are for. */
    if (els.trust) els.trust.hidden = !fromReport;
    if (els.visualLine && REPORT) {
      els.visualKicker.textContent = 'Hexa Research';
      els.visualLine.textContent = 'The angle came from your buyers. The ad comes next.';
    }

    var isCode = s === 'signup-code' || s === 'forgot-code';
    els.fieldName.hidden = s !== 'signup';
    els.fieldEmail.hidden = isCode || s === 'newpass';
    els.fieldPassword.hidden = !(s === 'signin' || s === 'signup');
    els.fieldCode.hidden = !isCode;
    els.fieldNewpass.hidden = s !== 'newpass';

    els.google.hidden = !(s === 'signin' || s === 'signup');
    if (els.or) els.or.hidden = els.google.hidden;

    els.forgot.hidden = s !== 'signin';
    els.resend.hidden = !isCode;
    els.back.hidden = !(isCode || s === 'forgot');
    els.toggleRow.hidden = !(s === 'signin' || s === 'signup');

    els.password.setAttribute('autocomplete', s === 'signup' ? 'new-password' : 'current-password');
    els.password.setAttribute('placeholder', s === 'signup' ? '6+ chars with a capital and a number' : 'Your password');
    els.toggleText.textContent = s === 'signup' ? 'Already have an account?' : 'New to Hexa?';
    els.toggle.textContent = s === 'signup' ? 'Sign in' : 'Create an account';

    if (isCode) { els.code.value = ''; els.code.focus(); }
    if (s === 'newpass') els.newpass.focus();
  }

  function busy(on, label) {
    els.submit.disabled = on;
    els.google.disabled = on;
    if (label) els.submit.textContent = label;
    else els.submit.textContent = COPY[state].submit;
  }

  function niceError(err) {
    var m = (err && err.message) || 'Something went wrong. Try again.';
    if (/Email not confirmed/i.test(m)) return 'This account is not activated yet.';
    if (/Invalid login credentials/i.test(m)) return 'That email and password do not match.';
    if (/already registered/i.test(m)) return 'That email already has an account. Try signing in.';
    if (/provider is not enabled/i.test(m)) return 'Google sign-in is not enabled yet. Use email for now.';
    if (/Password should contain/i.test(m)) return 'Make the password a bit stronger: at least one lowercase letter, one capital letter and one number.';
    if (/expired|invalid/i.test(m) && (state === 'signup-code' || state === 'forgot-code')) {
      return 'That code is not right or has expired. Check the digits or tap "Send a new code".';
    }
    return m;
  }

  // Already signed in? Skip the form (never mid-flow on the code screens).
  window.HexaAuth.ready().then(function () {
    if (window.HexaAuth.user() && (state === 'signin' || state === 'signup')) location.replace(NEXT);
  });

  /* ── Submit: one handler, six states ── */
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearMsgs();
    var email = (els.email.value || '').trim();
    var password = els.password.value || '';

    if (state === 'signin') {
      if (!email) { showError('Enter your email.'); return; }
      if (!password) { showError('Enter your password.'); return; }
      busy(true, 'Signing in…');
      window.HexaAuth.signInEmail(email, password).then(function (r) {
        busy(false);
        if (r.error) {
          if (/Email not confirmed/i.test(r.error.message || '')) {
            // send a fresh activation code and walk them straight into it
            codeEmail = email;
            window.HexaAuth.resendSignupCode(email);
            setState('signup-code');
            showNote('Your account is not activated yet. We just emailed you a new code.');
            return;
          }
          showError(niceError(r.error));
          return;
        }
        location.replace(NEXT);
      });
      return;
    }

    if (state === 'signup') {
      if (!email) { showError('Enter your email.'); return; }
      if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }
      busy(true, 'Creating account…');
      window.HexaAuth.signUpEmail(email, password, (els.name.value || '').trim()).then(function (r) {
        busy(false);
        if (r.error) { showError(niceError(r.error)); return; }
        if (r.data && r.data.session) { location.replace(NEXT); return; } // confirmations off
        // Existing confirmed account: Supabase answers with an identity-less
        // user and sends NO email (anti enumeration). Waiting on a code that
        // never comes would be cruel; sign-in is one tap away instead.
        var u = r.data && r.data.user;
        if (u && Array.isArray(u.identities) && u.identities.length === 0) {
          setState('signin');
          els.email.value = email;
          showNote('That email already has an account. Sign in below, or use "Forgot password?" if you lost the password.');
          return;
        }
        codeEmail = email;
        setState('signup-code');
      });
      return;
    }

    if (state === 'signup-code' || state === 'forgot-code') {
      var code = (els.code.value || '').replace(/\D/g, '');
      if (code.length < 6) { showError('Type the whole code from the email.'); return; }
      busy(true, 'Checking…');
      var type = state === 'signup-code' ? 'signup' : 'recovery';
      window.HexaAuth.verifyEmailCode(codeEmail, code, type).then(function (r) {
        busy(false);
        if (r.error) { showError(niceError(r.error)); els.code.select(); return; }
        if (type === 'signup') {
          // Brand-new account: land on the onboarding welcome, not a bare library.
          location.replace(NEXT === '/account.html' ? '/account.html?welcome=1' : NEXT);
        }
        else setState('newpass');
      });
      return;
    }

    if (state === 'forgot') {
      if (!email) { showError('Enter your account email.'); return; }
      busy(true, 'Sending code…');
      window.HexaAuth.resetPassword(email).then(function (r) {
        busy(false);
        if (r.error) { showError(niceError(r.error)); return; }
        codeEmail = email;
        setState('forgot-code');
      });
      return;
    }

    if (state === 'newpass') {
      var np = els.newpass.value || '';
      if (np.length < 8) { showError('Use at least 8 characters.'); return; }
      busy(true, 'Saving…');
      window.HexaAuth.updatePassword(np).then(function (r) {
        busy(false);
        if (r && r.error) { showError(r.error.message || 'Could not save the password.'); return; }
        location.replace(NEXT);
      });
    }
  });

  /* ── Code input: digits only, auto-verify on the sixth ── */
  els.code.addEventListener('input', function () {
    els.code.value = els.code.value.replace(/\D/g, '').slice(0, CODE_LEN);
    if (els.code.value.length === CODE_LEN) {
      els.form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  /* ── Resend with a 30s cooldown ── */
  var cooldown = 0;
  var cooldownTimer = null;
  els.resend.addEventListener('click', function () {
    if (cooldown > 0 || !codeEmail) return;
    clearMsgs();
    var send = state === 'signup-code'
      ? window.HexaAuth.resendSignupCode(codeEmail)
      : window.HexaAuth.resetPassword(codeEmail);
    send.then(function (r) {
      if (r && r.error) { showError(niceError(r.error)); return; }
      showNote('New code sent to ' + codeEmail + '.');
      cooldown = 30;
      els.resend.disabled = true;
      cooldownTimer = setInterval(function () {
        cooldown--;
        els.resend.textContent = cooldown > 0 ? 'Send a new code (' + cooldown + 's)' : 'Send a new code';
        if (cooldown <= 0) { clearInterval(cooldownTimer); els.resend.disabled = false; }
      }, 1000);
    });
  });

  els.back.addEventListener('click', function () { setState('signin'); });
  els.forgot.addEventListener('click', function () {
    els.email.value = (els.email.value || '').trim();
    setState('forgot');
    els.email.focus();
  });
  els.toggle.addEventListener('click', function () { setState(state === 'signup' ? 'signin' : 'signup'); });

  els.google.addEventListener('click', function () {
    clearMsgs();
    busy(true);
    window.HexaAuth.signInGoogle(NEXT).then(function (r) {
      // On success the browser redirects to Google; we only get here on error.
      busy(false);
      if (r && r.error) showError(niceError(r.error));
    });
  });

  // Deep link to signup: /login.html?mode=signup
  if (new URLSearchParams(location.search).get('mode') === 'signup') setState('signup');
  else setState('signin');
})();

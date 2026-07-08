/* Reflects auth state in the site nav: #nav-account toggles Sign in / Account.
 * Safe no-op on pages without that element. Depends on window.HexaAuth. */
(function () {
  'use strict';
  if (!window.HexaAuth) return;
  var el = document.getElementById('nav-account');
  if (!el) return;
  window.HexaAuth.onChange(function (user) {
    if (user) { el.textContent = 'Account'; el.setAttribute('href', '/account.html'); }
    else { el.textContent = 'Sign in'; el.setAttribute('href', '/login.html'); }
  });
})();

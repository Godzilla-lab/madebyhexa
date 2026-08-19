/*
 * Marks the document as scripted, before first paint.
 *
 * Two rules key off this: `html:not(.js) .rchip` and `html:not(.js) .how-step`
 * force those elements visible, so a browser with no JS never hides content
 * behind a reveal that will not run. Setting the class is what hands control
 * back to the animation.
 *
 * A real file rather than the inline <script> this replaces. The site sends
 * `script-src 'self'` with no 'unsafe-inline' and no hash, so the inline
 * version was refused on every production page load since the CSP landed: the
 * class was never set, and both reveals had been silently disabled the whole
 * time. Nothing looked broken, because the no-JS fallback is "show it".
 */
document.documentElement.className += ' js';

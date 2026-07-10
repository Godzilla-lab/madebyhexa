'use strict';

/* Renders Mike's plain-text emails as a matching HTML part, so links read as
 * clean clickable text ("madebyhexa.co", "Unsubscribe") instead of raw URLs
 * spilling across two lines. The look stays deliberately plain: same words,
 * same rhythm, just anchors instead of URL soup. The text/plain part still
 * ships alongside for clients that prefer it. */

const { SITE } = require('./drip-links');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* Body text -> paragraphs, with every site URL collapsed into a clean
 * anchor labeled madebyhexa.co. */
function bodyHtml(text) {
  const siteRe = new RegExp('(' + SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\s]*)', 'g');
  const paras = String(text).split(/\n\n+/).map((p) => {
    const withLinks = esc(p).replace(siteRe, (u) =>
      '<a href="' + u + '" style="color:#e0245e;text-decoration:underline">madebyhexa.co</a>');
    return '<p style="margin:0 0 16px">' + withLinks.replace(/\n/g, '<br>') + '</p>';
  });
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a1a1a;max-width:560px">' +
    paras.join('') + '</div>';
}

/* The signature + unsubscribe footer as one clean line each. */
function footerHtml(unsubUrl) {
  return '<p style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;' +
    'font-size:13px;line-height:1.6;color:#8a8a8a;max-width:560px;margin:26px 0 0;padding-top:14px;border-top:1px solid #ececec">' +
    'Mike, Hexa AI · <a href="' + SITE + '" style="color:#8a8a8a">madebyhexa.co</a><br>' +
    '<a href="' + esc(unsubUrl) + '" style="color:#8a8a8a">Unsubscribe</a></p>';
}

module.exports = { bodyHtml, footerHtml };

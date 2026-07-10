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

/* Body text -> paragraphs, with every URL collapsed into a clean anchor.
 * Site links read as madebyhexa.co; any other link gets the label supplied
 * in `labels` ({ url: 'Download your film' }) or falls back to its host. */
function linkify(p, labels) {
  return String(p).split(/(https?:\/\/[^\s]+)/g).map((part) => {
    if (!/^https?:\/\//.test(part)) return esc(part).replace(/\n/g, '<br>');
    const url = part.replace(/[).,;:!?]+$/, ''); // trailing punctuation stays prose
    const trail = part.slice(url.length);
    let label = labels[url];
    if (!label && url.indexOf(SITE) === 0) label = 'madebyhexa.co';
    if (!label) {
      try { label = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { label = url.slice(0, 40); }
    }
    return '<a href="' + esc(url) + '" style="color:#e0245e;text-decoration:underline">' +
      esc(label) + '</a>' + esc(trail);
  }).join('');
}

function bodyHtml(text, labels) {
  const paras = String(text).split(/\n\n+/).map((p) =>
    '<p style="margin:0 0 16px">' + linkify(p, labels || {}) + '</p>');
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

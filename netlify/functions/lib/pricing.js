'use strict';

/*
 * The studio pricing oracle. catalog/pricing.json holds the per-product
 * economics (measured Higgsfield cost, retail, margin); this module turns a
 * studio order into an authoritative charge amount. studio.js mirrors the
 * same math client-side for display, but every real charge and every credit
 * spend is priced HERE. Extras must match currentPrice() in studio.js.
 */

const PRICING = require('../../../catalog/pricing.json');

const SEGMENT_SECONDS = 15;
const EXTRA_SEGMENT_USD = 8;
const ADPACK_INCLUDED_FORMATS = 20;
// 1080p rendering costs more credits on every segment; premium products carry
// it in their base retail. Mirrors QUALITY_1080_PER_SEGMENT in studio.js.
const QUALITY_1080_PER_SEGMENT_USD = 3;
const PREMIUM_1080 = new Set(['tv_spot', 'pro_try_on', 'cinematic']);

/*
 * Turn a studio order into { amountCents, name, description, meta }.
 * Returns null when the order does not resolve to a priced catalog item.
 */
function priceStudioOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const raw = String(order.product || '');
  const key = raw.replace(/^(mode|action):/, '');
  const item = PRICING.items[key];
  if (!item) return null;

  const sel = order.selections && typeof order.selections === 'object' ? order.selections : {};
  let usd = item.retail_usd;

  // Post-render actions (revoice/translate/upscale) run on one finished clip,
  // 15s or less by construction: flat price, no length or quality extras.
  const isAction = raw.indexOf('action:') === 0;

  const duration = Number(sel.duration) || 0;
  const segments = !isAction && duration > SEGMENT_SECONDS ? Math.ceil(duration / SEGMENT_SECONDS) : 1;
  if (segments > 1) usd += (segments - 1) * EXTRA_SEGMENT_USD;

  const formats = Array.isArray(sel.formats) ? sel.formats.length : 0;
  if (key === 'adpack' && formats > ADPACK_INCLUDED_FORMATS) {
    usd += (formats - ADPACK_INCLUDED_FORMATS) * (item.extra_format_usd || 2);
  }

  const wantsUltra = sel.quality === '1080p' && !PREMIUM_1080.has(key);
  const isVideoProduct = key !== 'photoshoot' && key !== 'adpack' && key !== 'soul';
  if (wantsUltra && isVideoProduct) usd += segments * QUALITY_1080_PER_SEGMENT_USD;

  const title = typeof order.title === 'string' && order.title ? order.title.slice(0, 80) : key;
  const styleName = typeof sel.styleName === 'string' ? sel.styleName : '';
  const productName = typeof sel.productName === 'string' ? sel.productName.slice(0, 90) : '';
  const isVideo = isVideoProduct;
  const quality = PREMIUM_1080.has(key) || sel.quality === '1080p' ? '1080p' : '720p';
  const aspect = sel.aspect && (sel.aspect.id || sel.aspect);
  const aspectStr = typeof aspect === 'string' ? aspect : '';
  const eta = item.eta ? item.eta.replace('~', 'about ') : '';

  // Stripe line-item copy: name = the thing, description = the deliverable spec.
  let name;
  if (productName) {
    name = isVideo
      ? (styleName || title) + ' film for ' + productName
      : title + ' for ' + productName;
  } else {
    name = 'Hexa Studio: ' + title;
  }
  name = name.slice(0, 120);

  let description;
  if (isVideo) {
    const secs = duration > SEGMENT_SECONDS ? duration : SEGMENT_SECONDS;
    const spec = (aspectStr ? ' in ' + aspectStr : '') + ' at ' + quality;
    description = segments > 1
      ? 'One continuous ' + secs + ' second film' + spec + '. ' +
        segments + ' segments, same actor and scene, one storyboard. Full commercial license.' +
        (eta ? ' Ready in ' + eta + ',' : '') + ' delivered in your browser and by email.'
      : 'A 15 second ' + (styleName ? styleName + ' ' : '') + 'film' + spec +
        '. Full commercial license.' + (eta ? ' Ready in ' + eta + ',' : '') + ' delivered in your browser and by email.';
  } else {
    const bits = [];
    if (styleName) bits.push(styleName + ' style');
    if (key === 'adpack' && formats) bits.push(formats + ' formats');
    bits.push('Full commercial license');
    if (eta) bits.push('Ready in ' + eta);
    description = bits.join('. ') + '. Delivered in your browser and by email.';
  }

  if (isAction) {
    const actionNames = { revoice: 'Voice change', translate: 'Translation', upscale: 'Upscale' };
    name = (actionNames[key] || key) + (productName ? ' · ' + productName : ' · your film');
    description = 'Applied to one finished clip from your library. Full commercial license.' +
      (eta ? ' Ready in ' + eta + ',' : '') + ' delivered in your browser and by email.';
  }

  return {
    amountCents: Math.round(usd * 100),
    name: name,
    description: description.slice(0, 500),
    meta: {
      studio_product: key.slice(0, 100),
      studio_style: String(styleName || order.style || '').slice(0, 100),
      studio_duration: String(duration || SEGMENT_SECONDS),
      studio_formats: String(formats || ''),
      studio_price_usd: String(usd),
      studio_product_name: productName,
      studio_product_url: String(sel.link || '').slice(0, 200),
      studio_aspect: aspectStr.slice(0, 20),
      studio_quality: quality,
      studio_custom_creator: sel.avatar && sel.avatar.id === 'custom' ? '1' : '',
    },
  };
}

/*
 * Credits.
 *
 * 1 credit = $0.002, so a cent is five credits and the catalogue lands on round
 * numbers: a 20 creative pack is 6,000, a photoshoot 4,500, a 15s film 7,000.
 *
 * The denomination is deliberately fine. Large counts read as more generous
 * than the dollar figure they stand for, which is the whole reason to have a
 * currency of your own. The price in dollars still has to sit next to the
 * credit price wherever credits are sold: the conversion customers actually pay
 * is credits to finished work, and hiding it is what turns a credit system into
 * a grievance.
 *
 * Derived from priceStudioOrder rather than kept as a second price list, so the
 * two can never drift apart.
 */
const CREDITS_PER_CENT = 5;

function creditsForOrder(order) {
  const priced = priceStudioOrder(order);
  if (!priced || typeof priced.amountCents !== 'number') return null;
  return priced.amountCents * CREDITS_PER_CENT;
}

module.exports = {
  priceStudioOrder,
  creditsForOrder,
  CREDITS_PER_CENT,
  SEGMENT_SECONDS,
  EXTRA_SEGMENT_USD,
  ADPACK_INCLUDED_FORMATS,
};

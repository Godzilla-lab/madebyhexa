'use strict';

/*
 * Bright Data Web Unlocker: read a product page that refuses us.
 *
 * Roughly a third of real DTC storefronts will not answer a datacenter fetch.
 * Measured live 2026-08-13 from this stack: oura.com 403, ridge.com 403,
 * vessi.com connection refused. Their Shopify JSON endpoints are walled too,
 * so the whole origin is protected and there is no clever free way around it.
 * Through the unlocker all three answer 200, and two of the three hand over a
 * real product image (oura's page genuinely carries no og:image).
 *
 * Latency, measured on the same day: 5 to 10 seconds typically, occasionally
 * 20+. That shapes everything about how it is used. It cannot sit inside the
 * paste request, which has a 10 second function ceiling and a customer
 * watching. So callers either race it with a small budget, or run it in the
 * background and let the client's existing poll collect the result.
 *
 * Cost: $0.0015 a call, and results are cached per URL, so a page is unlocked
 * once for everybody rather than once per visitor.
 *
 * data_format 'markdown' was tested and rejected: slower AND it strips the
 * <meta> tags, which are the only thing we actually want.
 *
 * env: BRIGHTDATA_API_TOKEN, BRIGHTDATA_UNLOCKER_ZONE
 */

const ENDPOINT = 'https://api.brightdata.com/request';

function configured() {
  return !!(process.env.BRIGHTDATA_API_TOKEN && process.env.BRIGHTDATA_UNLOCKER_ZONE);
}

/*
 * Fetch a URL through the unlocker. Resolves { html, status } on success, or
 * null on any failure including the budget running out. Never throws: this is
 * always the fallback leg, so a failure here must degrade the peek, not break
 * it.
 */
async function unlockHtml(url, budgetMs) {
  if (!configured()) return null;
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, budgetMs || 9000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.BRIGHTDATA_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zone: process.env.BRIGHTDATA_UNLOCKER_ZONE,
        url: url,
        format: 'raw',
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 200) return null;
    return { html: html, status: res.status };
  } catch (e) {
    return null; // aborted, network, or Bright Data itself down
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { configured, unlockHtml };

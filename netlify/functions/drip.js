/* Onboarding drip: Mike's sequence. Day 0 goes out INSTANTLY via welcome-now.js
 * at signup; this hourly run is its fallback and carries the rest: day 1, 3, 5,
 * then the day-14 check-in.
 *
 * Runs hourly on a Netlify schedule (see netlify.toml), so the welcome lands
 * within the hour of signup. For every account it computes days-since-signup
 * and sends whichever step is due, at most one email per user per run.
 * Sent-state and opt-outs live in Netlify Blobs, so nothing is ever sent
 * twice and "unsubscribe" is honored forever.
 *
 * Research-backed shape (see commit message):
 *  - plain-text founder voice, one CTA per email, no more than 2 sends in
 *    the first 48h, behavior-aware: the "make your film" nudges (steps 2-3)
 *    are skipped for users who already created something.
 *  - grace window: a step only sends within 3 days of its due date, so
 *    turning this on never blasts the whole backlog at old signups.
 *
 * Unsubscribe is its own public function (drip-unsub.js): scheduled
 * functions are not HTTP-reachable in production.
 *
 * env: RESEND_API_KEY (or ZOHO_*), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      WEBHOOK_SECRET (unsub token signing), DRIP_DRY_RUN=1 to log only.
 */

'use strict';

const { getStore } = require('@netlify/blobs');
const { SITE, unsubLink } = require('./lib/drip-links');
const { bodyHtml, footerHtml } = require('./lib/mail-html');

/* Drip sender. Once updates.madebyhexa.co is verified in Resend, set
 * DRIP_FROM='"Mike from Hexa" <mike@updates.madebyhexa.co>' in Netlify env:
 * marketing reputation moves to the subdomain, receipts and film deliveries
 * stay on the root, and replies still land in the Zoho inbox via replyTo. */
const FROM = process.env.DRIP_FROM || '"Mike from Hexa" <mike@madebyhexa.co>';
const GRACE_DAYS = 3;

function footer(userId) {
  return '\n\n--\nMike, Hexa AI · madebyhexa.co\n' +
    'No more emails like this: ' + unsubLink(userId) + '\n';
}

/* Everything one send needs, computed once: used by the hourly loop below
 * AND by welcome-now.js, which fires the day-0 email the moment an account
 * is created instead of waiting for the next top of the hour. */
function compose(step, niceFn, userId) {
  const unsub = unsubLink(userId);
  return {
    from: FROM,
    replyTo: 'mike@madebyhexa.co',
    subject: step.subject(niceFn),
    text: step.body(niceFn) + footer(userId),
    html: bodyHtml(step.body(niceFn)) + footerHtml(unsub),
    headers: { 'List-Unsubscribe': '<' + unsub + '>' },
  };
}

/* ── The sequence ──────────────────────────────────────────────────
 * day: days after signup. skipIfActive: not sent once they have a creation. */
const STEPS = [
  {
    key: 'welcome', day: 0, skipIfActive: false,
    subject: (fn) => fn ? 'Welcome to Hexa, ' + fn + '. Here is the whole trick.' : 'Welcome to Hexa. Here is the whole trick.',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      "Mike here, I run Hexa. Thanks for making an account.\n\n" +
      'The whole product is one move: paste your product link, and we turn the page into a finished film. A real-looking person holding, opening, using your product, ready to post. Films made this way have pulled 10 million views for the brands that run them.\n\n' +
      'It takes about two minutes to see your first one:\n' + SITE + '/#composer\n\n' +
      'One honest warning: the brands beating you on TikTok and Reels are not better at video. They just make more of it, because theirs costs lunch money. Now yours does too.\n\n' +
      'If anything confuses you, just reply. I read these.',
  },
  {
    /* Sample claimers only (and only until they buy): they have already seen
     * their product move, so the pitch is the difference between 5 and 15.
     * Sits before why-video so it wins the day-1 slot for this group. */
    key: 'sample-upsell', day: 1, skipIfActive: false, onlyIfSampledUnconverted: true,
    subject: (fn) => fn ? fn + ', your 5 seconds want to be 15' : 'Your 5 seconds want to be 15',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'You made the free sample, so you have already seen it with your own eyes: your product, in a real person’s hands, looking filmed rather than generated. Most people never get past wondering if that is possible. You are already holding proof.\n\n' +
      'Here is the thing about those 5 seconds: they are the most expensive part of the film, and you already own them. The hook, the casting, the scene, the product read, all done. The full film just lets it finish the sentence: 15 seconds up to 2 minutes, same actor and same scene the whole way, with the demo and the line that makes people click.\n\n' +
      'It starts at $12. One coffee, against a product video your competitors pay an agency $500 and two weeks for. Every day the sample sits in your library is a day that film is not selling for you.\n\n' +
      'Your product is already loaded, so it is one click:\n' + SITE + '/#styles\n\n' +
      'And if the sample missed the mark for your product, reply and tell me what felt off. I read every one of these.',
  },
  {
    key: 'why-video', day: 1, skipIfActive: true,
    subject: (fn) => (fn ? fn + ', the' : 'The') + ' honest numbers on product video',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'Before Hexa I sat on the other side of this, trying to sell products with photos, so let me share the numbers that changed my mind.\n\n' +
      'Product pages with a video convert around 65% higher than pages without one. On the ad side it is even starker: video ads convert roughly three times better than static images, which is why the brands you compete with keep feeding the meter.\n\n' +
      'And here is the part nobody says out loud: most brands know all this and still quit video. When researchers ask why, the answers are always the same two: too expensive and no time. A single traditional shoot day runs thousands before you have tested a single angle.\n\n' +
      'That is the actual reason Hexa exists. Not to make video magic, just to make testing it cost lunch money instead of a shoot day.\n\n' +
      'The math is simple and a little brutal: if video converts 3x and you are not running any, the brands in your category that are will happily keep taking the difference.\n\n' +
      'See what the films look like first, if you want:\n' + SITE + '/#reel',
  },
  {
    key: 'best-film', day: 3, skipIfActive: true,
    subject: (fn) => (fn ? fn + ', how' : 'How') + ' to get a great film from one link',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'Three things that make your Hexa film noticeably better:\n\n' +
      '1. Paste the product page itself, not your homepage. We read the photos and the copy on that exact page.\n' +
      '2. If your page hides its photos (some stores block robots), add one photo on the next step. Same quality either way.\n' +
      '3. Not sure which format? Pick Auto. We choose what sells your kind of product best.\n\n' +
      'Do it with your best seller. It already converts, which means it deserves the video treatment first, and the film pays for itself fastest there:\n' + SITE + '/#composer',
  },
  {
    key: 'formats', day: 5, skipIfActive: false,
    subject: (fn) => 'Which video format sells which product' + (fn ? ', ' + fn : ''),
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'A cheat sheet we use with brands:\n\n' +
      'UGC style: looks like a real customer filmed it. Best for trust and cold traffic.\n' +
      'Unboxing: anticipation sells. Best for giftable and premium-feel products.\n' +
      'Tutorial or demo: show the product working. Best for anything with a learning curve.\n' +
      'TV spot: polished and cinematic. Best for brand ads and retargeting warm audiences.\n\n' +
      'Every format is one click in the studio:\n' + SITE + '/#composer\n\n' +
      'Make one for the product you are pushing this month. Testing a format costs less than the ad spend you would waste running the wrong one.',
  },
  {
    key: 'checkin', day: 14, skipIfActive: false,
    subject: (fn) => fn ? 'Anything in your way, ' + fn + '?' : 'Anything in your way?',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'No pitch in this one. You signed up two weeks ago, and I would honestly like to know: did you get what you came for?\n\n' +
      'If something felt confusing, too expensive, or just off, reply and tell me. One line is plenty. I read and answer every reply, and the product gets better because of it.\n\n' +
      'Mike',
  },
];

/* ── State (Netlify Blobs) ─────────────────────────────────────── */

function store() { return getStore('drip'); }

/* Blobs reads fail closed (never double-send, never mail past an unsub),
 * but a broken store must be loud in the run summary, not silent: with
 * fail-closed reads a dead store looks exactly like "everyone was mailed
 * already" and the drip goes quiet forever. */
let blobErrors = 0;

async function alreadySent(userId, key) {
  try { return !!(await store().get(userId + ':' + key)); } catch (e) { blobErrors++; return true; }
}
async function markSent(userId, key) {
  try { await store().set(userId + ':' + key, String(Date.now())); } catch (e) { blobErrors++; }
}
async function optedOut(userId) {
  try { return !!(await store().get('optout:' + userId)); } catch (e) { blobErrors++; return true; }
}

/* ── Handler ──────────────────────────────────────────────────── */

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);

  const sb = require('./lib/supabase');
  const mailer = require('./lib/mailer');
  if (!sb.configured() || !mailer.configured()) {
    console.error('drip: missing supabase or mail transport');
    return { statusCode: 200, body: 'not configured' };
  }
  const DRY = process.env.DRIP_DRY_RUN === '1';
  const db = sb.admin();

  // all users, paginated
  const users = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error('drip: listUsers failed:', error.message); break; }
    users.push(...(data.users || []));
    if (!data.users || data.users.length < 200) break;
  }

  const now = Date.now();
  let sent = 0, skipped = 0;

  for (const u of users) {
    if (!u.email || !u.created_at) continue;
    if (await optedOut(u.id)) { skipped++; continue; }
    const ageDays = (now - new Date(u.created_at).getTime()) / 86400000;

    // has this user made anything? (only checked when a step cares)
    let active = null;
    for (const step of STEPS) {
      if (ageDays < step.day || ageDays > step.day + GRACE_DAYS) continue;
      if (await alreadySent(u.id, step.key)) continue;
      if (step.onlyIfSampledUnconverted) {
        // A sampler owns only 'Free sample' creations; anything else means
        // they bought. Non-samplers consume the step silently so it never
        // re-evaluates on later runs.
        const { count: totalCr } = await db.from('creations')
          .select('id', { count: 'exact', head: true }).eq('user_id', u.id);
        const { count: sampleCr } = await db.from('creations')
          .select('id', { count: 'exact', head: true }).eq('user_id', u.id).ilike('title', 'Free sample%');
        if (!sampleCr || (totalCr || 0) > sampleCr) { await markSent(u.id, step.key); continue; }
      }
      if (step.skipIfActive) {
        if (active === null) {
          const { count } = await db.from('creations')
            .select('id', { count: 'exact', head: true }).eq('user_id', u.id);
          active = (count || 0) > 0;
        }
        if (active) { await markSent(u.id, step.key); continue; } // consumed, not sent
      }
      const fn = (u.user_metadata && u.user_metadata.name || '').trim().split(/\s+/)[0] || '';
      const niceFn = fn && fn.indexOf('@') === -1 ? fn.charAt(0).toUpperCase() + fn.slice(1) : '';
      if (DRY) {
        console.log('[dry-run] would send', step.key, 'to', u.email, '(age', ageDays.toFixed(1), 'days) subject:', step.subject(niceFn));
      } else {
        try {
          await mailer.transport().sendMail({ to: u.email, ...compose(step, niceFn, u.id) });
          await markSent(u.id, step.key);
        } catch (e) {
          console.error('drip: send failed for', u.email, step.key, e.message);
          continue;
        }
      }
      sent++;
      break; // at most one email per user per day
    }
  }

  if (blobErrors) console.error('drip: BLOBS BROKEN this run:', blobErrors, 'failed reads/writes; fail-closed means users were skipped, not mailed');
  console.log('drip: run done.', users.length, 'users,', sent, DRY ? 'due (dry run),' : 'sent,', skipped, 'opted out,', blobErrors, 'blob errors');
  return { statusCode: 200, body: JSON.stringify({ users: users.length, sent, dryRun: DRY, blobErrors }) };
};

/* Shared with welcome-now.js (instant day-0 send). */
exports.STEPS = STEPS;
exports.compose = compose;
exports.alreadySent = alreadySent;
exports.markSent = markSent;
exports.optedOut = optedOut;

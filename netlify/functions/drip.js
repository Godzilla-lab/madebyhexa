/* Onboarding drip: five educational emails from Mike: day 0, day 1, then weekly (7, 14, 21).
 *
 * Runs daily on a Netlify schedule (see netlify.toml). For every account it
 * computes days-since-signup and sends whichever step is due, at most one
 * email per user per day. Sent-state and opt-outs live in Netlify Blobs, so
 * nothing is ever sent twice and "unsubscribe" is honored forever.
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

const FROM = '"Mike from Hexa" <mike@madebyhexa.co>';
const GRACE_DAYS = 3;

function footer(userId) {
  return '\n\n--\nMike, Hexa AI · madebyhexa.co\n' +
    'No more emails like this: ' + unsubLink(userId) + '\n';
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
      'The whole product is one move: paste your product link, and we turn the page into a finished film. A real-looking person holding, opening, using your product, ready to post.\n\n' +
      'It takes about two minutes to see your first one:\n' + SITE + '/#composer\n\n' +
      'If anything confuses you, just reply. I read these.',
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
      'See what the films look like first, if you want:\n' + SITE + '/#reel',
  },
  {
    key: 'best-film', day: 7, skipIfActive: true,
    subject: (fn) => (fn ? fn + ', how' : 'How') + ' to get a great film from one link',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'Three things that make your Hexa film noticeably better:\n\n' +
      '1. Paste the product page itself, not your homepage. We read the photos and the copy on that exact page.\n' +
      '2. If your page hides its photos (some stores block robots), add one photo on the next step. Same quality either way.\n' +
      '3. Not sure which format? Pick Auto. We choose what sells your kind of product best.\n\n' +
      'Try it on your best seller:\n' + SITE + '/#composer',
  },
  {
    key: 'formats', day: 14, skipIfActive: false,
    subject: (fn) => 'Which video format sells which product' + (fn ? ', ' + fn : ''),
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'A cheat sheet we use with brands:\n\n' +
      'UGC style: looks like a real customer filmed it. Best for trust and cold traffic.\n' +
      'Unboxing: anticipation sells. Best for giftable and premium-feel products.\n' +
      'Tutorial or demo: show the product working. Best for anything with a learning curve.\n' +
      'TV spot: polished and cinematic. Best for brand ads and retargeting warm audiences.\n\n' +
      'Every format is one click in the studio:\n' + SITE + '/#composer\n\n' +
      'Make one for a product you are pushing this month.',
  },
  {
    key: 'checkin', day: 21, skipIfActive: false,
    subject: (fn) => fn ? 'Anything in your way, ' + fn + '?' : 'Anything in your way?',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'No pitch in this one. You signed up a few weeks ago, and I would honestly like to know: did you get what you came for?\n\n' +
      'If something felt confusing, too expensive, or just off, reply and tell me. One line is plenty. I read and answer every reply, and the product gets better because of it.\n\n' +
      'Mike',
  },
];

/* ── State (Netlify Blobs) ─────────────────────────────────────── */

function store() { return getStore('drip'); }

async function alreadySent(userId, key) {
  try { return !!(await store().get(userId + ':' + key)); } catch (e) { return true; } // fail closed: never double-send
}
async function markSent(userId, key) {
  try { await store().set(userId + ':' + key, String(Date.now())); } catch (e) { /* logged next run */ }
}
async function optedOut(userId) {
  try { return !!(await store().get('optout:' + userId)); } catch (e) { return true; }
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
          await mailer.transport().sendMail({
            from: FROM,
            to: u.email,
            replyTo: 'mike@madebyhexa.co',
            subject: step.subject(niceFn),
            text: step.body(niceFn) + footer(u.id),
            headers: { 'List-Unsubscribe': '<' + unsubLink(u.id) + '>' },
          });
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

  console.log('drip: run done.', users.length, 'users,', sent, DRY ? 'due (dry run),' : 'sent,', skipped, 'opted out');
  return { statusCode: 200, body: JSON.stringify({ users: users.length, sent, dryRun: DRY }) };
};

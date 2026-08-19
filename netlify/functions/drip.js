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
 * env: ZOHO_USER/ZOHO_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      WEBHOOK_SECRET (unsub token signing), DRIP_DRY_RUN=1 to log only.
 */

'use strict';

const { getStore } = require('@netlify/blobs');
const { SITE, unsubLink } = require('./lib/drip-links');
const { bodyHtml, footerHtml } = require('./lib/mail-html');

/* Drip sender. Zoho refuses any From that is not the authenticated mailbox
 * or one of its aliases, so the default rides mailer.fromAddress() with
 * Mike's display name. DRIP_FROM overrides (set it to a Zoho ALIAS like
 * mike@madebyhexa.co once that alias exists on the account). */
function dripFrom() {
  return process.env.DRIP_FROM ||
    '"Mike from Hexa" <' + require('./lib/mailer').fromAddress() + '>';
}
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
    from: dripFrom(),
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
    subject: (fn) => fn ? 'Welcome to Hexa, ' + fn + '. Start with what your buyers said.' : 'Welcome to Hexa. Start with what your buyers said.',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'Mike here, I run Hexa. Thanks for making an account.\n\n' +
      'Most people making ads are guessing what to say. We do the opposite: paste your product link and we go and read what real buyers in your category actually say about it, which of your competitors\' ads have been running long enough to prove they work, and whether your market is won by video or by statics.\n\n' +
      'Then you turn any of it into the ad, in the same place.\n\n' +
      'Your account has 2,500 credits on it already, so you can do that without paying anything. Start here:\n' + SITE + '/validate\n\n' +
      'Every claim in your report links to the comment it came from. If you think one is wrong, click it and check me. That is the whole point.\n\n' +
      'If anything confuses you, just reply. I read these.',
  },
  {
    key: 'first-report', day: 1, skipIfReported: true,
    subject: (fn) => fn ? fn + ', want to see what your market is complaining about?' : 'Want to see what your market is complaining about?',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'You have not run a report yet, so here is what actually comes back when you paste a link. It takes about a minute.\n\n' +
      'What people say: the recurring complaints, in their words, with a link to every comment.\n' +
      'What they wish existed: the gaps they keep asking for.\n' +
      'The objections: the reasons they give for NOT buying. This is the section nobody else produces, and it is the one your ad has to beat.\n' +
      'Who is advertising: your competitors\' ads, sorted by how long each has been running. Nobody keeps paying to run an ad that does not convert, so the top of that list is what your market has already proven.\n\n' +
      'Use your best seller. It already converts, so it is the one worth understanding first:\n' + SITE + '/validate\n\n' +
      'Free, and it does not touch your credits.',
  },
  {
    key: 'receipts', day: 3, skipIfActive: true,
    subject: (fn) => (fn ? fn + ', why' : 'Why') + ' we make you check our work',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'A thing I want to be straight about, because the internet is now full of tools that will confidently write you an ad angle out of nothing.\n\n' +
      'Hexa will not print a finding unless several different people raised it independently. If only two people said it, we show it as a weak signal and say so, because two loud comments are an anecdote, not a market. And every claim carries the actual quote and a link to where it was said.\n\n' +
      'Same with the video or statics call. We do not have an opinion about it. We count how long your competitors\' ads have actually been running and let the ones that survived tell you. In one apparel category we read recently, 10 of the 11 ads still running after 90 days were video. That is a fact about that category, not a rule about yours, which is exactly why we measure yours instead of guessing.\n\n' +
      'Run it on the product you are pushing this month:\n' + SITE + '/validate',
  },
  {
    key: 'angles-to-ads', day: 5, skipIfActive: true,
    subject: (fn) => 'Your 2,500 credits' + (fn ? ', ' + fn : '') + ', and what they make',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'Quick one about the credits sitting on your account.\n\n' +
      'When your report finishes it ends in angles: a specific claim, aimed at a specific buyer, in their words, backed by the comments that support it. Each one comes with a video hook and a static headline already written.\n\n' +
      'Next to each angle is a button that makes it. The hook goes straight into the brief, so what we proved is what gets made, and you are not retyping anything.\n\n' +
      'A single ad creative is 500 credits, so the 2,500 you already have makes five of them for nothing, or two more full market reads at 1,000 each.\n\n' +
      'And if a render fails, the credits go straight back to your balance automatically. You are never charged for work we do not deliver.\n\n' +
      SITE + '/validate',
  },
  {
    key: 'best-brief', day: 7, skipIfActive: true,
    subject: (fn) => (fn ? fn + ', three' : 'Three') + ' things that make your ads better',
    body: (fn) =>
      'Hey' + (fn ? ' ' + fn : '') + ',\n\n' +
      'Three small things that make a noticeable difference:\n\n' +
      '1. Paste the product page itself, not your homepage. We read the photos and the copy on that exact page, and a homepage tells us nothing specific.\n' +
      '2. Run the report before the ad. It costs nothing and it decides the format for you, so you are not paying to find out that your category runs video.\n' +
      '3. Take the angle with the most receipts first. They are ordered by weight of evidence, not by which one reads best, so the top one is the one your market has said most often.\n\n' +
      SITE + '/validate',
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
      /* Someone who has already run a report does not need to be told what a
       * report is. Consumed rather than skipped, so it never re-evaluates on a
       * later run. */
      if (step.skipIfReported) {
        const { count } = await db.from('reports')
          .select('id', { count: 'exact', head: true }).eq('user_id', u.id);
        if ((count || 0) > 0) { await markSent(u.id, step.key); continue; }
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

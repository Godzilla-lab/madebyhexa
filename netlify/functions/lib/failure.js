'use strict';

/*
 * What a dead render means, and what to tell the person who paid for it.
 *
 * Every terminal job status used to collapse into one sentence:
 *
 *     'Segment render failed (' + failed.status + '). ...'
 *
 * which raw-interpolated the engine's own word into customer copy. A tripped
 * safety filter read, literally, "Segment render failed (nsfw)." followed by
 * advice to run it again. That advice is wrong twice over: the second attempt
 * refuses identically, and it spends the refund we just issued.
 *
 * So terminal states are sorted into two kinds, because only two things can
 * actually have happened and they call for opposite advice:
 *
 *   declined  we would not make this. Retrying changes nothing. Say what to
 *             change instead, and never suggest another go.
 *   fault     the engine broke. Retrying is exactly right.
 *
 * Both refund. The split is about what we tell people to do next, not about
 * whether they get their money back: billing happens at job creation, so a
 * creative that never arrives has always been paid for.
 *
 * DEAD lives here too. It was copied into render-status.js, render-revise.js
 * and tools/chain-render.mjs, which is three chances for the list to drift
 * apart the next time the engine adds a status.
 */

const DECLINED = ['nsfw', 'rejected', 'moderated', 'content_policy'];
const FAULT = ['failed', 'canceled', 'cancelled', 'error', 'timeout'];
const DEAD = DECLINED.concat(FAULT);

function kindOf(status) {
  const s = String(status || '').toLowerCase();
  if (DECLINED.indexOf(s) >= 0) return 'declined';
  return 'fault';
}

/*
 * Customer-facing copy for a terminal render.
 *
 *   status   the engine's own word, used only to choose a sentence
 *   opts.refunded    true when money is already on its way back
 *   opts.credits     true when the refund is credits rather than a card refund
 *   opts.scope       'all' for a whole order, 'one' for a single creative
 *   opts.refundText  what came back, when it was neither a card nor credits.
 *                    A re-roll costs an allowance, so saying "your payment has
 *                    been refunded" there would name money that never moved.
 *
 * Returns { kind, retryable, headline, message }.
 *
 * headline and message are split rather than one string because render.html
 * shows them in two places, a title and a paragraph beneath it. Folding the
 * headline into the message put the same sentence on screen twice; keeping
 * them apart also means the page never has to invent its own wording for a
 * case the server already classified. A caller with only one line to fill
 * (the re-roll note) joins them.
 *
 * `retryable` is the flag the UI reads to decide whether to offer another go,
 * so nothing has to re-derive intent from the wording.
 */
function explain(status, opts) {
  const o = opts || {};
  const kind = kindOf(status);
  const one = o.scope === 'one';
  const money = o.refundText !== undefined ? o.refundText
    : o.refunded
      ? (o.credits ? ' The credits are already back in your balance.'
                   : ' Your payment has been refunded automatically.')
      : ' No charge stands for work we did not deliver.';

  if (kind === 'declined') {
    return {
      kind: kind,
      retryable: false,
      headline: one ? 'We could not make that one' : 'We could not make this one',
      /* No "try again": the filter is deterministic, so the same brief gets
       * the same answer and the retry spends the refund. */
      message: 'The brief asked for something our generation partner will not ' +
        'render, so it stopped before producing anything.' + money +
        ' Change the product photo or the wording of the brief and it will go through.',
    };
  }

  return {
    kind: kind,
    retryable: true,
    headline: one ? 'That creative did not render' : 'We could not finish this render',
    message: 'Something broke on the generation side, not in your brief.' +
      money + ' Running it again usually works.',
  };
}

module.exports = { DEAD, DECLINED, FAULT, kindOf, explain };

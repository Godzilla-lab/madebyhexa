'use strict';

/*
 * The second read, before a prompt reaches the engine.
 *
 * The whole pitch is that we do not guess. But the thing that writes the
 * prompts is a language model, and a language model asked to sell a product
 * will help: it adds "clinically proven", it puts a price on screen, it invents
 * a customer saying something nice. Nothing downstream catches that. The engine
 * renders whatever it is told, the image goes out as a real advert, and the
 * legal exposure is the customer's.
 *
 * So one writer, one critic. The writer is the storyboard agent; the critic is
 * a second, cheaper pass that reads each prompt against the facts we actually
 * hold and the five shared_style rules, and reports the exact wording that is
 * not supported.
 *
 * Two design choices worth stating.
 *
 * The critic does not rewrite. It returns the offending substrings and this
 * module removes them, so a cheap model can never smuggle new text into a
 * prompt on its way to fixing one. Finding is a judgment; editing is not.
 *
 * The critic never blocks. No provider, a timeout, malformed JSON, a gutted
 * prompt: every one of those returns the prompts untouched. A customer has
 * already paid by this point, and a render that ships with one unsupported
 * adjective is better than a render that does not ship.
 */

const recipes = require('../../../catalog/recipes.json');

/*
 * Reject a "fix" that would eat the prompt. Past this, the critic has misread
 * the brief rather than found a lie, and the safe move is to keep the original
 * and say so in the log.
 *
 * Sized from real prompts rather than picked round: a storyboard segment runs
 * 600 to 700 characters and one invented sentence is 60 to 80 of them, so an
 * honest find takes about a tenth. Half is far past any plausible number of
 * genuine findings.
 *
 * The absolute floor is the second half of the same rule, because a proportion
 * alone lets the last useful direction be stripped off a short prompt. Forty
 * characters is roughly "Same kitchen, she pours it and drinks", which still
 * directs a shot; below that there is no scene left to render.
 */
const MAX_STRIPPED_SHARE = 0.5;
const MIN_PROMPT_CHARS = 40;

/*
 * Remove the SENTENCE the flagged span sits in, not just the span.
 *
 * Cutting the span alone leaves wreckage, measured on live calls 2026-08-15:
 * quoting "clinically proven to preserve 40% more nutrients" left "She says it
 * is." behind, and quoting a clause without its full stop left "Same kitchen,
 * same creator. . She pours the smoothie." A dangling fragment is worse than
 * either the original or a clean cut, because it still reads as a claim about
 * to be made and the engine will happily finish the thought.
 *
 * Taking the whole sentence is also the conservative direction: it removes a
 * little more of an unsupported statement rather than a little less. The size
 * guards above are what stop that becoming destructive.
 *
 * This only ever deletes. Nothing new may be written into a prompt here, or
 * the critic has been handed a pen after all.
 */
function stripSentence(text, quote) {
  const at = text.indexOf(quote);
  if (at < 0) return null;

  // Walk out to the sentence boundaries either side of the span.
  let start = at;
  while (start > 0 && !/[.!?]/.test(text[start - 1])) start -= 1;

  let end = at + quote.length;
  /*
   * Only extend if the quote does not already end a sentence. Measured live
   * 2026-08-15: the critic quoted a whole sentence, terminator included, and
   * the forward walk then ran on to the NEXT full stop and took the following
   * sentence with it. That silently deleted the one line naming the product.
   */
  if (!/[.!?]\s*$/.test(quote)) {
    while (end < text.length && !/[.!?]/.test(text[end])) end += 1;
    if (end < text.length) end += 1; // take the terminator with it
  }

  const cut = (text.slice(0, start) + ' ' + text.slice(end));
  return cut.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

let _llm = null;
async function loadLLM() {
  if (_llm !== null) return _llm;
  try {
    _llm = await import('../../../research/lib/llm.mjs');
  } catch (e) {
    console.error('critic: could not load the model router:', e.message);
    _llm = false;
  }
  return _llm;
}

const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: 'One entry per unsupported piece of wording. Empty when the prompts are clean.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Which prompt, zero based.' },
          quote: { type: 'string', description: 'The exact substring from that prompt, copied character for character.' },
          kind: { type: 'string', enum: ['claim', 'price', 'review', 'text'] },
          why: { type: 'string' },
        },
        required: ['index', 'quote', 'kind', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

/* Byte-identical every call, so it caches on providers that cache. */
const RULES = [
  'You are the fact checker for an advertising studio. You are given the prompts',
  'that are about to be sent to an image or video engine, and the facts we',
  'actually hold about the product. Your only job is to find wording that asserts',
  'something we cannot support.',
  '',
  'Report a finding when a prompt:',
  '  claim   states a property, benefit, certification or comparison that the',
  '          facts do not contain (for example "clinically proven", "the fastest',
  '          on the market", "doctor recommended", a specific percentage)',
  '  price   puts any price, discount or offer on screen',
  '  review  invents a testimonial, a reviewer, a star rating or a review count',
  '  text    burns on-image text other than the approved headline, when one was',
  '          approved, or any text at all when none was',
  '',
  'Do NOT report: scene direction, camera language, lighting, wardrobe, mood,',
  'the product name, or anything the facts do support. Describing the product',
  'doing what it is for is not a claim. Being wrong in this direction is',
  'expensive: a stripped prompt makes a worse ad.',
  '',
  'quote must be copied from the prompt character for character, and must be the',
  'shortest span that carries the problem, normally one sentence or clause.',
  '',
  'The studio also holds these standing rules:',
].concat((recipes.shared_style || []).map(function (r) { return '  - ' + r; })).join('\n');

/*
 * Check a set of prompts. Returns { prompts, findings, checked }.
 *
 *   prompts   the prompts to use, with unsupported spans removed
 *   findings  what was removed and why, for the recipe record
 *   checked   false when no critic ran at all, so a caller can tell "clean"
 *             apart from "not looked at", which are very different things
 */
async function reviewPrompts(prompts, context) {
  const out = { prompts: prompts, findings: [], checked: false };
  if (!Array.isArray(prompts) || !prompts.length) return out;

  const llm = await loadLLM();
  if (!llm || !llm.configured()) return out;

  const ctx = context || {};
  const facts = [
    ctx.productName ? 'Product name: ' + ctx.productName : null,
    ctx.description ? 'What the page says it is: ' + String(ctx.description).slice(0, 900) : null,
    ctx.headline ? 'Approved on-image text, exactly this and nothing else: "' + ctx.headline + '"'
                 : 'No on-image text is approved for this order.',
    ctx.reviews && ctx.reviews.length
      ? 'Real customer reviews supplied by the seller, quotable verbatim:\n' +
        ctx.reviews.map(function (r) { return '  "' + String(r).slice(0, 240) + '"'; }).join('\n')
      : 'No real review text was supplied, so no testimonial may appear.',
  ].filter(Boolean).join('\n');

  let answer;
  try {
    answer = await llm.ask({
      model: llm.WORKER,
      maxTokens: 2000,
      label: 'critic',
      schema: SCHEMA,
      system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }],
      prompt: 'FACTS WE HOLD:\n' + facts + '\n\nPROMPTS TO CHECK:\n' +
        prompts.map(function (p, i) { return '[' + i + '] ' + p; }).join('\n\n'),
    });
  } catch (e) {
    console.error('critic call failed, shipping the prompts as written:', e.message);
    return out;
  }
  if (!answer || !Array.isArray(answer.findings)) return out;

  out.checked = true;
  const kept = prompts.slice();
  const applied = [];

  answer.findings.forEach(function (f) {
    const i = Number(f && f.index);
    const quote = String((f && f.quote) || '');
    // A quote the model paraphrased instead of copying cannot be located, and
    // guessing at what it meant is how a fact checker starts inventing.
    if (!Number.isInteger(i) || i < 0 || i >= kept.length || !quote) return;

    const after = stripSentence(kept[i], quote);
    if (after === null) return;
    if (after.length < kept[i].length * (1 - MAX_STRIPPED_SHARE) || after.length < MIN_PROMPT_CHARS) {
      console.warn('critic wanted to strip ' + Math.round((1 - after.length / kept[i].length) * 100) +
        '% of prompt ' + i + ', leaving ' + after.length + ' chars: keeping the original');
      return;
    }
    kept[i] = after;
    applied.push({ index: i, kind: f.kind || 'claim', quote: quote.slice(0, 240), why: String(f.why || '').slice(0, 240) });
  });

  out.prompts = kept;
  out.findings = applied;
  if (applied.length) {
    console.log('critic removed ' + applied.length + ' unsupported span(s): ' +
      applied.map(function (a) { return a.kind; }).join(', '));
  }
  return out;
}

module.exports = { reviewPrompts, MAX_STRIPPED_SHARE, __rulesForTest: RULES };

#!/usr/bin/env node
/*
 * The fact-check pass, checked.
 *
 *   node tools/criticcheck.mjs           request shape and the strip logic
 *   node tools/criticcheck.mjs --live    one real call on the live provider
 *
 * The critic exists because a language model asked to sell a product will
 * help: it adds "clinically proven", it puts a price on screen, it invents a
 * happy customer. The engine renders whatever it is told and the advert goes
 * out for real, so the exposure is the seller's.
 *
 * Two properties matter more than accuracy here and both are checked:
 *
 *   it removes rather than rewrites, so a cheap model cannot smuggle new text
 *   into a prompt on its way to fixing one
 *
 *   it never blocks. No provider, a bad answer, a paraphrased quote it cannot
 *   locate, a fix that would gut the prompt: every one ships the prompts
 *   untouched, because the customer has already paid.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', y: '\x1b[33m', x: '\x1b[0m' };
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${C.g}PASS${C.x}  ${name}`); }
  else { fail++; console.log(`  ${C.r}FAIL${C.x}  ${name}`); if (detail) console.log(`        ${C.d}${detail}${C.x}`); }
}

const LIVE = process.argv.includes('--live');

/*
 * Real length on purpose. A live storyboard segment runs 600 to 700
 * characters (measured 2026-08-15), and the size guards are proportional, so
 * a two-sentence fixture would trip them on an honest find and prove nothing
 * about production. These are the shape the agent actually produces, with one
 * invented claim and one invented price planted in them.
 */
const DIRTY = [
  'This is ONE continuous video (same woman, same warm kitchen, same casual outfit, same soft morning light from the window). ' +
  'The shot opens on a busy mother at her kitchen counter looking tired as she wrestles with an old blender that shakes, splatters and dies. ' +
  'She sighs, turns to camera and speaks in a calm, plain voice about how mornings with kids should not be this loud. ' +
  'She says it is clinically proven to preserve 40% more nutrients than any other blender on the market. ' +
  'She reaches off screen and sets the Zephyr Blender down on the counter beside her, then loads it with fruit and yoghurt. ' +
  'The segment closes on her hand resting on the lid, about to press the button.',

  'This is ONE continuous video (same woman, same warm kitchen, same casual outfit, same soft morning light from the window). ' +
  'It picks up exactly where the previous segment ended, her hand still on the lid as the Zephyr Blender finishes a smooth, quiet blend. ' +
  'She lifts the jug and pours a green smoothie into a child\'s cup without spilling any of it. ' +
  'Bold on-screen text reads "Only $29 today" across the lower third of the frame. ' +
  'In the same calm voice she says it is quiet enough not to wake the baby and small enough for a narrow counter. ' +
  'The segment closes on her looking straight down the lens with the blender clean and upright beside her.',
];

if (LIVE) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AGENTROUTER_API_KEY;
} else {
  /* Answer as the critic would, so the strip logic is what is under test.
   * Deliberately includes one quote that is NOT in the prompt, because a
   * paraphrased quote is the realistic failure and it must be ignored rather
   * than guessed at. */
  process.env.XAI_API_KEY = 'xai-fake';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AGENTROUTER_API_KEY;
  globalThis.fetch = async (url, init = {}) => {
    let body = {};
    try { body = JSON.parse(init.body || '{}'); } catch { /* ignore */ }
    globalThis.__lastCriticRequest = body;
    const answer = JSON.stringify({
      findings: [
        { index: 0, quote: 'clinically proven to preserve 40% more nutrients', kind: 'claim', why: 'not in the facts' },
        { index: 1, quote: 'Bold on-screen text reads "Only $29 today"', kind: 'price', why: 'no price is approved' },
        { index: 1, quote: 'a sentence the model paraphrased instead of copying', kind: 'claim', why: 'unlocatable' },
      ],
    });
    return new Response(JSON.stringify({
      id: 'c1', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }],
      usage: { prompt_tokens: 900, completion_tokens: 80 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const critic = require(join(ROOT, 'netlify/functions/lib/critic.js'));

console.log(`\n  Critic  (${LIVE ? 'LIVE on the real provider' : 'stubbed'})\n`);

const CONTEXT = {
  productName: 'Zephyr Blender',
  description: 'A quiet countertop blender for small kitchens. 300W motor, dishwasher-safe jug.',
  headline: '',
  reviews: [],
};

const t0 = Date.now();
const res = await critic.reviewPrompts(DIRTY, CONTEXT);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`  answered in ${secs}s, ${res.findings.length} span(s) removed\n`);
res.findings.forEach((f) => console.log(`    ${C.d}[${f.kind}] "${f.quote}"${C.x}`));
console.log('');
res.prompts.forEach((p, i) => console.log(`    ${C.d}[${i}] ${p}${C.x}`));
console.log('');

check('the critic ran', res.checked === true, String(res.checked));
check('the invented claim is gone', !res.prompts[0].includes('clinically proven'), res.prompts[0]);
check('  and it took the whole sentence, leaving no dangling fragment',
  !/She says it is\.|\. \./.test(res.prompts[0]), res.prompts[0]);
check('the invented price is gone', !res.prompts[1].includes('$29'), res.prompts[1]);
check('the scene direction survives',
  /warm kitchen/i.test(res.prompts[0]) && /pours a green smoothie/i.test(res.prompts[1]),
  res.prompts.join(' | '));
check('the product name survives', res.prompts[0].includes('Zephyr Blender'), res.prompts[0]);

/* The removal must be a removal. Nothing the critic returns may become text in
 * a prompt, or a cheap model has been handed a pen. */
const before = DIRTY.join(' ').split(/\s+/);
const after = res.prompts.join(' ').split(/\s+/);
const added = after.filter((w) => !before.includes(w));
check('nothing new was written into the prompts', added.length === 0, added.join(' '));

if (!LIVE) {
  check('a quote the model could not copy exactly is ignored, not guessed at',
    res.findings.length === 2, `${res.findings.length} applied of 3 reported`);

  const req = globalThis.__lastCriticRequest || {};
  const sys = (req.messages || []).find((m) => m.role === 'system');
  check('runs on the cheap tier', req.model === 'grok-4.20-0309-non-reasoning', req.model);
  check('the standing style rules are in the prompt',
    sys && /Never invent claims, prices, or review quotes/.test(sys.content),
    sys ? sys.content.slice(-160) : 'no system message');
  check('the facts we hold are given to it',
    JSON.stringify(req.messages).includes('300W motor'), 'facts missing');

  /* Never blocks. Each of these ships the prompts as written. */
  globalThis.fetch = async () => { throw new Error('network down'); };
  const dead = await critic.reviewPrompts(DIRTY, CONTEXT);
  check('a dead provider ships the prompts untouched',
    dead.checked === false && dead.prompts[0] === DIRTY[0], JSON.stringify(dead.findings));

  globalThis.fetch = async (url, init = {}) => {
    let body = {}; try { body = JSON.parse(init.body || '{}'); } catch { /* ignore */ }
    // A critic that wants to delete most of the prompt has misread the brief.
    const answer = JSON.stringify({ findings: [{ index: 0, quote: DIRTY[0].slice(200, 520), kind: 'claim', why: 'all of it' }] });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: answer } }], model: body.model, usage: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const greedy = await critic.reviewPrompts(DIRTY, CONTEXT);
  check(`a fix that would strip over ${Math.round(critic.MAX_STRIPPED_SHARE * 100)}% keeps the original`,
    greedy.prompts[0] === DIRTY[0], greedy.prompts[0].slice(0, 90));

  /* The floor, separately: a proportion alone lets the last useful direction be
   * stripped off a short prompt. */
  const SHORT = ['Creator holds it up. It is clinically proven to work.'];
  globalThis.fetch = async (url, init = {}) => {
    let body = {}; try { body = JSON.parse(init.body || '{}'); } catch { /* ignore */ }
    const answer = JSON.stringify({ findings: [{ index: 0, quote: 'It is clinically proven to work.', kind: 'claim', why: 'unsupported' }] });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: answer } }], model: body.model, usage: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tiny = await critic.reviewPrompts(SHORT, CONTEXT);
  check('a prompt too short to survive the cut is kept whole',
    tiny.prompts[0] === SHORT[0], tiny.prompts[0]);
}

console.log(`\n  ${fail === 0 ? C.g : C.r}${pass}/${pass + fail} passed${C.x}\n`);
process.exit(fail === 0 ? 0 : 1);

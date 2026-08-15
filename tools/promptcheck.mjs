#!/usr/bin/env node
/*
 * The prompt agent's request, inspected on the wire.
 *
 *   node tools/promptcheck.mjs
 *
 * Two things this exists to catch, both silent.
 *
 * One: the agent not running at all. It used to open with
 * `if (!process.env.ANTHROPIC_API_KEY) return null`, and that key is set in no
 * Netlify context, so every production render fell through to the beat sheet
 * template without anything looking broken. It now routes through the same
 * provider chain the reports use, and this asserts a request is actually made.
 *
 * Two: breaking the cached prefix. Anthropic caches on exact prefix match, so
 * moving one order-specific string into the system blocks means the cache
 * never hits again, at full input price, with nothing to notice. This plans
 * two deliberately different orders and checks the static half came out
 * byte-identical and carries nothing from either.
 *
 * Interception is at fetch rather than at the SDK, because llm.mjs imports the
 * SDK as ESM (no require.cache to swap) and because the wire body is the thing
 * that actually matters. It also means the xAI shape can be checked with the
 * same harness.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', y: '\x1b[33m', x: '\x1b[0m' };
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ${C.g}PASS${C.x}  ${name}`); }
  else { fail++; console.log(`  ${C.r}FAIL${C.x}  ${name}`); if (detail) console.log(`        ${C.d}${detail}${C.x}`); }
}

/* Capture the request instead of letting it out, and answer in each API's own
 * shape so the caller's happy path runs all the way to a parsed storyboard. */
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url && url.url ? url.url : url);
  let body = {};
  try { body = JSON.parse(init.body || (url && url.body) || '{}'); } catch { /* leave empty */ }
  sent.push({ href, body });

  const segments = Number((JSON.stringify(body).match(/Write the (\d+) segment/) || [])[1] || 1);
  const answer = JSON.stringify({ prompts: Array.from({ length: segments }, (_, i) => 'segment ' + (i + 1)) });

  const payload = href.includes('anthropic')
    ? {
        id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1400, output_tokens: 200, cache_creation_input_tokens: 1200, cache_read_input_tokens: 0 },
      }
    : {
        id: 'chatcmpl_1', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }],
        usage: { prompt_tokens: 1400, completion_tokens: 200 },
      };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', 'request-id': 'req_fake' },
  });
};

const ORDER_A = {
  product: 'mode:ugc',
  selections: {
    duration: 30, aspect: '9:16', productName: 'Zephyr Blender',
    desc: 'a quiet countertop blender',
    directions: 'Warm kitchen, morning light, no shouting.',
    brand: { brand_name: 'Zephyr', tone: 'calm', audience: 'busy parents' },
  },
};
const ORDER_B = {
  product: 'mode:ugc',
  selections: {
    duration: 30, aspect: '16:9', productName: 'Nocturne Lamp',
    desc: 'a bedside reading lamp',
    directions: 'Late evening, low key, gallery feel.',
    brand: { brand_name: 'Nocturne', tone: 'moody', audience: 'insomniacs' },
  },
};

/* llm.mjs reads the environment once, at import. Run the whole thing twice in
 * child-free isolation by choosing the provider before the first require. */
const WANT = process.argv[2] || 'anthropic';
if (WANT === 'anthropic') {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-for-inspection';
  delete process.env.XAI_API_KEY;
} else {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.XAI_API_KEY = 'xai-fake-for-inspection';
}
delete process.env.AGENTROUTER_API_KEY;

const { planOrder } = require(join(ROOT, 'netlify/functions/render-create.js'));

console.log(`\n  Prompt agent request  (provider: ${WANT})\n`);

await planOrder(ORDER_A);
await planOrder(ORDER_B);

check('the agent actually calls a model, twice', sent.length >= 2, `${sent.length} calls`);

if (sent.length >= 2) {
  const [a, b] = sent;

  if (WANT === 'anthropic') {
    check('resolves the worker tier to claude-haiku-4-5', a.body.model === 'claude-haiku-4-5', a.body.model);
    /* Haiku 4.5 rejects both adaptive thinking and effort, and llm.mjs strips
     * them per model rather than per provider. Sending either would 400 every
     * render, so the absence here is the assertion. */
    check('drops adaptive thinking, which Haiku 4.5 rejects', !a.body.thinking, JSON.stringify(a.body.thinking));
    check('drops effort, which Haiku 4.5 rejects', !(a.body.output_config || {}).effort,
      JSON.stringify(a.body.output_config && a.body.output_config.effort));
    check('keeps the json schema',
      a.body.output_config && a.body.output_config.format && a.body.output_config.format.type === 'json_schema',
      JSON.stringify(a.body.output_config));

    const blocks = Array.isArray(a.body.system) ? a.body.system : null;
    check('the system prompt goes out as blocks, so it can be cached', !!blocks, typeof a.body.system);

    if (blocks) {
      const last = blocks[blocks.length - 1];
      check('the LAST static block carries the cache breakpoint',
        last.cache_control && last.cache_control.type === 'ephemeral', JSON.stringify(last.cache_control));
      check('no earlier block wastes a breakpoint', blocks.slice(0, -1).every((x) => !x.cache_control));

      const chars = blocks.map((x) => x.text).join('').length;
      // About 3.7 characters per token on English prose. Used only to show the
      // prefix clears the 512 token floor, not to bill anything on.
      const approxTokens = Math.round(chars / 3.7);
      check(`the prefix clears the 512 token cache floor (~${approxTokens} tokens from ${chars} chars)`,
        approxTokens > 512, `${approxTokens} tokens`);

      const aStatic = JSON.stringify(a.body.system);
      const bStatic = JSON.stringify(b.body.system);
      check('two different orders send a byte-identical prefix', aStatic === bStatic,
        aStatic === bStatic ? '' : 'the prefix differs, so the cache will never hit');

      const leaks = ['Zephyr Blender', 'Nocturne Lamp', 'busy parents', 'insomniacs',
        'Warm kitchen', 'Late evening', 'countertop blender', 'bedside reading lamp']
        .filter((s) => aStatic.includes(s) || bStatic.includes(s));
      check('nothing order-specific leaked into the cached prefix', leaks.length === 0, leaks.join(', '));

      const aVolatile = JSON.stringify(a.body.messages);
      check('the volatile brief sits after the breakpoint, in messages',
        aVolatile.includes('Zephyr Blender') && aVolatile.includes('Warm kitchen'),
        aVolatile.slice(0, 160));
    }
  } else {
    /* Worker, not synth, and measured: grok-4.6 took 49 to 64s and ignored the
     * schema, while a synchronous Netlify function is capped at 26s. */
    check('resolves the worker tier to grok-4.20 non-reasoning',
      a.body.model === 'grok-4.20-0309-non-reasoning', a.body.model);
    check('goes to the xAI endpoint', /api\.x\.ai/.test(a.href), a.href);
    const sys = (a.body.messages || []).find((m) => m.role === 'system');
    check('the system prompt is flattened to one string, not blocks',
      sys && typeof sys.content === 'string', JSON.stringify(sys && typeof sys.content));
    check('  and still carries the exemplar library',
      sys && sys.content.includes('storyboard writer') && sys.content.length > 3000,
      sys ? `${sys.content.length} chars` : 'no system message');
    check('the brief is a separate user message',
      (a.body.messages || []).some((m) => m.role === 'user' && String(m.content).includes('Zephyr Blender')));
    check('asks for the schema in the shape this API takes',
      a.body.response_format && a.body.response_format.type === 'json_schema',
      JSON.stringify(a.body.response_format && a.body.response_format.type));
  }
}

/* ── The proven angle, all the way to the engine ──────────────────
 *
 * The seam the product hangs on. A report proves a line; the pack has to
 * render THAT line, as literal on-image text, not paraphrase it from a
 * "Brand direction:" aside. This used to arrive with headline empty and take
 * the else branch: "No on-image text." */
{
  const packPrompt = async (selections) => {
    const plan = await planOrder({ product: 'adpack', selections });
    return (plan && plan.paramsList && plan.paramsList[0] && plan.paramsList[0].prompt) || '';
  };

  const HEAD = 'Blend it. Drink it. Rinse it. Done.';

  const withHeadline = await packPrompt({
    link: 'https://example-store.com/products/portable-blender',
    productName: 'Portable Blender',
    headline: HEAD,
    directions: 'Sell the cleanup, not the blending.',
    angle: { claim: 'Sell the cleanup, not the blending.', persona: 'Busy people who hate washing up', receipts: 6 },
  });
  check('a report-driven pack renders the proven headline as on-image text',
    withHeadline.includes('Render this exact on-image text, spelled exactly: "' + HEAD + '"'),
    withHeadline.slice(0, 260));
  check('  and does NOT say "No on-image text"', !withHeadline.includes('No on-image text'),
    withHeadline.slice(0, 260));
  check('  and names who the ad is for',
    withHeadline.includes('Who this is for: Busy people who hate washing up'), withHeadline.slice(0, 400));

  // An order that carries only the structured angle still lands the line.
  const angleOnly = await packPrompt({
    link: 'https://example-store.com/products/portable-blender',
    productName: 'Portable Blender',
    angle: { headline: HEAD, claim: 'Sell the cleanup', persona: '', receipts: 6 },
  });
  check('an order carrying only the angle still lands the headline',
    angleOnly.includes('spelled exactly: "' + HEAD + '"'), angleOnly.slice(0, 260));

  // No report, no angle: nothing is invented. Blank stays blank.
  const cold = await packPrompt({
    link: 'https://example-store.com/products/portable-blender',
    productName: 'Portable Blender',
  });
  check('a cold pack with no proven line invents none',
    cold.includes('No on-image text') && !cold.includes('spelled exactly'), cold.slice(0, 200));
}

if (WANT === 'anthropic') {
  console.log(`\n  ${C.y}Not checked here:${C.x} that an Anthropic cache READ occurs. That needs`);
  console.log(`  a real ANTHROPIC_API_KEY and an assertion on cache_read_input_tokens > 0`);
  console.log(`  across two live calls, and no such key is set in any Netlify context.`);
  console.log(`  Production runs on xAI, which caches automatically: measured live on`);
  console.log(`  2026-08-15, 1,088 of 1,133 prompt tokens came back cached.`);
}
console.log(`\n  ${fail === 0 ? C.g : C.r}${pass}/${pass + fail} passed${C.x}\n`);
process.exit(fail === 0 ? 0 : 1);

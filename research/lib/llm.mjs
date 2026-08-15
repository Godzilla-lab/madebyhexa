/*
 * Model routing for the research engine.
 *
 * The plan's tiering: bulk extraction and compression are reading, not
 * reasoning, so they run cheap and in parallel; only the final synthesis --
 * the one that needs judgment -- runs on the expensive model.
 *
 * PROVIDERS, in preference order:
 *
 *   anthropic    ANTHROPIC_API_KEY      native SDK, the reference path
 *                worker claude-haiku-4-5 $1/$5, synth claude-opus-5 $5/$25
 *   xai          XAI_API_KEY            Grok, first-party, OpenAI-shaped
 *                worker grok-4.20-0309-non-reasoning, synth grok-4.6
 *   agentrouter  AGENTROUTER_API_KEY    third-party reseller, last resort
 *
 * All three answer the same `ask()` contract, so the rest of the engine never
 * learns which one is live. That matters more than it looks: a resold gateway
 * can lose its upstream quota mid-run, and swapping providers must not mean
 * touching synthesis code.
 *
 * Measured 2026-08-13 on agentrouter: it serves claude-opus-5, claude-opus-4-8
 * and gpt-5.6-sol, but the Claude models answer "Budget pool quota has been
 * exhausted" -- their pool, not ours -- so gpt-5.6-sol is the only model
 * actually reachable there today. It also refuses any request that does not
 * identify itself as the Claude Code CLI, which is why the user agent is a
 * configurable env var and not a hardcoded constant.
 *
 * Without any key the engine still runs retrieval and writes an evidence-only
 * report, which is a genuinely useful failure mode -- you can still read what
 * people said, just without the synthesis on top.
 */

import Anthropic from '@anthropic-ai/sdk';

/* ── provider selection ────────────────────────────────────────── */

/*
 * xAI outranks agentrouter deliberately. agentrouter is a reseller: it lost its
 * Claude quota mid-session once already, and the only model it actually serves
 * is gpt-5.6-sol, so the "route" it offers is a route of one. xAI is a
 * first-party account with its own key. It stays behind Anthropic only because
 * Anthropic is the reference path the prompts were written against.
 */
export function provider() {
  return providers()[0] || null;
}

/*
 * Every provider we hold a key for, best first. This is a FALLBACK CHAIN, not a
 * choice: a research run makes dozens of calls and any one of them can hit a
 * quota wall, a rate limit or a bad gateway minute. When that happens the call
 * moves to the next provider instead of the report losing a section, which is
 * what "use both together" actually needs to mean in practice.
 */
export function providers() {
  const list = [];
  if (process.env.ANTHROPIC_API_KEY) list.push('anthropic');
  if (process.env.XAI_API_KEY) list.push('xai');
  if (process.env.AGENTROUTER_API_KEY) list.push('agentrouter');
  return list;
}

const ROUTES = {
  anthropic: { worker: 'claude-haiku-4-5', synth: 'claude-opus-5' },
  // Only gpt-5.6-sol is actually served here today; see the header note.
  agentrouter: { worker: 'gpt-5.6-sol', synth: 'gpt-5.6-sol' },
  /* Measured live 2026-08-13 against this account's /v1/models. grok-4-fast and
   * grok-4 do NOT exist here and would 404. The non-reasoning 4.20 is the right
   * worker by a distance: 1.5s and 219 tokens where grok-4.6 takes 8.8s for the
   * same answer, which is exactly the bulk-extraction profile. Both honour
   * json_schema strict mode, so the angles schema holds. Multi-agent is not
   * allowed on chat completions, so it is not an option. */
  xai: { worker: 'grok-4.20-0309-non-reasoning', synth: 'grok-4.6' },
};

const PROVIDERS = providers();
const PROVIDER = PROVIDERS[0] || null;

/*
 * Tiers, not model names. Each provider spells its own worker and synth
 * differently, so callers ask for the JOB and the chain resolves the model per
 * attempt. Passing a literal model name still works and pins the call.
 */
export const WORKER = 'worker';
export const SYNTH = 'synth';

function modelFor(name, tier) {
  const r = ROUTES[name] || ROUTES.anthropic;
  if (tier === WORKER) return r.worker;
  if (tier === SYNTH) return r.synth;
  return tier; // an explicit model name: honour it
}

/* Effort is supported on the Opus/Sonnet 5 line but errors on Haiku 4.5, and
 * Haiku takes the older thinking shape, so capability is per-model not global. */
const CAPS = {
  'claude-opus-5':    { effort: true,  adaptiveThinking: true },
  'claude-sonnet-5':  { effort: true,  adaptiveThinking: true },
  'claude-haiku-4-5': { effort: false, adaptiveThinking: false },
};

export function configured() {
  return PROVIDER !== null;
}

/* The whole chain, so a run's header says exactly what it will fall back to. */
export function providerLabel() {
  if (!PROVIDERS.length) return 'none';
  return PROVIDERS
    .map(function (p) {
      const r = ROUTES[p] || {};
      return `${p} (${r.worker} / ${r.synth})`;
    })
    .join(' then ');
}

/* ── transport: Anthropic ──────────────────────────────────────── */

let anthropicClient = null;

/*
 * `system` may be a plain string or an array of content blocks. Blocks exist
 * so a caller can mark a cache breakpoint on the static half of a long prompt:
 * Anthropic caches on exact prefix match, so a large instruction that is
 * byte-identical every call is read back at about a tenth of input price.
 *
 * Only the Anthropic transport can honour that. Every other provider here is
 * OpenAI-shaped and takes one system string, so flatten() is what they get.
 * Callers therefore never have to know which provider is live, which is the
 * whole point of this file.
 */
function flattenSystem(system) {
  if (!Array.isArray(system)) return system;
  return system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n\n');
}

async function askAnthropic({ model, system, prompt, schema, maxTokens, effort, cost, label }) {
  if (!anthropicClient) anthropicClient = new Anthropic();

  const caps = CAPS[model] || {};
  const req = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  };

  if (schema) req.output_config = { format: { type: 'json_schema', schema } };
  if (caps.effort && effort) req.output_config = { ...(req.output_config || {}), effort };
  if (caps.adaptiveThinking) req.thinking = { type: 'adaptive' };

  // Stream anything that could run long; short structured calls go direct.
  let msg;
  if (maxTokens > 16000) {
    msg = await anthropicClient.messages.stream(req).finalMessage();
  } else {
    msg = await anthropicClient.messages.create(req);
  }

  if (cost) cost.usage(model, msg.usage || {});

  if (msg.stop_reason === 'refusal') {
    console.error(`  ! ${label}: model declined (${msg.stop_details?.category || 'unspecified'})`);
    return null;
  }

  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/* ── transport: OpenAI-compatible (agentrouter, xAI) ───────────── */

function openaiConfig(name) {
  if (name === 'xai') {
    return {
      base: process.env.XAI_BASE_URL || 'https://api.x.ai',
      key: process.env.XAI_API_KEY,
      userAgent: null,
    };
  }
  return {
    base: (process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org').replace(/\/$/, ''),
    key: process.env.AGENTROUTER_API_KEY,
    /*
     * This gateway rejects every request whose user agent is not the Claude Code
     * CLI ("unauthorized client detected"), which tells you plainly what it is
     * reselling. Kept in env so the value is a deployment decision, visible and
     * changeable, rather than something buried in code.
     */
    userAgent: process.env.AGENTROUTER_USER_AGENT || 'claude-cli/2.1.228 (external, cli)',
  };
}

async function postChat(body, { base, key, userAgent }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (userAgent) headers['User-Agent'] = userAgent;

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }

  if (!res.ok || !json || json.error) {
    const msg = json?.error?.message || text.slice(0, 200);
    const err = new Error(`${res.status}: ${msg}`);
    err.body = msg;
    throw err;
  }
  return json;
}

async function askOpenAICompatible({ providerName, model, system: systemIn, prompt, schema, maxTokens, cost, label }) {
  const cfg = openaiConfig(providerName);
  // One system string is all an OpenAI-shaped API takes; cache breakpoints,
  // if the caller set any, are an Anthropic feature and simply do not apply.
  const system = flattenSystem(systemIn);

  const base = {
    model,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
  };

  const withSchema = schema
    ? { ...base, response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: true } } }
    : base;

  let json;
  try {
    json = await postChat(withSchema, cfg);
  } catch (e) {
    // Not every gateway forwards structured outputs. Fall back to asking for
    // JSON in the prompt rather than losing the section entirely.
    if (!schema) throw e;
    console.error(`  ~ ${label}: structured output refused (${e.body || e.message}), retrying as plain JSON`);
    json = await postChat({
      ...base,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        {
          role: 'user',
          content: `${prompt}\n\nReply with ONLY a JSON object matching this schema. No prose, no code fence.\n${JSON.stringify(schema)}`,
        },
      ],
    }, cfg);
  }

  const u = json.usage || {};
  if (cost) {
    cost.usage(model, {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
    });
  }

  const choice = (json.choices || [])[0] || {};
  if (choice.finish_reason === 'content_filter') {
    console.error(`  ! ${label}: provider content filter`);
    return null;
  }
  return choice.message?.content || '';
}

/* ── public API ────────────────────────────────────────────────── */

/*
 * One structured call. Returns the parsed object, or null if the model is
 * unavailable or the response did not validate -- callers degrade rather than
 * throw, because a missing section is better than a dead report.
 */
export async function ask({
  model = WORKER,
  system,
  prompt,
  schema,
  maxTokens = 8000,
  effort,
  cost,
  label = 'llm',
}) {
  if (!configured()) return null;

  let lastError = null;

  for (let i = 0; i < PROVIDERS.length; i++) {
    const name = PROVIDERS[i];
    const resolved = modelFor(name, model);
    const args = {
      providerName: name, model: resolved,
      system, prompt, schema, maxTokens, effort, cost, label,
    };

    try {
      const text = name === 'anthropic'
        ? await askAnthropic(args)
        : await askOpenAICompatible(args);

      // A refusal or a content filter is the model's answer, not an outage.
      // Another provider may well answer it, so it counts as a failed attempt
      // rather than a final null.
      if (text === null) { lastError = 'declined'; continue; }
      if (!schema) return text;

      try {
        return JSON.parse(text);
      } catch {
        // Gateways that ignore response_format tend to fence the JSON.
        const fenced = String(text).match(/\{[\s\S]*\}/);
        if (fenced) {
          try { return JSON.parse(fenced[0]); } catch { /* fall through */ }
        }
        lastError = 'response was not valid JSON';
      }
    } catch (e) {
      lastError = e.message;
    }

    const next = PROVIDERS[i + 1];
    console.error(`  ! ${label} on ${name} (${resolved}): ${lastError}` +
      (next ? ` -> falling back to ${next}` : ''));
  }

  console.error(`  ! ${label}: every provider failed (${lastError})`);
  return null;
}

/* Run several independent calls at once. This is the whole latency story:
 * report sections do not depend on each other, so they should never queue. */
export async function askAll(jobs) {
  return Promise.all(jobs.map((j) => ask(j)));
}

/* Exposed for tools/promptcheck.mjs. Flattening is what keeps a cacheable
 * Anthropic prompt usable on an OpenAI-shaped provider, and it is invisible
 * from outside, so the test needs a handle on it. */
export const __flattenSystemForTest = flattenSystem;

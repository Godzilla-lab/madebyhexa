'use strict';

/*
 * Turns a studio order into real generation jobs.
 *
 * POST { order }  where order is the payload studio.js composes:
 *   { product: 'mode:ugc' | 'cinematic' | 'preview' | ...,
 *     selections: { link, desc, avatar, hook, setting, camera, grade, light,
 *                   aspect, duration, ... } }
 *
 * Video orders run on Marketing Studio (or Cinematic Studio). One engine
 * output caps at 15 seconds, so longer orders are split into 15s segments:
 * one continuous storyboard, one prompt per segment, every segment locked to
 * the same avatar, setting and voice so they cut together as one film. The
 * segments are stitched into a single file after render (ffmpeg, tools/stitch.sh).
 *
 * Returns { jobs: [{ id, segment, of }], engine, credits } for render.html
 * to poll via render-status.
 *
 * Guardrail: this endpoint spends credits, so it refuses unless the request
 * carries one of:
 *   - x-render-key matching RENDER_DEV_KEY (concierge / testing path), or
 *   - { paid: <Stripe Checkout session id> } for a session that is actually
 *     paid AND whose amount covers the server-priced order. The created job
 *     ids are stamped onto the payment intent's metadata, so replaying the
 *     same session returns the same jobs instead of spending twice.
 */

const hf = require('./lib/hf');
const promptLib = require('./lib/prompts');
const { priceStudioOrder, creditsForOrder } = require('./lib/pricing');
const { getUser } = require('./lib/auth');
const sb = require('./lib/supabase');
const { allow } = require('./lib/ratelimit');

const SEGMENT_SECONDS = 15;

/*
 * Marketing Studio will not make a clip shorter than this.
 *
 * The engine declares duration_range 12-15 (models_explore, 2026-08-14). The
 * free sample was asking it for 5 seconds, which is outside that range, so the
 * create was being rejected and the free taste has almost certainly never
 * worked for anybody.
 */
const MS_VIDEO_MIN_SECONDS = 12;

/*
 * The free taste: one short grounded clip per account, ever. It runs on the
 * same engine as the paid product on purpose, because a sample that does not
 * look like what you would buy sells nothing.
 *
 * That fidelity has a price. The floor is the engine's floor, so the cheapest
 * possible free sample is a 12 second Marketing Studio render, which is close
 * to a full UGC film in credits rather than the ~1 dollar the old 5 second
 * figure assumed. Chris can still turn the dial with SAMPLE_SECONDS, but it is
 * clamped to what the engine will actually accept instead of to 4-10, which
 * only ever produced a 422.
 */
const SAMPLE_SECONDS = Math.min(
  SEGMENT_SECONDS,
  Math.max(MS_VIDEO_MIN_SECONDS, parseInt(process.env.SAMPLE_SECONDS, 10) || MS_VIDEO_MIN_SECONDS)
);

/* Products whose output is stills, for the creations.type column. */
const IMAGE_PRODUCTS = ['photoshoot', 'adpack', 'adsingle'];

/* The ad pack ships twenty creatives, matching ADPACK_INCLUDED_FORMATS in
 * lib/pricing.js. Each name is a distinct direct-response concept, so a pack is
 * twenty different arguments rather than twenty crops of the same one. Ordered
 * by how reliably each concept converts, so a short pack still gets the best. */
const ADPACK_DEFAULT_FORMATS = 20;
/* Deduped: the catalog lists "Stat Surround" twice, and a repeated concept in a
 * twenty pack means the buyer paid for the same argument twice. */
/*
 * Higgsfield's DTC Ads formats: the name the buyer picks, the style_id that
 * actually drives the render, and Higgsfield's own published sample of it.
 *
 * The style_id is the whole point. Passing it to ms_image reproduces the exact
 * layout in that sample with the customer's product dropped in, which is what
 * makes a preview on our site an honest promise instead of decoration.
 * Measured 2026-08-14: Star Review through ms_image came back with the same
 * skeleton as Higgsfield's published sample (quote, star row, review card,
 * helpful count), where the same concept through nano_banana_2 failed outright.
 *
 * review_shaped marks the formats that stage a testimonial. They invent a
 * reviewer name, a rating and a helpful count; Higgsfield's own sample does it
 * too. Publishing fabricated endorsements is the customer's legal problem, so
 * these stay out of the default rotation and unlock only when real review text
 * is supplied. 28 of the 39 formats are not review shaped, comfortably more
 * than a 20 creative pack needs.
 */
const AD_FORMATS = require('../../catalog/higgsfield/ad-formats.json').items;
const AD_FORMAT_BY_NAME = AD_FORMATS.reduce(function (m, f) { m[f.name] = f; return m; }, {});
const AD_FORMAT_NAMES = AD_FORMATS
  .filter(function (f) { return !f.review_shaped; })
  .map(function (f) { return f.name; });

/* Write the library row for this render. Owner precedence: the paid order's
 * owner (webhook/checkout wrote it), else the signed-in caller (dev-key
 * renders while testing logged in). Anonymous dev renders own nothing and
 * write nothing. Failures only log: the render itself must never break
 * because bookkeeping hiccuped. Returns the creation id or null. */
async function persistCreation(order, engine, paidSessionId, event, creditOrderId, jobs) {
  try {
    if (!sb.configured()) return null;
    const db = sb.admin();
    let userId = null;
    // A credit render already opened its own order row, and the ledger's spend
    // points at it. Carrying the id onto the creation is what later lets a
    // failed creative find what was paid for it and refund the right amount.
    let orderId = creditOrderId || null;
    if (paidSessionId) {
      const { data: o } = await db.from('orders')
        .select('id,user_id,status')
        .eq('stripe_session_id', paidSessionId).maybeSingle();
      if (o) {
        userId = o.user_id;
        orderId = o.id;
        if (o.status === 'pending') {
          await db.from('orders').update({ status: 'paid' }).eq('id', o.id);
        }
      }
    }
    if (!userId) {
      const user = await getUser(event);
      if (user) userId = user.userId;
    }
    if (!userId) return null;

    const sel = (order.selections && typeof order.selections === 'object') ? order.selections : {};
    const product = String(order.product || '');
    let title = [sel.productName, sel.styleName].filter(Boolean).join(' · ') ||
      product.replace(/^mode:/, '').replace(/_/g, ' ');
    // Samples carry a server-set prefix: it is both the library label and the
    // one-per-account dedup key, so it must never come from the client.
    if (product === 'sample') title = 'Free sample · ' + (sel.productName || 'your product');
    // Action rows say what happened to which film, from server-resolved data.
    if (product.indexOf('action:') === 0) {
      const labels = { 'action:revoice': 'New voice', 'action:translate': 'Translated', 'action:upscale': 'Upscaled' };
      const langName = sel.language && DUB_LANGUAGES[sel.language] ? ' (' + DUB_LANGUAGES[sel.language] + ')' : '';
      title = (labels[product] || 'Edited') + langName + ' · ' + (sel._sourceTitle || 'your film');
    }
    /*
     * The jobs this row is made of.
     *
     * The column has existed since the first schema and nothing ever wrote it,
     * so it was always the empty default. account.js:93 builds the "rejoin
     * this render" link out of it, which meant a card that was still rendering
     * fell through to href="#": the one moment a customer most wants to click
     * back into their render was the one moment the link went nowhere. It is
     * also what lets a repeated credit render replay instead of charging twice.
     */
    const jobIds = Array.isArray(jobs)
      ? jobs.map(function (j) { return j && j.id; }).filter(Boolean)
      : [];

    const { data: row, error } = await db.from('creations').insert({
      user_id: userId,
      order_id: orderId,
      job_ids: jobIds,
      engine: engine || null,
      type: IMAGE_PRODUCTS.indexOf(product) >= 0 ? 'image' : 'video',
      title: title.slice(0, 120),
      prompt: typeof sel.notes === 'string' ? sel.notes.slice(0, 2000) : null,
      status: 'rendering',
    }).select('id').single();
    if (error) { console.error('creation insert failed:', error.message); return null; }
    return row ? row.id : null;
  } catch (e) {
    console.error('creation persist failed:', e.message);
    return null;
  }
}

/* Post-render actions (action:revoice / action:translate / action:upscale)
 * run on ONE finished clip the payer already owns. Resolve the source video
 * from the buyer's library, never from a client-supplied URL: the orders row
 * for the Stripe session names the owner, and the creation must be theirs. */
async function resolveActionSource(order, paidSessionId) {
  if (!sb.configured()) return { ok: false, status: 503, error: 'accounts not configured' };
  const db = sb.admin();
  const { data: o } = await db.from('orders')
    .select('user_id').eq('stripe_session_id', paidSessionId).maybeSingle();
  if (!o || !o.user_id) return { ok: false, status: 403, error: 'this order has no owner account' };

  const sel = order.selections || {};
  const { data: c } = await db.from('creations')
    .select('id,user_id,title,type,result_urls')
    .eq('id', String(sel.creationId || '')).maybeSingle();
  if (!c || c.user_id !== o.user_id) {
    return { ok: false, status: 404, error: 'source film not found in your library' };
  }
  const urls = Array.isArray(c.result_urls) ? c.result_urls : [];
  const idx = Math.max(0, parseInt(sel.clipIndex, 10) || 0);
  const url = urls[idx] || urls[0];
  if (c.type !== 'video' || !url) {
    return { ok: false, status: 409, error: 'that creation has no finished video yet' };
  }
  return { ok: true, url: url, sourceTitle: c.title || 'your film' };
}

/* Dubbing's 18 target languages, UI label -> engine code. */
const DUB_LANGUAGES = {
  eng: 'English', spa: 'Spanish', fra: 'French', deu: 'German', ita: 'Italian',
  por: 'Portuguese', pol: 'Polish', swe: 'Swedish', fin: 'Finnish', rus: 'Russian',
  tur: 'Turkish', ara: 'Arabic', hin: 'Hindi', cmn: 'Mandarin', jpn: 'Japanese',
  kor: 'Korean', ind: 'Indonesian', fil: 'Filipino',
};

/* ── Credit-render replay guard ───────────────────────────────────
 *
 * Three small pieces: recognise a duplicate-key error, insert an order
 * carrying the key, and find what a previous request with that key produced.
 */

/* PostgREST reports a unique violation as SQLSTATE 23505. The message match is
 * a belt-and-braces fallback for clients that flatten the code away. */
function isDuplicateKey(err) {
  if (!err) return false;
  return err.code === '23505' || /duplicate key value violates unique/i.test(String(err.message || ''));
}

/* An idempotency key is opaque to us; it only has to be stable and not be a
 * vector. Bounded and character-restricted so it cannot be used to smuggle
 * anything into a column other people's queries read. */
function cleanIdempotencyKey(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{8,128}$/.test(s) ? s : null;
}

/*
 * Insert the order with its key.
 *
 * The fallback exists because migration 013 adds the column, and a deploy that
 * lands before the migration is applied would otherwise fail every credit
 * render with "column orders.idempotency_key does not exist" (SQLSTATE 42703).
 * Losing the replay guard is bad; refusing to render at all is worse. It logs
 * loudly, because running like this means the migration still has to be run.
 */
async function insertCreditOrder(fields, idempotencyKey) {
  const db = sb.admin();
  const withKey = idempotencyKey ? Object.assign({}, fields, { idempotency_key: idempotencyKey }) : fields;
  const first = await db.from('orders').insert(withKey).select('id').single();
  if (!first.error || !idempotencyKey) return first;
  if (first.error.code === '42703' || /idempotency_key/.test(String(first.error.message || ''))) {
    console.error('orders.idempotency_key missing: apply supabase/migrations/013_order_idempotency.sql. ' +
      'Credit renders are running WITHOUT a double-charge guard.');
    return db.from('orders').insert(fields).select('id').single();
  }
  return first;
}

/*
 * What an earlier request with this key already made, in the shape a fresh
 * create returns, so the browser cannot tell the difference and simply
 * rejoins its render. Returns null when there is nothing to replay.
 */
async function replayCreditOrder(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  try {
    const db = sb.admin();
    const { data: prior, error } = await db.from('orders')
      .select('id')
      .eq('user_id', userId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error || !prior) return null;

    const { data: creation } = await db.from('creations')
      .select('id,job_ids,engine')
      .eq('order_id', prior.id)
      .maybeSingle();
    if (!creation || !creation.job_ids || !creation.job_ids.length) return null;

    const all = creation.job_ids;
    return {
      jobs: all.map(function (id, i) { return { id: id, segment: i + 1, of: all.length }; }),
      engine: creation.engine || null,
      creation: creation.id,
      replay: true,
    };
  } catch (e) {
    /* A replay lookup that errors must not block the render. The worst case is
     * the old behaviour, and the unique index still catches the insert. */
    console.error('replay lookup failed:', e.message);
    return null;
  }
}

/*
 * Validate a paid Stripe session against the order. Returns:
 *   { ok: true, jobs }        session already rendered; reuse those jobs
 *   { ok: true, stamp }       paid and unspent; stamp(jobs, engine) records them
 *   { ok: false, status, error }
 */
async function checkPaidSession(sessionId, order) {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 503, error: 'payments not configured' };
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
  } catch (e) {
    return { ok: false, status: 403, error: 'unknown payment session' };
  }
  if (session.payment_status !== 'paid') {
    return { ok: false, status: 402, error: 'payment not completed' };
  }

  const priced = priceStudioOrder(order);
  if (!priced) return { ok: false, status: 400, error: 'unknown studio product' };
  if ((session.amount_total || 0) < priced.amountCents) {
    return { ok: false, status: 403, error: 'payment does not cover this order' };
  }

  const pi = session.payment_intent && typeof session.payment_intent === 'object'
    ? session.payment_intent : null;

  // replay guard: a refresh of render.html?paid=... must not spend twice
  if (pi && pi.metadata && pi.metadata.hexa_jobs) {
    const jobs = pi.metadata.hexa_jobs.split(',').map(function (id, i, all) {
      return { id: id, segment: i + 1, of: all.length };
    });
    return { ok: true, jobs: jobs, engine: pi.metadata.hexa_engine || null };
  }

  return {
    ok: true,
    stamp: async function (jobs, engine) {
      if (!pi) return;
      try {
        await stripe.paymentIntents.update(pi.id, {
          metadata: {
            hexa_jobs: jobs.map(function (j) { return j.id; }).join(','),
            hexa_engine: engine || '',
          },
        });
      } catch (e) {
        console.error('could not stamp jobs onto payment intent:', e.message);
      }
    },
  };
}

/* Segment storyboard. Template-based today; when ANTHROPIC_API_KEY lands,
 * writeStoryboard is the single place a Claude call replaces the template. */
/* Beat sheets: each 15s segment is one beat of a classic direct-response arc.
 * The arc chosen depends on how many segments the order buys, so a 60s film
 * is a real four-act ad, not the same middle beat repeated. Each beat says
 * what THIS 15 seconds must accomplish, and each prompt after the first
 * restates the previous beat's end state so the engine continues the take. */
const ARCS = {
  2: [
    { name: 'hook + reveal', does: 'Grab attention in the first two seconds, reveal the product, and land its single biggest promise.', ends: 'holding the product up to the camera, mid-sentence, energized' },
    { name: 'proof + CTA', does: 'Show the product doing the thing, react honestly to the result, and close with a direct call to action.', ends: 'looking into the lens delivering the call to action' },
  ],
  3: [
    { name: 'hook + problem', does: 'Grab attention in the first two seconds, then name the everyday frustration this product kills.', ends: 'reaching for the product with a knowing look' },
    { name: 'demo', does: 'Demonstrate the product in real use, close on the key detail, and give one concrete, specific benefit.', ends: 'mid-demo, visibly impressed by the result' },
    { name: 'payoff + CTA', does: 'Show the after state, compare it to the opening frustration, and close with a direct call to action.', ends: 'looking into the lens delivering the call to action' },
  ],
  4: [
    { name: 'hook', does: 'Grab attention in the first two seconds and make a bold, almost-too-big claim about this product.', ends: 'leaning into the camera, about to explain' },
    { name: 'problem', does: 'Tell the story of the frustration everyone has without this product, specific and relatable.', ends: 'picking the product up for the first time' },
    { name: 'demo + proof', does: 'Demonstrate the product working, linger on the most satisfying moment, and react honestly.', ends: 'holding up the result to the camera' },
    { name: 'payoff + CTA', does: 'Sum up the transformation in one line and close with a direct, urgent call to action.', ends: 'looking into the lens delivering the call to action' },
  ],
};

/* Middle beats for films longer than the 4-beat arc (90s+). Cycled between
 * the problem beat and the closing payoff so a 2-minute film keeps saying
 * something new instead of repeating its CTA. */
const LONG_MIDDLE_BEATS = [
  { name: 'demo + proof', does: 'Demonstrate the product working, linger on the most satisfying moment, and react honestly.', ends: 'holding up the result to the camera' },
  { name: 'objection', does: 'Voice the doubt a skeptical buyer has about this product, then answer it on camera with the product in hand.', ends: 'nodding, convinced, turning the product over' },
  { name: 'second use', does: 'Show a second, less obvious way to use the product and why that alone justifies buying it.', ends: 'setting the product down, visibly satisfied' },
  { name: 'social proof', does: 'Relay what other people say about this product and react to the best of it with the product in frame.', ends: 'smiling at the camera, holding the product' },
];

/* Beats for an order of N segments: the 2-4 beat arcs verbatim, and past 4
 * the hook/problem opening and payoff close wrap a cycle of middle beats. */
function arcFor(segments) {
  if (segments <= 4) return ARCS[Math.max(2, segments)];
  const four = ARCS[4];
  const beats = [four[0], four[1]];
  for (let i = 0; i < segments - 3; i++) beats.push(LONG_MIDDLE_BEATS[i % LONG_MIDDLE_BEATS.length]);
  beats.push(four[3]);
  return beats;
}

/* The prompt agent. Claude studies Higgsfield's own hook and scene prompts
 * (the harvested library) and writes one purpose-built prompt per 15s
 * segment, in that same house style. Falls back to the beat-sheet template
 * when no ANTHROPIC_API_KEY is configured or the call fails. */
/* research/lib/llm.mjs is ESM and this file is CommonJS, so it comes in by
 * dynamic import. Cached after the first call, since a warm function will plan
 * many orders. A failure here is never fatal: the beat sheet still writes a
 * competent storyboard, so the render goes out either way. */
let _llm = null;
async function loadLLM() {
  if (_llm) return _llm;
  try {
    _llm = await import('../../research/lib/llm.mjs');
  } catch (e) {
    console.error('prompt agent: could not load the model router:', e.message);
    _llm = null;
  }
  return _llm;
}

async function agentStoryboard(order, segments, facts) {
  /*
   * Routed through the research engine's provider chain, not straight at the
   * Anthropic SDK.
   *
   * This used to open `if (!process.env.ANTHROPIC_API_KEY) return null`, and
   * that key is set in no Netlify context (checked across production,
   * deploy-preview, branch-deploy and dev on 2026-08-15). So the prompt agent
   * had never once run in production: every video ever sold fell through to
   * the beat sheet template below, silently, because the fallback is a good
   * one and nothing looked broken.
   *
   * research/lib/llm.mjs already solves this. It holds the provider chain the
   * report engine runs on, and that chain is live today on the xAI key. Going
   * through it means the agent runs now, and upgrades itself to Opus 5 the
   * moment an Anthropic key exists, without this file changing again.
   */
  const llm = await loadLLM();
  if (!llm || !llm.configured()) {
    console.error('prompt agent: no LLM provider configured, using the beat sheet');
    return null;
  }
  const s = order.selections || {};

  const brief = [
    'Product: ' + (s.link || s.desc || 'unknown'),
    facts && facts.title ? 'Product name: ' + facts.title : (s.productName ? 'Product name: ' + s.productName : null),
    facts && facts.description ? 'What the product is, from its own page: ' + String(facts.description).slice(0, 700) : null,
    facts && facts.type ? 'Product type: ' + facts.type : null,
    s.avatar && s.avatar.name ? 'Creator: ' + s.avatar.name : null,
    s.hook && s.hook.name ? 'Opening hook: "' + s.hook.name + '" whose script is: ' + ((promptLib.findHook(s.hook.id) || {}).prompt || '') : null,
    s.setting && s.setting.name ? 'Scene: ' + s.setting.name : null,
    brandBrief(s) ? 'Brand context, apply throughout: ' + brandBrief(s) : null,
    s.directions ? 'Customer direction, follow it faithfully over everything else: ' + String(s.directions).slice(0, 1200) : null,
    'Total length: ' + (segments * SEGMENT_SECONDS) + ' seconds as ' + segments + ' segments of ' + SEGMENT_SECONDS + 's, generated separately and stitched into one continuous film.',
  ].filter(Boolean).join('\n');

  const schema = {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exactly one generation prompt per segment, in order.',
      },
    },
    required: ['prompts'],
    additionalProperties: false,
  };

  try {
    const out = await llm.ask({
      /*
       * Worker tier, not synthesis, and that is a measured choice rather than
       * a thrifty one. Measured live against this account on 2026-08-15 with
       * the real exemplar prompt:
       *
       *   grok-4.6 (synth)   49 to 64s, ignored the json schema and answered
       *                      with nested objects that would not parse
       *   grok-4.20 (worker)  2.6s, honoured the schema exactly, and xAI
       *                      returned 1,088 of 1,133 prompt tokens as cached
       *
       * The timing alone settles it. render-create is a synchronous function
       * and Netlify caps those at 26 seconds, so a synthesis call would 502
       * the create request and the customer would watch a paid render fail.
       * This is prompt writing against a worked example, not open judgment,
       * which is exactly the profile the worker tier is for.
       */
      model: llm.WORKER,
      maxTokens: 4096,
      effort: 'high',
      label: 'storyboard',
      schema: schema,
      /*
       * Split so the static half can be cached.
       *
       * The instruction and the exemplar library are byte-identical on every
       * call, about 1,400 tokens of them, and the only volatile part is the
       * brief, which goes in `prompt` and therefore sits after the breakpoint.
       * Marking the last static block writes a prefix that later orders read
       * back at roughly a tenth of input price. Opus 5 needs 512 tokens
       * minimum for a cacheable prefix, so this clears it with room.
       *
       * Move anything order-specific into these blocks and the prefix stops
       * matching: the cache then silently never hits, at full price, with
       * nothing visibly broken. tools/promptcheck.mjs is what catches that.
       * Providers that cannot cache flatten these to one system string.
       */
      system: [
        {
          type: 'text',
          text:
            'You are the storyboard writer for a hyper-real AI video studio. You write generation ' +
            'prompts for a video engine that renders 15-second segments. Study the proven prompt ' +
            'library below: match its concrete, physical, camera-aware style. Every segment prompt ' +
            'must state that this is ONE continuous video (same person, same room, same outfit, same ' +
            'lighting), describe exactly how the previous segment ended and how this one picks up ' +
            'from that body position, follow a direct-response ad arc (hook, problem, demo, payoff, ' +
            'call to action) across the segments, and end by describing the exact frame the segment ' +
            'closes on so the next segment can continue it.',
        },
        {
          type: 'text',
          text: promptLib.asExemplars(),
          cache_control: { type: 'ephemeral' },
        },
      ],
      prompt: 'Write the ' + segments + ' segment prompts for this order:\n' + brief,
    });
    if (out && Array.isArray(out.prompts) && out.prompts.length === segments) return out.prompts;
    console.error('prompt agent returned ' + (out ? 'the wrong number of prompts' : 'nothing') + ', using the beat sheet');
  } catch (e) {
    console.error('prompt agent failed, using beat-sheet template:', e.message);
  }
  return null;
}

function writeStoryboard(order, segments, facts) {
  const s = order.selections || {};
  const product = (facts && facts.title) || s.productName ||
    (s.link ? ('the product at ' + s.link) : (s.desc || 'the product'));
  const hook = s.hook && s.hook.name ? s.hook.name : null;
  const setting = s.setting && s.setting.name ? s.setting.name : null;
  const base =
    'A hyper-realistic creator video selling ' + product + '.' +
    (facts && facts.description ? ' The product: ' + String(facts.description).slice(0, 400) + '.' : '') +
    (setting ? ' Scene: ' + setting + '.' : '') +
    ' Natural handheld feel, honest tone, no captions burned in.' +
    (brandBrief(s) ? ' Brand context, apply throughout: ' + brandBrief(s) : '') +
    (s.directions ? ' Customer direction, follow it faithfully: ' + String(s.directions).slice(0, 1200) : '');

  if (segments === 1) {
    return [base + (hook ? ' Open with the "' + hook + '" hook.' : '')];
  }

  const arc = arcFor(segments);
  const prompts = [];
  for (let i = 0; i < segments; i++) {
    const beat = arc[Math.min(i, arc.length - 1)];
    const prev = i > 0 ? arc[Math.min(i - 1, arc.length - 1)] : null;
    let p = base +
      ' This is segment ' + (i + 1) + ' of ' + segments +
      ' of ONE continuous video: same person, same room, same outfit, same lighting, same time of day.';
    if (prev) {
      p += ' The previous segment ended with the creator ' + prev.ends +
        '; this segment picks up from exactly that moment and body position.';
    } else if (hook) {
      p += ' Open with the "' + hook + '" hook.';
    }
    p += ' This segment: ' + beat.does +
      ' End the segment with the creator ' + beat.ends + '.';
    prompts.push(p);
  }
  return prompts;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* Resolve a completed web product for this order, spending at most budgetMs.
 * Peek usually created it minutes ago (selections.webProductId), so the
 * common case is one instant GET. A fresh create only helps if the scrape
 * finishes inside the budget; otherwise the render proceeds ungrounded. */
/* The scraped product facts (real name, description, type) for the prompt
 * writers, or null. One GET; the scrape usually finished during the peek. */
async function webProductFacts(id) {
  if (!id) return null;
  try {
    const wp = await hf.getWebProduct(id);
    if (!wp || wp.status !== 'completed') return null;
    let title = wp.title && String(wp.title);
    if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title.trim())) title = null; // host echo
    return {
      title: title ? title.slice(0, 90) : null,
      description: wp.description ? String(wp.description).slice(0, 900) : null,
      type: wp.type || null,
    };
  } catch (e) {
    return null;
  }
}

/*
 * Scrape the customer's product page into an engine web product and wait for
 * it, within a budget. The resolved id is written back onto the selections,
 * not just returned: productImageRef() and webProductFacts() both read
 * s.webProductId, so a caller that only awaited this function used to throw the
 * scrape away and fall back to an INVENTED product. Keeping the id here means
 * no call site can make that mistake again.
 */
/*
 * What we know about the product when the engine's scrape came back empty.
 *
 * The pasted link is the whole grounding chain: the scrape becomes
 * web_product_ids on the video job and its title and description are what the
 * script talks about. Measured 2026-08-13, that scrape fails on about 2 in 5
 * real stores, and when it does the render used to proceed knowing nothing:
 * a paid film about a generic product the customer never sold.
 *
 * product-unlock-background has usually already read the same page through
 * Bright Data and cached what it found. It cannot supply web_product_ids, so
 * the visual grounding is still lost, but the script can at least be written
 * about the real product. Free to read, since the page was already paid for.
 */
async function unlockedFacts(link) {
  if (!link) return null;
  try {
    const { getStore } = require('@netlify/blobs');
    const peek = require('./product-peek');
    const target = await peek.guardUrl(link);
    if (!target) return null;
    const rec = await getStore('peeks').get(peek.unlockKey(target.href), { type: 'json' });
    if (!rec || (!rec.title && !rec.description)) return null;
    return {
      title: rec.title || null,
      description: rec.description || null,
      type: null,
    };
  } catch (e) {
    return null;
  }
}

async function ensureWebProduct(s, budgetMs) {
  let id = s.webProductId || null;
  try {
    if (!id && s.link) {
      // A cold scrape takes about ten seconds, measured, which is the entire
      // budget of a synchronous Netlify function. The studio peeks the product
      // at step one and sends the id along, so this only happens on a path that
      // skipped the peek. When we already hold a peeked image we can ground the
      // render without waiting, so wait briefly and move on; only when there is
      // nothing else to ground on is the full wait worth the risk.
      const wp = await hf.createWebProduct(s.link);
      id = wp && wp.id;
      if (s.productImage) budgetMs = Math.min(budgetMs, 3000);
    }
    if (!id) return null;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const got = await hf.getWebProduct(id);
      if (got.status === 'completed') { s.webProductId = id; return id; }
      if (got.status === 'failed') return null;
      if (Date.now() > deadline) return null;
      await sleep(1500);
    }
  } catch (e) {
    return null;
  }
}

/*
 * The customer's actual product image as a media reference, or null.
 *
 * Order matters, and it is not the cheap one first.
 *
 *   1. The image the customer actually saw. product-peek reads the page and the
 *      engine scrapes it separately, and the two can disagree: an Allbirds wool
 *      runner URL scraped as a flip flop from the same page, observed live
 *      2026-08-13. The studio showed the buyer the page's image and they
 *      approved it, so a pack built on the engine's other guess would advertise
 *      a product they never agreed to sell. Correctness beats one second.
 *      Costs a fetch and a PUT.
 *
 *   2. The web product's own media_input_id. That id IS a usable reference, so
 *      this path costs no upload at all. It is also where a peeked image ends
 *      up when product-peek fell back to the scrape, in which case the two are
 *      the same picture and nothing is lost.
 *
 *   3. The web product's media URL, fetched and PUT.
 *
 * Note what is NOT here: handing the engine a URL. The media endpoint only ever
 * PRESIGNS, the `url` in the body is ignored for images exactly as for video,
 * and the id it returns has no bytes behind it, so passing it as a reference
 * 500s the generation. That silently un-grounded every ad pack and photoshoot
 * until it was measured.
 *
 * Returning null is a real outcome, not a failure: the render proceeds
 * ungrounded rather than dying. But it means the product in the image is
 * invented, so it is worth a log line.
 */
async function uploadRefFromUrl(url) {
  const src = await fetch(url);
  if (!src.ok) throw new Error('product image fetch failed (' + src.status + ')');
  const buf = Buffer.from(await src.arrayBuffer());
  const media = await hf.uploadImageBytes(buf, src.headers.get('content-type') || 'image/jpeg');
  return media && media.id ? { type: 'media_input', id: media.id } : null;
}

async function productImageRef(s) {
  // 1. what the buyer approved
  if (typeof s.productImage === 'string' && /^https:\/\//.test(s.productImage)) {
    try {
      const ref = await uploadRefFromUrl(s.productImage);
      if (ref) return ref;
    } catch (e) {
      // Not fatal: the engine's own scrape is still a real picture of the
      // product, and a grounded render on that beats an invented one.
      console.warn('productImageRef: approved image unusable, falling back:', e.message);
    }
  }

  // 2 and 3. whatever the engine scraped
  try {
    if (s.webProductId) {
      const wp = await hf.getWebProduct(s.webProductId);
      const primary = (wp.medias || []).find(function (m) { return m.is_primary; }) || (wp.medias || [])[0];
      if (primary && primary.media_input_id) return { type: 'media_input', id: primary.media_input_id };
      if (primary && primary.url) return await uploadRefFromUrl(primary.url);
    }
  } catch (e) {
    console.error('productImageRef failed, rendering ungrounded:', e.message);
    return null;
  }

  console.warn('productImageRef: no product image, rendering ungrounded');
  return null;
}

/*
 * Brand memory as a prompt line.
 *
 * Deliberately shapes HOW something is said and never WHAT is claimed. Tone,
 * audience and vocabulary are the customer's to set; product facts come from
 * the product page and the research, because a brand field that could assert
 * "clinically proven" would launder an unevidenced claim into every creative.
 *
 * Words to avoid is listed last and phrased as a hard rule, because it is the
 * one a model is most likely to drift past.
 */
function brandBrief(s) {
  const b = s && s.brand;
  if (!b) return null;
  const bits = [];
  if (b.brand_name) bits.push('Brand: ' + String(b.brand_name).slice(0, 80));
  if (b.audience) bits.push('They sell to: ' + String(b.audience).slice(0, 200));
  if (b.tone) bits.push('Voice: ' + String(b.tone).slice(0, 200));
  if (b.words_use) bits.push('Words that are theirs, use them: ' + String(b.words_use).slice(0, 200));
  if (b.offer) bits.push('Standing offer: ' + String(b.offer).slice(0, 120));
  if (b.notes) bits.push(String(b.notes).slice(0, 300));
  if (b.words_avoid) bits.push('NEVER use these words or phrases: ' + String(b.words_avoid).slice(0, 200));
  return bits.length ? bits.join('. ') : null;
}

/* Map a studio order to engine calls. Returns { kind, jobType, paramsList }. */
async function planOrder(order) {
  const s = order.selections || {};
  const product = order.product || '';
  const aspect = s.aspect || '9:16';
  /*
   * Duration is client supplied, so it needs a ceiling as well as a floor.
   * Unclamped, selections.duration = 1e9 asks for 66 million segments, and
   * createJobsInWaves would sit there issuing engine calls until the function
   * died. Payment happens before planning so nobody could actually reach it
   * without paying for it first, but a spend guard is the wrong last line of
   * defence against resource exhaustion: the loop should refuse to be that
   * large whoever asks. Eight minutes is well past the longest film sold.
   */
  const MAX_SEGMENTS = 32;
  const duration = Math.min(
    SEGMENT_SECONDS * MAX_SEGMENTS,
    Math.max(SEGMENT_SECONDS, parseInt(s.duration, 10) || SEGMENT_SECONDS)
  );
  const segments = Math.ceil(duration / SEGMENT_SECONDS);

  // cheap live-proof product: one Soul V2 image
  if (product === 'preview') {
    return {
      kind: 'images', jobType: 'text2image_soul_v2',
      paramsList: [{
        prompt: s.desc || 'Photoreal product shot, studio light, premium DTC brand look.',
        aspect_ratio: aspect === '9:16' ? '9:16' : aspect,
        quality: '1.5k',
      }],
    };
  }

  // Customer-supplied creator photos become a real custom avatar: each photo
  // uploads as presigned media, the batch becomes a marketing-studio avatar,
  // and the film is fronted by that exact person. Only if the whole chain
  // fails does the order fall back to concierge (501 -> honest queued state).
  if (s.avatar && s.avatar.id === 'custom') {
    const photos = Array.isArray(s.avatarPhotos) ? s.avatarPhotos.slice(0, 3) : [];
    if (!photos.length) return null;
    try {
      const refs = [];
      for (const dataUrl of photos) {
        const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(String(dataUrl));
        if (!m) continue;
        const media = await hf.uploadImageBytes(Buffer.from(m[2], 'base64'), m[1]);
        if (media && media.id) refs.push({ type: 'media_input', id: media.id });
      }
      if (!refs.length) return null;
      const made = await hf.createAvatars([{
        name: 'Customer creator · ' + String(order.id || '').slice(0, 8),
        image_references: refs,
      }]);
      const av = Array.isArray(made) ? made[0] : made;
      if (!av || !av.id) return null;
      s.avatar = { id: av.id, name: s.avatar.name || 'Your own creator' };
    } catch (e) {
      console.error('custom avatar creation failed, order goes concierge:', e.message);
      return null;
    }
  }

  // 1080p on standard modes is a paid upgrade (priced per segment in
  // lib/pricing.js); premium products ship 1080p in their base price.
  const PREMIUM_1080 = { 'mode:tv_spot': 1, 'mode:pro_try_on': 1, cinematic: 1 };
  const resolution = (PREMIUM_1080[product] || s.quality === '1080p') ? '1080p' : '720p';

  // Post-render actions: one finished clip in, one transformed clip out.
  // Param shapes and per-clip costs verified live against the jobs API
  // 2026-07-09 (voice_change 2cr, dubbing 45cr, video_upscale 2cr per 15s).
  if (product.indexOf('action:') === 0) {
    if (!s._sourceUrl) return null;
    const media = await hf.uploadVideoFromUrl(s._sourceUrl);
    if (!media || !media.id) return null;
    const input = { type: 'media_input', id: media.id };
    if (product === 'action:revoice') {
      const voiceId = String(s.voiceId || '');
      if (!/^[0-9a-f-]{36}$/i.test(voiceId)) return null;
      return {
        kind: 'videos', jobType: 'voice_change',
        paramsList: [{ input_video: input, voice_id: voiceId, voice_type: 'preset' }],
      };
    }
    if (product === 'action:translate') {
      const lang = String(s.language || '');
      if (!DUB_LANGUAGES[lang]) return null;
      return {
        kind: 'videos', jobType: 'dubbing',
        paramsList: [{ input_video: input, target_language: lang }],
      };
    }
    if (product === 'action:upscale') {
      return { kind: 'videos', jobType: 'video_upscale', paramsList: [{ input_video: input }] };
    }
    return null;
  }

  // Auto rides Marketing Studio too: it is the strongest engine for product
  // ads and the only one that grounds the render in the scraped real product.
  // The free sample is the same engine and grounding at 5 seconds: the taste
  // must look exactly like what they would buy, or it sells nothing.
  if (product.indexOf('mode:') === 0 || product === 'auto' || product === 'sample') {
    const mode = product === 'auto' || product === 'sample' ? 'ugc' : product.slice(5);
    if (product === 'sample') {
      const webProductId = await ensureWebProduct(s, 6000);
      const facts = (await webProductFacts(webProductId)) || (await unlockedFacts(s.link));
      const name = (facts && facts.title) || s.productName || 'the product';
      const p = {
        prompt: 'UGC selfie video, handheld phone energy. A relatable creator holds ' + name +
          ' up to the camera, hooks the viewer in the first second with genuine excitement about it, ' +
          'and lands its single biggest promise. Natural indoor light, real skin texture, ' +
          'looks shot on a phone, not produced.',
        mode: mode,
        aspect_ratio: aspect,
        duration: SAMPLE_SECONDS,
        resolution: '720p',
        generate_audio: true,
      };
      if (webProductId) {
        p.web_product_ids = [webProductId];
        p.specific_mode = 'web_product';
      }
      return { kind: 'videos', jobType: 'marketing_studio_video', paramsList: [p] };
    }
    // Resolve the scraped product first: its real name and description feed
    // the storyboard, so the script talks about the actual product.
    const webProductId = await ensureWebProduct(s, 6000);
    const facts = (await webProductFacts(webProductId)) || (await unlockedFacts(s.link));
    const prompts = (await agentStoryboard(order, segments, facts)) || writeStoryboard(order, segments, facts);
    return {
      kind: 'videos', jobType: 'marketing_studio_video',
      paramsList: prompts.map(function (prompt) {
        const p = {
          prompt: prompt,
          mode: mode,
          aspect_ratio: aspect,
          duration: SEGMENT_SECONDS,
          resolution: resolution,
          generate_audio: true,
        };
        if (webProductId) {
          p.web_product_ids = [webProductId];
          p.specific_mode = 'web_product';
        }
        if (s.avatar && s.avatar.id) p.avatar_ids = [s.avatar.id];
        if (s.hook && s.hook.id) p.hook_id = s.hook.id;
        if (s.setting && s.setting.id) p.setting_id = s.setting.id;
        return p;
      }),
    };
  }

  if (product === 'cinematic') {
    await ensureWebProduct(s, 8000); // scrape before reading facts
    const cinFacts = (await webProductFacts(s.webProductId)) || (await unlockedFacts(s.link));
    let prompts = (await agentStoryboard(order, segments, cinFacts)) || writeStoryboard(order, segments, cinFacts);
    // Cinematic Studio takes no hook_id/setting_id, so inject the full library
    // prompt text that Marketing Studio would have applied server-side.
    const hookRec = s.hook && promptLib.findHook(s.hook.id || s.hook.name);
    if (hookRec) prompts = prompts.map(function (p, i) { return i === 0 ? p + ' Hook: ' + hookRec.prompt : p; });
    return {
      kind: 'videos', jobType: 'cinematic_studio_video_3_5',
      paramsList: prompts.map(function (prompt) {
        const p = {
          prompt: prompt,
          aspect_ratio: aspect,
          duration: SEGMENT_SECONDS,
          resolution: resolution,
          generate_audio: true,
        };
        if (s.camera) p.camera_style = s.camera;
        if (s.grade) p.color_grading = s.grade;
        if (s.light) p.light_scheme = s.light;
        return p;
      }),
    };
  }

  // Product Photoshoot: ten images, one pass. The photoshoot prompt writer
  // turns the chosen shoot style into structured prompts; each renders on
  // nano_banana_2 with the customer's real product image as the reference.
  if (product === 'photoshoot') {
    const COUNT = 10;
    const shootMode = (s.mode && s.mode.id) || 'product_shot';
    await ensureWebProduct(s, 8000); // scrape before reading facts or medias
    const shootFacts = (await webProductFacts(s.webProductId)) || (await unlockedFacts(s.link));
    const intent =
      (s.directions && String(s.directions).slice(0, 600)) ||
      ('Brand-quality ' + shootMode.replace(/_/g, ' ') + ' of ' +
        ((shootFacts && shootFacts.title) || s.productName || s.desc || 'the product') +
        (s.productSiteName ? ' by ' + s.productSiteName : '') +
        ((shootFacts && shootFacts.description) ? ' The product: ' + String(shootFacts.description).slice(0, 300) : '') + '.');

    let prompts = null;
    try {
      const enhanced = await hf.photoshootEnhance({
        mode: shootMode,
        user_prompt: intent,
        count: COUNT,
        enhance_only: true,
      });
      if (enhanced && Array.isArray(enhanced.prompts)) {
        prompts = enhanced.prompts.map(function (p) { return p.prompt || p; }).filter(Boolean);
      }
    } catch (e) {
      console.error('photoshoot enhance failed, using intent directly:', e.message);
    }
    if (!prompts || !prompts.length) prompts = [intent];
    const base = prompts.length;
    while (prompts.length < COUNT) prompts.push(prompts[prompts.length % base]);
    prompts = prompts.slice(0, COUNT);

    // nano_banana_2 aspect enum has no 9:16/16:9 guarantees beyond the doc;
    // map ours onto its nearest supported ratio.
    const NANO_ASPECTS = { '1:1': '1:1', '16:9': '3:2', '9:16': '2:3', '4:3': '4:3', '21:9': '3:2' };
    const shootAspect = NANO_ASPECTS[typeof s.aspect === 'string' ? s.aspect : (s.aspect && s.aspect.id)] || '1:1';

    const ref = await productImageRef(s);

    return {
      kind: 'images', jobType: 'nano_banana_2',
      paramsList: prompts.map(function (prompt) {
        const p = {
          prompt: prompt,
          aspect_ratio: shootAspect,
          resolution: '2k',
        };
        if (ref) p.image_references = [ref];
        return p;
      }),
    };
  }

  /*
   * DTC Ad Pack: twenty static ad creatives in one pass.
   *
   * This used to return null and be fulfilled by hand, which stopped being
   * tenable when the pack went to twenty creatives for $12. It renders on the
   * same proven path as the photoshoot (nano_banana_2 grounded on the
   * customer's real product image), and the only new work is turning each ad
   * FORMAT into a brief.
   *
   * The formats are the value. Each one is a distinct direct-response concept
   * ("Customer Quote", "Then vs Now", "Star Review", "Bundle Deal"), so a pack
   * is twenty different arguments for the same product rather than twenty
   * variations of one. That is what makes it an answer to the creative
   * treadmill instead of another swipe file.
   *
   * Two rules hold here, both borrowed from the research engine:
   *   - Never invent a product claim. Copy is built from the scraped facts and
   *     the customer's own directions; if we do not know it, we do not say it.
   *   - On-image text is stated explicitly and kept short, because one typo
   *     makes a careful brand look careless.
   */
  if (product === 'adpack' || product === 'adsingle') {
    const chosen = Array.isArray(s.formats) ? s.formats.filter(Boolean) : [];
    // One creative, whatever the client sent in formats. This is the product a
    // new account's welcome credits buy, so its size is fixed by the SKU rather
    // than by anything the browser can ask for.
    const single = product === 'adsingle';

    /*
     * A revision re-renders ONE creative, not the pack. The buyer gets twenty
     * starting points and will always want to change a headline or re-roll a
     * concept that missed, so each creative is addressable on its own by
     * (concept, headline, aspect). One image is about two credits, which is
     * what keeps the "no reject fees" promise on the pricing page affordable
     * rather than aspirational.
     */
    const revising = !!(s.revise && (s.revise.concept || s.revise.headline));
    /*
     * Same ceiling reasoning as film segments: the formats array arrives from
     * the client and drives one engine call each, so an array of ten thousand
     * is ten thousand creates. Pricing scales with the count and the charge is
     * taken before any of this runs, so it is not a way to get free work, but
     * the loop still should not agree to be unbounded. There are 39 formats in
     * the catalogue, so 60 leaves room to ask for repeats.
     */
    const MAX_ADPACK_FORMATS = 60;
    const wanted = (revising || single)
      ? 1
      : Math.min(MAX_ADPACK_FORMATS, Math.max(1, chosen.length || ADPACK_DEFAULT_FORMATS));

    // Scrape first, then read. The facts and the product image both come off
    // the same web product, so asking for either before it exists is how a
    // pack ends up describing a product we never actually read.
    await ensureWebProduct(s, 8000);
    const adFacts = (await webProductFacts(s.webProductId)) || (await unlockedFacts(s.link));
    const name = (adFacts && adFacts.title) || s.productName || s.desc || 'the product';
    const detail = (adFacts && adFacts.description) ? String(adFacts.description).slice(0, 400) : '';
    const brandLine = s.productSiteName ? ' by ' + s.productSiteName : '';

    // The angle's headline when the order came from a validation report,
    // otherwise the customer's own direction. Never invented here.
    const headlineSrc = (revising && s.revise.headline) ? s.revise.headline : s.headline;
    const headline = (typeof headlineSrc === 'string' && headlineSrc.trim())
      ? headlineSrc.trim().slice(0, 90)
      : '';
    const directions = (s.directions && String(s.directions).slice(0, 400)) || '';

    /*
     * Placement ratios: 4:5 is the feed workhorse, 1:1 travels everywhere, 9:16
     * is stories and reels. Cycling them means one pack covers every slot.
     *
     * ms_image has no 4:5, so 3:4 stands in for it: both are portrait and a
     * 3:4 crops to 4:5 without losing the composition. The old nano_banana_2
     * mapping sent 4:5 to 4:3, which is landscape, so every "feed" creative in
     * a pack came back the wrong way round for the placement it was made for.
     */
    const AD_ASPECTS = ['4:5', '1:1', '9:16'];
    const MS_AD_ASPECT = { '4:5': '3:4', '1:1': '1:1', '9:16': '9:16' };

    /*
     * Real review text, supplied by the buyer. Nothing is scraped: DTC stores
     * keep reviews inside Yotpo, Okendo, Judge.me, Trustpilot and friends,
     * each behind its own key, and measured 2026-08-14 none of Allbirds,
     * Brooklinen or Huel expose review bodies in server-side HTML at all.
     * Guessing here would put invented words in a real customer's mouth, so
     * the words have to come from the person who owns them.
     */
    const realReviews = Array.isArray(s.reviews)
      ? s.reviews.map(function (r) { return String((r && (r.text || r)) || '').trim(); })
          .filter(Boolean).slice(0, 3)
      : [];
    const allowReview = realReviews.length > 0;

    const picked = revising
      ? [String(s.revise.concept || 'Headline')]
      : (chosen.length
        ? chosen.map(function (f) { return (f && (f.name || f.id)) || 'Headline'; })
        : AD_FORMAT_NAMES.slice(0, wanted));

    /*
     * A testimonial format with nothing real to quote will invent a reviewer, a
     * star rating and a helpful count. Swap those slots for an honest format
     * that is not already in the set rather than ship a fabricated endorsement.
     */
    const substituted = [];
    const names = picked.map(function (n, i) {
      const f = AD_FORMAT_BY_NAME[n];
      if (allowReview || !f || !f.review_shaped) return n;
      const spare = AD_FORMAT_NAMES.filter(function (x) { return picked.indexOf(x) < 0; });
      const to = spare.length ? spare[i % spare.length] : 'Headline';
      // Only worth telling them about when they asked for it by name. Filling
      // the default twenty from honest formats needs no announcement.
      if (revising || chosen.length) substituted.push({ from: n, to: to });
      return to;
    });

    // A revision keeps the slot's original placement so the re-roll drops back
    // into the same spot in the set rather than changing shape.
    const aspectOffset = revising ? (parseInt(s.revise.index, 10) || 0) : 0;

    const prompts = [];
    for (let i = 0; i < wanted; i++) {
      const concept = names[i % names.length];
      const fmt = AD_FORMAT_BY_NAME[concept];
      // Only a format that stages a testimonial gets the review text, and it
      // gets it verbatim: the format supplies the layout, the customer supplies
      // the words, and the model is told to invent neither.
      const reviewLine = (fmt && fmt.review_shaped && realReviews.length)
        ? 'Use only this real customer review, quoted exactly as written: "'
          + realReviews[i % realReviews.length].slice(0, 240)
          + '". Do not invent a reviewer name, star rating, review count or helpful count. '
        : '';
      // A brief with named slots, not an adjective pile: product, concept,
      // scene, lighting, the exact on-image text, and what to avoid.
      prompts.push(
        'Direct response static ad creative. Concept: ' + concept + '. ' +
        'Product: ' + name + brandLine + '. ' +
        (detail ? 'What it is: ' + detail + ' ' : '') +
        (brandBrief(s) ? brandBrief(s) + '. ' : '') +
        (directions ? 'Brand direction: ' + directions + ' ' : '') +
        reviewLine +
        'Studio quality commercial photography, clean composition with room for text, ' +
        'soft directional lighting, the real product as the hero and unaltered. ' +
        (headline ? 'Render this exact on-image text, spelled exactly: "' + headline + '". ' +
                    'Bold clean sans-serif, high contrast, fully legible, no other text. '
                  : 'No on-image text. ') +
        'Avoid: stock photo look, extra logos, altered packaging, distorted or misspelled text, ' +
        'watermarks, and any invented claim or badge.'
      );
    }

    const adRef = await productImageRef(s);

    /*
     * DTC Ads rather than a general image model.
     *
     * style_id is what buys the format: Higgsfield holds the layout recipe for
     * "Star Review" or "Comparison Table" and applies it, so the pack looks
     * like the samples on our site instead of twenty variations on a headline
     * over a photo. Measured 2026-08-14 against the same product and grounding:
     * 0.5 credits an image versus 2.0, and the Star Review format that failed
     * outright on nano_banana_2 rendered first time here.
     *
     * style_id is required by the engine, so an unrecognised concept falls back
     * to Headline instead of 422ing a pack the customer has already paid for.
     */
    const FALLBACK_STYLE = (AD_FORMAT_BY_NAME.Headline || AD_FORMATS[0]).style_id;

    return {
      kind: 'images', jobType: 'ms_image',
      // Named formats we could not honour, so the UI can say why and offer the
      // fix ("paste your real reviews to unlock Star Review") instead of the
      // buyer silently receiving a format they did not ask for.
      substituted: substituted.length ? substituted : undefined,
      paramsList: prompts.map(function (prompt, i) {
        const fmt = AD_FORMAT_BY_NAME[names[i % names.length]];
        const p = {
          prompt: prompt,
          aspect_ratio: MS_AD_ASPECT[AD_ASPECTS[(i + aspectOffset) % AD_ASPECTS.length]] || '1:1',
          style_id: (fmt && fmt.style_id) || FALLBACK_STYLE,
        };
        if (adRef) p.image_references = [adRef];
        return p;
      }),
    };
  }

  return null; // soul stays concierge for now
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/*
 * Create every job in the plan, in waves.
 *
 * This used to be a sequential loop, which was fine while an order meant one to
 * four jobs. A twenty creative ad pack made it a timeout: the engine answers a
 * create in about 0.8s, so twenty in a row is roughly 17 seconds against a
 * Netlify synchronous function ceiling of 10. The customer's card is already
 * charged by this point, so a timeout here is the worst failure we can have.
 *
 * Waves rather than one big Promise.all: twenty simultaneous creates is a good
 * way to meet a rate limiter, and a rate limited create costs us the same
 * timeout we are trying to avoid. Eight at a time puts a twenty pack in three
 * waves, comfortably inside the ceiling.
 *
 * One retry per failed create, because a single flaky create should not cost
 * someone their whole order. If a job still will not create we throw, which
 * surfaces as a 402 or 502 and leaves the refund paths to do their job.
 */
const CREATE_WAVE = 8;

async function createJobsInWaves(plan) {
  const total = plan.paramsList.length;
  const jobs = new Array(total);

  for (let start = 0; start < total; start += CREATE_WAVE) {
    const wave = [];
    for (let i = start; i < Math.min(start + CREATE_WAVE, total); i++) wave.push(i);
    await Promise.all(wave.map(async function (i) {
      let created;
      try {
        created = await hf.createJob(plan.kind, plan.jobType, plan.paramsList[i]);
      } catch (e) {
        if (e.status === 402) throw e; // out of credits: retrying cannot help
        console.warn('create failed for job ' + (i + 1) + '/' + total + ', retrying:', e.message);
        created = await hf.createJob(plan.kind, plan.jobType, plan.paramsList[i]);
      }
      jobs[i] = { id: created.id, segment: i + 1, of: total };
    }));
  }

  return jobs;
}

exports.planOrder = planOrder; // exposed for tests and the concierge CLI path
exports.brandBrief = brandBrief; // exposed so the brand line can be asserted in tests

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!hf.configured()) return json(503, { error: 'generation backend not configured' });

  let order, paidSessionId, idempotencyKey;
  try {
    const body = JSON.parse(event.body || '{}');
    order = body.order;
    paidSessionId = typeof body.paid === 'string' ? body.paid : null;
    // Only the credit path uses this; the card path replays off the session.
    idempotencyKey = cleanIdempotencyKey(body.idempotencyKey);
  } catch (e) { return json(400, { error: 'bad json' }); }
  if (!order || !order.product) return json(400, { error: 'missing order' });

  // spend guard: dev key (concierge/testing) or a verified paid Stripe session
  const devKey = process.env.RENDER_DEV_KEY;
  const given = (event.headers && (event.headers['x-render-key'] || event.headers['X-Render-Key'])) || '';
  const devAuthorized = !!devKey && given === devKey;

  /*
   * Loose on purpose. This was 12 an hour, set when every render meant its own
   * Stripe checkout, so twelve was already an implausible number of purchases.
   * Under credits it is the wrong shape entirely: someone who has just bought
   * 50,000 credits is entitled to spend them, and cutting them off at the
   * thirteenth render punishes the best customer we have.
   *
   * The wallet is the real limit. A render cannot happen without a balance to
   * charge, and the balance is checked and debited inside one locked statement,
   * so there is nothing here for a free rider to exploit. This ceiling exists
   * only to stop a flood from turning into a pile of engine calls.
   */
  if (!devAuthorized && !(await allow('render', event, 200))) {
    return json(429, { error: 'Too many render requests. Please wait a bit and try again.' });
  }

  let stampJobs = null;
  let creditOrderId = null; // set when the render was paid for with credits

  /*
   * The free 5 second clip is retired.
   *
   * It was the most expensive thing we gave away by a wide margin: 80 engine
   * credits, about $4.16 a head, against $0.026 for a static ad and $0.049 for
   * a full market read. It also stopped making sense once the report started
   * measuring whether a category is won by video or statics, because we were
   * handing every visitor a video regardless of what we had just told them.
   *
   * Refused here rather than only removed from the pages, because the entry
   * point was a product id in a JSON body and anything that can still post one
   * would otherwise still spend the money. Every UI route to it is gone; this
   * is the backstop.
   */
  if (order.product === 'sample') {
    return json(410, {
      error: 'The free clip has been replaced by a free market read: we tell you what your buyers '
        + 'actually say and which competitor ads are proven, then make the ad from that.',
      replacement: '/validate',
    });
  }

  /*
   * The free ad, and the only work we do without payment or an account.
   *
   * A report ends by naming the line we would run. Making the visitor create an
   * account before they can see that line as an actual ad is asking them to
   * commit before we have proved anything, so the first creative off a report
   * is free and needs nothing. It replaces the old free 5 second clip and costs
   * $0.026 against that clip's $4.16, which is the entire reason the trade is
   * affordable.
   *
   * Four things stop it being a free image API:
   *
   *   it is one SKU only, adsingle, so nobody can ask for a film
   *   it needs the report's claim token, which is 32 random bytes we issued
   *   it is once per report, held in Blobs, so replaying the call does nothing
   *   it is rate limited per address on top of all of that
   *
   * Anonymous renders write no library row (persistCreation returns early
   * without a user), so the image lives on the render page and signing in is
   * how you keep it. That is the ask, and it comes after we have delivered.
   */
  let freeAd = false;
  if (!devAuthorized && order.product === 'adsingle' && order.freeReport) {
    const { id: rid, claim } = order.freeReport;
    if (!sb.configured()) return json(503, { error: 'accounts not configured' });
    if (!(await allow('free-ad', event, 30))) {
      return json(429, { error: 'Too many free ads from this connection. Try again shortly.' });
    }

    const { data: rep } = await sb.admin().from('reports')
      .select('id,claim_token,user_id,status').eq('id', String(rid || '')).maybeSingle();
    if (!rep || rep.status !== 'ready') return json(404, { error: 'no such report' });

    /* Same ownership test report-status uses: the claim token, compared in
     * constant time, or a signed-in owner. */
    let owns = false;
    const given = String(claim || '');
    if (rep.claim_token && given && given.length === rep.claim_token.length) {
      owns = require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(rep.claim_token));
    }
    if (!owns && rep.user_id) {
      const u = await getUser(event);
      owns = !!u && u.userId === rep.user_id;
    }
    if (!owns) return json(404, { error: 'no such report' });

    // Once per report. Checked and claimed before any engine call, so a double
    // click cannot buy two.
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('free-ads');
      if (await store.get('report:' + rep.id)) {
        return json(409, {
          error: 'This report already had its free ad. Sign in and your welcome credits make three more.',
        });
      }
      await store.set('report:' + rep.id, String(Date.now()));
    } catch (e) {
      console.error('free ad guard unavailable:', e.message);
      return json(503, { error: 'could not start the free ad' });
    }
    freeAd = true;
  }

  if (!devAuthorized && !freeAd) {
    /*
     * Two ways to pay: a Stripe session, or credits already on the account.
     *
     * Credits are charged here, at create, because that is when the engine
     * charges us (measured 2026-08-14: DTC Ads bills the moment a job is
     * accepted, not on completion). Anything that then fails to render is
     * refunded per creative by render-status, so a failure never quietly eats
     * someone's balance.
     */
    if (!paidSessionId) {
      if (!sb.configured()) return json(503, { error: 'accounts not configured' });
      const user = await getUser(event);
      if (!user) return json(401, { error: 'Sign in to spend credits.' });

      const credits = creditsForOrder(order);
      if (!credits) return json(400, { error: 'this product has no credit price' });

      /*
       * The credit path's replay guard, which is what the card path gets for
       * free from Stripe: a session id the server recognises a second time.
       *
       * Credits had nothing equivalent. The whole defence was one
       * localStorage.setItem in the browser, written AFTER this call returned,
       * so a refresh mid-flight, a quota error or private mode charged the
       * balance twice for one render. The key is now generated and stored by
       * the client BEFORE the request and recorded here, with uniqueness
       * decided by Postgres (migration 013) rather than by a check in code.
       */
      const replay = await replayCreditOrder(user.userId, idempotencyKey);
      if (replay) {
        console.log('credit render replayed for key', idempotencyKey);
        return json(200, replay);
      }

      // The order row exists before the spend so the ledger has something
      // stable to point at, and so a refund can find what was paid for it.
      const priced = priceStudioOrder(order);
      const { data: row, error: orderErr } = await insertCreditOrder({
        user_id: user.userId,
        product: order.product,
        selections: order.selections || {},
        amount_cents: priced ? priced.amountCents : null,
        status: 'paid',
      }, idempotencyKey);

      /* Lost the race: another request with the same key inserted first, which
       * is the double submit this exists to catch. Hand back what it made
       * rather than charging again. */
      if (orderErr && isDuplicateKey(orderErr)) {
        const raced = await replayCreditOrder(user.userId, idempotencyKey);
        if (raced) return json(200, raced);
        return json(409, { error: 'That render is already starting. Give it a moment.' });
      }
      if (orderErr || !row) return json(503, { error: 'could not open an order' });

      const { error: spendErr } = await sb.admin().rpc('credit_spend', {
        p_user: user.userId,
        p_amount: credits,
        p_ref: 'order:' + row.id,
        p_note: order.product,
      });
      if (spendErr) {
        // Balance is checked and debited inside one locked statement, so this
        // is the only place "not enough credits" can be decided. Roll the empty
        // order back rather than leave a paid row nothing was charged for.
        await sb.admin().from('orders').delete().eq('id', row.id);
        if (/insufficient credits/i.test(spendErr.message || '')) {
          return json(402, { error: 'Not enough credits for this render.', creditsNeeded: credits });
        }
        return json(503, { error: 'could not charge credits' });
      }
      creditOrderId = row.id;
    } else {
      const paid = await checkPaidSession(paidSessionId, order);
      if (!paid.ok) return json(paid.status, { error: paid.error });
      if (paid.jobs) return json(200, { jobs: paid.jobs, engine: paid.engine, replay: true });
      stampJobs = paid.stamp;
    }
  }

  // Action orders work on a clip from the payer's own library. The resolved
  // URL is stamped server-side; a client-sent _sourceUrl is never trusted.
  if (String(order.product).indexOf('action:') === 0) {
    order.selections = order.selections || {};
    if (devAuthorized && order.selections.sourceUrl) {
      order.selections._sourceUrl = String(order.selections.sourceUrl);
      order.selections._sourceTitle = 'dev test clip';
    } else {
      const src = await resolveActionSource(order, paidSessionId);
      if (!src.ok) return json(src.status, { error: src.error });
      order.selections._sourceUrl = src.url;
      order.selections._sourceTitle = src.sourceTitle;
    }
  }

  /*
   * Brand memory, attached before anything is planned.
   *
   * The customer told us their voice once, in their account. Making them retype
   * it into the direction box on every order is how brand context ends up
   * missing from most creatives: not because people disagree with it, but
   * because nobody types the same paragraph twice.
   *
   * Loaded server side and merged into selections, so it reaches every prompt
   * builder through the path they already read. Never fatal: an order without a
   * brand profile is exactly the order we made yesterday.
   */
  try {
    const brandUser = await getUser(event);
    if (brandUser && sb.configured()) {
      const { data: brand } = await sb.admin().from('brand_profiles')
        .select('brand_name,audience,tone,words_use,words_avoid,offer,notes')
        .eq('user_id', brandUser.userId)
        .is('scope', null)
        .maybeSingle();
      if (brand) order.selections = Object.assign({}, order.selections, { brand: brand });
    }
  } catch (e) {
    console.error('brand profile not loaded:', e.message);
  }

  const plan = await planOrder(order);
  if (!plan) return json(501, { error: 'this product is fulfilled concierge-side for now' });

  try {
    const jobs = await createJobsInWaves(plan);
    if (stampJobs) await stampJobs(jobs, plan.jobType);
    const creationId = await persistCreation(order, plan.jobType, paidSessionId, event, creditOrderId, jobs);
    return json(200, {
      jobs: jobs,
      engine: plan.jobType,
      creation: creationId,
      substituted: plan.substituted || undefined,
    });
  } catch (e) {
    /*
     * The credits are already spent by this point, and if no job was created
     * there is nothing for render-status to refund against later. Give them
     * back here rather than leave a customer charged for an empty order.
     */
    if (creditOrderId) {
      try {
        const credits = creditsForOrder(order);
        if (credits) {
          await sb.admin().rpc('credit_refund', {
            p_user: (await getUser(event) || {}).userId,
            p_amount: credits,
            p_ref: 'order-failed:' + creditOrderId,
            p_note: 'No jobs could be created',
          });
        }
        await sb.admin().from('orders').update({ status: 'failed' }).eq('id', creditOrderId);
      } catch (refundErr) {
        console.error('credit refund after create failure did not land:', refundErr.message);
      }
    }
    return json(e.status === 402 ? 402 : 502, { error: String(e.message), detail: e.detail || null });
  }
};

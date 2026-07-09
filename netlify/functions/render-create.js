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
const { priceStudioOrder } = require('./lib/pricing');
const { getUser } = require('./lib/auth');
const sb = require('./lib/supabase');
const { allow } = require('./lib/ratelimit');

const SEGMENT_SECONDS = 15;

/* The free taste: one short grounded clip per account, ever. Long enough for
 * one hook beat with the real product in frame, short enough that giving it
 * away costs ~a dollar in credits. */
const SAMPLE_SECONDS = 5;

/* Products whose output is stills, for the creations.type column. */
const IMAGE_PRODUCTS = ['photoshoot', 'adpack'];

/* Write the library row for this render. Owner precedence: the paid order's
 * owner (webhook/checkout wrote it), else the signed-in caller (dev-key
 * renders while testing logged in). Anonymous dev renders own nothing and
 * write nothing. Failures only log: the render itself must never break
 * because bookkeeping hiccuped. Returns the creation id or null. */
async function persistCreation(order, engine, paidSessionId, event) {
  try {
    if (!sb.configured()) return null;
    const db = sb.admin();
    let userId = null;
    let orderId = null;
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
    const { data: row, error } = await db.from('creations').insert({
      user_id: userId,
      order_id: orderId,
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
async function agentStoryboard(order, segments, facts) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const s = order.selections || {};
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();

  const brief = [
    'Product: ' + (s.link || s.desc || 'unknown'),
    facts && facts.title ? 'Product name: ' + facts.title : (s.productName ? 'Product name: ' + s.productName : null),
    facts && facts.description ? 'What the product is, from its own page: ' + String(facts.description).slice(0, 700) : null,
    facts && facts.type ? 'Product type: ' + facts.type : null,
    s.avatar && s.avatar.name ? 'Creator: ' + s.avatar.name : null,
    s.hook && s.hook.name ? 'Opening hook: "' + s.hook.name + '" whose script is: ' + ((promptLib.findHook(s.hook.id) || {}).prompt || '') : null,
    s.setting && s.setting.name ? 'Scene: ' + s.setting.name : null,
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
    const msg = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system:
        'You are the storyboard writer for a hyper-real AI video studio. You write generation ' +
        'prompts for a video engine that renders 15-second segments. Study the proven prompt ' +
        'library below: match its concrete, physical, camera-aware style. Every segment prompt ' +
        'must state that this is ONE continuous video (same person, same room, same outfit, same ' +
        'lighting), describe exactly how the previous segment ended and how this one picks up ' +
        'from that body position, follow a direct-response ad arc (hook, problem, demo, payoff, ' +
        'call to action) across the segments, and end by describing the exact frame the segment ' +
        'closes on so the next segment can continue it.\n\n' + promptLib.asExemplars(),
      messages: [{ role: 'user', content: 'Write the ' + segments + ' segment prompts for this order:\n' + brief }],
      output_config: { format: { type: 'json_schema', schema: schema } },
    });
    const text = msg.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    const out = JSON.parse(text);
    if (Array.isArray(out.prompts) && out.prompts.length === segments) return out.prompts;
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

async function ensureWebProduct(s, budgetMs) {
  let id = s.webProductId || null;
  try {
    if (!id && s.link) {
      const wp = await hf.createWebProduct(s.link);
      id = wp && wp.id;
    }
    if (!id) return null;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const got = await hf.getWebProduct(id);
      if (got.status === 'completed') return id;
      if (got.status === 'failed') return null;
      if (Date.now() > deadline) return null;
      await sleep(1500);
    }
  } catch (e) {
    return null;
  }
}

/* The customer's actual product image as a media reference, or null. */
async function productImageRef(s) {
  try {
    let url = null;
    if (s.webProductId) {
      const wp = await hf.getWebProduct(s.webProductId);
      const primary = (wp.medias || []).find(function (m) { return m.is_primary; }) || (wp.medias || [])[0];
      if (primary) url = primary.url;
    }
    if (!url && typeof s.productImage === 'string' && /^https:\/\//.test(s.productImage)) {
      url = s.productImage;
    }
    if (!url) return null;
    const media = await hf.uploadImageFromUrl(url);
    return media && media.id ? { type: 'media_input', id: media.id } : null;
  } catch (e) {
    return null;
  }
}

/* Map a studio order to engine calls. Returns { kind, jobType, paramsList }. */
async function planOrder(order) {
  const s = order.selections || {};
  const product = order.product || '';
  const aspect = s.aspect || '9:16';
  const duration = Math.max(SEGMENT_SECONDS, parseInt(s.duration, 10) || SEGMENT_SECONDS);
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
      const facts = await webProductFacts(webProductId);
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
    const facts = await webProductFacts(webProductId);
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
    const cinFacts = await webProductFacts(s.webProductId);
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
    const shootFacts = await webProductFacts(s.webProductId);
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

    await ensureWebProduct(s, 4000); // best effort: fills medias for the ref
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

  return null; // adpack / soul stay concierge for now
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.planOrder = planOrder; // exposed for tests and the concierge CLI path

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (!hf.configured()) return json(503, { error: 'generation backend not configured' });

  let order, paidSessionId;
  try {
    const body = JSON.parse(event.body || '{}');
    order = body.order;
    paidSessionId = typeof body.paid === 'string' ? body.paid : null;
  } catch (e) { return json(400, { error: 'bad json' }); }
  if (!order || !order.product) return json(400, { error: 'missing order' });

  // spend guard: dev key (concierge/testing) or a verified paid Stripe session
  const devKey = process.env.RENDER_DEV_KEY;
  const given = (event.headers && (event.headers['x-render-key'] || event.headers['X-Render-Key'])) || '';
  const devAuthorized = !!devKey && given === devKey;

  if (!devAuthorized && !(await allow('render', event, 12))) {
    return json(429, { error: 'Too many render requests. Please wait a bit and try again.' });
  }

  let stampJobs = null;
  if (!devAuthorized && order.product === 'sample') {
    // The free taste: no payment, but a real account and only ever one.
    // Signed-in also means the drip picks them up and the film has a home.
    if (!sb.configured()) return json(503, { error: 'accounts not configured' });
    const user = await getUser(event);
    if (!user) return json(401, { error: 'Sign in free to claim your sample.' });
    if (!(await allow('sample', event, 3))) {
      return json(429, { error: 'Too many sample requests. Please wait a bit and try again.' });
    }
    const { count, error: dupErr } = await sb.admin().from('creations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.userId)
      .ilike('title', 'Free sample%');
    if (dupErr) return json(503, { error: 'could not check sample eligibility' });
    if ((count || 0) > 0) {
      return json(409, { error: 'Your free sample is already in your library. A full film starts at $12.' });
    }
  } else if (!devAuthorized) {
    if (!paidSessionId) return json(403, { error: 'payment required' });
    const paid = await checkPaidSession(paidSessionId, order);
    if (!paid.ok) return json(paid.status, { error: paid.error });
    if (paid.jobs) return json(200, { jobs: paid.jobs, engine: paid.engine, replay: true });
    stampJobs = paid.stamp;
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

  const plan = await planOrder(order);
  if (!plan) return json(501, { error: 'this product is fulfilled concierge-side for now' });

  try {
    const jobs = [];
    for (let i = 0; i < plan.paramsList.length; i++) {
      const created = await hf.createJob(plan.kind, plan.jobType, plan.paramsList[i]);
      jobs.push({ id: created.id, segment: i + 1, of: plan.paramsList.length });
    }
    if (stampJobs) await stampJobs(jobs, plan.jobType);
    const creationId = await persistCreation(order, plan.jobType, paidSessionId, event);
    return json(200, { jobs: jobs, engine: plan.jobType, creation: creationId });
  } catch (e) {
    return json(e.status === 402 ? 402 : 502, { error: String(e.message), detail: e.detail || null });
  }
};

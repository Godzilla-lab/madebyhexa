/*
 * Per-run cost meter.
 *
 * The plan makes this non-negotiable: "instrument tokens and vendor calls per
 * report from the very first run" and "no price ships until three real reports
 * have measured costs end to end." So every paid call in the engine charges
 * here, and every run prints what it actually cost.
 *
 * Rates live in one table so there is exactly one place to correct when the
 * unverified vendor prices are confirmed. Anything marked `unverified` prints
 * with a warning rather than quietly pretending to be a real number.
 */

/* Prompt size at which xAI switches a request to its long-context rate card.
 * Applied to the whole request, not to the excess. */
export const LONG_CONTEXT_TOKENS = 200000;

export const RATES = {
  // Anthropic, confirmed 2026-08-13 (per 1M tokens).
  'claude-opus-5':   { in: 5.00,  out: 25.00, verified: true },
  'claude-sonnet-5': { in: 3.00,  out: 15.00, verified: true },
  'claude-haiku-4-5': { in: 1.00, out: 5.00,  verified: true },
  // Fast mode is the same model at premium pricing.
  'claude-opus-5:fast': { in: 10.00, out: 50.00, verified: true },

  /*
   * xAI, from the published rate card at docs.x.ai/docs/models, read 2026-08-14.
   *
   * These are the two models this engine actually routes to. The old
   * grok-fast / grok-4-fast / grok-4 entries were guesses at models the account
   * does not serve, which is why every report priced at $0.00: the meter looked
   * up a key that was never used and charged nothing for the ones that were.
   *
   * `long` is the >= 200k prompt tier. It is not a surcharge on the excess: once
   * a prompt crosses 200k, xAI bills the WHOLE request at the higher rate, so a
   * 210k prompt costs double a 199k one rather than a fraction more. That is a
   * cliff worth seeing in the numbers, because the CLI sends its full evidence
   * set and can cross it while the worker's 300 line budget does not.
   */
  'grok-4.6': {
    in: 2.00, out: 6.00,
    long: { in: 4.00, out: 12.00 },
    verified: true,
  },
  'grok-4.20-0309-non-reasoning': {
    in: 1.25, out: 2.50,
    long: { in: 2.50, out: 5.00 },
    verified: true,
  },
  'grok-4.20-0309-reasoning': {
    in: 1.25, out: 2.50,
    long: { in: 2.50, out: 5.00 },
    verified: true,
  },
  'grok-4.5': {
    in: 2.00, out: 6.00,
    long: { in: 4.00, out: 12.00 },
    verified: true,
  },

  // agentrouter.org resells access and publishes no rate card, so per-token
  // cost here is genuinely unknown -- these lines print with `?` and must not
  // be used to price a report. Verify against the account's own usage page
  // before anything ships.
  'gpt-5.6-sol': { in: 0, out: 0, verified: false },
  'claude-opus-4-8': { in: 5.00, out: 25.00, verified: false },

  // Bright Data Web Unlocker, MEASURED live 2026-08-13 against zone web_unlocker1:
  // one target.com request billed $0.0015 (320KB, 82s). Per request, not per
  // byte, so a heavy page costs the same as a light one.
  'brightdata.unlocker': { per_call: 0.0015, verified: true },
  'brightdata.browser':  { per_call: 0.0060, verified: false },

  // Apify Meta Ad Library. Measured end to end 2026-08-13: a 30-ad pull cost
  // $0.174, i.e. $0.0058/ad, which puts the $5/month free cap at ~862 ads or
  // roughly 28 reports at 30 ads each. This is currently the ONLY working path
  // to Meta ad durations -- Bright Data's dataset marketplace has no Meta Ad
  // Library scraper (checked all 1,737 datasets on 2026-08-13).
  'apify.fb-ads-item': { per_call: 0.0058, verified: true },
};

export function createCostMeter(label) {
  const calls = [];
  let unverifiedSeen = false;

  function note(key, rate) {
    if (rate && rate.verified === false) unverifiedSeen = true;
  }

  return {
    label,

    /* A non-token vendor call: charge(key, count). */
    charge(key, count = 1) {
      const rate = RATES[key];
      note(key, rate);
      const usd = rate && rate.per_call ? rate.per_call * count : 0;
      calls.push({ key, kind: 'call', count, usd, verified: rate ? rate.verified !== false : false });
      return usd;
    },

    /* An LLM call: usage(model, {input_tokens, output_tokens}, provider).
     *
     * `provider` is recorded because a row naming only the model cannot answer
     * "who actually billed us for this". Settling that once took a live report
     * and a hand-checked price calculation. */
    usage(model, u = {}, provider) {
      const rate = RATES[model];
      note(model, rate);
      const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const outTok = u.output_tokens || 0;

      /*
       * Long-context billing is decided by the PROMPT size and then applied to
       * the whole request, output included. Charging the standard rate on a
       * 250k prompt would under-report by half.
       */
      const tier = rate && rate.long && inTok >= LONG_CONTEXT_TOKENS ? rate.long : rate;
      const usd = tier && tier.in != null
        ? (inTok / 1e6) * tier.in + (outTok / 1e6) * tier.out
        : 0;
      calls.push({
        key: model,
        provider: provider || null,
        kind: 'llm',
        in: inTok,
        out: outTok,
        usd,
        long: tier !== rate,
        verified: rate ? rate.verified !== false : false,
      });
      return usd;
    },

    total() {
      return calls.reduce((s, c) => s + c.usd, 0);
    },

    /* Grouped breakdown, biggest line first. */
    breakdown() {
      const byKey = new Map();
      for (const c of calls) {
        const cur = byKey.get(c.key) || { key: c.key, provider: c.provider || null, kind: c.kind, n: 0, in: 0, out: 0, usd: 0, verified: c.verified };
        cur.n += c.count || 1;
        cur.in += c.in || 0;
        cur.out += c.out || 0;
        cur.usd += c.usd;
        byKey.set(c.key, cur);
      }
      return [...byKey.values()].sort((a, b) => b.usd - a.usd);
    },

    hasUnverified() {
      return unverifiedSeen;
    },

    report() {
      const rows = this.breakdown();
      const lines = [`\n  cost: $${this.total().toFixed(4)}  (${label})`];
      for (const r of rows) {
        const detail = r.kind === 'llm'
          ? `${r.in.toLocaleString()} in / ${r.out.toLocaleString()} out`
          : `${r.n} call${r.n === 1 ? '' : 's'}`;
        lines.push(
          `    ${r.verified ? ' ' : '?'} ${r.key.padEnd(24)} ${detail.padEnd(28)} $${r.usd.toFixed(4)}`
        );
      }
      if (unverifiedSeen) {
        lines.push('    ? = rate not yet confirmed with the vendor; treat that line as an estimate');
      }
      return lines.join('\n');
    },

    toJSON() {
      return { label, total_usd: this.total(), lines: this.breakdown(), has_unverified: unverifiedSeen };
    },
  };
}

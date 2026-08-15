#!/usr/bin/env node
/*
 * Long-video chain engine: exact-continuation segments, stitched into one film.
 *
 *   node tools/chain-render.mjs --order order.json [--out final.mp4] [--xfade 0.3]
 *
 * order.json is the studio order payload ({ product, selections }). The engine:
 *   1. plans segment prompts via the same planOrder the backend uses
 *      (Claude prompt agent when ANTHROPIC_API_KEY is set, beat sheet otherwise)
 *   2. renders segment 1, polls until complete
 *   3. downloads it, extracts the LAST frame (ffmpeg), uploads it as media,
 *      and starts segment 2 from that exact frame (start_image) so the
 *      background, outfit and lighting physically cannot change
 *   4. repeats for every segment, then stitches with tools/stitch.sh
 *
 * Progressive delivery: after each segment completes it prints the segment URL
 * and a render.html?jobs=... link that already plays everything finished so
 * far, while the next segment renders.
 *
 * Needs: HIGGSFIELD_TOKEN + HIGGSFIELD_WORKSPACE_ID env (or it reads the CLI's
 * credentials file), ffmpeg on PATH.
 */

import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://fnf-api-gw.higgsfield.ai/fnf';

/* ── credentials: env first, CLI config as fallback ── */
if (!process.env.HIGGSFIELD_TOKEN) {
  try {
    const creds = JSON.parse(readFileSync(join(process.env.HOME, '.config/higgsfield/credentials.json'), 'utf8'));
    process.env.HIGGSFIELD_TOKEN = creds.access_token;
  } catch {}
}
if (!process.env.HIGGSFIELD_WORKSPACE_ID) {
  try {
    const cfg = JSON.parse(readFileSync(join(process.env.HOME, '.config/higgsfield/config.json'), 'utf8'));
    process.env.HIGGSFIELD_WORKSPACE_ID = cfg.workspace_id;
  } catch {}
}

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const hf = require(join(ROOT, 'netlify/functions/lib/hf.js'));
const { planOrder } = require(join(ROOT, 'netlify/functions/render-create.js'));
const { DEAD } = require(join(ROOT, 'netlify/functions/lib/failure.js'));

/* ── args ── */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
}
const orderPath = arg('order');
if (!orderPath) {
  console.error('usage: node tools/chain-render.mjs --order order.json [--out final.mp4] [--xfade 0.3]');
  process.exit(1);
}
const order = JSON.parse(readFileSync(orderPath, 'utf8'));
const outPath = arg('out', 'chain-output.mp4');
const xfade = arg('xfade', '0');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJob(id, label) {
  const started = Date.now();
  for (;;) {
    const job = await hf.getJob(id);
    if (job.status === 'completed') return job;
    if (DEAD.includes(String(job.status))) {
      throw new Error(label + ' ' + job.status);
    }
    process.stdout.write(`\r${label}: ${job.status} (${Math.round((Date.now() - started) / 1000)}s) `);
    await sleep(5000);
  }
}

/* Download a segment, pull its final frame, upload as media, return media id. */
async function relayLastFrame(videoUrl, work, n) {
  const seg = join(work, `seg${n}.mp4`);
  const frame = join(work, `seg${n}-last.png`);
  execFileSync('curl', ['-sSf', '-o', seg, videoUrl]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-sseof', '-0.1', '-i', seg, '-frames:v', '1', '-q:v', '2', '-y', frame]);

  const media = await hf.api('POST', '/developer/v2alpha/media?type=image', {});
  const put = await fetch(media.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: readFileSync(frame),
  });
  if (!put.ok) throw new Error('frame upload failed: ' + put.status);
  await hf.api('POST', `/developer/v2alpha/media/${media.id}/confirm?type=image`, {});
  return { mediaId: media.id, localSeg: seg };
}

/* ── run ── */
if (!hf.configured()) {
  console.error('missing HIGGSFIELD_TOKEN / HIGGSFIELD_WORKSPACE_ID');
  process.exit(1);
}

const plan = await planOrder(order);
if (!plan || plan.kind !== 'videos') {
  console.error('order does not plan to a video job');
  process.exit(1);
}
const n = plan.paramsList.length;
console.log(`engine: ${plan.jobType}, ${n} segment(s) of 15s`);

const work = mkdtempSync(join(tmpdir(), 'hexa-chain-'));
const segments = [];
const jobIds = [];
let startImage = null;

for (let i = 0; i < n; i++) {
  const params = { ...plan.paramsList[i] };
  if (startImage) params.start_image = { type: 'media_input', id: startImage };

  const created = await hf.createJob(plan.kind, plan.jobType, params);
  jobIds.push(created.id);
  console.log(`\nsegment ${i + 1}/${n} started: ${created.id}`);

  const job = await waitForJob(created.id, `segment ${i + 1}/${n}`);
  console.log(`\nsegment ${i + 1}/${n} done: ${job.result_url}`);
  console.log(`  watch so far: render.html?jobs=${jobIds.join(',')}`);

  if (i < n - 1) {
    const relay = await relayLastFrame(job.result_url, work, i + 1);
    segments.push(relay.localSeg);
    startImage = relay.mediaId;
    console.log(`  last frame relayed as media ${relay.mediaId}; next segment starts from it`);
  } else {
    const seg = join(work, `seg${i + 1}.mp4`);
    execFileSync('curl', ['-sSf', '-o', seg, job.result_url]);
    segments.push(seg);
  }
}

if (segments.length > 1) {
  const stitchArgs = xfade !== '0' ? ['-x', xfade, outPath, ...segments] : [outPath, ...segments];
  execFileSync('bash', [join(ROOT, 'tools/stitch.sh'), ...stitchArgs], { stdio: 'inherit' });
} else {
  execFileSync('cp', [segments[0], outPath]);
}
writeFileSync(outPath + '.jobs.json', JSON.stringify({ jobs: jobIds, order }, null, 1));
console.log(`\nfinal film: ${outPath}`);

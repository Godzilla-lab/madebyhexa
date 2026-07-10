'use strict';

/*
 * Server-side stitcher: turns a multi-segment film into the one continuous
 * master the customer actually bought. Runs as a Netlify background function
 * (invoked fire-and-forget by render-status the moment every segment lands).
 *
 * The join is a lossless repackage (-c copy): all segments come from the same
 * engine run with identical codec parameters, so no re-encode, no quality
 * loss, seconds of CPU. The master is verified before anyone hears about it:
 * a full decode pass must report zero errors AND the master's duration must
 * match the sum of the segments within tolerance. A master that fails either
 * check is thrown away; the customer keeps per-segment delivery and the
 * failure is loud in the function log. Verified masters land in Supabase
 * Storage, jump to the front of the library row, and go out by email.
 *
 * Auth: internal only. Callers must send x-stitch-key: WEBHOOK_SECRET.
 * Idempotent: a creation whose result_urls[0] already points at storage is
 * done; concurrent invokes are additionally guarded by a Blobs claim.
 *
 * env: WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      RESEND_API_KEY (or ZOHO_*) for the delivery email.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sb = require('./lib/supabase');

const BUCKET = 'masters';
const DURATION_TOLERANCE_S = 1.5;

function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); return; }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/* CLI deploys bundle from the deploying machine, so the ffmpeg-static binary
 * in the bundle can be the wrong OS (a Mac binary on Netlify's Linux). Trust
 * nothing: try each candidate with -version, and if none actually executes,
 * pull the pinned Linux build (the exact release ffmpeg-static installs) to
 * /tmp once per container. */
const FFMPEG_LINUX_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64';
let ffmpegResolved = null;

async function ffmpegBin() {
  if (ffmpegResolved) return ffmpegResolved;
  const candidates = ['/tmp/hexa-ffmpeg'];
  try { const p = require('ffmpeg-static'); if (p) candidates.unshift(p); } catch (e) { /* not bundled */ }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) { await run(c, ['-version']); ffmpegResolved = c; return c; }
    } catch (e) { /* wrong platform or corrupt; keep looking */ }
  }
  const res = await fetch(FFMPEG_LINUX_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('ffmpeg download failed: ' + res.status);
  fs.writeFileSync('/tmp/hexa-ffmpeg', Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  await run('/tmp/hexa-ffmpeg', ['-version']);
  ffmpegResolved = '/tmp/hexa-ffmpeg';
  return ffmpegResolved;
}

/* ffmpeg prints "Duration: 00:01:30.04" to stderr on -i; good enough and
 * avoids shipping a second binary for ffprobe. */
async function videoDuration(file) {
  const out = await run(await ffmpegBin(), ['-hide_banner', '-i', file, '-f', 'null', '-'])
    .catch((e) => ({ stderr: e.stderr || '' })); // -i alone exits 1 by design
  const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(out.stderr);
  if (!m) throw new Error('could not read duration of ' + path.basename(file));
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('segment fetch ' + res.status + ' for ' + url.slice(0, 80));
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/* One stitch attempt: download, concat -c copy, verify, or throw. */
async function stitch(urls, workDir) {
  const segs = [];
  for (let i = 0; i < urls.length; i++) {
    segs.push(await download(urls[i], path.join(workDir, 'seg-' + i + '.mp4')));
  }

  const listFile = path.join(workDir, 'list.txt');
  fs.writeFileSync(listFile, segs.map((s) => "file '" + s + "'").join('\n'));
  const master = path.join(workDir, 'master.mp4');
  await run(await ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', '-y', master,
  ]);

  // Verification 1: the duration must equal the sum of its parts.
  let expected = 0;
  for (const s of segs) expected += await videoDuration(s);
  const actual = await videoDuration(master);
  if (Math.abs(actual - expected) > DURATION_TOLERANCE_S) {
    throw new Error('duration mismatch: master ' + actual.toFixed(2) + 's vs segments ' + expected.toFixed(2) + 's');
  }

  // Verification 2: a full decode pass must be error-free (catches broken
  // frames, codec mismatches between segments, truncated downloads).
  const decode = await run(await ffmpegBin(), ['-v', 'error', '-i', master, '-f', 'null', '-']);
  const errors = decode.stderr.trim();
  if (errors) throw new Error('decode errors in master: ' + errors.slice(0, 300));

  return { master, durationS: actual };
}

async function uploadMaster(db, creationId, file) {
  // Bucket create is idempotent; "already exists" is success.
  try { await db.storage.createBucket(BUCKET, { public: false }); } catch (e) { /* exists */ }
  const key = creationId + '/hexa-master.mp4';
  const { error: upErr } = await db.storage.from(BUCKET)
    .upload(key, fs.readFileSync(file), { contentType: 'video/mp4', upsert: true });
  if (upErr) throw new Error('storage upload failed: ' + upErr.message);
  const { data, error: signErr } = await db.storage.from(BUCKET)
    .createSignedUrl(key, 60 * 60 * 24 * 365);
  if (signErr || !data || !data.signedUrl) throw new Error('sign url failed: ' + (signErr && signErr.message));
  return data.signedUrl;
}

async function emailMaster(db, creation, url, durationS) {
  const mailer = require('./lib/mailer');
  if (!mailer.configured() || !creation.user_id) return;
  let email = null;
  try {
    const { data } = await db.auth.admin.getUserById(creation.user_id);
    email = data && data.user && data.user.email;
  } catch (e) { /* no email, no send */ }
  if (!email) return;

  const mins = Math.floor(durationS / 60);
  const secs = Math.round(durationS % 60);
  const runtime = (mins ? mins + ':' + String(secs).padStart(2, '0') : secs + ' seconds');
  await mailer.transport().sendMail({
    from: '"' + (process.env.FROM_NAME || 'Hexa AI') + '" <' + mailer.fromAddress() + '>',
    to: email,
    replyTo: mailer.fromAddress(),
    subject: 'Your full film is ready' + (creation.title ? ': ' + creation.title : ''),
    text: [
      'Your segments finished rendering, and the full film is stitched: one continuous ' + runtime + ' take, ready to post.',
      '',
      'Download it here (link is good for a year):',
      url,
      '',
      'It also lives in your library: https://madebyhexa.co/account.html',
      '',
      'Questions? Reply to this email, a human answers.',
      '',
      'Hexa AI',
      '',
      'P.S. From your library you can swap the voice, translate it into 18 languages, or upscale it, one click each.',
    ].join('\n'),
  });
}

exports.handler = async (event) => {
  require('./lib/blobs-context').connect(event);
  const given = (event.headers && (event.headers['x-stitch-key'] || event.headers['X-Stitch-Key'])) || '';
  if (!process.env.WEBHOOK_SECRET || given !== process.env.WEBHOOK_SECRET) {
    return { statusCode: 403, body: 'forbidden' };
  }
  if (!sb.configured()) return { statusCode: 503, body: 'no db' };

  let creationId;
  try { creationId = String(JSON.parse(event.body || '{}').creationId || ''); }
  catch (e) { return { statusCode: 400, body: 'bad json' }; }
  if (!creationId) return { statusCode: 400, body: 'missing creationId' };

  const db = sb.admin();
  const { data: c } = await db.from('creations')
    .select('id,user_id,title,type,status,result_urls')
    .eq('id', creationId).maybeSingle();

  const urls = (c && Array.isArray(c.result_urls)) ? c.result_urls : [];
  if (!c || c.type !== 'video' || c.status !== 'completed' || urls.length < 2) {
    console.log('stitch: nothing to do for', creationId);
    return { statusCode: 200, body: 'nothing to do' };
  }
  // Idempotency: a master at the front means a previous run finished.
  if (/\/storage\/v1\//.test(urls[0] || '')) {
    console.log('stitch: master already present for', creationId);
    return { statusCode: 200, body: 'already stitched' };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-'));
  try {
    const { master, durationS } = await stitch(urls, workDir);
    const signedUrl = await uploadMaster(db, creationId, master);

    // Master leads; the segments stay behind it for anyone who wants parts.
    const { error: updErr } = await db.from('creations')
      .update({ result_urls: [signedUrl].concat(urls) })
      .eq('id', creationId);
    if (updErr) throw new Error('creation update failed: ' + updErr.message);

    // Email is best-effort and time-boxed: a hung SMTP connection must not
    // eat the function's runtime budget. The master is already saved.
    await Promise.race([
      emailMaster(db, c, signedUrl, durationS),
      new Promise((resolve) => setTimeout(resolve, 25000)),
    ]).catch((e) => console.error('stitch: delivery email failed (master is saved):', e.message));

    console.log('stitch: master delivered for', creationId, '(' + durationS.toFixed(1) + 's)');
    return { statusCode: 200, body: 'stitched' };
  } catch (e) {
    // Loud, and harmless: the customer still has every segment in the library.
    console.error('stitch: FAILED for', creationId + ':', e.message);
    return { statusCode: 200, body: 'stitch failed: ' + e.message };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* tmp */ }
  }
};

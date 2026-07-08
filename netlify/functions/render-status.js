'use strict';

/*
 * Poll endpoint for render.html.
 *
 * GET ?jobs=id1,id2,...  (also accepts legacy ?job=id)
 *
 * Aggregates every segment job and answers in the shape render.js expects:
 *   { status: 'in_progress'|'completed'|'failed',
 *     step: 'research'|'brief'|'generate'|'finish',
 *     pct: 0..100,
 *     result: { url, type, urls: [segment urls in order] } }   when completed
 */

const hf = require('./lib/hf');

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

const DONE = ['completed'];
const DEAD = ['failed', 'canceled', 'cancelled', 'nsfw', 'error'];

exports.handler = async (event) => {
  if (!hf.configured()) return json(503, { error: 'generation backend not configured' });

  const q = event.queryStringParameters || {};
  const ids = String(q.jobs || q.job || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!ids.length) return json(400, { error: 'missing jobs' });

  try {
    const jobs = await Promise.all(ids.map(function (id) { return hf.getJob(id); }));

    const failed = jobs.find(function (j) { return DEAD.indexOf(String(j.status)) >= 0; });
    if (failed) {
      return json(200, { status: 'failed', message: 'Segment render failed (' + failed.status + '). No charge stands for a failed render.' });
    }

    const done = jobs.filter(function (j) { return DONE.indexOf(String(j.status)) >= 0; });
    if (done.length === jobs.length) {
      const urls = jobs.map(function (j) { return j.result_url; });
      const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(urls[0] || '');
      return json(200, {
        status: 'completed',
        step: 'finish',
        pct: 100,
        result: {
          url: urls[0],
          urls: urls,
          type: isVideo ? 'video' : 'image',
          thumbnail: jobs[0].thumbnail_url || null,
        },
      });
    }

    // in flight: queued jobs sit in 'brief', running ones in 'generate'
    const running = jobs.some(function (j) { return String(j.status) === 'in_progress'; });
    const pct = Math.round(10 + (done.length / jobs.length) * 80 + (running ? 8 : 0));
    return json(200, {
      status: 'in_progress',
      step: running || done.length ? 'generate' : 'brief',
      pct: Math.min(94, pct),
      segmentsDone: done.length,
      segmentsTotal: jobs.length,
    });
  } catch (e) {
    return json(502, { error: String(e.message), detail: e.detail || null });
  }
};

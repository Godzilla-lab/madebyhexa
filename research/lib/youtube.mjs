/*
 * YouTube comment mining via yt-dlp. No API key, no quota.
 *
 * Verified 2026-08-13: `ytsearch5:<query>` returns ids + view counts with no
 * credentials, and this repo already proves the comment side works
 * (comments/_pull.sh pulled 3,645 comments across 30 videos).
 *
 * Review and unboxing comment sections are unusually rich in purchase-objection
 * language -- people say why they did NOT buy, which is the hardest signal to
 * get anywhere else.
 *
 * IMPORTANT: yt-dlp is slow (tens of seconds per video). In production this
 * belongs in the harvester, never in a user's request path. The CLI runs it
 * inline because Phase 1 is about judging output quality, not latency.
 */

import { execFile } from 'node:child_process';

const YTDLP = ['-m', 'yt_dlp'];

function run(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'python3',
      [...YTDLP, ...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout || ''), err })
    );
  });
}

export async function available() {
  const { ok } = await run(['--version'], { timeoutMs: 20000 });
  return ok;
}

/*
 * Search without an API key. Returns newest-first by relevance as YouTube
 * ranks it; we re-sort by views because a 2M-view review has a far richer
 * comment section than a 200-view one.
 */
export async function searchVideos(query, { limit = 6 } = {}) {
  const { ok, stdout } = await run([
    '--flat-playlist',
    '--no-warnings',
    '--print', '%(id)s\t%(title)s\t%(view_count)s',
    `ytsearch${limit}:${query}`,
  ]);
  if (!ok) return [];

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line.includes('\t'))
    .map((line) => {
      const [id, title, views] = line.split('\t');
      return { id, title: (title || '').slice(0, 200), views: Number(views) || 0 };
    })
    .filter((v) => v.id && /^[\w-]{11}$/.test(v.id))
    .sort((a, b) => b.views - a.views);
}

/*
 * Pull top comments for one video. `max_comments=N,N,0` asks yt-dlp for N top
 * comments and no replies, which is the right trade: top-level comments carry
 * the opinion, replies are mostly argument.
 */
export async function fetchComments(videoId, { max = 120, minChars = 40 } = {}) {
  const { ok, stdout } = await run([
    '--skip-download',
    '--no-warnings',
    '--write-comments',
    '--extractor-args', `youtube:max_comments=${max},${max},0;comment_sort=top`,
    '--print', '%()j',
    `https://www.youtube.com/watch?v=${videoId}`,
  ], { timeoutMs: 180000 });

  if (!ok || !stdout.trim()) return [];

  let info;
  try {
    info = JSON.parse(stdout.trim().split('\n').pop());
  } catch {
    return [];
  }

  const raw = Array.isArray(info.comments) ? info.comments : [];
  return raw
    .map((c) => ({
      videoId,
      body: String(c.text || '').replace(/\s+/g, ' ').trim().slice(0, 700),
      likes: Number(c.like_count) || 0,
      author: c.author || '',
    }))
    .filter((c) => c.body.length >= minChars)
    .sort((a, b) => b.likes - a.likes);
}

/*
 * Mine a category: find the review videos, then read their comment sections.
 * Sequential by design -- parallel yt-dlp invocations get throttled by YouTube
 * and the failure mode is silent empty results.
 */
export async function mineCategory(queries, { videosPerQuery = 3, commentsPerVideo = 100, maxVideos = 6 } = {}) {
  const videos = [];
  const seen = new Set();

  for (const q of queries) {
    const found = await searchVideos(q, { limit: videosPerQuery });
    for (const v of found) {
      if (seen.has(v.id) || videos.length >= maxVideos) continue;
      seen.add(v.id);
      videos.push({ ...v, matchedQuery: q });
    }
    if (videos.length >= maxVideos) break;
  }

  const comments = [];
  for (const v of videos) {
    const got = await fetchComments(v.id, { max: commentsPerVideo });
    for (const c of got) comments.push({ ...c, videoTitle: v.title });
  }

  return { videos, comments };
}

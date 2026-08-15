/*
 * Retrieval shapes to corpus documents.
 *
 * Split out of corpus.mjs, which opens SQLite at module scope. Both the CLI and
 * the Netlify worker need these builders, but the worker stores its corpus in
 * Postgres and must never pull node:sqlite into its bundle. The functions
 * themselves are pure and have no dependencies at all, so they belong here
 * rather than behind a database driver.
 */

/*
 * Stable id for a body of text that has no public id of its own.
 *
 * djb2, not a cryptographic hash: this only has to be deterministic and cheap,
 * because its whole job is to let the same comment harvested twice collide on
 * the corpus's unique index instead of being stored again.
 */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function redditDocs(posts, comments) {
  const out = [];
  for (const p of posts) {
    out.push({
      source: 'reddit', kind: 'post', externalId: p.id, channel: p.subreddit,
      text: p.body ? `${p.title}\n\n${p.body}` : p.title,
      score: p.score, url: p.url, createdUtc: p.created,
    });
  }
  for (const c of comments) {
    const post = posts.find((p) => p.id === c.postId);
    out.push({
      source: 'reddit', kind: 'comment',
      // Comments have no stable public id here, so hash the body against the post.
      externalId: `${c.postId}:${hash(c.body)}`,
      channel: post ? post.subreddit : '',
      text: c.body, score: c.score,
      url: post ? post.url : '', createdUtc: 0,
    });
  }
  return out;
}

export function youtubeDocs(comments) {
  return comments.map((c) => ({
    source: 'youtube', kind: 'comment',
    externalId: `${c.videoId}:${hash(c.body)}`,
    channel: c.videoTitle || '',
    text: c.body, score: c.likes,
    url: `https://www.youtube.com/watch?v=${c.videoId}`, createdUtc: 0,
  }));
}

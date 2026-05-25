import axios from 'axios';

// ── 404 cache: tweets that returned 404 are cached for 24h to prevent retry spam ─────
const dead404Cache = new Map();        // key: tweet status URL, value: ts of 404
const DEAD_TTL_MS = 24 * 3600 * 1000;
function isDead(url) {
  const at = dead404Cache.get(url);
  if (!at) return false;
  if (Date.now() - at > DEAD_TTL_MS) { dead404Cache.delete(url); return false; }
  return true;
}
function markDead(url) {
  dead404Cache.set(url, Date.now());
  // Cap cache size to avoid unbounded growth
  if (dead404Cache.size > 5000) {
    const oldest = [...dead404Cache.entries()].sort((a, b) => a[1] - b[1]).slice(0, 1000);
    for (const [k] of oldest) dead404Cache.delete(k);
  }
}

function extractTweetUrl(input) {
  const urls = [
    input?.twitter,
    input?.twitter_username,
    input?.link?.twitter_username,
  ].filter(Boolean).map(String);
  const raw = urls.find(url => /(?:^|\/)status\/\d+/.test(url)) || '';
  if (!raw) return null;
  if (raw.startsWith('i/') || raw.startsWith('communities/')) return null;
  if (raw.startsWith('http')) return raw.replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://x.com');
  return `https://x.com/${raw.replace(/^@/, '')}`;
}

function toFxTwitter(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://fxtwitter.com')
    .replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://fxtwitter.com');
}
function toFxTwitterApi(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://api.fxtwitter.com')
    .replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://api.fxtwitter.com');
}
function toVxTwitterApi(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://api.vxtwitter.com')
    .replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://api.vxtwitter.com');
}
function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractTweetTextFromFx(data) {
  if (!data) return null;
  if (typeof data === 'object') return data.tweet?.text || data.text || null;
  const ogDescription = data.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1]
    || data.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i)?.[1];
  if (ogDescription) return decodeHtmlEntities(ogDescription).trim();
  const title = data.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? decodeHtmlEntities(title.replace(/\s+/g, ' ')).trim() : null;
}

function extractTweetMetricsFromFx(data) {
  const tweet = data?.tweet || data;
  if (!tweet || typeof tweet !== 'object') return null;
  return {
    likes: Number(tweet.likes ?? tweet.likeCount ?? 0),
    retweets: Number(tweet.retweets ?? tweet.reposts ?? tweet.retweetCount ?? 0),
    replies: Number(tweet.replies ?? tweet.replyCount ?? 0),
    quotes: Number(tweet.quotes ?? tweet.quoteCount ?? 0),
    bookmarks: Number(tweet.bookmarks ?? 0),
    views: tweet.views == null ? null : Number(tweet.views),
    createdAt: tweet.created_at || tweet.date || null,
    createdTimestamp: tweet.created_timestamp || tweet.date_epoch || null,
    authorFollowers: tweet.author?.followers == null ? null : Number(tweet.author.followers),
    authorVerified: Boolean(tweet.author?.verification?.verified || tweet.author?.verified),
    authorScreenName: tweet.author?.screen_name || tweet.user_screen_name || null,
  };
}

// vxtwitter returns slightly different shape — normalize to match fxtwitter
function extractTweetFromVx(data) {
  if (!data || typeof data !== 'object') return { text: null, metrics: null };
  const text = data.text || null;
  const metrics = {
    likes: Number(data.likes ?? 0),
    retweets: Number(data.retweets ?? 0),
    replies: Number(data.replies ?? 0),
    quotes: Number(data.quotes ?? 0),
    bookmarks: 0,
    views: null,
    createdAt: data.date || null,
    createdTimestamp: data.date_epoch || null,
    authorFollowers: null,
    authorVerified: false,
    authorScreenName: data.user_screen_name || null,
  };
  return { text, metrics };
}

function viralityScore(metrics) {
  if (!metrics) return null;
  const views = Number(metrics.views || 0);
  const followers = Number(metrics.authorFollowers || 0);
  const engagement = Number(metrics.likes || 0)
    + Number(metrics.retweets || 0) * 2
    + Number(metrics.quotes || 0) * 2
    + Number(metrics.replies || 0);
  return {
    engagement,
    engagementPerView: views > 0 ? engagement / views * 100 : null,
    engagementPerFollower: followers > 0 ? engagement / followers * 100 : null,
  };
}

async function tryFxApi(url) {
  const apiUrl = toFxTwitterApi(url);
  const res = await axios.get(apiUrl, {
    timeout: 8000,
    headers: { Accept: 'application/json' },
    validateStatus: s => s < 500, // treat 4xx as resolved so we can read body
  });
  if (res.status === 404) { const e = new Error('404'); e.code = 404; throw e; }
  if (res.status >= 400)  { const e = new Error(`status ${res.status}`); e.code = res.status; throw e; }
  return {
    apiUrl,
    text: extractTweetTextFromFx(res.data),
    metrics: extractTweetMetricsFromFx(res.data),
    source: 'fxtwitter',
  };
}

async function tryVxApi(url) {
  const apiUrl = toVxTwitterApi(url);
  const res = await axios.get(apiUrl, {
    timeout: 8000,
    headers: { Accept: 'application/json' },
    validateStatus: s => s < 500,
  });
  if (res.status === 404) { const e = new Error('404'); e.code = 404; throw e; }
  if (res.status >= 400)  { const e = new Error(`status ${res.status}`); e.code = res.status; throw e; }
  const parsed = extractTweetFromVx(res.data);
  return { apiUrl, text: parsed.text, metrics: parsed.metrics, source: 'vxtwitter' };
}

async function tryFxHtml(url) {
  const fxUrl = toFxTwitter(url);
  const res = await axios.get(fxUrl, {
    timeout: 8000,
    headers: { Accept: 'text/html,application/json' },
    validateStatus: s => s < 500,
  });
  if (res.status === 404) { const e = new Error('404'); e.code = 404; throw e; }
  if (res.status >= 400)  { const e = new Error(`status ${res.status}`); e.code = res.status; throw e; }
  return {
    fxUrl,
    text: extractTweetTextFromFx(res.data),
    metrics: extractTweetMetricsFromFx(res.data),
    source: 'fxtwitter_html',
  };
}

export async function fetchTwitterNarrative(graduatedCoin, gmgn) {
  const url = extractTweetUrl(graduatedCoin) || extractTweetUrl(gmgn);
  if (!url) return null;

  // Skip URLs known dead in last 24h (deleted tweets / suspended accounts).
  if (isDead(url)) return { url, fxUrl: toFxTwitter(url), text: null, dead: true };

  // Try fxtwitter api → vxtwitter api → fxtwitter html (fallback chain).
  const attempts = [tryFxApi, tryVxApi, tryFxHtml];
  for (const fn of attempts) {
    try {
      const r = await fn(url);
      if (r.text || r.metrics) {
        return {
          url,
          fxUrl: toFxTwitter(url),
          text: r.text,
          metrics: r.metrics,
          virality: viralityScore(r.metrics),
          source: r.source,
        };
      }
    } catch (err) {
      // 404 from any provider → cache and stop trying (tweet is gone everywhere)
      if (err.code === 404 || /404/.test(err.message)) {
        markDead(url);
        return { url, fxUrl: toFxTwitter(url), text: null, dead: true };
      }
      // Other errors (timeout, network, 5xx) → try next provider
      // Suppress per-attempt log; only log final failure below
    }
  }

  // All attempts failed for non-404 reasons (network/timeout).
  console.log(`[twitter] all providers failed: ${url}`);
  return { url, fxUrl: toFxTwitter(url), text: null, error: 'all_providers_failed' };
}

export {
  extractTweetUrl, toFxTwitter, toFxTwitterApi, toVxTwitterApi,
  extractTweetTextFromFx, extractTweetMetricsFromFx, viralityScore,
  isDead, markDead,
};

// lib/xlink-standard.js — used by xtracking.js (root)
// Extracted verbatim from the bot source so tests exercise the real
// production logic instead of a separate reimplementation.
// Do not edit here without also updating the bot file(s) that require it,
// or vice versa.

const axios = require('axios');

const extractUsernameFromXLink = async (url) => {
  if (!url || typeof url !== "string") return null;

  const cleanUsername = (u) => {
    if (!u) return null;
    u = u.toLowerCase().trim();

    const banned = [
      "i", "intent", "imprint", "imprint.html", "privacy",
      "privacy.html", "status", "home", "tos", "tos.html"
    ];

    if (banned.includes(u)) return null;
    if (!/^[a-z0-9_]{1,25}$/i.test(u)) return null;

    return u;
  };

  // ✅ ONLY extract Tweet ID (nothing else)
  const idMatch =
    url.match(/\/status\/(\d+)/i) ||
    url.match(/\/i\/status\/(\d+)/i);

  if (!idMatch) return null;

  const tweetId = idMatch[1];

  // ===============================
  // 1️⃣ Twitter oEmbed (author_url)
  // ===============================
  try {
    const r = await axios.get(
      `https://publish.twitter.com/oembed?url=https://twitter.com/i/status/${tweetId}`,
      { timeout: 6000 }
    );

    const match = r.data?.author_url?.match(/twitter\.com\/([^\/]+)/i);
    const valid = cleanUsername(match?.[1]);
    if (valid) return valid;
  } catch {}

  // ==================================
  // 2️⃣ Syndication API (screen_name)
  // ==================================
  try {
    const r = await axios.get(
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}`,
      { timeout: 6000 }
    );

    const valid = cleanUsername(r.data?.user?.screen_name);
    if (valid) return valid;
  } catch {}

  return null;
};

const isXLink = (text) => {
  if (!text || typeof text !== 'string') return false;
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/.+/i.test(text);
};

module.exports = { extractUsernameFromXLink, isXLink };

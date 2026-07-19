// lib/xlink-advanced.js — used by xtracking/xtracking.js
// Extracted verbatim from the bot source so tests exercise the real
// production logic instead of a separate reimplementation.
// Do not edit here without also updating the bot file(s) that require it,
// or vice versa.

const axios = require('axios');

const extractUsernameFromXLink = async (url) => {
  if (!url || typeof url !== "string") return null;

  // Validate + sanitize username
  const cleanUsername = (u) => {
    if (!u) return null;
    u = u.toLowerCase().trim();

    const banned = [
      "i",
      "intent",
      "imprint",
      "imprint.html",
      "privacy",
      "privacy.html",
      "status",
      "home",
      "tos",
      "tos.html"
    ];

    if (banned.includes(u)) return null;
    if (u.includes("imprint") || u.includes("privacy") || u.includes("html"))
      return null;

    // Only accept valid usernames
    if (!/^[a-z0-9_]{1,25}$/i.test(u)) return null;

    return u;
  };

  // -------------------------
  // METHOD 1: Direct URL extraction
  // -------------------------
  const directPatterns = [
    /x\.com\/([^\/]+)\/status\/\d+/i,
    /twitter\.com\/([^\/]+)\/status\/\d+/i,
    /x\.com\/([^\/?#]+)/i,
    /twitter\.com\/([^\/?#]+)/i,
    /x\.com\/([^\/]+)$/i
  ];

  for (const p of directPatterns) {
    const m = url.match(p);
    const valid = cleanUsername(m?.[1]);
    if (valid) return valid;
  }

  // -------------------------
  // Detect tweet ID
  // -------------------------
  const matchId = url.match(/\/status\/(\d+)/i) || url.match(/\/i\/status\/(\d+)/i);
  if (!matchId) return null;
  const tweetId = matchId[1];

  // -------------------------
  // METHOD 2: oEmbed
  // -------------------------
  try {
    const r = await axios.get(
      `https://publish.twitter.com/oembed?url=https://twitter.com/i/status/${tweetId}`,
      { timeout: 6000 }
    );
    const m = r.data?.author_url?.match(/twitter\.com\/([^\/]+)/i);
    const valid = cleanUsername(m?.[1]);
    if (valid) return valid;
  } catch {}

  // -------------------------
  // METHOD 3: Syndication API
  // -------------------------
  try {
    const r = await axios.get(
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}`,
      { timeout: 6000 }
    );
    const valid = cleanUsername(r.data?.user?.screen_name);
    if (valid) return valid;
  } catch {}

  // -------------------------
  // METHOD 4: HTML full fetch + meta scan
  // -------------------------
  let html = "";
  try {
    const h = await axios.get(`https://twitter.com/i/status/${tweetId}`, {
      timeout: 7000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    html = h.data;
  } catch {}

  if (html) {
    const patterns = [
      /"screen_name":"([^"]+)"/i,
      /"userScreenName":"([^"]+)"/i,
      /twitter\.com\/([^\/"]+)/i,
      /content="https:\/\/twitter\.com\/([^\/"]+)/i
    ];
    for (const p of patterns) {
      const m = html.match(p);
      const valid = cleanUsername(m?.[1]);
      if (valid) return valid;
    }
  }

  // -------------------------
  // METHOD 5: Extract embedded Tweet JSON
  // -------------------------
  if (html) {
    const jsonMatch = html.match(/<script[^>]*>window\.__INITIAL_STATE__=(\{.*?\})<\/script>/i);
    if (jsonMatch) {
      try {
        const json = JSON.parse(jsonMatch[1]);
        const candidates = [
          json?.tweet?.core?.user?.screen_name,
          json?.globalObjects?.users,
        ];

        for (const c of candidates) {
          if (!c) continue;
          if (typeof c === "string") {
            const valid = cleanUsername(c);
            if (valid) return valid;
          } else if (typeof c === "object") {
            for (const k in c) {
              const valid = cleanUsername(c[k]?.screen_name);
              if (valid) return valid;
            }
          }
        }
      } catch {}
    }
  }

  // -------------------------
  // METHOD 6: Parse any JSON inside <script> tags
  // -------------------------
  if (html) {
    const scriptJsons = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of scriptJsons) {
      try {
        const potential = block.match(/"screen_name":"([^"]+)"/i);
        const valid = cleanUsername(potential?.[1]);
        if (valid) return valid;
      } catch {}
    }
  }

  // -------------------------
  // METHOD 7: Look for profile image URLs (they contain the username)
  // -------------------------
  if (html) {
    const imgMatch = html.match(/https:\/\/pbs\.twimg\.com\/profile_images\/[^\/]+\/([^\/_]+)[._]/i);
    const valid = cleanUsername(imgMatch?.[1]);
    if (valid) return valid;
  }

  // -------------------------
  // METHOD 8: Look for creator tag (OpenGraph)
  // -------------------------
  if (html) {
    const ogMatch = html.match(/property="og:site_name" content="([^"]+)"/i);
    const valid = cleanUsername(ogMatch?.[1]);
    if (valid) return valid;
  }

  // -------------------------
  // METHOD 9: Extract username from canonical link
  // -------------------------
  if (html) {
    const canonical = html.match(/<link rel="canonical" href="https:\/\/twitter\.com\/([^\/"]+)/i);
    const valid = cleanUsername(canonical?.[1]);
    if (valid) return valid;
  }

  // -------------------------
  // METHOD 10: Extract from user ID mapping (hidden payloads)
  // -------------------------
  if (html) {
    const userJson = html.match(/"users":\{(.*?)\}/is);
    if (userJson) {
      try {
        const jas = JSON.parse(`{"users":{${userJson[1]}}}`);
        for (const uid in jas.users) {
          const valid = cleanUsername(jas.users[uid]?.screen_name);
          if (valid) return valid;
        }
      } catch {}
    }
  }

  // NOTHING WORKED → return null
  return null;
};

const isXLink = (text) => {
  if (!text || typeof text !== 'string') return false;
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/.+/i.test(text);
};

module.exports = { extractUsernameFromXLink, isXLink };

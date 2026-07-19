// lib/xlink-basic.js — shared by alpha/alpha.js, elite/alpha.js, xlike/xlike.js
// Extracted verbatim from the bot source so tests exercise the real
// production logic instead of a separate reimplementation.
// Do not edit here without also updating the bot file(s) that require it,
// or vice versa.

const axios = require('axios');

const extractUsernameFromXLink = async (url) => {
  if (!url || typeof url !== 'string') return null;
  
  // METHOD 1: Direct extraction from URL
  const directPatterns = [
    /https?:\/\/x\.com\/([^\/]+)\/status\/[0-9]+/i,
    /https?:\/\/(?:www\.)?x\.com\/([^\/]+)/i,
    /https?:\/\/twitter\.com\/([^\/]+)\/status\/[0-9]+/i,
    /https?:\/\/(?:www\.)?twitter\.com\/([^\/]+)/i
  ];
  
  for (const pattern of directPatterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      const username = match[1].toLowerCase();
      // Skip shortened links - we'll handle them separately
      if (username === 'i' || username === 'intent') {
        break; // Exit loop and try other methods
      }
      return username;
    }
  }
  
  // METHOD 2: If it's a shortened link, try to extract tweet ID
  const shortenedPattern = /\/i\/status\/(\d+)/i;
  const match = url.match(shortenedPattern);
  
  if (match && match[1]) {
    const tweetId = match[1];
    
    try {
      // Try using Twitter's oEmbed API (more reliable)
      const oembedUrl = `https://publish.twitter.com/oembed?url=https://twitter.com/i/status/${tweetId}`;
      const response = await axios.get(oembedUrl, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json'
        }
      });
      
      if (response.data && response.data.author_url) {
        const authorMatch = response.data.author_url.match(/twitter\.com\/([^\/]+)/i);
        if (authorMatch && authorMatch[1]) {
          return authorMatch[1].toLowerCase();
        }
      }
    } catch (error) {
      console.log('oEmbed method failed:', error.message);
    }
    
    try {
      // METHOD 3: Try using Twitter's syndication API (no API key needed)
      const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}`;
      const response = await axios.get(syndicationUrl, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.data && response.data.user) {
        return response.data.user.screen_name.toLowerCase();
      }
    } catch (error) {
      console.log('Syndication method failed:', error.message);
    }
    
    try {
      // METHOD 4: Try to fetch the page and parse HTML
      const htmlResponse = await axios.get(`https://twitter.com/i/status/${tweetId}`, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const html = htmlResponse.data;
      
      // Try to find username in meta tags
      const metaPatterns = [
        /"screen_name":"([^"]+)"/i,
        /"userScreenName":"([^"]+)"/i,
        /twitter\.com\/([^\/"]+)/i,
        /content="https:\/\/twitter\.com\/([^\/"]+)/i
      ];
      
      for (const pattern of metaPatterns) {
        const metaMatch = html.match(pattern);
        if (metaMatch && metaMatch[1] && metaMatch[1] !== 'i' && metaMatch[1] !== 'intent') {
          return metaMatch[1].toLowerCase();
        }
      }
    } catch (error) {
      console.log('HTML parsing method failed:', error.message);
    }
  }
  
  return null;
};

const isXLink = (text) => {
  if (!text || typeof text !== 'string') return false;
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/.+/i.test(text);
};

module.exports = { extractUsernameFromXLink, isXLink };

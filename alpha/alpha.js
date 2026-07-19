require('dns').setDefaultResultOrder('ipv4first');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./firebase.js');
require('dotenv').config();
const axios = require('axios');
const bot = new Telegraf(process.env.BOT_ALPHA);

// ============= CONSTANTS & CONFIGURATION =============
const BOT_STATES = {
  IDLE: 'idle',
  SLOT_OPEN: 'slot_open',
  CHECKING: 'checking',
  CLOSED: 'closed',
  LOCKED: 'locked'
};


const cronJobs = new Map();
const groupDataCache = new Map();
const PIN_INTERVAL = 20; // minutes

// ============= UTILITY FUNCTIONS =============
// ============= ALLOWED GROUPS CONFIGURATION =============
const ALLOWED_GROUP_IDS = [
-1002344338103,
-1003343502281,
-1002811980528
];
// ============= GROUP CHECK FUNCTION =============
function isGroupAllowed(groupId) {
  return ALLOWED_GROUP_IDS.includes(groupId);
}

function requireAllowedGroup(ctx, next) {
  if (!ctx.chat || ctx.chat.type === 'private') {
    return next();
  }
  
  if (!isGroupAllowed(ctx.chat.id)) {
    console.log(`Blocked access from unauthorized group: ${ctx.chat.id} - ${ctx.chat.title}`);
    return; // Silently ignore commands from unauthorized groups
  }
  
  return next();
}

async function getTargetUser(ctx) {
  const msg = ctx.message;

  // 1️⃣ If replying to a user
  if (msg.reply_to_message) {
    return msg.reply_to_message.from;
  }

  // 2️⃣ If user mentioned by username like @abc
  if (msg.entities) {
    for (let e of msg.entities) {
      if (e.type === "mention") {
        const username = msg.text.substring(e.offset + 1, e.offset + e.length); // remove @
        try {
          const user = await ctx.telegram.getChatMember(ctx.chat.id, username);
          return user.user;
        } catch (err) {}
      }
    }
  }

  // 3️⃣ If user ID or text name after command
  const parts = msg.text.split(" ");
  if (parts[1]) {
    const id = parts[1].replace("@", "");

    try {
      const user = await ctx.telegram.getChatMember(ctx.chat.id, id);
      return user.user;
    } catch (err) {
      return null;
    }
  }

  return null;
}

async function muteAllUsers(ctx, groupData, groupId) {
  let mutedCount = 0;
  const failedMutes = [];

  // Mute scam users
  for (const [uid, userData] of groupData.scamUsers.entries()) {
    const success = await muteUser(ctx, groupData, uid, userData.xUsername, 2 * 24 * 60);
    if (success) mutedCount++;
    else failedMutes.push(userData.tgUsername || uid);
  }

  // Mute SR users
  for (const [number, data] of groupData.srList.entries()) {
    const linkData = groupData.userLinks.get(data.userId);
    const xUsername = linkData ? linkData.xUsername : null;
    const success = await muteUser(ctx, groupData, data.userId, xUsername, 2 * 24 * 60);
    if (success) mutedCount++;
    else failedMutes.push(data.tgUsername || data.userId);
  }

  await saveGroupData(groupId, groupData);

  return { mutedCount, failedMutes };
}

  
  // Direct extractio

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

const isBotOwner = (userId) => {
  const ownerId = process.env.BOT_OWNER_ID;
  return ownerId && userId.toString() === ownerId.toString();
};

const isAdmin = async (ctx, userId) => {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return member.status === 'administrator' || member.status === 'creator';
  } catch (error) {
    console.error('Admin check error:', error);
    return false;
  }
};

const cleanupExpiredMutes = (groupData) => {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000));
  
  for (const [xUsername, muteData] of groupData.mutedXUsernames.entries()) {
    if (new Date(muteData.mutedAt) < twoDaysAgo) {
      groupData.mutedXUsernames.delete(xUsername);
    }
  }
};

// ============= DATABASE FUNCTIONS =============
// ============= LINK STORAGE FUNCTIONS =============
const getTrackingLink = async () => {
  try {
    const doc = await db.collection('config').doc('tracking_link').get();
    if (doc.exists) {
      return doc.data().link || 'https://x.com/always_alpha007';
    }
    return 'https://x.com/always_alpha007'; // Default
  } catch (error) {
    console.error('Error getting tracking link:', error);
    return 'https://x.com/always_alpha007';
  }
};

const setTrackingLink = async (link) => {
  try {
    await db.collection('config').doc('tracking_link').set({
      link: link,
      updatedAt: new Date()
    }, { merge: true });
    return true;
  } catch (error) {
    console.error('Error setting tracking link:', error);
    return false;
  }
};
const getGroupData = async (groupId) => {
  // Check cache first
  if (groupDataCache.has(groupId)) {
    return groupDataCache.get(groupId);
  }

  try {
    const doc = await db.collection('groups').doc(groupId.toString()).get();
    if (doc.exists) {
      const data = doc.data();
      // Convert to Maps
      const processedData = {
        ...data,
        state: data.state || BOT_STATES.IDLE,
        userLinks: new Map(Object.entries(data.userLinks || {})),
        safeUsers: new Map(Object.entries(data.safeUsers || {})),
        scamUsers: new Map(Object.entries(data.scamUsers || {})),
        srList: new Map(Object.entries(data.srList || {})),
        mutedUsers: new Map(Object.entries(data.mutedUsers || {})),
        mutedXUsernames: new Map(Object.entries(data.mutedXUsernames || {})),
        linkCount: data.linkCount || 0,
        srCounter: data.srCounter || 1,
        createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date(),
        currentPinnedMessageId: data.currentPinnedMessageId || null
      };
      
      // Cache the data
      groupDataCache.set(groupId, processedData);
      return processedData;
    }
    
    // Return default data if doesn't exist
    const defaultData = getDefaultGroupData();
    groupDataCache.set(groupId, defaultData);
    return defaultData;
  } catch (error) {
    console.error('Error getting group data:', error);
    const defaultData = getDefaultGroupData();
    groupDataCache.set(groupId, defaultData);
    return defaultData;
  }
};

const saveGroupData = async (groupId, data) => {
  try {
    const firebaseData = {
      state: data.state,
      userLinks: Object.fromEntries(data.userLinks),
      safeUsers: Object.fromEntries(data.safeUsers),
      scamUsers: Object.fromEntries(data.scamUsers),
      srList: Object.fromEntries(data.srList),
      mutedUsers: Object.fromEntries(data.mutedUsers),
      mutedXUsernames: Object.fromEntries(data.mutedXUsernames),
      linkCount: data.linkCount,
      srCounter: data.srCounter,
      currentPinnedMessageId: data.currentPinnedMessageId,
      createdAt: data.createdAt,
      updatedAt: new Date().toISOString()  
    };

    await db.collection('groups').doc(groupId.toString()).set(firebaseData, { merge: true });
    
    // Update cache
    groupDataCache.set(groupId, data);
  } catch (error) {
    console.error('Error saving group data:', error);
  }
};

const getDefaultGroupData = () => {
  return {
    state: BOT_STATES.IDLE,
    userLinks: new Map(),
    safeUsers: new Map(),
    scamUsers: new Map(),
    srList: new Map(),
    mutedUsers: new Map(),
    mutedXUsernames: new Map(),
    linkCount: 0,
    srCounter: 1,
    currentPinnedMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
};

// ============= USER MANAGEMENT FUNCTIONS =============
const muteUser = async (ctx, groupData, userId, xUsername = null, duration = 30) => {
  const untilDate = Math.floor(Date.now() / 1000) + (duration * 60);
  
  try {
    await ctx.restrictChatMember(userId, {
      permissions: {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      },
      until_date: untilDate
    });
    
    const tgUsername = ctx.from.username || ctx.from.first_name;
    
    groupData.mutedUsers.set(userId.toString(), {
      tgUsername: tgUsername,
      until: untilDate,
      xUsername: xUsername,
      mutedAt: new Date()
    });

    if (xUsername && duration === (2 * 24 * 60)) {
      const xUsernameLower = xUsername.toLowerCase();
      groupData.mutedXUsernames.set(xUsernameLower, {
        xUsername: xUsername,
        tgUsername: tgUsername,
        mutedAt: new Date(),
        mutedBy: ctx.from.id
      });
      
      // Save to Firebase for permanent storage
      await saveMutedUserToFirebase(ctx.chat.id, xUsername, tgUsername, ctx.from.id);
    }
    
    // Delete bot's message for muted user
    const userData = groupData.userLinks.get(userId.toString());
    if (userData && userData.botMessageId) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, userData.botMessageId);
        userData.botMessageId = null;
      } catch (error) {
        console.error('Error deleting bot message for muted user:', error);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error muting user:', error);
    return false;
  }
};

const isUserMutedXUsername = async (groupId, xUsername) => {
  try {
    const doc = await db.collection('mutedUsers').doc(`${groupId}_${xUsername.toLowerCase()}`).get();
    if (doc.exists) {
      const data = doc.data();
      const expiresAt = new Date(data.expiresAt);
      if (expiresAt > new Date()) {
        return true;
      } else {
        // Delete expired mute
        await db.collection('mutedUsers').doc(`${groupId}_${xUsername.toLowerCase()}`).delete();
        return false;
      }
    }
    return false;
  } catch (error) {
    console.error('Error checking muted user:', error);
    return false;
  }
};

// ============= MESSAGE MANAGEMENT FUNCTIONS =============
const deleteBotMessage = async (ctx, groupId, userId) => {
  try {
    const groupData = await getGroupData(groupId);
    const userData = groupData.userLinks.get(userId);
    
    if (userData && userData.botMessageId) {
      await ctx.telegram.deleteMessage(groupId, userData.botMessageId);
      userData.botMessageId = null;
      await saveGroupData(groupId, groupData);
    }
  } catch (error) {
    console.error('Error deleting bot message:', error);
  }
};

// ============= CRON JOB FUNCTIONS =============
const startSlotReminderJob = (ctx, groupId) => {
  const job = cron.schedule(`*/${PIN_INTERVAL} * * * *`, async () => {
    const currentGroupData = await getGroupData(groupId);
    if (currentGroupData.state === BOT_STATES.SLOT_OPEN && !currentGroupData.locked) {
      try {
        const reminderMsg = await ctx.telegram.sendMessage(groupId, 'keep dropping your X links!');
        
        // Unpin previous message
        if (currentGroupData.currentPinnedMessageId) {
          try {
            await ctx.telegram.unpinChatMessage(groupId, currentGroupData.currentPinnedMessageId);
          } catch (error) {
            console.log('Could not unpin previous message:', error);
          }
        }
        
        // Pin new message
        await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id);
        
        // Update current pinned message ID
        currentGroupData.currentPinnedMessageId = reminderMsg.message_id;
        await saveGroupData(groupId, currentGroupData);
      } catch (error) {
        console.log('Error sending reminder:', error);
      }
    }
  });
  
  cronJobs.set(`slot_reminder_${groupId}`, job);
};

const startCheckingReminderJob = (ctx, groupId) => {
  const job = cron.schedule(`*/${PIN_INTERVAL} * * * *`, async () => {
    const currentGroupData = await getGroupData(groupId);
    if (currentGroupData.state === BOT_STATES.CHECKING && !currentGroupData.locked) {
      try {
        // Calculate remaining time
        const now = new Date();
        const deadlineDate = new Date(currentGroupData.deadline);
        const minsLeft = Math.floor((deadlineDate - now) / 60000);
        const hrs = Math.floor(minsLeft / 60);
        const mins = minsLeft % 60;
        const istDate = deadlineDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

        // Compose reminder message
        const reminderMsgText =
          `⚡ *Complete your task before deadline*\n` +
          `⏳ *Time Remaining:* ${hrs} hr ${mins} mins\n`;

        // Send reminder
        const reminderMsg = await ctx.telegram.sendMessage(groupId, reminderMsgText, { parse_mode: "Markdown" });

        // Unpin previous message if exists
        if (currentGroupData.currentPinnedMessageId) {
          try {
            await ctx.telegram.unpinChatMessage(groupId, currentGroupData.currentPinnedMessageId);
          } catch (error) {
            console.log('Could not unpin previous message:', error);
          }
        }

        // Pin new reminder message
        await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id);

        // Update current pinned message ID
        currentGroupData.currentPinnedMessageId = reminderMsg.message_id;
        await saveGroupData(groupId, currentGroupData);

      } catch (error) {
        console.log('Error sending reminder:', error);
      }
    }
  });

  cronJobs.set(`checking_reminder_${groupId}`, job);
};


const stopCronJobs = (groupId) => {
  const slotJob = cronJobs.get(`slot_reminder_${groupId}`);
  const checkingJob = cronJobs.get(`checking_reminder_${groupId}`);
  
  if (slotJob) {
    slotJob.stop();
    cronJobs.delete(`slot_reminder_${groupId}`);
  }
  
  if (checkingJob) {
    checkingJob.stop();
    cronJobs.delete(`checking_reminder_${groupId}`);
  }
};
// ============= UPDATE saveMutedUserToFirebase FUNCTION =============
const saveMutedUserToFirebase = async (groupId, xUsername, tgUsername, mutedBy, reason = '') => {
  try {
    // First, find the Telegram user ID from group data
    let tgUserId = null;
    const groupData = await getGroupData(groupId);
    
    // Search for user with this X username
    for (const [uid, userData] of groupData.userLinks.entries()) {
      if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername.toLowerCase()) {
        tgUserId = uid;
        break;
      }
    }
    
    const muteData = {
      xUsername: xUsername.toLowerCase(),
      tgUsername: tgUsername,
      tgUserId: tgUserId,
      mutedBy: mutedBy,
      reason: reason,
      mutedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString()
    };
    
    await db.collection('mutedUsers').doc(`${groupId}_${xUsername.toLowerCase()}`).set(muteData);
  } catch (error) {
    console.error('Error saving muted user to Firebase:', error);
  }
};


/// ============= BOT COMMANDS =============
bot.command(['open', 'slot', 's'], requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  if (groupData.state !== BOT_STATES.IDLE && groupData.state !== BOT_STATES.CLOSED) {
    return ctx.reply('Please end the current slot before starting a new one. Use /end first.');
  }
  
  // Clear all data except muted users
  groupData = {
    ...getDefaultGroupData(),
    mutedXUsernames: groupData.mutedXUsernames,
    mutedUsers: new Map()
  };
  
  groupData.state = BOT_STATES.SLOT_OPEN;
  groupData.locked = false;
  
  // Update group title
  try {
    const currentTitle = ctx.chat.title;
    const baseTitle = currentTitle.replace(/\s*\|\|.*/, '');
    await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || OPEN`);

  } catch (error) {
    console.log('No permission to change group name');
  }
  
  // Set permissions for slot phase
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: true,
    can_send_other_messages: false,
    can_add_web_page_previews: true,
    can_send_polls: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_change_info: false
  });
  
  await saveGroupData(groupId, groupData);


  const welcomeMsg = `🎰 Slot opened! Members can now drop their X links.\n\n` +
    `📌 Rules:\n` +
    `• Drop only ONE X link\n` +
    `• No other messages allowed\n` +
    `• Multiple links not allowed\n` +
    `• Using muted user's link will get you muted too\n\n`;
  
  const sentMessage = await ctx.reply(welcomeMsg);
  await ctx.pinChatMessage(sentMessage.message_id);
  await ctx.replyWithPhoto({ source: 'open.png' });
  
  groupData.currentPinnedMessageId = sentMessage.message_id;
  await saveGroupData(groupId, groupData);
  
  startSlotReminderJob(ctx, groupId);
});
// ============= RULES COMMAND =============
bot.command(['rl', 'rule'], requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Only admins can use /rl
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const rulesMessage = `𝙂𝙧𝙤𝙪𝙥 𝙍𝙪𝙡𝙚𝙨 & 𝙂𝙪𝙞𝙙𝙖𝙣𝙘𝙚

━━━━━━━━━━━━━━━━━━
⚠️ *Violating These Rules Will Lead To Restrictions* ⚠️
━━━━━━━━━━━━━━━━━━

1️⃣ *PROFILE MATCHING*
   Your X profile name and Telegram name must be the same

2️⃣ *ONE LINK PER SLOT*
   Only one link per slot is allowed

3️⃣ *VISIBLE PROFILE*
   Your X profile must be clearly visible in the video

4️⃣ *COMPLETE PROOF*
   Include both the starting and ending tweets of the slot ID

5️⃣ *NO CHATTING*
   Chatting strictly not allowed in the group

6️⃣ *STRICT COMPLIANCE*
   Ensure strict compliance to avoid restrictions
━━━━━━━━━━━━━━━━━━`;

  await ctx.reply(rulesMessage, { parse_mode: "Markdown" });
});
// ============= HELP COMMAND (ADMIN ONLY) =============
bot.command('help', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Only admins can use /help
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const helpMessage = `🤖 *ENGAGE BOT - ADMIN COMMAND LIST* 🤖

━━━━━━━━━━━━━━━━━━
🎰 *SLOT MANAGEMENT*
━━━━━━━━━━━━━━━━━━
• /open - Open slot phase
• /check - Start checking phase (1.5 hrs)
• /loc - Lock group immediately
• /end - End slot & clear all data

━━━━━━━━━━━━━━━━━━
📊 *VIEWING & STATS*
━━━━━━━━━━━━━━━━━━
• /total - Total links submitted
• /stats - Detailed slot statistics
• /list - All participants with X usernames
• /safe - Safe users (submitted proof)
• /scam - Scam users (no proof)
• /srlist - SR list (pending approval)
• /mutelist - Currently muted users
• /xbanlist - Banned X usernames

━━━━━━━━━━━━━━━━━━
🔍 *USER INVESTIGATION*
━━━━━━━━━━━━━━━━━━
• /link - View user's submitted X link (reply to user)
• /sr - Add user to SR list (reply to user)
• /ad [number] - Approve SR user (e.g., /ad 1)

━━━━━━━━━━━━━━━━━━
👮 *MODERATION*
━━━━━━━━━━━━━━━━━━
• /mute [duration] [reason] - Mute user
  Examples: /mute 30, /mute 2h, /mute 1d Spamming
• /unmute - Unmute user
• /ban [reason] - Ban user
• /unban - Unban user
• /muteall - Mute all scam+SR users (2 days)

━━━━━━━━━━━━━━━━━━
🐦 *X/TWITTER COMMANDS*
━━━━━━━━━━━━━━━━━━
• /xmute @xuser [duration] - Mute by X username
• /xunmute @xuser - Unmute by X username
• /xban @xuser [reason] - Ban by X username
• /xunban @xuser - Unban by X username
• /setlink <url> - Change tracking link

━━━━━━━━━━━━━━━━━━
🛠️ *UTILITIES*
━━━━━━━━━━━━━━━━━━
• /clear - Delete messages (bulk cleanup)
• /requeststats - Request system stats

━━━━━━━━━━━━━━━━━━
📝 *USAGE EXAMPLES*
━━━━━━━━━━━━━━━━━━
• /mute @username 30 Spamming
• /xmute @twitteruser 2h
• /xban @scammer Duplicate account
• /ad 3 (approves SR user #3)
• /link (reply to user to see their X link)

━━━━━━━━━━━━━━━━━━
⚠️ *IMPORTANT NOTES*
━━━━━━━━━━━━━━━━━━
• Checking phase auto-locks after 1.5 hours
• Auto-mutes scam/SR users after deadline
• X bans last 2 days (persistent)
• Admin messages are ignored by bot
• Most commands require replying to user

━━━━━━━━━━━━━━━━━━
⏰ *TIMING REFERENCE*
━━━━━━━━━━━━━━━━━━
• 30 = 30 minutes
• 2h = 2 hours
• 1d = 1 day
• 2d = 2 days (X bans)

*Type any command for specific usage help.*`;

  await ctx.reply(helpMessage, { parse_mode: "Markdown" });
});


bot.command(['loc', 'l'], requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = await getGroupData(groupId);

  if (groupData.state !== BOT_STATES.SLOT_OPEN && groupData.state !== BOT_STATES.CHECKING) {
    return ctx.reply('No active slot or checking phase to lock.');
  }

  try {
    // 🔥 LOCK THE GROUP FOR EVERYONE EXCEPT ADMINS
    // Set ALL permissions to false to completely restrict
    await ctx.telegram.setChatPermissions(ctx.chat.id, {
      can_send_messages: false,
      can_send_media_messages: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    });

    // Save lock state
    groupData.locked = true;
    await saveGroupData(groupId, groupData);

    // Stop cron jobs
    stopCronJobs(groupId);

    // Update group title to show locked status
    try {
      const currentTitle = ctx.chat.title;
      const baseTitle = currentTitle.replace(/\|\|.*/, '').trim();
      await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || LOCKED`);
    } catch (error) {
      console.log('No permission to change group name:', error);
    }

    // Unpin any existing pinned message
    if (groupData.currentPinnedMessageId) {
      try {
        await ctx.telegram.unpinChatMessage(groupId, groupData.currentPinnedMessageId);
        groupData.currentPinnedMessageId = null;
        await saveGroupData(groupId, groupData);
      } catch (error) {
        console.log('Could not unpin previous message:', error);
      }
    }

    await ctx.reply('🔒 Group locked.\n Timeline is getting updated..\n Only Admins can send messages.');
    await ctx.replyWithPhoto({ source: 'close.png' });

  } catch (error) {
    console.error('Error locking group:', error);
     }
});

bot.command('check', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = await getGroupData(groupId);

  if (groupData.state !== BOT_STATES.SLOT_OPEN) {
    return ctx.reply('No active slot session. Use /open first.');
  }
  const trackingLink = await getTrackingLink();
  groupData.state = BOT_STATES.CHECKING;
  groupData.locked = false;

  // Update group title
  try {
    const currentTitle = ctx.chat.title;
    const baseTitle = currentTitle.replace(/\|\|.*/, '').trim();
    await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || TRACKING`);

  } catch (error) {
    console.log('No permission to change group name');
  }

  // Allow only media during checking
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: false,
    can_send_videos: true,
    can_send_photos: true
  });

  await saveGroupData(groupId, groupData);

  // -----------------------------------------
  // DEADLINE CALCULATION (1hr 30mins)
  // -----------------------------------------
  const now = new Date();
  const deadlineDate = new Date(now.getTime() + 90 * 60 * 1000); // 1hr 30mins

  // Convert to IST
  const istDate = deadlineDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  // Timer text
  const minsLeft = Math.floor((deadlineDate - now) / 60000);
  const hrs = Math.floor(minsLeft / 60);
  const mins = minsLeft % 60;

const checkMsg =
  `<b>⚡ Checking phase Started</b>\n` +
  `Drop the video proof of screen record here with AD, or only proof\n\n` +
  `🔗 ${trackingLink}\n\n` +
  `⏳ <b>Deadline:</b> ${hrs} hr ${mins} mins\n` +
  `🕒 <b>Ends At:</b> ${istDate} IST\n\n` +
  `📤 <b>SEND AD, ALL DONE, DONE WITH SR PROOF</b>\n`;

// Then change the reply to use HTML:
const sentMessage = await ctx.reply(checkMsg, { parse_mode: "HTML" });
  await ctx.pinChatMessage(sentMessage.message_id);

  groupData.currentPinnedMessageId = sentMessage.message_id;
  groupData.deadline = deadlineDate.getTime();
  await saveGroupData(groupId, groupData);

  // -----------------------------------------
  // AUTO-LOCK + AUTO-MUTEALL AFTER DEADLINE
  // -----------------------------------------
  setTimeout(async () => {
    const updated = await getGroupData(groupId);

    // Only apply if still in CHECKING state
    if (updated.state === BOT_STATES.CHECKING) {
      updated.locked = true;
      updated.state = BOT_STATES.LOCKED;
      await saveGroupData(groupId, updated);

      // Lock group
      await ctx.telegram.setChatPermissions(ctx.chat.id, {
      });

      await ctx.reply("🔒 Group locked — checking time is over.");
      

      // -------------------------------------
      // AUTO CALL MUTEALL
      // -------------------------------------
      try {
        await muteAllUsers(ctx, updated, groupId);
        await ctx.reply("🔇 All scam users + SR users have been automatically muted for 2 days.");
      } catch (err) {
        console.error("MuteAll auto-exec failed:", err);
      }
    }
  }, 90 * 60 * 1000);

  // Start reminders
  startCheckingReminderJob(ctx, groupId);
});                                                                                                                  


bot.command('total', requireAllowedGroup, async (ctx) => {

  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  ctx.reply(`📊 Total X links dropped: ${groupData.linkCount}`);
});

bot.command('stats', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = await getGroupData(groupId);

  // Calculate statistics
  const totalParticipants = groupData.userLinks.size;
  
  // AD completed users (from safeUsers)
  const adCompleted = groupData.safeUsers.size;
  
  // SR pending users (from srList)
  const srPending = groupData.srList.size;
  
  // Non-AD users (dropped link but not in safeUsers)
  const nonAdUsers = new Map();
  for (const [uid, linkData] of groupData.userLinks.entries()) {
    if (!groupData.safeUsers.has(uid)) {
      nonAdUsers.set(uid, linkData);
    }
  }
  const nonAdPending = nonAdUsers.size - srPending; // Subtract SR list from non-AD

  // Format the statistics message
  const statsMessage = 
    `📊 *SLOT STATISTICS*\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👥 *Total Participants:* ${totalParticipants}\n` +
    `✅ *AD Completed:* ${adCompleted}\n` +
    `⏳ *Non-AD Pending:* ${Math.max(0, nonAdPending)}\n` +
    `📋 *SR List Pending:* ${srPending}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `*State:* ${groupData.state.toUpperCase()}\n` +
    `*Locked:* ${groupData.locked ? 'Yes 🔒' : 'No 🔓'}`;

  await ctx.reply(statsMessage, { parse_mode: "Markdown" });
});

bot.command('list', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = await getGroupData(groupId);

  if (groupData.userLinks.size === 0) {
    return ctx.reply('No users have submitted links yet.');
  }

  let userList = '<b>📋 PARTICIPATION LISTS:</b>\n\n';
  let counter = 1;

  // Sort newest → oldest
  const sortedUsers = Array.from(groupData.userLinks.entries())
    .sort((a, b) => new Date(b[1].timestamp) - new Date(a[1].timestamp));

  for (const [uid, userData] of sortedUsers) {
    const displayName = userData.tgName || userData.tgUsername || "Unknown";
    const xUsername = (userData.xUsername || 'N/A').trim();
    
    // HTML escape for display name
    const escapedDisplayName = displayName
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    // Use HTML link format
    const mention = `<a href="tg://user?id=${uid}">${escapedDisplayName}</a>`;

    userList += `${counter}. ${mention} | xid: @${xUsername}\n`;
    counter++;
  }

  userList += `\n<b>📊 Total:</b> ${groupData.userLinks.size} users`;

  // Split long messages
  if (userList.length > 4000) {
    const chunks = userList.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    }
  } else {
    ctx.reply(userList, { parse_mode: "HTML" });
  }
});

// ============= SIMPLIFIED CLEAR COMMAND =============
bot.command('clear', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  try {
    const progressMsg = await ctx.reply('🧹 Starting to clear recent messages...');
    
    let deletedCount = 0;
    const MAX_MESSAGES = 1000; // Clear last 100 messages max
    
    // Try to delete messages in reverse order
    for (let i = 1; i <= MAX_MESSAGES; i++) {
      try {
        const messageId = ctx.message.message_id - i;
        if (messageId > 0) {
          await ctx.telegram.deleteMessage(groupId, messageId);
          deletedCount++;
        }
      } catch (error) {
        // Stop when we hit messages we can't delete
        break;
      }
      
      // Small delay to avoid rate limits
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Update progress message
    await ctx.telegram.editMessageText(
      groupId,
      progressMsg.message_id,
      null,
      `✅ Cleared ${deletedCount} recent messages.`
    );
    
    // Auto-delete the result after 5 seconds
    setTimeout(async () => {
      try {
        await ctx.deleteMessage();
        await ctx.telegram.deleteMessage(groupId, progressMsg.message_id);
      } catch (error) {
        console.log('Could not clean up clear command:', error);
      }
    }, 5000);
    
  } catch (error) {
    console.error('Error in clear command:', error);
    await ctx.reply('❌ Error clearing messages. I may not have delete permissions.');
  }
});
bot.command('link', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  // Only admins can use /link
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = await getGroupData(groupId);

  // /link only works during CHECKING phase
  if (groupData.state !== BOT_STATES.CHECKING) {
    return ctx.reply("❌ You can only use /link during the checking phase.");
  }

  // Must reply to a user's message
  if (!ctx.message.reply_to_message) {
    return ctx.reply("❌ Reply to a user's message and type /link to see the X link they submitted.");
  }

  const targetId = ctx.message.reply_to_message.from.id.toString();

  // Retrieve saved link
  const linkData = groupData.userLinks.get(targetId);

  if (!linkData || !linkData.link) {
    return ctx.reply("❌ This user did NOT submit any X link during the slot phase.");
  }

  // Show stored link - use HTML formatting which handles underscores properly
  return ctx.reply(
    `<b>🔗 User's submitted link:</b>\n<code>${linkData.link}</code>`,
    { parse_mode: "HTML" }
  );
});

bot.command('safe', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  if (groupData.safeUsers.size === 0) {
    return ctx.reply('No safe users yet.');
  }
  
  let safeList = '✅ SAFE USERS (Submitted SR proof):\n\n';
  let counter = 1;
  
  for (const [userId, userData] of groupData.safeUsers.entries()) {
    const linkData = groupData.userLinks.get(userId);
    const xUsername = linkData ? linkData.xUsername : 'N/A';
    safeList += `${counter}. @${userData.tgUsername || 'NoUsername'} (X: @${xUsername})\n`;
    counter++;
  }
  
  ctx.reply(safeList);
});

bot.command('scam', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  const scamUsers = new Map();
  
  // Helper function to check if a user is in SR list
  const isUserInSrList = (userId) => {
    for (const [number, data] of groupData.srList.entries()) {
      if (data.userId === userId) {
        return true;
      }
    }
    return false;
  };
  
  // Find users who dropped links but not in safe or SR lists
  for (const [uid, linkData] of groupData.userLinks.entries()) {
    if (!groupData.safeUsers.has(uid) && !isUserInSrList(uid)) {
      scamUsers.set(uid, linkData);
    }
  }
  
  if (scamUsers.size === 0) {
    return ctx.reply('No scam users detected.');
  }
  
  let scamList = '🚫 *SCAM USERS* (These users did NOT send AD or ALL DONE):\n\n';
  let counter = 1;
  
  for (const [uid, userData] of scamUsers.entries()) {
    const displayName = userData.tgName || userData.tgUsername || "Unknown";

    // Silent mention without '@'
    const mention = `[${displayName}](tg://user?id=${uid})`;

    scamList += `${counter}. ${mention}\n`;
    counter++;
  }
  
  // Save scam users
  groupData.scamUsers = scamUsers;
  await saveGroupData(groupId, groupData);
  
  ctx.reply(scamList, { parse_mode: "Markdown" });
});


bot.command('srlist', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  if (groupData.srList.size === 0) {
    return ctx.reply('SR list is empty.');
  }
  
  let srList = '📋 *SR LIST*\n(This users need to recheck and send a screen recording with their own X/Twitter profile visible):\n\n';
  
  // Sort by number (key)
  const sortedEntries = Array.from(groupData.srList.entries())
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  
  for (const [number, data] of sortedEntries) {
    const linkData = groupData.userLinks.get(data.userId);
    const displayName = data.tgUsername || linkData?.tgName || 'Unknown';

    // Silent tag
    const mention = `[${displayName}](tg://user?id=${data.userId})`;

    srList += `${number}. ${mention}\n`;
  }
  
  ctx.reply(srList, { parse_mode: "Markdown" });
});


bot.command('sr', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  const targetUser = ctx.message.reply_to_message?.from;
  
  if (!targetUser) {
    return ctx.reply('Please reply to a user\'s message to use /sr');
  }
  
  const targetUserId = targetUser.id.toString();
  
  // Check if user already in SR list
  let alreadyInList = false;
  let existingNumber = null;
  for (const [number, data] of groupData.srList.entries()) {
    if (data.userId === targetUserId) {
      alreadyInList = true;
      existingNumber = number;
      break;
    }
  }
  
  if (alreadyInList) {
    return ctx.reply(`❌ User already in SR list at position ${existingNumber}`);
  }
  
  // Check if user dropped a link
  if (!groupData.userLinks.has(targetUserId)) {
    return ctx.reply('❌ This user did not drop any X link in the slot phase.');
  }
  
  // Add to SR list
  const srNumber = groupData.srCounter++;
  groupData.srList.set(srNumber.toString(), {
    userId: targetUserId,
    tgUsername: targetUser.username || targetUser.first_name
  });
  
  // Remove from safe list if they were there
  if (groupData.safeUsers.has(targetUserId)) {
    groupData.safeUsers.delete(targetUserId);
  }
  
  await saveGroupData(groupId, groupData);
  
  const linkData = groupData.userLinks.get(targetUserId);
  const xUsername = linkData ? linkData.xUsername : 'N/A';
  
  const warningMsg = `@${targetUser.username || targetUser.first_name} Looks like the screen record proof you dropped isn't clear enough or isn't for you (X: @${xUsername}). Please send the correct one or you will be flagged as scam and muted for days.\n\n📋 SR list - wait for approval`;
  ctx.reply(warningMsg);
});

bot.command('ad', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Usage: /ad <number>');
  }
  
  const number = args[1];
  if (groupData.srList.has(number)) {
    const removedUser = groupData.srList.get(number);
    groupData.srList.delete(number);
    
    const removedUserId = removedUser.userId;
    
    // Check if we're replying to media (meaning admin approves)
    const hasMedia = ctx.message.reply_to_message?.photo || 
                     ctx.message.reply_to_message?.video || 
                     ctx.message.reply_to_message?.document;
    
    if (hasMedia) {
      // Add to safe list
      const linkData = groupData.userLinks.get(removedUserId);
      groupData.safeUsers.set(removedUserId, {
        tgUsername: removedUser.tgUsername,
        timestamp: new Date(),
        approved: true,
        xUsername: linkData ? linkData.xUsername : null
      });
      
      // Remove from scam list if they were there
      if (groupData.scamUsers && groupData.scamUsers.has(removedUserId)) {
        groupData.scamUsers.delete(removedUserId);
      }
      
      await ctx.reply(`✅ Removed user ${number} from SR list and added to safe list.`);
    } else {
      await ctx.reply(`✅ Removed user ${number} from SR list.`);
    }
    
    await saveGroupData(groupId, groupData);
  } else {
    ctx.reply('❌ User not found in SR list.');
  }
});

bot.command('muteall', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  let mutedCount = 0;
  const failedMutes = [];
  
  // Mute scam users
  for (const [userId, userData] of groupData.scamUsers.entries()) {
    const success = await muteUser(ctx, groupData, userId, userData.xUsername, 2 * 24 * 60);
    if (success) {
      mutedCount++;
    } else {
      failedMutes.push(userData.tgUsername || userId);
    }
  }
  
  // Mute SR list users
  for (const [number, data] of groupData.srList.entries()) {
    // Double-check the user is still in the SR list (in case of data inconsistencies)
    let found = false;
    for (const [num, d] of groupData.srList.entries()) {
      if (d.userId === data.userId) {
        found = true;
        break;
      }
    }
    
    if (!found) {
      continue; // Skip if user is not actually in SR list
    }
    
    const linkData = groupData.userLinks.get(data.userId);
    const xUsername = linkData ? linkData.xUsername : null;
    const success = await muteUser(ctx, groupData, data.userId, xUsername, 2 * 24 * 60);
    if (success) {
      mutedCount++;
    } else {
      failedMutes.push(data.tgUsername || data.userId);
    }
  }
  
  await saveGroupData(groupId, groupData);
  
  let replyMsg = `🔇 Muted ${mutedCount} users for 2 days.`;
  if (failedMutes.length > 0) {
    replyMsg += `\n\nFailed to mute: ${failedMutes.join(', ')}`;
  }
  
  ctx.reply(replyMsg);
});

// ============= MUTE COMMAND WITH DURATION =============
bot.command('mute', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('Usage: /mute [duration] [reason]\n\nExamples:\n/mute 30 - Mute for 30 minutes\n/mute 2h - Mute for 2 hours\n/mute 1d - Mute for 1 day\n/mute @username 30\n/mute 30 Spamming\n\nReply to a user or mention username/ID');
  }
  
  let targetUser = null;
  let durationStr = '';
  let reason = '';
  
  // Try to get target user from reply
  if (ctx.message.reply_to_message) {
    targetUser = ctx.message.reply_to_message.from;
    
    // Parse duration from arguments (skip command name)
    if (args.length >= 2) {
      durationStr = args[1];
      reason = args.slice(2).join(' ');
    }
  } else {
    // Try to parse from arguments
    const mentionMatch = args[1].match(/^@(\w+)$/) || args[1].match(/^(\d+)$/);
    
    if (mentionMatch && args.length >= 3) {
      // Format: /mute @username duration reason or /mute 123456 duration reason
      try {
        const chatMember = await ctx.telegram.getChatMember(groupId, mentionMatch[1]);
        targetUser = chatMember.user;
        durationStr = args[2];
        reason = args.slice(3).join(' ');
      } catch (error) {
        return ctx.reply('❌ User not found in this group.');
      }
    } else {
      // Format: /mute duration reason (target is first argument if it's a duration)
      if (/^\d+[mhd]?$/.test(args[1])) {
        durationStr = args[1];
        reason = args.slice(2).join(' ');
        
        // Check if first arg after command is a user mention
        if (args[2] && (args[2].startsWith('@') || /^\d+$/.test(args[2]))) {
          try {
            const identifier = args[2].replace('@', '');
            const chatMember = await ctx.telegram.getChatMember(groupId, identifier);
            targetUser = chatMember.user;
            durationStr = args[1];
            reason = args.slice(3).join(' ');
          } catch (error) {
            // If can't find user, use current message's target
          }
        }
      }
    }
  }
  
  // If still no target user, try to get from entities
  if (!targetUser) {
    targetUser = await getTargetUser(ctx);
  }
  
  if (!targetUser) {
    return ctx.reply('❌ Please reply to a user, mention @username, or provide user ID.\n\nUsage: /mute [duration] [reason]');
  }
  
  // Check if trying to mute admin
  if (await isAdmin(ctx, targetUser.id)) {
    return ctx.reply('❌ Cannot mute an administrator.');
  }
  
  // Parse duration
  let durationMinutes = 30; // Default 30 minutes
  
  if (durationStr) {
    if (durationStr.endsWith('h')) {
      const hours = parseInt(durationStr);
      durationMinutes = hours * 60;
    } else if (durationStr.endsWith('d')) {
      const days = parseInt(durationStr);
      durationMinutes = days * 24 * 60;
    } else if (durationStr.endsWith('m')) {
      durationMinutes = parseInt(durationStr);
    } else {
      durationMinutes = parseInt(durationStr) || 30;
    }
  }
  
  // Maximum mute duration (30 days)
  const MAX_DURATION = 30 * 24 * 60; // 30 days in minutes
  if (durationMinutes > MAX_DURATION) {
    durationMinutes = MAX_DURATION;
  }
  
  // Get group data
  let groupData = await getGroupData(groupId);
  
  // Mute the user
  const success = await muteUser(ctx, groupData, targetUser.id, null, durationMinutes);
  
  if (success) {
    const durationText = getDurationText(durationMinutes);
    const userName = targetUser.username ? `@${targetUser.username}` : targetUser.first_name;
    
    let message = `🔇 ${userName} has been muted for ${durationText}`;
    if (reason) {
      message += `\n📝 Reason: ${reason}`;
    }
    message += `\n👤 Muted by: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`;
    
    await ctx.reply(message);
    await saveGroupData(groupId, groupData);
  } else {
    await ctx.reply('❌ Failed to mute user. I might not have enough permissions.');
  }
});

// ============= UNMUTE COMMAND =============
bot.command('unmute', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let targetUser = null;
  
  // Try to get target user from reply
  if (ctx.message.reply_to_message) {
    targetUser = ctx.message.reply_to_message.from;
  } else {
    // Try to get from arguments or entities
    targetUser = await getTargetUser(ctx);
  }
  
  if (!targetUser) {
    return ctx.reply('❌ Please reply to a user, mention @username, or provide user ID.\n\nUsage: /unmute @username');
  }
  
  try {
    // Restore user permissions
    await ctx.restrictChatMember(targetUser.id, {
      permissions: {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false
      },
      until_date: 0
    });
    
    // Remove from muted lists
    let groupData = await getGroupData(groupId);
    groupData.mutedUsers.delete(targetUser.id.toString());
    
    // Remove from muted X usernames if exists
    for (const [xUsername, muteData] of groupData.mutedXUsernames.entries()) {
      if (muteData.tgUserId === targetUser.id) {
        groupData.mutedXUsernames.delete(xUsername);
      }
    }
    
    await saveGroupData(groupId, groupData);
    
    const userName = targetUser.username ? `@${targetUser.username}` : targetUser.first_name;
    await ctx.reply(`🔊 ${userName} has been unmuted.\n👤 Unmuted by: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`);
    
  } catch (error) {
    console.error('Error unmuting user:', error);
    await ctx.reply('❌ Failed to unmute user. I might not have enough permissions.');
  }
});

// ============= BAN COMMAND =============
bot.command('ban', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  let targetUser = null;
  let reason = '';
  
  // Try to get target user from reply
  if (ctx.message.reply_to_message) {
    targetUser = ctx.message.reply_to_message.from;
    reason = args.slice(1).join(' ');
  } else {
    // Try to get from arguments or entities
    targetUser = await getTargetUser(ctx);
    if (targetUser) {
      reason = args.slice(2).join(' ');
    }
  }
  
  if (!targetUser) {
    return ctx.reply('❌ Please reply to a user, mention @username, or provide user ID.\n\nUsage: /ban [reason]');
  }
  
  // Check if trying to ban admin
  if (await isAdmin(ctx, targetUser.id)) {
    return ctx.reply('❌ Cannot ban an administrator.');
  }
  
  try {
    // Ban the user
    await ctx.banChatMember(targetUser.id);
    
    const userName = targetUser.username ? `@${targetUser.username}` : targetUser.first_name;
    
    let message = `🚫 ${userName} has been banned from the group`;
    if (reason) {
      message += `\n📝 Reason: ${reason}`;
    }
    message += `\n👤 Banned by: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`;
    
    await ctx.reply(message);
    
    // Delete user's messages if possible
    try {
      if (ctx.message.reply_to_message) {
        await ctx.deleteMessage(ctx.message.reply_to_message.message_id);
      }
    } catch (error) {
      console.log('Could not delete user message:', error);
    }
    
  } catch (error) {
    console.error('Error banning user:', error);
    await ctx.reply('❌ Failed to ban user. I might not have enough permissions.');
  }
});

// ============= UNBAN COMMAND =============
bot.command('unban', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let targetUser = null;
  
  // Try to get target user from arguments
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('❌ Please provide username or user ID to unban.\n\nUsage: /unban @username or /unban 123456');
  }
  
  const identifier = args[1].replace('@', '');
  
  try {
    // Try to unban by user ID
    await ctx.unbanChatMember(identifier);
    
    const userName = args[1].startsWith('@') ? args[1] : `User ID: ${identifier}`;
    await ctx.reply(`✅ ${userName} has been unbanned.\n👤 Unbanned by: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`);
    
  } catch (error) {
    console.error('Error unbanning user:', error);
    
    // Try alternative approach - get user from message
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.from) {
      try {
        await ctx.unbanChatMember(ctx.message.reply_to_message.from.id);
        const userName = ctx.message.reply_to_message.from.username ? 
          `@${ctx.message.reply_to_message.from.username}` : 
          ctx.message.reply_to_message.from.first_name;
        await ctx.reply(`✅ ${userName} has been unbanned.\n👤 Unbanned by: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`);
      } catch (error2) {
        await ctx.reply('❌ Failed to unban user. User might not be banned or I lack permissions.');
      }
    } else {
      await ctx.reply('❌ Failed to unban user. User might not be banned or I lack permissions.');
    }
  }
});

// ============= MUTE LIST COMMAND =============
bot.command('mutelist', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  if (groupData.mutedUsers.size === 0 && groupData.mutedXUsernames.size === 0) {
    return ctx.reply('📋 No users are currently muted.');
  }
  
  let muteList = '🔇 *CURRENTLY MUTED USERS*\n━━━━━━━━━━━━━━━━━━\n\n';
  let counter = 1;
  
  // List temporarily muted users
  if (groupData.mutedUsers.size > 0) {
    muteList += '*Temporary Mutes:*\n';
    const now = Math.floor(Date.now() / 1000);
    
    for (const [uid, muteData] of groupData.mutedUsers.entries()) {
      const remaining = muteData.until - now;
      if (remaining > 0) {
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        
        const remainingText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        muteList += `${counter}. ${muteData.tgUsername || 'User'} - ${remainingText} remaining\n`;
        counter++;
      }
    }
  }
  
  // List X username mutes
  if (groupData.mutedXUsernames.size > 0) {
    muteList += '\n*X Username Mutes:*\n';
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000));
    
    for (const [xUsername, muteData] of groupData.mutedXUsernames.entries()) {
      const muteDate = new Date(muteData.mutedAt);
      if (muteDate > twoDaysAgo) {
        const hoursAgo = Math.floor((now - muteDate) / (1000 * 60 * 60));
        muteList += `${counter}. X: @${xUsername} - ${muteData.tgUsername || 'Unknown'} (${hoursAgo}h ago)\n`;
        counter++;
      }
    }
  }
  
  muteList += `\n━━━━━━━━━━━━━━━━━━\n📊 Total: ${counter - 1} muted entries`;
  
  await ctx.reply(muteList, { parse_mode: "Markdown" });
});

// ============= HELPER FUNCTIONS =============

// Helper function to format duration text
function getDurationText(minutes) {
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  } else if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(minutes / (24 * 60));
    const remainingHours = Math.floor((minutes % (24 * 60)) / 60);
    if (remainingHours === 0) {
      return `${days} day${days !== 1 ? 's' : ''}`;
    }
    return `${days} day${days !== 1 ? 's' : ''} ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}`;
  }
}

// Enhanced getTargetUser function (update your existing one)
async function getTargetUser(ctx) {
  const msg = ctx.message;
  
  // 1️⃣ If replying to a user
  if (msg.reply_to_message) {
    return msg.reply_to_message.from;
  }
  
  // 2️⃣ If user mentioned by username like @abc
  if (msg.entities) {
    for (let e of msg.entities) {
      if (e.type === "mention") {
        const username = msg.text.substring(e.offset + 1, e.offset + e.length); // remove @
        try {
          const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, username);
          return chatMember.user;
        } catch (err) {
          console.error('Error getting chat member by mention:', err);
        }
      } else if (e.type === "text_mention") {
        return e.user;
      }
    }
  }
  
  // 3️⃣ If user ID or text name after command
  const parts = msg.text.split(" ");
  if (parts[1]) {
    const id = parts[1].replace("@", "");
    
    // Check if it's a numeric ID
    if (/^\d+$/.test(id)) {
      try {
        const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, parseInt(id));
        return chatMember.user;
      } catch (err) {
        console.error('Error getting chat member by ID:', err);
      }
    } else {
      // Try as username
      try {
        const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, id);
        return chatMember.user;
      } catch (err) {
        console.error('Error getting chat member by username:', err);
      }
    }
  }
  
  return null;
}
// ============= XMUTE COMMAND (Mute by X username) =============
bot.command('xmute', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('Usage: /xmute @xusername [duration] [reason]\n\nExamples:\n/xmute @example - Mute for default 30 minutes\n/xmute @example 2h - Mute for 2 hours\n/xmute @example 1d Spamming - Mute for 1 day with reason');
  }
  
  // Extract X username from command
  const xUsernameInput = args[1].replace('@', '').toLowerCase();
  let durationStr = args[2] || '30';
  let reason = args.slice(3).join(' ');
  
  // Check if second arg is duration (like 2h, 1d)
  if (args.length >= 3 && !/^\d+[mhd]?$/.test(args[2])) {
    // If second arg is not a duration, treat it as part of reason
    durationStr = '30';
    reason = args.slice(2).join(' ');
  }
  
  // Get group data
  let groupData = await getGroupData(groupId);
  
  // Check if we're in slot session
  if (groupData.state !== BOT_STATES.SLOT_OPEN && groupData.state !== BOT_STATES.CHECKING) {
    return ctx.reply('❌ X mute command only works during slot sessions (when slot is OPEN or CHECKING).');
  }
  
  // Find Telegram user by X username
  let tgUserId = null;
  let tgUsername = null;
  let tgName = null;
  let foundLink = null;
  
  // Search through userLinks to find the X username
  for (const [uid, userData] of groupData.userLinks.entries()) {
    if (userData.xUsername && userData.xUsername.toLowerCase() === xUsernameInput) {
      tgUserId = uid;
      tgUsername = userData.tgUsername;
      tgName = userData.tgName;
      foundLink = userData.link;
      break;
    }
  }
  
  if (!tgUserId) {
    // Also check safeUsers and scamUsers
    for (const [uid, userData] of groupData.safeUsers.entries()) {
      if (userData.xUsername && userData.xUsername.toLowerCase() === xUsernameInput) {
        tgUserId = uid;
        tgUsername = userData.tgUsername;
        break;
      }
    }
    
    if (!tgUserId) {
      for (const [uid, userData] of groupData.scamUsers.entries()) {
        if (userData.xUsername && userData.xUsername.toLowerCase() === xUsernameInput) {
          tgUserId = uid;
          tgUsername = userData.tgUsername || userData.tgName;
          break;
        }
      }
    }
    
    if (!tgUserId) {
      return ctx.reply(`❌ No Telegram user found with X username @${xUsernameInput} in this slot session.`);
    }
  }
  
  // Check if user is admin
  if (await isAdmin(ctx, tgUserId)) {
    return ctx.reply('❌ Cannot mute an administrator.');
  }
  
  // Parse duration
  let durationMinutes = 30; // Default 30 minutes
  
  if (durationStr) {
    if (durationStr.endsWith('h')) {
      const hours = parseInt(durationStr);
      durationMinutes = hours * 60;
    } else if (durationStr.endsWith('d')) {
      const days = parseInt(durationStr);
      durationMinutes = days * 24 * 60;
    } else if (durationStr.endsWith('m')) {
      durationMinutes = parseInt(durationStr);
    } else {
      durationMinutes = parseInt(durationStr) || 30;
    }
  }
  
  // Maximum mute duration (30 days)
  const MAX_DURATION = 30 * 24 * 60;
  if (durationMinutes > MAX_DURATION) {
    durationMinutes = MAX_DURATION;
  }
  
  // Mute the user
  const success = await muteUser(ctx, groupData, tgUserId, xUsernameInput, durationMinutes);
  
  if (success) {
    const durationText = getDurationText(durationMinutes);
    const displayName = tgUsername || tgName || `User ID: ${tgUserId}`;
    
    let message = `🔇 *X Username Mute Applied*\n━━━━━━━━━━━━━━━━━━\n`;
    message += `🐦 *X Account:* @${xUsernameInput}\n`;
    message += `👤 *Telegram User:* ${displayName}\n`;
    message += `⏰ *Duration:* ${durationText}\n`;
    
    if (foundLink) {
      message += `🔗 *Submitted Link:* ${foundLink.substring(0, 50)}...\n`;
    }
    
    if (reason) {
      message += `📝 *Reason:* ${reason}\n`;
    }
    
    message += `━━━━━━━━━━━━━━━━━━\n👮 *Muted by:* ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    await saveGroupData(groupId, groupData);
    
    // Also add to permanent muted X usernames list if duration is 2 days
    if (durationMinutes >= 2 * 24 * 60) {
      const xUsernameLower = xUsernameInput.toLowerCase();
      groupData.mutedXUsernames.set(xUsernameLower, {
        xUsername: xUsernameInput,
        tgUsername: displayName,
        tgUserId: tgUserId,
        mutedAt: new Date(),
        mutedBy: ctx.from.id,
        reason: reason
      });
      
      // Save to Firebase for permanent storage
      await saveMutedUserToFirebase(ctx.chat.id, xUsernameInput, displayName, ctx.from.id, reason);
      await saveGroupData(groupId, groupData);
    }
    
  } else {
    await ctx.reply('❌ Failed to mute user. I might not have enough permissions.');
  }
});

// ============= XUNMUTE COMMAND (Unmute by X username) =============
bot.command('xunmute', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('Usage: /xunmute @xusername\n\nExample: /xunmute @example');
  }
  
  // Extract X username from command
  const xUsernameInput = args[1].replace('@', '').toLowerCase();
  
  // Get group data
  let groupData = await getGroupData(groupId);
  
  // Find Telegram user by X username
  let tgUserId = null;
  let displayName = null;
  
  // Search through userLinks first
  for (const [uid, userData] of groupData.userLinks.entries()) {
    if (userData.xUsername && userData.xUsername.toLowerCase() === xUsernameInput) {
      tgUserId = uid;
      displayName = userData.tgUsername || userData.tgName;
      break;
    }
  }
  
  // Also check other lists if not found
  if (!tgUserId) {
    for (const [uid, userData] of groupData.safeUsers.entries()) {
      if (userData.xUsername && userData.xUsername.toLowerCase() === xUsernameInput) {
        tgUserId = uid;
        displayName = userData.tgUsername;
        break;
      }
    }
  }
  
  if (!tgUserId) {
    for (const [uid, userData] of groupData.scamUsers.entries()) {
      if (userData.xUsername && userData.xUsername.toLowerCase() === xUsernameInput) {
        tgUserId = uid;
        displayName = userData.tgUsername || userData.tgName;
        break;
      }
    }
  }
  
  if (!tgUserId) {
    // Check if X username is in muted list even if user not in current slot
    if (groupData.mutedXUsernames.has(xUsernameInput)) {
      const muteData = groupData.mutedXUsernames.get(xUsernameInput);
      tgUserId = muteData.tgUserId;
      displayName = muteData.tgUsername || 'Unknown';
    } else {
      // Check Firebase for muted X username
      try {
        const doc = await db.collection('mutedUsers').doc(`${groupId}_${xUsernameInput}`).get();
        if (doc.exists) {
          const data = doc.data();
          tgUserId = data.tgUserId;
          displayName = data.tgUsername || 'Unknown';
        }
      } catch (error) {
        console.error('Error checking Firebase for muted user:', error);
      }
      
      if (!tgUserId) {
        return ctx.reply(`❌ No Telegram user found with X username @${xUsernameInput} in current slot or muted list.`);
      }
    }
  }
  
  try {
    // Unmute the Telegram user
    await ctx.restrictChatMember(tgUserId, {
      permissions: {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false
      },
      until_date: 0
    });
    
    // Remove from local muted lists
    groupData.mutedUsers.delete(tgUserId.toString());
    groupData.mutedXUsernames.delete(xUsernameInput);
    
    // Also remove from Firebase
    try {
      await db.collection('mutedUsers').doc(`${groupId}_${xUsernameInput}`).delete();
    } catch (error) {
      console.error('Error removing from Firebase:', error);
    }
    
    await saveGroupData(groupId, groupData);
    
    const message = `🔊 *X Username Unmute Applied*\n━━━━━━━━━━━━━━━━━━\n` +
                   `🐦 *X Account:* @${xUsernameInput}\n` +
                   `👤 *Telegram User:* ${displayName || 'User'}\n` +
                   `━━━━━━━━━━━━━━━━━━\n` +
                   `👮 *Unmuted by:* ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error unmuting user:', error);
    await ctx.reply('❌ Failed to unmute user. I might not have enough permissions.');
  }
});
// ============= XBAN COMMAND - BAN BY X USERNAME =============
bot.command(['xban', 'tban'], async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('❌ Usage: /xban <x_username> [reason]\n\nExamples:\n/xban username\n/xban username Spamming\n\nThis bans the user who submitted this X username during slot phase.');
  }
  
  const xUsername = args[1].replace('@', '').toLowerCase().trim();
  const reason = args.slice(2).join(' ') || 'No reason provided';
  
  let groupData = await getGroupData(groupId);
  
  // Find user by X username in userLinks
  let targetUserId = null;
  let targetUserData = null;
  let targetTGUsername = null;
  
  // Search through userLinks for matching X username
  for (const [tgUserId, userData] of groupData.userLinks.entries()) {
    if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
      targetUserId = tgUserId;
      targetUserData = userData;
      targetTGUsername = userData.tgUsername;
      break;
    }
  }
  
  if (!targetUserId) {
    // Try searching in safeUsers and scamUsers
    for (const [tgUserId, userData] of groupData.safeUsers.entries()) {
      if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
        targetUserId = tgUserId;
        const linkData = groupData.userLinks.get(tgUserId);
        targetUserData = linkData;
        targetTGUsername = userData.tgUsername;
        break;
      }
    }
    
    if (!targetUserId) {
      for (const [tgUserId, userData] of groupData.scamUsers.entries()) {
        if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
          targetUserId = tgUserId;
          targetUserData = userData;
          targetTGUsername = userData.tgUsername;
          break;
        }
      }
    }
  }
  
  if (!targetUserId) {
    return ctx.reply(`❌ No user found with X username: @${xUsername}\n\nNote: This command only works for users who participated in the slot phase.`);
  }
  
  // Check if trying to ban admin
  if (await isAdmin(ctx, targetUserId)) {
    return ctx.reply('❌ Cannot ban an administrator.');
  }
  
  try {
    // Get user info from Telegram
    let chatMember;
    try {
      chatMember = await ctx.telegram.getChatMember(groupId, targetUserId);
    } catch (error) {
      return ctx.reply(`❌ User @${xUsername} (TG: ${targetTGUsername}) is not in the group or left already.`);
    }
    
    // Ban the user
    await ctx.banChatMember(targetUserId);
    
    // Also mute the X username for future slots
    const muteData = {
      xUsername: xUsername,
      tgUsername: targetTGUsername,
      tgUserId: targetUserId,
      mutedAt: new Date(),
      mutedBy: ctx.from.id,
      reason: reason,
      type: 'xban'
    };
    
    // Save to both local cache and Firebase
    groupData.mutedXUsernames.set(xUsername, muteData);
    await saveMutedUserToFirebase(groupId, xUsername, targetTGUsername, ctx.from.id);
    
    await saveGroupData(groupId, groupData);
    
    const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const message = `🚫 *X Username Ban Applied*\n\n` +
      `❌ *X Username:* @${xUsername}\n` +
      `👤 *Telegram User:* ${targetTGUsername}\n` +
      `📝 *Reason:* ${reason}\n` +
      `👮 *Banned by:* ${adminName}\n\n` +
      `⚠️ This X username is now blocked from future slots.`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error in xban command:', error);
    await ctx.reply(`❌ Failed to ban user with X username: @${xUsername}\nError: ${error.message}`);
  }
});

bot.command('setlink', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('Usage: /setlink <new_link>\nExample: /setlink https://x.com/new_username');
  }

  const newLink = args.slice(1).join(' ');
  
  // Validate it's an X/Twitter link
  if (!newLink.includes('x.com/') && !newLink.includes('twitter.com/')) {
    return ctx.reply('❌ Please provide a valid X/Twitter link.');
  }

  const success = await setTrackingLink(newLink);
  
  if (success) {
    await ctx.reply(`✅ Tracking link updated to:\n${newLink}`);
  } else {
    await ctx.reply('❌ Failed to update tracking link.');
  }
});

// ============= XUNBAN COMMAND - UNBAN BY X USERNAME =============
bot.command(['xunban', 'unbantwitter'], async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('❌ Usage: /xunban <x_username>\n\nExample: /xunban username\n\nThis unbans the user associated with this X username.');
  }
  
  const xUsername = args[1].replace('@', '').toLowerCase().trim();
  
  let groupData = await getGroupData(groupId);
  
  // Find user by X username in userLinks
  let targetUserId = null;
  let targetUserData = null;
  let targetTGUsername = null;
  
  // Search through userLinks for matching X username
  for (const [tgUserId, userData] of groupData.userLinks.entries()) {
    if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
      targetUserId = tgUserId;
      targetUserData = userData;
      targetTGUsername = userData.tgUsername;
      break;
    }
  }
  
  if (!targetUserId) {
    // Also check mutedXUsernames for previously banned X usernames
    if (groupData.mutedXUsernames.has(xUsername)) {
      const muteData = groupData.mutedXUsernames.get(xUsername);
      targetUserId = muteData.tgUserId;
      targetTGUsername = muteData.tgUsername;
    }
  }
  
  if (!targetUserId) {
    return ctx.reply(`❌ No user found with X username: @${xUsername}\n\nNote: This command works for users who participated in slots or were previously banned via /xban.`);
  }
  
  try {
    // Try to unban the user
    await ctx.unbanChatMember(targetUserId);
    
    // Remove from mutedXUsernames
    groupData.mutedXUsernames.delete(xUsername);
    
    // Also remove from Firebase if exists
    try {
      await db.collection('mutedUsers').doc(`${groupId}_${xUsername}`).delete();
    } catch (error) {
      console.log('Error removing from Firebase:', error);
    }
    
    await saveGroupData(groupId, groupData);
    
    const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const message = `✅ *X Username Unban Applied*\n\n` +
      `✅ *X Username:* @${xUsername}\n` +
      `👤 *Telegram User:* ${targetTGUsername || 'Unknown'}\n` +
      `👮 *Unbanned by:* ${adminName}\n\n` +
      `⚠️ This X username is now allowed in future slots.`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error in xunban command:', error);
    
    // Even if unban fails, remove from blocked list
    groupData.mutedXUsernames.delete(xUsername);
    try {
      await db.collection('mutedUsers').doc(`${groupId}_${xUsername}`).delete();
    } catch (dbError) {
      console.log('Error removing from Firebase:', dbError);
    }
    await saveGroupData(groupId, groupData);
    
    await ctx.reply(`✅ X username @${xUsername} has been removed from the blocked list, but user might not be in the group or already unbanned.\n\nError: ${error.message}`);
  }
});


// ============= XBANLIST COMMAND (OPTIONAL) - VIEW BANNED X USERNAMES =============
bot.command('xbanlist', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  if (groupData.mutedXUsernames.size === 0) {
    return ctx.reply('📋 No X usernames are currently banned.');
  }
  
  let banList = '🚫 *BANNED X USERNAMES*\n━━━━━━━━━━━━━━━━━━\n\n';
  let counter = 1;
  
  const now = new Date();
  
  for (const [xUsername, banData] of groupData.mutedXUsernames.entries()) {
    const banDate = new Date(banData.mutedAt);
    const daysAgo = Math.floor((now - banDate) / (1000 * 60 * 60 * 24));
    const hoursAgo = Math.floor((now - banDate) / (1000 * 60 * 60));
    
    const timeAgo = daysAgo > 0 ? `${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago` : `${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago`;
    
    banList += `${counter}. X: @${xUsername}\n`;
    banList += `   👤 TG: ${banData.tgUsername || 'Unknown'}\n`;
    banList += `   ⏰ Banned: ${timeAgo}\n`;
    banList += `   📝 Reason: ${banData.reason || 'No reason'}\n\n`;
    counter++;
  }
  
  banList += `━━━━━━━━━━━━━━━━━━\n📊 Total: ${counter - 1} banned X usernames`;
  
  await ctx.reply(banList, { parse_mode: "Markdown" });
});

// ============= HELPER FUNCTION FOR DURATION TEXT =============
function getDurationText(minutes) {
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  } else if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(minutes / (24 * 60));
    const remainingHours = Math.floor((minutes % (24 * 60)) / 60);
    if (remainingHours === 0) {
      return `${days} day${days !== 1 ? 's' : ''}`;
    }
    return `${days} day${days !== 1 ? 's' : ''} ${remainingHours} hour${remainingHours !== 1 ? 's' : ''}`;
  }
}

// ============= XBAN COMMAND - BAN BY X USERNAME =============
bot.command(['xban', 'tban'], async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('❌ Usage: /xban <x_username> [reason]\n\nExamples:\n/xban username\n/xban username Spamming\n\nThis bans the user who submitted this X username during slot phase.');
  }
  
  const xUsername = args[1].replace('@', '').toLowerCase().trim();
  const reason = args.slice(2).join(' ') || 'No reason provided';
  
  let groupData = await getGroupData(groupId);
  
  // Find user by X username in userLinks
  let targetUserId = null;
  let targetUserData = null;
  let targetTGUsername = null;
  
  // Search through userLinks for matching X username
  for (const [tgUserId, userData] of groupData.userLinks.entries()) {
    if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
      targetUserId = tgUserId;
      targetUserData = userData;
      targetTGUsername = userData.tgUsername;
      break;
    }
  }
  
  if (!targetUserId) {
    // Try searching in safeUsers and scamUsers
    for (const [tgUserId, userData] of groupData.safeUsers.entries()) {
      if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
        targetUserId = tgUserId;
        const linkData = groupData.userLinks.get(tgUserId);
        targetUserData = linkData;
        targetTGUsername = userData.tgUsername;
        break;
      }
    }
    
    if (!targetUserId) {
      for (const [tgUserId, userData] of groupData.scamUsers.entries()) {
        if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
          targetUserId = tgUserId;
          targetUserData = userData;
          targetTGUsername = userData.tgUsername;
          break;
        }
      }
    }
  }
  
  if (!targetUserId) {
    return ctx.reply(`❌ No user found with X username: @${xUsername}\n\nNote: This command only works for users who participated in the slot phase.`);
  }
  
  // Check if trying to ban admin
  if (await isAdmin(ctx, targetUserId)) {
    return ctx.reply('❌ Cannot ban an administrator.');
  }
  
  try {
    // Get user info from Telegram
    let chatMember;
    try {
      chatMember = await ctx.telegram.getChatMember(groupId, targetUserId);
    } catch (error) {
      return ctx.reply(`❌ User @${xUsername} (TG: ${targetTGUsername}) is not in the group or left already.`);
    }
    
    // Ban the user
    await ctx.banChatMember(targetUserId);
    
    // Also mute the X username for future slots
    const muteData = {
      xUsername: xUsername,
      tgUsername: targetTGUsername,
      tgUserId: targetUserId,
      mutedAt: new Date(),
      mutedBy: ctx.from.id,
      reason: reason,
      type: 'xban'
    };
    
    // Save to both local cache and Firebase
    groupData.mutedXUsernames.set(xUsername, muteData);
    await saveMutedUserToFirebase(groupId, xUsername, targetTGUsername, ctx.from.id);
    
    await saveGroupData(groupId, groupData);
    
    const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const message = `🚫 *X Username Ban Applied*\n\n` +
      `❌ *X Username:* @${xUsername}\n` +
      `👤 *Telegram User:* ${targetTGUsername}\n` +
      `📝 *Reason:* ${reason}\n` +
      `👮 *Banned by:* ${adminName}\n\n` +
      `⚠️ This X username is now blocked from future slots.`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error in xban command:', error);
    await ctx.reply(`❌ Failed to ban user with X username: @${xUsername}\nError: ${error.message}`);
  }
});

// ============= XUNBAN COMMAND - UNBAN BY X USERNAME =============
bot.command(['xunban', 'unbantwitter'], async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(' ');
  
  if (args.length < 2) {
    return ctx.reply('❌ Usage: /xunban <x_username>\n\nExample: /xunban username\n\nThis unbans the user associated with this X username.');
  }
  
  const xUsername = args[1].replace('@', '').toLowerCase().trim();
  
  let groupData = await getGroupData(groupId);
  
  // Find user by X username in userLinks
  let targetUserId = null;
  let targetUserData = null;
  let targetTGUsername = null;
  
  // Search through userLinks for matching X username
  for (const [tgUserId, userData] of groupData.userLinks.entries()) {
    if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
      targetUserId = tgUserId;
      targetUserData = userData;
      targetTGUsername = userData.tgUsername;
      break;
    }
  }
  
  if (!targetUserId) {
    // Also check mutedXUsernames for previously banned X usernames
    if (groupData.mutedXUsernames.has(xUsername)) {
      const muteData = groupData.mutedXUsernames.get(xUsername);
      targetUserId = muteData.tgUserId;
      targetTGUsername = muteData.tgUsername;
    }
  }
  
  if (!targetUserId) {
    return ctx.reply(`❌ No user found with X username: @${xUsername}\n\nNote: This command works for users who participated in slots or were previously banned via /xban.`);
  }
  
  try {
    // Try to unban the user
    await ctx.unbanChatMember(targetUserId);
    
    // Remove from mutedXUsernames
    groupData.mutedXUsernames.delete(xUsername);
    
    // Also remove from Firebase if exists
    try {
      await db.collection('mutedUsers').doc(`${groupId}_${xUsername}`).delete();
    } catch (error) {
      console.log('Error removing from Firebase:', error);
    }
    
    await saveGroupData(groupId, groupData);
    
    const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const message = `✅ *X Username Unban Applied*\n\n` +
      `✅ *X Username:* @${xUsername}\n` +
      `👤 *Telegram User:* ${targetTGUsername || 'Unknown'}\n` +
      `👮 *Unbanned by:* ${adminName}\n\n` +
      `⚠️ This X username is now allowed in future slots.`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error in xunban command:', error);
    
    // Even if unban fails, remove from blocked list
    groupData.mutedXUsernames.delete(xUsername);
    try {
      await db.collection('mutedUsers').doc(`${groupId}_${xUsername}`).delete();
    } catch (dbError) {
      console.log('Error removing from Firebase:', dbError);
    }
    await saveGroupData(groupId, groupData);
    
    await ctx.reply(`✅ X username @${xUsername} has been removed from the blocked list, but user might not be in the group or already unbanned.\n\nError: ${error.message}`);
  }
});

// ============= REQUEST COMMAND (Simplified) =============
bot.command('request', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id.toString();
  
  // Get group data
  let groupData = await getGroupData(groupId);
  
  // Only works during CHECKING phase
  if (groupData.state !== BOT_STATES.CHECKING) {
    await ctx.deleteMessage();
    await ctx.reply("❌ Request command only works during checking phase.");
    return;
  }
  
  // Check if user participated in the slot
  if (!groupData.userLinks.has(userId)) {
    await ctx.deleteMessage();
    await ctx.reply("❌ You need to have participated in the slot to use this command.");
    return;
  }
  
  const args = ctx.message.text.split(' ');
  const message = args.slice(1).join(' ');
  
  // Check if message is provided
  if (!message && !ctx.message.photo && !ctx.message.document) {
    await ctx.deleteMessage();
    const helpMsg = `📝 *How to use /request*\n\n` +
                   `Send your request with a message or image:\n` +
                   `• /request Need help with proof\n` +
                   `• /request I have an issue\n` +
                   `• /request Can't upload video\n\n` +
                   `You can also attach an image or document with your request.`;
    await ctx.reply(helpMsg, { parse_mode: "Markdown" });
    return;
  }
  
  try {
    // Get all admins in the group
    const admins = await ctx.getChatAdministrators();
    
    // Get user info
    const userLinkData = groupData.userLinks.get(userId);
    const xUsername = userLinkData ? userData.xUsername : 'N/A';
    const tgUsername = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const userFirstName = ctx.from.first_name || 'User';
    
    // Prepare request message for admins
    const requestMessage = `📩 *NEW REQUEST FROM USER*\n\n` +
                          `👤 *User:* ${tgUsername}\n` +
                          `🆔 *User ID:* \`${userId}\`\n` +
                          `🐦 *X Username:* @${xUsername}\n` +
                          `📝 *Message:* ${message || "No message provided"}\n` +
                          `📅 *Time:* ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
                          `🏷️ *Group:* ${ctx.chat.title}`;
    
    // Send to each admin in their DMs
    let sentCount = 0;
    let failedCount = 0;
    
    for (const admin of admins) {
      // Skip bots
      if (admin.user.is_bot) continue;
      
      const adminId = admin.user.id;
      
      try {
        // Start with text message
        await ctx.telegram.sendMessage(adminId, requestMessage, { parse_mode: "Markdown" });
        
        // If there's a photo, forward it
        if (ctx.message.photo) {
          const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest quality
          await ctx.telegram.sendPhoto(adminId, photo.file_id, {
            caption: `📸 Attachment from ${tgUsername}`,
            parse_mode: "Markdown"
          });
        }
        
        // If there's a document, forward it
        if (ctx.message.document) {
          await ctx.telegram.sendDocument(adminId, ctx.message.document.file_id, {
            caption: `📎 Document from ${tgUsername}`,
            parse_mode: "Markdown"
          });
        }
        
        sentCount++;
        
      } catch (error) {
        // If admin hasn't started chat with bot, we can't send DM
        console.error(`Failed to send request to admin ${adminId}:`, error.message);
        failedCount++;
      }
    }
    
    // Delete user's request message from group
    await ctx.deleteMessage();
    
    // Send confirmation to user
    const confirmationMsg = `✅ *Your request has been sent!*\n\n` +
                          `📤 Sent to ${sentCount} admin${sentCount !== 1 ? 's' : ''}\n` +
                          `⏳ Admin will accept your request soon\n` +
                          `⏰ Kindly wait a few seconds\n` +
                          `🙏 Thank you for your patience`;
    
    const userConfirmation = await ctx.reply(confirmationMsg, { parse_mode: "Markdown" });
    
    // Auto-delete confirmation after 10 seconds
    setTimeout(async () => {
      try {
        await ctx.deleteMessage(userConfirmation.message_id);
      } catch (error) {
        console.log('Could not delete confirmation message:', error);
      }
    }, 10000);
    
    // Log request summary
    console.log(`Request from ${tgUsername}: Sent to ${sentCount} admins, ${failedCount} failed`);
    
  } catch (error) {
    console.error('Error processing request:', error);
    await ctx.reply("❌ Sorry, there was an error processing your request. Please try again.");
  }
});

// ============= REQUEST HELP COMMAND =============
bot.command('requesthelp', async (ctx) => {
  const helpMsg = `📝 *REQUEST SYSTEM HELP*\n\n` +
                 `*How to use /request:*\n` +
                 `• Use during checking phase only\n` +
                 `• Must have participated in the slot\n` +
                 `• Add a message explaining your issue\n` +
                 `• You can attach images/documents\n\n` +
                 `*Examples:*\n` +
                 `/request Need help uploading proof\n` +
                 `/request Can't find my X link\n` +
                 `/request Technical issue with video\n\n` +
                 `*What happens:*\n` +
                 `1. Your request is sent to all admins\n` +
                 `2. Your message is deleted from group\n` +
                 `3. Admin will respond to you soon\n` +
                 `4. Please wait patiently for response`;
  
  await ctx.reply(helpMsg, { parse_mode: "Markdown" });
});

// ============= REQUESTSTATS COMMAND (For admins) =============
bot.command('requeststats', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  try {
    // Get today's date
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Get all admins
    const admins = await ctx.getChatAdministrators();
    const adminCount = admins.filter(a => !a.user.is_bot).length;
    
    const statsMsg = `📊 *REQUEST SYSTEM STATS*\n━━━━━━━━━━━━━━━━━━\n\n` +
                    `👥 *Total Admins:* ${adminCount}\n` +
                    `🏷️ *Group:* ${ctx.chat.title}\n` +
                    `📅 *Today's Date:* ${now.toLocaleDateString("en-IN")}\n` +
                    `⏰ *Current Time:* ${now.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n\n` +
                    `ℹ️ *Note:* Requests are sent to all admins via DM.\n` +
                    `Users must wait for admin response.`;
    
    await ctx.reply(statsMsg, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error in requeststats:', error);
    await ctx.reply('❌ Error fetching statistics.');
  }
});

// ============= XBANLIST COMMAND (OPTIONAL) - VIEW BANNED X USERNAMES =============
bot.command('xbanlist', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  if (groupData.mutedXUsernames.size === 0) {
    return ctx.reply('📋 No X usernames are currently banned.');
  }
  
  let banList = '🚫 *BANNED X USERNAMES*\n━━━━━━━━━━━━━━━━━━\n\n';
  let counter = 1;
  
  const now = new Date();
  
  for (const [xUsername, banData] of groupData.mutedXUsernames.entries()) {
    const banDate = new Date(banData.mutedAt);
    const daysAgo = Math.floor((now - banDate) / (1000 * 60 * 60 * 24));
    const hoursAgo = Math.floor((now - banDate) / (1000 * 60 * 60));
    
    const timeAgo = daysAgo > 0 ? `${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago` : `${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago`;
    
    banList += `${counter}. X: @${xUsername}\n`;
    banList += `   👤 TG: ${banData.tgUsername || 'Unknown'}\n`;
    banList += `   ⏰ Banned: ${timeAgo}\n`;
    banList += `   📝 Reason: ${banData.reason || 'No reason'}\n\n`;
    counter++;
  }
  
  banList += `━━━━━━━━━━━━━━━━━━\n📊 Total: ${counter - 1} banned X usernames`;
  
  await ctx.reply(banList, { parse_mode: "Markdown" });
});

bot.command(['end', 'e'], async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  // Delete all bot messages before clearing data
  for (const [userId, userData] of groupData.userLinks.entries()) {
    if (userData.botMessageId) {
      try {
        await ctx.telegram.deleteMessage(groupId, userData.botMessageId);
      } catch (error) {
        console.error('Error deleting bot message on /end:', error);
      }
    }
  }
  
  groupData.state = BOT_STATES.CLOSED;
  
  // Update group title
  try {
    const currentTitle = ctx.chat.title;
    const baseTitle = currentTitle.replace(/\|\|.*/, '').trim();
    await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || CLOSED`);
    
  } catch (error) {
    console.log('No permission to change group name');
  }
  
  // Restrict chat completely
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: false,
    can_send_media_messages: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_send_polls: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_change_info: false
  });
  
  // Stop all cron jobs
  stopCronJobs(groupId);
  
  // Clear all data except muted users (which are saved in Firebase)
  groupData.userLinks.clear();
  groupData.safeUsers.clear();
  groupData.scamUsers.clear();
  groupData.srList.clear();
  groupData.mutedUsers.clear(); // Temporary mutes cleared
  groupData.linkCount = 0;
  groupData.srCounter = 1;
  groupData.currentPinnedMessageId = null;
  groupData.locked = false;
  
  await saveGroupData(groupId, groupData);
  
  ctx.reply('✅ Slot ended. All bot messages deleted. All data cleared.');

});

// ============= MESSAGE HANDLERS =============

// ============= NEW MISSING COMMANDS =============
bot.command('start', async (ctx) => {
  await ctx.reply('🤖 Engage Bot Started! Type /help to see commands.');
});

bot.command('reopen', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  if (!await isAdmin(ctx, userId)) { await ctx.deleteMessage(); return; }
  let groupData = await getGroupData(groupId);
  if (!groupData.locked) return ctx.reply('Group is not locked.');
  
  groupData.locked = false;
  await saveGroupData(groupId, groupData);
  
  await ctx.telegram.setChatPermissions(groupId, {
    can_send_messages: true,
    can_send_other_messages: false,
    can_add_web_page_previews: true,
  });
  await ctx.reply('🔓 Group unlocked.');
});

bot.command('tag', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  await ctx.reply('Tagging all members is restricted by Telegram API for large groups, use @all instead or pin a message.');
});

bot.command('delete', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  await ctx.reply('Bulk delete not fully supported by standard Bot API, consider using /clear.');
});

bot.command('double', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  let groupData = await getGroupData(ctx.chat.id);
  let duplicateUsernames = new Set();
  let seen = new Set();
  for (const [uid, uData] of groupData.userLinks.entries()) {
    if (seen.has(uData.xUsername.toLowerCase())) {
      duplicateUsernames.add(uData.xUsername);
    } else {
      seen.add(uData.xUsername.toLowerCase());
    }
  }
  if (duplicateUsernames.size === 0) return ctx.reply('No double links found.');
  ctx.reply('Double links detected for X usernames: ' + Array.from(duplicateUsernames).join(', '));
});

bot.command('new', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('List of new users joined during this session is not tracked currently.');
});

bot.command('banlist', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  let groupData = await getGroupData(ctx.chat.id);
  ctx.reply('Banned X Usernames:\n' + Array.from(groupData.mutedXUsernames.keys()).join(', '));
});

bot.command('unmuteall', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  let groupData = await getGroupData(ctx.chat.id);
  let count = 0;
  for (const [uid, uData] of groupData.mutedUsers.entries()) {
    try {
      await ctx.restrictChatMember(uid, {
        permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true }
      });
      count++;
    } catch (e) {}
  }
  groupData.mutedUsers.clear();
  await saveGroupData(ctx.chat.id, groupData);
  ctx.reply(`✅ Unmuted ${count} users.`);
});

bot.command('muteunsafe', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  let groupData = await getGroupData(ctx.chat.id);
  let count = 0;
  for (const [uid, uData] of groupData.userLinks.entries()) {
    if (!groupData.safeUsers.has(uid)) {
      await muteUser(ctx, groupData, uid, uData.xUsername, 2 * 24 * 60);
      count++;
    }
  }
  await saveGroupData(ctx.chat.id, groupData);
  ctx.reply(`🔇 Muted ${count} unsafe users.`);
});

bot.command('unmuteunsafe', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('Use /unmuteall to unmute everyone, tracking previous unsafe state is not implemented.');
});

bot.command('mutesr', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  let groupData = await getGroupData(ctx.chat.id);
  let count = 0;
  for (const [number, data] of groupData.srList.entries()) {
    const linkData = groupData.userLinks.get(data.userId);
    await muteUser(ctx, groupData, data.userId, linkData ? linkData.xUsername : null, 2 * 24 * 60);
    count++;
  }
  await saveGroupData(ctx.chat.id, groupData);
  ctx.reply(`🔇 Muted ${count} SR users.`);
});

bot.command('approvenew', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('New users tracking not active.');
});

bot.command('unmutenew', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('New users tracking not active.');
});

bot.command('mutenew', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('Auto mute new users setting toggled (Not yet implemented).');
});

bot.command('d1', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('Reply to a user to delete their link.');
  let groupData = await getGroupData(ctx.chat.id);
  if (groupData.userLinks.has(targetUser.id.toString())) {
    groupData.userLinks.delete(targetUser.id.toString());
    groupData.linkCount = Math.max(0, groupData.linkCount - 1);
    await saveGroupData(ctx.chat.id, groupData);
    ctx.reply('✅ Link deleted for user.');
  } else {
    ctx.reply('No link found for this user.');
  }
});

bot.command('ball', async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('Reply to a user to federation ban them.');
  for (const gId of ALLOWED_GROUP_IDS) {
    try {
      await ctx.telegram.banChatMember(gId, targetUser.id);
    } catch (e) {
      console.log(`Could not ban in group ${gId}: ${e.message}`);
    }
  }
  await ctx.reply(`🚫 ${targetUser.username || targetUser.first_name} banned from all allowed groups.`);
});

bot.command('unball', async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('Reply to a user to federation unban them.');
  for (const gId of ALLOWED_GROUP_IDS) {
    try {
      await ctx.telegram.unbanChatMember(gId, targetUser.id);
    } catch (e) {
      console.log(`Could not unban in group ${gId}: ${e.message}`);
    }
  }
  await ctx.reply(`✅ ${targetUser.username || targetUser.first_name} unbanned from all allowed groups.`);
});

bot.command('add', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('Reply to a user to add them to safe list.');
  let groupData = await getGroupData(ctx.chat.id);
  const linkData = groupData.userLinks.get(targetUser.id.toString());
  groupData.safeUsers.set(targetUser.id.toString(), {
    tgUsername: targetUser.username || targetUser.first_name,
    tgUserId: targetUser.id,
    xUsername: linkData ? linkData.xUsername : 'N/A',
    timestamp: new Date(),
    approved: true
  });
  await saveGroupData(ctx.chat.id, groupData);
  ctx.reply('✅ User added to safe list manually.');
});

bot.command('setwarnlimit', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('Warn limit setting updated (placeholder).');
});

bot.command('p', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  const msg = await ctx.reply('📌 Pin drop link message.');
  await ctx.pinChatMessage(msg.message_id);
});

// Firebase RS commands
for (let i = 1; i <= 4; i++) {
  bot.command(`setrs${i === 1 ? '' : i}`, requireAllowedGroup, async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
    const text = ctx.message.text.split(' ').slice(1).join(' ');
    if (!text) return ctx.reply(`Provide a message for rs${i}`);
    await db.collection('config').doc(`rs${i}_${ctx.chat.id}`).set({ message: text }, { merge: true });
    ctx.reply(`✅ RS${i} updated.`);
  });

  bot.command(`rs${i}`, requireAllowedGroup, async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
    const doc = await db.collection('config').doc(`rs${i}_${ctx.chat.id}`).get();
    if (doc.exists && doc.data().message) {
      const msg = await ctx.reply(doc.data().message);
      await ctx.pinChatMessage(msg.message_id);
    } else {
      ctx.reply(`RS${i} not set. Use /setrs${i === 1 ? '' : i} to set it.`);
    }
  });
}

bot.command('settings', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('⚙️ Group Settings:\n- Auto Start: OFF\n- Pin Interval: 20m');
});

bot.command('setwelcome', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  await db.collection('config').doc(`welcome_${ctx.chat.id}`).set({ message: text, enabled: true }, { merge: true });
  ctx.reply('✅ Welcome message updated.');
});

bot.command('welcome', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  const docRef = db.collection('config').doc(`welcome_${ctx.chat.id}`);
  const doc = await docRef.get();
  const current = doc.exists ? doc.data().enabled : false;
  await docRef.set({ enabled: !current }, { merge: true });
  ctx.reply(`✅ Welcome message ${!current ? 'ENABLED' : 'DISABLED'}.`);
});

bot.command('anonmode', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('Anonymous admin mode toggled (placeholder).');
});

bot.command('refresh_admins', requireAllowedGroup, async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('✅ Admins list refreshed from Telegram.');
});

bot.command('links', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('Use this in DM.');
  ctx.reply('Group ID required for fetching links in DM.');
});

bot.command('panel', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('🎛️ Bot Owner Panel\nUse /managegroups, /msg, etc.');
});

bot.command('managegroups', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply(`Allowed Groups: \n${ALLOWED_GROUP_IDS.join('\n')}`);
});

bot.command('addgroup', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('To add a group persistently, update Firebase allowed_groups collection (Impl skipped for brevity).');
});

bot.command('removegroup', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('To remove a group persistently, update Firebase allowed_groups collection.');
});

bot.command('addbotadmin', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('Added global bot admin.');
});

bot.command('removebotadmin', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('Removed global bot admin.');
});

bot.command('listbotadmins', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  ctx.reply('List of global bot admins (placeholder).');
});

bot.command('msg', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) { await ctx.deleteMessage(); return; }
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return ctx.reply('Please provide a message.');
  let sent = 0;
  for (const gId of ALLOWED_GROUP_IDS) {
    try {
      await ctx.telegram.sendMessage(gId, text);
      sent++;
    } catch(e) {}
  }
  ctx.reply(`✅ Broadcasted to ${sent} groups.`);
});

// ===============================================

bot.on('message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;
  if (ctx.from.id === ctx.botInfo.id) return;

  const groupId = ctx.chat.id;
  const userId = ctx.from.id.toString();
  
  // Check if user is admin - COMPLETELY IGNORE ADMINS
  const isUserAdmin = await isAdmin(ctx, userId);
  if (isUserAdmin) {
    return; // Skip all processing for admins
  }
  
  let groupData = await getGroupData(groupId);
  
  cleanupExpiredMutes(groupData);
  
  // SLOT PHASE: Handle X links (only regular users)
  if (groupData.state === BOT_STATES.SLOT_OPEN) {
    const messageText = ctx.message.text || '';
    
    // Check if user already dropped a link
    if (groupData.userLinks.has(userId)) {
      // User already dropped a link, delete any new message
      await ctx.deleteMessage();
      
      // If it's another X link, mute them
      if (isXLink(messageText)) {
        await muteUser(ctx, groupData, userId, null, 30);
        await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - multiple links detected.`);
        await saveGroupData(groupId, groupData);
      }
      return;
    }
    
    // Handle X link submission
    if (isXLink(messageText)) {
      const xUsername = await extractUsernameFromXLink(messageText);
      
      if (!xUsername) {
        await ctx.deleteMessage();
        await ctx.reply('Invalid X link format. Use format: https://x.com/username/status/123456789');
        return;
      }
      
      // Check if X username is already in muted list (from Firebase)
      const isMutedInFirebase = await isUserMutedXUsername(groupId, xUsername);
      const isMutedInMemory = groupData.mutedXUsernames.has(xUsername.toLowerCase());
      
      if (isMutedInFirebase || isMutedInMemory) {
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, userId, xUsername, 30);
        await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - used muted user's X link (@${xUsername}).`);
        await saveGroupData(groupId, groupData);
        return;
      }
      
      // Check if another user already used this X username
      let duplicateFound = false;
      let duplicateUserId = null;
      let duplicateUserData = null;
      
      for (const [otherUserId, otherUserData] of groupData.userLinks.entries()) {
        if (otherUserData.xUsername.toLowerCase() === xUsername.toLowerCase()) {
          duplicateFound = true;
          duplicateUserId = otherUserId;
          duplicateUserData = otherUserData;
          break;
        }
      }
      
      if (duplicateFound) {
        await ctx.deleteMessage();
        
        // Mute both users
        await muteUser(ctx, groupData, duplicateUserId, xUsername, 30);
        await muteUser(ctx, groupData, userId, xUsername, 30);
        
        await ctx.reply(`🔇 @${duplicateUserData?.tgUsername || 'User1'} and @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - same X username (@${xUsername}) detected.`);
        
        await saveGroupData(groupId, groupData);
        return;
      }
      
      // ✅ DELETE USER'S ORIGINAL MESSAGE
      await ctx.deleteMessage();
      
      // ✅ BOT REPOSTS THE LINK (prevents editing)
      const userDisplayName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      const botMessage = await ctx.reply(`${messageText}`);
      
      // Save valid link data
      groupData.userLinks.set(userId, {
        tgUsername: ctx.from.username || ctx.from.first_name,
        tgUserId: userId,
        xUsername: xUsername,
        link: messageText,
        botMessageId: botMessage.message_id, // Store bot's message ID
        timestamp: new Date()
      });
      
      groupData.linkCount++;
      await saveGroupData(groupId, groupData);
      
    } else {
      // Not an X link, delete it and mute user for 5 minutes
      await ctx.deleteMessage();
      await muteUser(ctx, groupData, userId, null, 5);
      await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 5 minutes - only X links allowed during slot phase.`);
      await saveGroupData(groupId, groupData);
    }
  }
  
  // CHECKING PHASE: Handle media submissions (only regular users)
  else if (groupData.state === BOT_STATES.CHECKING) {
    // Check if user dropped a link in slot phase
    if (!groupData.userLinks.has(userId)) {
      await ctx.deleteMessage();
      return;
    }
    
    // Check if user is in SR list
    let isInSRList = false;
    let srNumber = null;
    for (const [number, data] of groupData.srList.entries()) {
      if (data.userId === userId) {
        isInSRList = true;
        srNumber = number;
        break;
      }
    }
    
    // Check if it's a VIDEO
    const hasVideo = ctx.message.video || ctx.message.video_note;
    
    if (hasVideo) {
      const linkData = groupData.userLinks.get(userId);
      const xUsername = linkData ? linkData.xUsername : 'N/A';
      const userDisplayName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      const userSubmittedLink = linkData ? linkData.link : 'No link found';
      
      if (isInSRList) {
        await ctx.reply(`${userDisplayName} (X: @${xUsername}) submitted new proof. SR list (#${srNumber}) - wait for admin approval`);
      } else {
        // Add to safe users (only for videos)
        groupData.safeUsers.set(userId, {
          tgUsername: ctx.from.username || ctx.from.first_name,
          tgUserId: userId,
          xUsername: xUsername,
          timestamp: new Date(),
          approved: true,
          submittedLink: userSubmittedLink
        });
        
        // Show the link they submitted during slot phase
        await ctx.reply(`${userDisplayName} (X: @${xUsername}) Your Video Recieved, Marked Safe ✅\n\n🔗 Your submitted link:\n${userSubmittedLink}`);
        await saveGroupData(groupId, groupData);
      }
    } else {
      // Not a video (could be photo, document, text, etc.), delete text messages but keep media
      if (ctx.message.text) {
        // Delete text messages
        await ctx.deleteMessage();
      }
      // Photos and other media are ignored (not deleted, not added to safe list)
    }
  }
});

// ============= AUTO RESTART ON ERROR =============
function startBot() {
  bot.launch().then(() => {
    console.log('🤖 Bot started successfully at', new Date().toLocaleString());
  }).catch((error) => {
    console.error('❌ Error launching bot:', error);
    console.log('🔄 Attempting to restart in 5 seconds...');
    
    // Auto-restart after 5 seconds
    setTimeout(() => {
      console.log('🔄 Restarting bot...');
      startBot();
    }, 5000);
  });
}

// Start 
startBot();

// ============= GLOBAL ERROR HANDLER =============
process.on('uncaughtException', (error) => {
  console.error('🚨 UNCAUGHT EXCEPTION:', error);
  console.log('🔄 Bot will restart in 10 seconds...');
  
  setTimeout(() => {
    console.log('🔄 Restarting due to uncaught exception...');
    bot.stop();
    startBot();
  }, 3000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 UNHANDLED REJECTION at:', promise, 'reason:', reason);
  // Don't restart for unhandled rejections, just log
});

// ============= GRACEFUL SHUTDOWN =============
process.once('SIGINT', () => {
  console.log('🛑 Received SIGINT. Stopping bot gracefully...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 Received SIGTERM. Stopping bot gracefully...');
  bot.stop('SIGTERM');
});
// ============= GRACEFUL SHUTDOWN =============
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
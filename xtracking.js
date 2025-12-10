const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./firebase.js');
require('dotenv').config();
const axios = require('axios');
const bot = new Telegraf(process.env.BOT_TEST);

// ============= CONSTANTS & CONFIGURATION =============
const BOT_STATES = {
  IDLE: 'idle',
  SLOT_OPEN: 'slot_open',
  CHECKING: 'checking',
  CLOSED: 'closed',
  LOCKED: 'locked'
};

const PIN_INTERVAL = 20; // minutes
const ALLOWED_GROUP_IDS = [-1003432835643];
const cronJobs = new Map();
const groupDataCache = new Map();

// ============= UTILITY FUNCTIONS =============
function isGroupAllowed(groupId) {
  return ALLOWED_GROUP_IDS.includes(groupId);
}

function requireAllowedGroup(ctx, next) {
  if (!ctx.chat || ctx.chat.type === 'private') {
    return next();
  }
  
  if (!isGroupAllowed(ctx.chat.id)) {
    console.log(`Blocked access from unauthorized group: ${ctx.chat.id} - ${ctx.chat.title}`);
    return;
  }
  
  return next();
}

const isXLink = (text) => {
  if (!text || typeof text !== 'string') return false;
  return /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/.+/i.test(text);
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

// ============= DATABASE FUNCTIONS =============
const getTrackingLink = async (groupId) => {
  try {
    const doc = await db.collection('groupTrackingLinks').doc(groupId.toString()).get();
    if (doc.exists) {
      const data = doc.data();
      return data.link || 'https://x.com/always_alpha007';
    }
    return 'https://x.com/always_alpha007';
  } catch (error) {
    console.error('Error getting tracking link:', error);
    return 'https://x.com/always_alpha007';
  }
};

const setTrackingLink = async (groupId, link) => {
  try {
    await db.collection('groupTrackingLinks').doc(groupId.toString()).set({
      link: link,
      updatedAt: new Date().toISOString(),
      updatedBy: 'admin'
    }, { merge: true });
    return true;
  } catch (error) {
    console.error('Error setting tracking link:', error);
    return false;
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
    updatedAt: new Date(),
    locked: false
  };
};

const getGroupData = async (groupId) => {
  if (groupDataCache.has(groupId)) {
    return groupDataCache.get(groupId);
  }

  try {
    const doc = await db.collection('groups').doc(groupId.toString()).get();
    if (doc.exists) {
      const data = doc.data();
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
        currentPinnedMessageId: data.currentPinnedMessageId || null,
        locked: data.locked || false,
        createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
        updatedAt: data.updatedAt ? new Date(data.updatedAt) : new Date()
      };
      
      groupDataCache.set(groupId, processedData);
      return processedData;
    }
    
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
      locked: data.locked || false,
      deadline: data.deadline || null,
      createdAt: data.createdAt ? data.createdAt.toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await db.collection('groups').doc(groupId.toString()).set(firebaseData, { merge: true });
    groupDataCache.set(groupId, data);
  } catch (error) {
    console.error('Error saving group data:', error);
  }
};

// ============= X LINK PARSING FUNCTIONS =============
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
    if (u.includes("imprint") || u.includes("privacy") || u.includes("html")) return null;
    if (!/^[a-z0-9_]{1,25}$/i.test(u)) return null;

    return u;
  };

  // Direct URL extraction
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

  // Extract tweet ID
  const matchId = url.match(/\/status\/(\d+)/i) || url.match(/\/i\/status\/(\d+)/i);
  if (!matchId) return null;
  const tweetId = matchId[1];

  try {
    // Try oEmbed
    const r = await axios.get(
      `https://publish.twitter.com/oembed?url=https://twitter.com/i/status/${tweetId}`,
      { timeout: 6000 }
    );
    const m = r.data?.author_url?.match(/twitter\.com\/([^\/]+)/i);
    const valid = cleanUsername(m?.[1]);
    if (valid) return valid;
  } catch {}

  try {
    // Try Syndication API
    const r = await axios.get(
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}`,
      { timeout: 6000 }
    );
    const valid = cleanUsername(r.data?.user?.screen_name);
    if (valid) return valid;
  } catch {}

  return null;
};

// ============= UPDATED GET TARGET USER FUNCTION =============
async function getTargetUser(ctx) {
    const msg = ctx.message;
    const chatId = ctx.chat.id;

    if (!msg || !msg.text) return null;

    // 1️⃣ Reply user - most accurate
    if (msg.reply_to_message && msg.reply_to_message.from) {
        return msg.reply_to_message.from;
    }

    // 2️⃣ Text mention entity (Telegram provides full user object)
    if (msg.entities) {
        for (let e of msg.entities) {
            if (e.type === "text_mention" && e.user) {
                return e.user;
            }
        }
    }

    let username = null;

    // 3️⃣ Read @username mention (safe)
    if (msg.entities) {
        for (let e of msg.entities) {
            if (e.type === "mention") {
                username = msg.text.substring(e.offset + 1, e.offset + e.length);
            }
        }
    }

    // 4️⃣ Or read second argument (/cmd @username)
    if (!username) {
        const parts = msg.text.split(" ");
        if (parts[1] && parts[1].startsWith("@")) {
            username = parts[1].substring(1);
        }
    }

    if (!username) return null;

    username = username.toLowerCase();

    // 5️⃣ 🔥 GET ALL CHAT MEMBERS & MATCH USERNAME
    try {
        const admins = await ctx.telegram.getChatAdministrators(chatId);

        // Try admin list first
        let found = admins.find(m =>
            m.user.username &&
            m.user.username.toLowerCase() === username
        );

        if (found) return found.user;
    } catch (err) {
        console.log("Error reading admin list:", err.message);
    }

    // 6️⃣ 
    try {
        const member = await ctx.telegram.getChatMember(chatId, ctx.from.id);
        if (member && member.user) {
            // Bots cannot list all members
            // Only admin list + reply + text mention works
        }
    } catch {}

    // 
    return null;
}


const isUserMutedXUsername = async (groupId, xUsername) => {
  try {
    if (!xUsername || typeof xUsername !== 'string') return false;
    
    const xUsernameLower = xUsername.toLowerCase();
    const doc = await db.collection('mutedUsers').doc(`${groupId}_${xUsernameLower}`).get();
    
    if (doc.exists) {
      const data = doc.data();
      const expiresAt = new Date(data.expiresAt);
      if (expiresAt > new Date()) {
        return true;
      } else {
        await db.collection('mutedUsers').doc(`${groupId}_${xUsernameLower}`).delete();
        return false;
      }
    }
    return false;
  } catch (error) {
    console.error('Error checking muted user:', error);
    return false;
  }
};

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
      
      await saveMutedUserToFirebase(ctx.chat.id, xUsername, tgUsername, ctx.from.id);
    }
    
    const userData = groupData.userLinks.get(userId.toString());
    if (userData && userData.botMessageId) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, userData.botMessageId);
        userData.botMessageId = null;
      } catch (error) {
        console.error('Error deleting bot message:', error);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error muting user:', error);
    return false;
  }
};

const saveMutedUserToFirebase = async (groupId, xUsername, tgUsername, mutedBy, reason = '') => {
  try {
    let tgUserId = null;
    const groupData = await getGroupData(groupId);
    
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
    console.error('Error saving muted user:', error);
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

const muteAllUsers = async (ctx, groupData, groupId) => {
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
};

// ============= CRON JOB FUNCTIONS =============
const startSlotReminderJob = (ctx, groupId) => {
  const job = cron.schedule(`*/${PIN_INTERVAL} * * * *`, async () => {
    const currentGroupData = await getGroupData(groupId);
    if (currentGroupData.state === BOT_STATES.SLOT_OPEN && !currentGroupData.locked) {
      try {
        const reminderMsg = await ctx.telegram.sendMessage(groupId, 'keep dropping your X links!');
        
        if (currentGroupData.currentPinnedMessageId) {
          try {
            await ctx.telegram.unpinChatMessage(groupId, currentGroupData.currentPinnedMessageId);
          } catch (error) {
            console.log('Could not unpin previous message:', error);
          }
        }
        
        await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id);
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
        const now = new Date();
        const deadlineDate = new Date(currentGroupData.deadline);
        const minsLeft = Math.floor((deadlineDate - now) / 60000);
        const hrs = Math.floor(minsLeft / 60);
        const mins = minsLeft % 60;
        const istDate = deadlineDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

        const reminderMsgText =
          `⚡ *Complete your task before deadline*\n` +
          `⏳ *Time Remaining:* ${hrs} hr ${mins} mins\n`;

        const reminderMsg = await ctx.telegram.sendMessage(groupId, reminderMsgText, { parse_mode: "Markdown" });

        if (currentGroupData.currentPinnedMessageId) {
          try {
            await ctx.telegram.unpinChatMessage(groupId, currentGroupData.currentPinnedMessageId);
          } catch (error) {
            console.log('Could not unpin previous message:', error);
          }
        }

        await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id);
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

// ============= HELPER FUNCTIONS =============
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

// ============= BOT COMMANDS =============
bot.command('open', requireAllowedGroup, async (ctx) => {
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
  
  try {
    const currentTitle = ctx.chat.title;
    const baseTitle = currentTitle.replace(/\s*\|\|.*/, '');
    await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || OPEN`);
  } catch (error) {
    console.log('No permission to change group name');
  }
  
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
  
  const trackingLink = await getTrackingLink(groupId);
  groupData.state = BOT_STATES.CHECKING;
  groupData.locked = false;

  try {
    const currentTitle = ctx.chat.title;
    const baseTitle = currentTitle.replace(/\|\|.*/, '').trim();
    await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || TRACKING`);
  } catch (error) {
    console.log('No permission to change group name');
  }

  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: false,
    can_send_videos: true,
    can_send_photos: true
  });

  // Deadline calculation (1hr 30mins)
  const now = new Date();
  const deadlineDate = new Date(now.getTime() + 90 * 60 * 1000);
  const istDate = deadlineDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
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

  const sentMessage = await ctx.reply(checkMsg, { parse_mode: "HTML" });
  await ctx.pinChatMessage(sentMessage.message_id);

  groupData.currentPinnedMessageId = sentMessage.message_id;
  groupData.deadline = deadlineDate.getTime();
  await saveGroupData(groupId, groupData);

  // Auto-lock after deadline
  setTimeout(async () => {
    const updated = await getGroupData(groupId);
    if (updated.state === BOT_STATES.CHECKING) {
      updated.locked = true;
      updated.state = BOT_STATES.LOCKED;
      await saveGroupData(groupId, updated);

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

      await ctx.reply("🔒 Group locked — checking time is over.");
      
      try {
        await muteAllUsers(ctx, updated, groupId);
        await ctx.reply("🔇 All scam users + SR users have been automatically muted for 2 days.");
      } catch (err) {
        console.error("MuteAll auto-exec failed:", err);
      }
    }
  }, 90 * 60 * 1000);

  startCheckingReminderJob(ctx, groupId);
});

bot.command('loc', requireAllowedGroup, async (ctx) => {
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

    groupData.locked = true;
    await saveGroupData(groupId, groupData);
    stopCronJobs(groupId);

    try {
      const currentTitle = ctx.chat.title;
      const baseTitle = currentTitle.replace(/\|\|.*/, '').trim();
      await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || LOCKED`);
    } catch (error) {
      console.log('No permission to change group name:', error);
    }

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

bot.command('end', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  // Delete all bot messages
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
  
  try {
    const currentTitle = ctx.chat.title;
    const baseTitle = currentTitle.replace(/\|\|.*/, '').trim();
    await ctx.telegram.setChatTitle(ctx.chat.id, `${baseTitle} || CLOSED`);
  } catch (error) {
    console.log('No permission to change group name');
  }
  
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
  
  stopCronJobs(groupId);
  
  // Clear all data except muted users
  groupData.userLinks.clear();
  groupData.safeUsers.clear();
  groupData.scamUsers.clear();
  groupData.srList.clear();
  groupData.mutedUsers.clear();
  groupData.linkCount = 0;
  groupData.srCounter = 1;
  groupData.currentPinnedMessageId = null;
  groupData.locked = false;
  
  await saveGroupData(groupId, groupData);
  ctx.reply('✅ Slot ended. All bot messages deleted. All data cleared.');
});

bot.command('rl', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
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

bot.command('help', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
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
⚠️ *IMPORTANT NOTES*
━━━━━━━━━━━━━━━━━━
• Checking phase auto-locks after 1.5 hours
• Auto-mutes scam/SR users after deadline
• X bans last 2 days (persistent)
• Admin messages are ignored by bot
• Most commands require replying to user

⏰ *TIMING REFERENCE*
• 30 = 30 minutes
• 2h = 2 hours
• 1d = 1 day
• 2d = 2 days (X bans)`;

  await ctx.reply(helpMessage, { parse_mode: "Markdown" });
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

// ============= IMPROVED CLEAR COMMAND =============
bot.command('clear', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  try {
    const commandMessageId = ctx.message.message_id;
    const progressMsg = await ctx.reply('🧹 Starting to clear messages... (0 deleted)');
    
    let deletedCount = 0;
    const MAX_ATTEMPTS = 500; // Maximum messages to attempt deleting
    const BATCH_SIZE = 20; // Delete in batches
    const DELAY_MS = 2000; // Delay between batches
    
    // Start from the most recent message before the command
    let currentMessageId = commandMessageId - 1;
    
    while (currentMessageId > 0 && deletedCount < MAX_ATTEMPTS) {
      let batchDeleted = 0;
      
      // Try to delete a batch of messages
      for (let i = 0; i < BATCH_SIZE && currentMessageId > 0; i++) {
        try {
          await ctx.telegram.deleteMessage(groupId, currentMessageId);
          deletedCount++;
          batchDeleted++;
          currentMessageId--;
        } catch (error) {
          if (error.response && error.response.error_code === 400) {
            // Message too old or doesn't exist, skip it
            currentMessageId--;
            continue;
          } else {
            // Other error (permission, rate limit), wait and try again
            console.log(`Delete error at message ${currentMessageId}:`, error.message);
            break;
          }
        }
      }
      
      // Update progress every batch
      if (deletedCount > 0 && (deletedCount % 20 === 0 || batchDeleted === 0)) {
        try {
          await ctx.telegram.editMessageText(
            groupId,
            progressMsg.message_id,
            null,
            `🧹 Clearing... ${deletedCount} messages deleted so far`
          );
        } catch (error) {
          console.log('Could not update progress:', error.message);
        }
      }
      
      // If we couldn't delete any in this batch, we've hit the limit
      if (batchDeleted === 0) {
        break;
      }
      
      // Wait between batches to avoid rate limits
      if (currentMessageId > 0 && deletedCount < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }
    
    // Final result
    const resultMsg = await ctx.reply(`✅ Successfully cleared ${deletedCount} messages.`);
    
    // Clean up after 5 seconds
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(groupId, commandMessageId);
        await ctx.telegram.deleteMessage(groupId, progressMsg.message_id);
        await ctx.telegram.deleteMessage(groupId, resultMsg.message_id);
      } catch (error) {
        console.log('Cleanup error:', error.message);
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
// ============= ADS COMMAND (Add to safe list during slot phase) =============
bot.command('ads', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Only admins can use /ads
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  // Check if we're in slot phase
  if (groupData.state !== BOT_STATES.CHECKING) {
    return ctx.reply('❌ /ads command only works during slot phase (when slot is OPEN).');
  }
  
  // Must reply to a user's message
  if (!ctx.message.reply_to_message) {
    return ctx.reply('❌ Please reply to a user\'s message with /ads to add them to safe list.');
  }
  
  const targetUser = ctx.message.reply_to_message.from;
  const targetUserId = targetUser.id.toString();
  
  // Check if target user is admin
  if (await isAdmin(ctx, targetUser.id)) {
    return ctx.reply('❌ Cannot use /ads on administrators.');
  }
  
  // Check if replied message has a photo
  if (!ctx.message.reply_to_message.photo) {
    return ctx.reply('❌ Please reply to a user\'s PHOTO message with /ads.');
  }
  
  // Check if user has submitted an X link
  if (!groupData.userLinks.has(targetUserId)) {
    return ctx.reply(`❌ @${targetUser.username || targetUser.first_name} has not submitted any X link yet.`);
  }
  
  // Get user's X link data
  const userLinkData = groupData.userLinks.get(targetUserId);
  
  // Check if user is already in safe list
  if (groupData.safeUsers.has(targetUserId)) {
    return ctx.reply(`✅ @${targetUser.username || targetUser.first_name} is already in the safe list.`);
  }
  
  // Remove from scam list if exists
  if (groupData.scamUsers.has(targetUserId)) {
    groupData.scamUsers.delete(targetUserId);
  }
  
  // Remove from SR list if exists
  let removedFromSR = false;
  for (const [number, data] of groupData.srList.entries()) {
    if (data.userId === targetUserId) {
      groupData.srList.delete(number);
      removedFromSR = true;
      break;
    }
  }
  
  // Add to safe users list
  groupData.safeUsers.set(targetUserId, {
    tgUsername: targetUser.username || targetUser.first_name,
    tgUserId: targetUserId,
    xUsername: userLinkData.xUsername,
    timestamp: new Date(),
    approved: true,
    approvedBy: ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name,
    approvedAt: new Date(),
    submittedLink: userLinkData.link
  });
  
  await saveGroupData(groupId, groupData);
  
  // Send confirmation message
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const userName = targetUser.username ? `@${targetUser.username}` : targetUser.first_name;
  
  let confirmationMsg = `✅ ${userName} has been added to safe list.\n`;
  
  if (removedFromSR) {
    confirmationMsg += `📋 Removed from SR list\n`;
  }
 
  await ctx.reply(confirmationMsg);
  
  // Optional: Delete the admin's command message
  try {
    await ctx.deleteMessage();
  } catch (error) {
    console.log('Could not delete command message:', error.message);
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


// ============= IMPROVED BAN COMMAND =============
bot.command('ban', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(/\s+/).filter(arg => arg.trim());
  let targetUser = null;
  let reason = '';
  
  // Try to get target user from reply
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.from) {
    targetUser = ctx.message.reply_to_message.from;
    reason = args.slice(1).join(' ');
  } else {
    // Try to get from arguments
    targetUser = await getTargetUser(ctx);
    if (targetUser) {
      // Extract reason (skip command and user identifier)
      let foundUserIndex = -1;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('@') || /^\d+$/.test(arg)) {
          foundUserIndex = i;
          break;
        }
      }
      
      if (foundUserIndex !== -1) {
        reason = args.slice(foundUserIndex + 1).join(' ');
      }
    }
  }
  
  if (!targetUser) {
    return ctx.reply('❌ Please reply to a user, mention @username, or provide user ID.\n\nUsage: /ban [reason]');
  }
  
  // Check if trying to ban self
  if (targetUser.id === userId) {
    return ctx.reply('❌ You cannot ban yourself.');
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

// ============= IMPROVED UNBAN COMMAND =============
bot.command('unban', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(/\s+/).filter(arg => arg.trim());
  
  if (args.length < 2) {
    return ctx.reply('❌ Please provide username or user ID to unban.\n\nUsage: /unban @username or /unban 123456');
  }
  
  const identifier = args[1].replace('@', '').trim();
  
  if (!identifier) {
    return ctx.reply('❌ Invalid identifier provided.');
  }
  
  try {
    // First try as user ID
    let userIdToUnban = null;
    
    if (/^\d+$/.test(identifier)) {
      userIdToUnban = parseInt(identifier);
    } else {
      // Try to get user ID from username
      try {
        // Check if user is in the group (for active members)
        const chatMember = await ctx.telegram.getChatMember(groupId, identifier);
        userIdToUnban = chatMember.user.id;
      } catch (error) {
        // User not in group, try unbanning with username
        userIdToUnban = identifier;
      }
    }
    
    // Try to unban
    await ctx.unbanChatMember(userIdToUnban);
    
    const userName = args[1].startsWith('@') ? args[1] : `User ID: ${identifier}`;
    await ctx.reply(`✅ ${userName} has been unbanned.\n👤 Unbanned by: ${ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name}`);
    
  } catch (error) {
    console.error('Error unbanning user:', error);
    
    // Try alternative approach
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

// ============= IMPROVED XMUTE COMMAND =============
bot.command('xmute', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(/\s+/).filter(arg => arg.trim());
  
  if (args.length < 2) {
    return ctx.reply('Usage: /xmute @xusername [duration] [reason]\n\nExamples:\n/xmute @example - Mute for default 30 minutes\n/xmute @example 2h - Mute for 2 hours\n/xmute @example 1d Spamming - Mute for 1 day with reason');
  }
  
  // Extract X username from command
  const xUsernameInput = args[1].replace('@', '').toLowerCase().trim();
  if (!xUsernameInput) {
    return ctx.reply('❌ Please provide a valid X username.\nUsage: /xmute @xusername [duration] [reason]');
  }
  
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
  let durationMinutes = 30;
  
  if (durationStr) {
    if (durationStr.endsWith('h')) {
      const hours = parseInt(durationStr) || 1;
      durationMinutes = hours * 60;
    } else if (durationStr.endsWith('d')) {
      const days = parseInt(durationStr) || 1;
      durationMinutes = days * 24 * 60;
    } else if (durationStr.endsWith('m')) {
      durationMinutes = parseInt(durationStr) || 30;
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
    
    // Escape special Markdown characters in the link
    let safeLink = foundLink || '';
    if (safeLink) {
      // Escape underscores and other Markdown special characters
      safeLink = safeLink.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
    }
    
    let message = `🔇 *X Username Mute*\n`;
    message += `🐦 *X Account:* @${xUsernameInput}\n`;
    message += `👤 *Telegram User:* ${escapeMarkdown(displayName)}\n`;
    message += `⏰ *Duration:* ${durationText}\n`;
    
    if (foundLink) {
      // Truncate long links for display
      const displayLink = safeLink.length > 50 ? safeLink.substring(0, 47) + '...' : safeLink;
      message += `🔗 *Submitted Link:* ${displayLink}\n`;
    }
    
    if (reason) {
      message += `📝 *Reason:* ${escapeMarkdown(reason)}\n`;
    }
    
    const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    message += `━━━━━━━━━━━━━━━━━━\n👮 *Muted by:* ${escapeMarkdown(adminName)}`;
    
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

// ============= HELPER FUNCTION TO ESCAPE MARKDOWN =============
function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ============= IMPROVED XUNMUTE COMMAND =============
bot.command('xunmute', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(/\s+/).filter(arg => arg.trim());
  
  if (args.length < 2) {
    return ctx.reply('Usage: /xunmute @xusername\n\nExample: /xunmute @example');
  }
  
  // Extract X username from command
  const xUsernameInput = args[1].replace('@', '').toLowerCase().trim();
  if (!xUsernameInput) {
    return ctx.reply('❌ Please provide a valid X username.\nUsage: /xunmute @xusername');
  }
  
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
    
    const message = `🔊 *X Username Unmute*\n` +
                   `🐦 *X Account:* @${xUsernameInput} tg:${escapeMarkdown(displayName || 'User')}`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error unmuting user:', error);
    await ctx.reply('❌ Error');
  }
});

// ============= IMPROVED XBAN COMMAND =============
bot.command('xban', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const args = ctx.message.text.split(/\s+/).filter(arg => arg.trim());
  
  if (args.length < 2) {
    return ctx.reply('❌ Usage: /xban <x_username> [reason]\n\nExamples:\n/xban username\n/xban username Spamming\n\nThis bans the user who submitted this X username during slot phase.');
  }
  
  const xUsername = args[1].replace('@', '').toLowerCase().trim();
  if (!xUsername) {
    return ctx.reply('❌ Please provide a valid X username.');
  }
  
  const reason = args.slice(2).join(' ') || 'No reason provided';
  
  let groupData = await getGroupData(groupId);
  
  // Find user by X username in userLinks
  let targetUserId = null;
  let targetTGUsername = null;
  
  // Search through userLinks for matching X username
  for (const [tgUserId, userData] of groupData.userLinks.entries()) {
    if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
      targetUserId = tgUserId;
      targetTGUsername = userData.tgUsername;
      break;
    }
  }
  
  if (!targetUserId) {
    // Try searching in safeUsers and scamUsers
    for (const [tgUserId, userData] of groupData.safeUsers.entries()) {
      if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
        targetUserId = tgUserId;
        targetTGUsername = userData.tgUsername;
        break;
      }
    }
    
    if (!targetUserId) {
      for (const [tgUserId, userData] of groupData.scamUsers.entries()) {
        if (userData.xUsername && userData.xUsername.toLowerCase() === xUsername) {
          targetUserId = tgUserId;
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
    try {
      await ctx.telegram.getChatMember(groupId, targetUserId);
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
    await saveMutedUserToFirebase(groupId, xUsername, targetTGUsername, ctx.from.id, reason);
    
    await saveGroupData(groupId, groupData);
    
    const message = `🚫 *X Username Ban*\n\n` +
      `❌ *X Username:* @${xUsername} tg: ${escapeMarkdown(targetTGUsername)} has been banned.\n`;
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    
  } catch (error) {
    console.error('Error in xban command:', error);
    await ctx.reply(`❌ Failed to ban user with X username: @${xUsername}\nError: ${error.message}`);
  }
});

// ============= SETLINK COMMAND =============
bot.command('setlink', async (ctx) => {
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

  const success = await setTrackingLink(groupId, newLink);
  
  if (success) {
    await ctx.reply(`✅ Tracking link updated for this group:\n${newLink}\n\nThis link will be shown during checking phase.`);
  } else {
    await ctx.reply('❌ Failed to update tracking link.');
  }
});

// ============= XUNBAN COMMAND - UNBAN BY X USERNAME =============
bot.command('xunban', async (ctx) => {
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
    const message = `✅ *X Username Unban *\n\n` +
      `✅ *X Username:* @${xUsername} has been unbanned.\n`;
    
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
bot.command('xban', async (ctx) => {
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
bot.command('xunban', async (ctx) => {
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



// ============= MESSAGE HANDLERS =============
// ============= MESSAGE HANDLERS =============
bot.on('message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;
  if (ctx.from.id === ctx.botInfo.id) return;

  const groupId = ctx.chat.id;
  const userId = ctx.from.id.toString();
  
  const isUserAdmin = await isAdmin(ctx, userId);
  if (isUserAdmin) {
    return;
  }
  
  let groupData = await getGroupData(groupId);
  cleanupExpiredMutes(groupData);
  
  // SLOT PHASE - ALLOW CHATTING, ONLY REGULATE X LINKS
  if (groupData.state === BOT_STATES.SLOT_OPEN) {
    const messageText = ctx.message.text || '';
    
    // If user has already dropped an X link
    if (groupData.userLinks.has(userId)) {
      // User already submitted an X link, check if they're trying to submit another
      if (isXLink(messageText)) {
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, userId, null, 30);
        await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - multiple X links detected.`);
        await saveGroupData(groupId, groupData);
      }
      // If it's not an X link, allow chatting (don't delete or mute)
      return;
    }
    
    // User hasn't submitted an X link yet
    if (isXLink(messageText)) {
      const xUsername = await extractUsernameFromXLink(messageText);
      
      if (!xUsername) {
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, userId, null, 5);
        await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 5 minutes - invalid X link format.`);
        await saveGroupData(groupId, groupData);
        return;
      }
      
      // Check if X username is muted
      if (xUsername) {
        const isMutedInFirebase = await isUserMutedXUsername(groupId, xUsername);
        const isMutedInMemory = groupData.mutedXUsernames.has(xUsername.toLowerCase());
        
        if (isMutedInFirebase || isMutedInMemory) {
          await ctx.deleteMessage();
          await muteUser(ctx, groupData, userId, xUsername, 30);
          await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - used muted user's X link (@${xUsername}).`);
          await saveGroupData(groupId, groupData);
          return;
        }
      }
      
      // Check for duplicate X username
      let duplicateFound = false;
      let duplicateUserId = null;
      let duplicateUserData = null;
      
      for (const [otherUserId, otherUserData] of groupData.userLinks.entries()) {
        if (otherUserData.xUsername && otherUserData.xUsername.toLowerCase() === xUsername.toLowerCase()) {
          duplicateFound = true;
          duplicateUserId = otherUserId;
          duplicateUserData = otherUserData;
          break;
        }
      }
      
      if (duplicateFound) {
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, duplicateUserId, xUsername, 30);
        await muteUser(ctx, groupData, userId, xUsername, 30);
        await ctx.reply(`🔇 @${duplicateUserData?.tgUsername || 'User1'} and @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - same X username (@${xUsername}) detected.`);
        await saveGroupData(groupId, groupData);
        return;
      }
      
      // Save valid X link
      groupData.userLinks.set(userId, {
        tgUsername: ctx.from.username || ctx.from.first_name,
        tgUserId: userId,
        xUsername: xUsername,
        link: messageText,
        userMessageId: ctx.message.message_id,
        timestamp: new Date()
      });
      
      groupData.linkCount++;
      await saveGroupData(groupId, groupData);
      
      // Optional: Send confirmation message
      // await ctx.reply(`✅ @${ctx.from.username || ctx.from.first_name} X link saved successfully!`);
      
    } else {
      // If it's not an X link, allow chatting (don't delete or mute)
      // Only regular chatting is allowed
      return;
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
        
        await ctx.reply(`${userDisplayName} (X: @${xUsername}) Your Video Recieved, Marked Safe ✅`);
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

// ============= EDITED MESSAGE HANDLER =============
bot.on('edited_message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.editedMessage.from.id === ctx.botInfo.id) return;

  const groupId = ctx.chat.id;
  const userId = ctx.editedMessage.from.id.toString();
  
  const isUserAdmin = await isAdmin(ctx, userId);
  if (isUserAdmin) return;
  
  let groupData = await getGroupData(groupId);
  
  // Only check during SLOT_OPEN phase for X link edits
  if (groupData.state === BOT_STATES.SLOT_OPEN) {
    const messageText = ctx.editedMessage.text || '';
    
    // Check if this is a tracked X link message
    const userData = groupData.userLinks.get(userId);
    if (userData && userData.userMessageId === ctx.editedMessage.message_id) {
      
      const originalLink = userData.link;
      
      // ANY edit to the X link message triggers punishment
      if (messageText !== originalLink) {
        // Delete the edited message
        await ctx.deleteMessage();
        
        // Also delete bot's verification message if it exists
        if (userData.botMessageId) {
          try {
            await ctx.telegram.deleteMessage(groupId, userData.botMessageId);
          } catch (error) {
            console.error('Error deleting bot message:', error);
          }
        }
        
        // Mute user for 30 minutes for editing their X link
        await muteUser(ctx, groupData, userId, null, 30);
        
        // Remove user from userLinks since they violated
        groupData.userLinks.delete(userId);
        groupData.linkCount = Math.max(0, groupData.linkCount - 1);
        
        const xUsername = userData.xUsername || 'N/A';
        
        await ctx.reply(`🔇 @${ctx.editedMessage.from.username || ctx.editedMessage.from.first_name} muted for 30 minutes - editing your X link is strictly prohibited!\n\nOriginal link was: ${originalLink}`);
        await saveGroupData(groupId, groupData);
      }
    }
  }
});
// ============= EDITED MESSAGE HANDLER =============
bot.on('edited_message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.editedMessage.from.id === ctx.botInfo.id) return;

  const groupId = ctx.chat.id;
  const userId = ctx.editedMessage.from.id.toString();
  
  const isUserAdmin = await isAdmin(ctx, userId);
  if (isUserAdmin) return;
  
  let groupData = await getGroupData(groupId);
  
  if (groupData.state === BOT_STATES.SLOT_OPEN) {
    const messageText = ctx.editedMessage.text || '';
    const userData = groupData.userLinks.get(userId);
    
    if (userData && userData.userMessageId === ctx.editedMessage.message_id) {
      const originalLink = userData.link;
      
      if (messageText !== originalLink) {
        await ctx.deleteMessage();
        
        if (userData.botMessageId) {
          try {
            await ctx.telegram.deleteMessage(groupId, userData.botMessageId);
          } catch (error) {
            console.error('Error deleting bot message:', error);
          }
        }
        
        await muteUser(ctx, groupData, userId, null, 30);
        groupData.userLinks.delete(userId);
        groupData.linkCount = Math.max(0, groupData.linkCount - 1);
        
        const xUsername = userData.xUsername || 'N/A';
        await ctx.reply(`🔇 @${ctx.editedMessage.from.username || ctx.editedMessage.from.first_name} muted for 30 minutes - editing your X link is strictly prohibited!\n\nOriginal link was: ${originalLink}`);
        await saveGroupData(groupId, groupData);
      }
    }
  }
});

// ============= BOT STARTUP =============
function startBot() {
  bot.launch().then(() => {
    console.log('🤖 Bot started successfully at', new Date().toLocaleString());
  }).catch((error) => {
    console.error('❌ Error launching bot:', error);
    console.log('🔄 Attempting to restart in 5 seconds...');
    
    setTimeout(() => {
      console.log('🔄 Restarting bot...');
      startBot();
    }, 5000);
  });
}

// Start bot
startBot();

// ============= ERROR HANDLING =============
process.on('uncaughtException', (error) => {
  console.error('🚨 UNCAUGHT EXCEPTION:', error);
  console.log('🔄 Bot will restart in 10 seconds...');
  
  setTimeout(() => {
    console.log('🔄 Restarting due to uncaught exception...');
    bot.stop();
    startBot();
  }, 10000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// ============= GRACEFUL SHUTDOWN =============
process.once('SIGINT', () => {
  console.log('🛑 Received SIGINT. Stopping bot gracefully...');
  bot.stop('SIGINT');
});

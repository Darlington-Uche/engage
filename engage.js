const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./firebase.js');
const express = require('express');
require('dotenv').config();

const app = express();

// Use webhook instead of polling
const WEBHOOK_DOMAIN = 'https://engage-sobe.onrender.com';
const WEBHOOK_PATH = '/webhook';
const PORT = process.env.PORT || 3000;

// Configure webhook
app.use(express.json());
app.use(bot.webhookCallback(WEBHOOK_PATH));

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

// Set webhook on startup
async function setWebhook() {
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
    console.log('Webhook set successfully');
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
}

// Start server and set webhook
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await setWebhook();
  console.log('Bot started successfully with webhooks');
});


// Initialize Firebase Admin
const serviceAccount = require('./data.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const bot = new Telegraf("8500910728:AAHaRCPCOnaWR0g82pFamKIjKdq9Rq50Fl4");

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
const PIN_INTERVAL = 10; // minutes

// ============= UTILITY FUNCTIONS =============
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

const extractUsernameFromXLink = (url) => {
  const match = url.match(/https?:\/\/x\.com\/([^\/]+)\/status\/[0-9]+/i) || 
                url.match(/https?:\/\/(?:www\.)?x\.com\/([^\/]+)/i) ||
                url.match(/https?:\/\/twitter\.com\/([^\/]+)\/status\/[0-9]+/i) ||
                url.match(/https?:\/\/(?:www\.)?twitter\.com\/([^\/]+)/i);
  return match ? match[1].toLowerCase() : null;
};

const isXLink = (text) => {
  return text && (text.includes('x.com/') || text.includes('twitter.com/'));
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
      updatedAt: new Date()
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

const saveMutedUserToFirebase = async (groupId, xUsername, tgUsername, mutedBy) => {
  try {
    const muteData = {
      xUsername: xUsername.toLowerCase(),
      tgUsername: tgUsername,
      mutedBy: mutedBy,
      mutedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (2 * 24 * 60 * 60 * 1000)).toISOString()
    };
    
    await db.collection('mutedUsers').doc(`${groupId}_${xUsername}`).set(muteData);
  } catch (error) {
    console.error('Error saving muted user to Firebase:', error);
  }
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

/// ============= BOT COMMANDS =============
bot.command('slot', async (ctx) => {
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

  // 🟢 SEND STICKER HERE
  await ctx.replyWithSticker('AgACAgUAAxkBAAE-wfRpMRvIQhcuekoZw6iMAAHfFcJACMMAAggMaxvZcIlVVmtxWMSnNOcBAAMCAANtAAM2BA');  
  // Replace the ID above with your OWN sticker ID

  const welcomeMsg = `🎰 Slot opened! Members can now drop their X links.\n\n` +
    `📌 Rules:\n` +
    `• Drop only ONE X link\n` +
    `• No other messages allowed\n` +
    `• Multiple links not allowed\n` +
    `• Using muted user's link will get you muted too\n\n`;
  
  const sentMessage = await ctx.reply(welcomeMsg);
  await ctx.pinChatMessage(sentMessage.message_id);
  
  groupData.currentPinnedMessageId = sentMessage.message_id;
  await saveGroupData(groupId, groupData);
  
  startSlotReminderJob(ctx, groupId);
});

bot.command('loc', async (ctx) => {
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
  
  // Restrict all users except admins from sending messages
  try {
    
    await ctx.restrictChatMember(groupId, userId, {
  permissions: {}  
});
    
    // Save lock state in your database
    groupData.locked = true;
    await saveGroupData(groupId, groupData);
    
    // Stop reminder jobs
    stopCronJobs(groupId);
    
    await ctx.reply('🔒 Group locked. Reminders stopped. Users cannot send messages.');
    
  } catch (error) {
    console.error('Error locking group:', error);
    await ctx.reply('❌ Failed to lock group. Make sure the bot is an admin with proper permissions.');
  }
});

bot.command('check', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = await getGroupData(groupId);

  if (groupData.state !== BOT_STATES.SLOT_OPEN) {
    return ctx.reply('No active slot session. Use /slot first.');
  }

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
    can_send_photos: false
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
    `⚡ *Checking phase Started*\n` +
    `Drop the video proof of screen record here with AD, or only proof\n\n` +
    `🔗 {timeline link}\n\n` +
    `⏳ *Deadline:* ${hrs} hr ${mins} mins\n` +
    `🕒 *Ends At:* ${istDate} IST\n\n` +
    `📤 *SEND AD, ALL DONE, DONE WITH SR PROOF*\n`;

  const sentMessage = await ctx.reply(checkMsg, { parse_mode: "Markdown" });
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


bot.command('total', async (ctx) => {

  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  ctx.reply(`📊 Total X links dropped: ${groupData.linkCount}`);
});

// ============= NEW COMMAND: /list =============
bot.command('list', async (ctx) => {
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

  let userList = '📋 PARTICIPATION LISTS:\n\n';
  let counter = 1;

  // Sort newest → oldest
  const sortedUsers = Array.from(groupData.userLinks.entries())
    .sort((a, b) => new Date(b[1].timestamp) - new Date(a[1].timestamp));

  for (const [uid, userData] of sortedUsers) {
    const displayName = userData.tgName || userData.tgUsername || "Unknown";
    const xUsername = userData.xUsername || 'N/A';

    // Tag WITHOUT @username → using tg://user?id=
    const mention = `[${displayName}](tg://user?id=${uid})`;

    userList += `${counter}. ${mention} | xid: @${xUsername}\n`;
    counter++;
  }

  userList += `\n📊 Total: ${groupData.userLinks.size} users`;

  // Split long messages
  if (userList.length > 4000) {
    const chunks = userList.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    }
  } else {
    ctx.reply(userList, { parse_mode: "Markdown" });
  }
});

// ============= NEW COMMAND: /clear =============
bot.command('clear', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const commandMessageId = ctx.message.message_id;
  
  // Send initial message
  const progressMsg = await ctx.reply('🧹 Starting to clear messages... (0 deleted)');
  
  let messagesDeleted = 0;
  const BATCH_SIZE = 80;
  const DELAY_BETWEEN_BATCHES = 5000; // 3 seconds
  
  try {
    let lastMessageId = ctx.message.message_id - 1;
    let batchCount = 0;
    let shouldContinue = true;
    
    while (shouldContinue && lastMessageId > 0) {
      batchCount = 0;
      const batchPromises = [];
      
      // Try to delete a batch of messages
      while (batchCount < BATCH_SIZE && lastMessageId > 0) {
        batchPromises.push(
          ctx.telegram.deleteMessage(groupId, lastMessageId).catch(() => {
            // Ignore errors for individual messages
          })
        );
        lastMessageId--;
        batchCount++;
      }
      
      // Wait for batch to complete
      await Promise.all(batchPromises);
      messagesDeleted += batchCount;
      
      // Update progress message
      try {
        await ctx.telegram.editMessageText(
          groupId,
          progressMsg.message_id,
          null,
          `🧹 Clearing messages... (${messagesDeleted} deleted so far)`
        );
      } catch (error) {
        // If we can't edit, send a new message
        try {
          await ctx.telegram.sendMessage(groupId, `🧹 Cleared ${messagesDeleted} messages so far...`);
        } catch (e) {
          // Ignore
        }
      }
      
      // Stop if we've deleted a lot of messages or reached the beginning
      if (messagesDeleted >= 50000 || lastMessageId <= 1) {
        shouldContinue = false;
        break;
      }
      
      // Wait before next batch
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
    
    // Send completion message
    const completionMsg = await ctx.reply(`✅ Successfully cleared ${messagesDeleted} messages.`);
    
    // Clean up command messages after a delay
    setTimeout(async () => {
      try {
        await ctx.telegram.deleteMessage(groupId, commandMessageId);
        await ctx.telegram.deleteMessage(groupId, progressMsg.message_id);
        await ctx.telegram.deleteMessage(groupId, completionMsg.message_id);
      } catch (error) {
        console.error('Error cleaning up clear command messages:', error);
      }
    }, 5000);
    
  } catch (error) {
    console.error('Error in clear command:', error);
    await ctx.reply(`❌ Error clearing messag
        
        s: ${error.message}`);
  }
});
bot.command('link', async (ctx) => {
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

  // Show stored link
  return ctx.reply(
    `🔗 *User's submitted link:*\n${linkData.link}`,
    { parse_mode: "Markdown" }
  );
});


bot.command('safe', async (ctx) => {
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

bot.command('scam', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  const scamUsers = new Map();
  
  // Find users who dropped links but not in safe or SR lists
  for (const [uid, linkData] of groupData.userLinks.entries()) {
    if (!groupData.safeUsers.has(uid) && !groupData.srList.has(uid)) {
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


bot.command('srlist', async (ctx) => {
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


bot.command('sr', async (ctx) => {
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

bot.command('rm', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = await getGroupData(groupId);
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Usage: /rm <number>');
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
      const linkData = groupData.userLinks.get(removedUserId);
      groupData.safeUsers.set(removedUserId, {
        tgUsername: removedUser.tgUsername,
        timestamp: new Date(),
        approved: true,
        xUsername: linkData ? linkData.xUsername : null
      });
      
      await ctx.reply(`✅ Removed user ${number} from SR list and added to safe list.`);
    } else {
      await ctx.reply(`✅ Removed user ${number} from SR list.`);
    }
    
    await saveGroupData(groupId, groupData);
  } else {
    ctx.reply('❌ User not found in SR list.');
  }
});

bot.command('muteall', async (ctx) => {
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

// =========================
// Helper: extract target user
// =========================
async function getTargetUser(ctx) {
  // Case 1 — admin replied to a user
  if (ctx.message.reply_to_message) {
    const u = ctx.message.reply_to_message.from;
    return { id: u.id, username: u.username || null };
  }

  // Case 2 — admin used something like:
  // /mute 123456789
  // /mute @username
  const parts = ctx.message.text.split(" ");
  if (parts.length > 1) {
    const target = parts[1].trim();

    // If begins with @username
    if (target.startsWith("@")) {
      const username = target.replace("@", "");
      try {
        const user = await ctx.telegram.getChatMember(ctx.chat.id, username);
        return { id: user.user.id, username };
      } catch (err) {
        return null;
      }
    }

    // If number → treat as user ID
    if (!isNaN(target)) {
      return { id: target, username: null };
    }
  }

  return null;
}



// =================================
// /mute — default 60 mins or custom
// Usage:
// /mute 10 → mutes replied user 10 mins
// /mute @user 30 → mutes for 30 mins
// =================================
bot.command('mute', async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.deleteMessage();

  const target = await getTargetUser(ctx);
  if (!target) return ctx.reply("❌ Reply to a user or provide @username/userId.");

  const parts = ctx.message.text.split(" ");
  const mins = parts[2] ? parseInt(parts[2]) : (parts[1] && !isNaN(parts[1]) ? parseInt(parts[1]) : 60);

  const until = Math.floor(Date.now() / 1000) + mins * 60;

  await ctx.telegram.restrictChatMember(ctx.chat.id, target.id, {
    can_send_messages: false,
    until_date: until
  });

  ctx.reply(`🔇 Muted [user](tg://user?id=${target.id}) for *${mins} mins*.`, { parse_mode: "Markdown" });
});




// =================================
// /unmute
// =================================
bot.command('unmute', async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.deleteMessage();

  const target = await getTargetUser(ctx);
  if (!target) return ctx.reply("❌ Reply to a user or provide @username/userId.");

  await ctx.telegram.restrictChatMember(ctx.chat.id, target.id, {
    can_send_messages: true,
    can_send_media_messages: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true
  });

  ctx.reply(`🔊 Unmuted [user](tg://user?id=${target.id}).`, { parse_mode: "Markdown" });
});




// =================================
// /ban
// =================================
bot.command('ban', async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.deleteMessage();

  const target = await getTargetUser(ctx);
  if (!target) return ctx.reply("❌ Reply to a user or provide @username/userId.");

  await ctx.telegram.banChatMember(ctx.chat.id, target.id);

  ctx.reply(`🚫 Banned [user](tg://user?id=${target.id}).`, { parse_mode: "Markdown" });
});




// =================================
// /unban
// =================================
bot.command('unban', async (ctx) => {
  if (!await isAdmin(ctx, ctx.from.id)) return ctx.deleteMessage();

  const target = await getTargetUser(ctx);
  if (!target) return ctx.reply("❌ Reply to a user or provide @username/userId.");

  await ctx.telegram.unbanChatMember(ctx.chat.id, target.id);

  ctx.reply(`♻️ Unbanned [user](tg://user?id=${target.id}).`, { parse_mode: "Markdown" });
});


bot.command('end', async (ctx) => {
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
bot.on('message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;
  
  const groupId = ctx.chat.id;
  const userId = ctx.from.id.toString();
  let groupData = await getGroupData(groupId);
  
  cleanupExpiredMutes(groupData);
  
  // SLOT PHASE: Handle X links
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
      const xUsername = extractUsernameFromXLink(messageText);
      
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
      // Not an X link, delete it
      await ctx.deleteMessage();
    }
  }
  
  // CHECKING PHASE: Handle media submissions
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
    
    const hasMedia = ctx.message.photo || ctx.message.video || 
                    ctx.message.document || ctx.message.video_note;
    
    if (hasMedia) {
      const linkData = groupData.userLinks.get(userId);
      const xUsername = linkData ? linkData.xUsername : 'N/A';
      const userDisplayName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
      
      if (isInSRList) {
        await ctx.reply(`${userDisplayName} (X: @${xUsername}) submitted new proof. SR list (#${srNumber}) - wait for admin approval`);
      } else {
        // Add to safe users
        groupData.safeUsers.set(userId, {
          tgUsername: ctx.from.username || ctx.from.first_name,
          tgUserId: userId,
          xUsername: xUsername,
          timestamp: new Date(),
          approved: true
        });
        
        await ctx.reply(`${userDisplayName} (X: @${xUsername}) your SR proof has been received ✅`);
        await saveGroupData(groupId, groupData);
      }
    } else {
      // Not media, delete message
      await ctx.deleteMessage();
    }
  }
});

// ============= ERROR HANDLING =============
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
});


// Export the Express app for Render
module.exports = app;

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

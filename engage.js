const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./firebase');
const express = require('express');
require('dotenv').config();

// Ensure the correct token is used
const bot = new Telegraf("8500910728:AAHaRCPCOnaWR0g82pFamKIjKdq9Rq50Fl4");
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


// Bot states
const BOT_STATES = {
  IDLE: 'idle',
  SLOT_OPEN: 'slot_open',
  LOCKED: 'locked', // New state for /loc
  CHECKING: 'checking',
  CLOSED: 'closed'
};

// Utility functions for link matching
const extractUsernameFromXLink = (url) => {
  const match = url.match(/https?:\/\/x\.com\/([^\/]+)/i) ||
                url.match(/https?:\/\/twitter\.com\/([^\/]+)/i);
  return match ? match[1] : null;
};

const isXLink = (text) => {
  return text && (text.includes('x.com/') || text.includes('twitter.com/'));
};

const getXLinkUsernameAndPost = (text) => {
    const match = text.match(/https?:\/\/(?:x|twitter)\.com\/([^\/]+)\/status\/(\d+)/i);
    if (match) {
        return {
            xUsername: match[1].toLowerCase(),
            postId: match[2]
        };
    }
    return null;
};

// Check if user is admin
const isAdmin = async (ctx, userId) => {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return member.status === 'administrator' || member.status === 'creator';
  } catch (error) {
    return false;
  }
};

// Add automatic cleanup for expired muted X usernames
const cleanupExpiredMutes = (groupData) => {
  const now = Date.now();
  const twoDays = 2 * 24 * 60 * 60 * 1000;

  for (const [xUsername, muteData] of groupData.mutedXUsernames.entries()) {
    if ((now - muteData.mutedAt.getTime()) > twoDays) {
      groupData.mutedXUsernames.delete(xUsername);
    }
  }
};

// Database functions
const getGroupData = async (groupId) => {
  try {
    const doc = await db.collection('groups').doc(groupId.toString()).get();
    if (doc.exists) {
      // Convert Date/Timestamp objects back to Date objects if stored as one
      const data = doc.data();
      if (data.mutedXUsernames) {
        // Ensure mutedAt is a Date object if it was a Firebase Timestamp
        for (const [key, value] of Object.entries(data.mutedXUsernames)) {
          if (value.mutedAt && typeof value.mutedAt.toDate === 'function') {
            value.mutedAt = value.mutedAt.toDate();
          }
        }
      }
      return data;
    }
    return getDefaultGroupData();
  } catch (error) {
    console.error('Error getting group data:', error);
    return getDefaultGroupData();
  }
};

const saveGroupData = async (groupId, data) => {
  try {
    // Convert Maps to plain Objects for Firebase
    const firebaseData = {
      ...data,
      userLinks: Object.fromEntries(data.userLinks),
      safeUsers: Object.fromEntries(data.safeUsers),
      scamUsers: Object.fromEntries(data.scamUsers),
      srList: Object.fromEntries(data.srList),
      mutedUsers: Object.fromEntries(data.mutedUsers),
      mutedXUsernames: Object.fromEntries(data.mutedXUsernames),
      updatedAt: new Date()
    };

    await db.collection('groups').doc(groupId.toString()).set(firebaseData, { merge: true });
  } catch (error) {
    console.error('Error saving group data:', error);
  }
};

const getDefaultGroupData = () => {
  return {
    state: BOT_STATES.IDLE,
    userLinks: new Map(), // key: telegram_user_id, value: {username, xUsername, postId, timestamp}
    safeUsers: new Map(), // key: telegram_user_id, value: {username, timestamp, approved}
    scamUsers: new Map(),
    srList: new Map(), // key: sr_number, value: {userId, username}
    mutedUsers: new Map(), // key: telegram_user_id, value: {username, until, xUsername}
    mutedXUsernames: new Map(), // key: x_username (lowercase), value: {mutedAt, mutedBy, xUsername}
    linkCount: 0,
    srCounter: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
};

const convertToMaps = (data) => {
  // Ensure we convert plain objects back to Maps
  return {
    ...data,
    userLinks: new Map(Object.entries(data.userLinks || {})),
    safeUsers: new Map(Object.entries(data.safeUsers || {})),
    scamUsers: new Map(Object.entries(data.scamUsers || {})),
    srList: new Map(Object.entries(data.srList || {})),
    mutedUsers: new Map(Object.entries(data.mutedUsers || {})),
    mutedXUsernames: new Map(Object.entries(data.mutedXUsernames || {}))
  };
};

const muteUser = async (ctx, groupData, userId, xUsername = null, durationMinutes = 30) => {
  const untilDate = Math.floor(Date.now() / 1000) + (durationMinutes * 60);

  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
      permissions: {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      },
      until_date: untilDate
    });

    // Store muted user
    const muteData = {
      username: ctx.from.username,
      until: untilDate,
      xUsername: xUsername
    };

    // If the message context is available, use ctx.from, otherwise, we'd need to fetch user data
    // Assuming ctx.from is the user being muted in all calls to this function for simplicity here.
    groupData.mutedUsers.set(userId.toString(), muteData);

    // Store X username only if duration is 2 days (2880 minutes)
    const twoDaysMins = 2 * 24 * 60;
    if (xUsername && durationMinutes === twoDaysMins) {
      groupData.mutedXUsernames.set(xUsername.toLowerCase(), {
        mutedAt: new Date(),
        mutedBy: ctx.from.id,
        xUsername: xUsername
      });
    }

  } catch (error) {
    // console.error(`Error muting user ${userId}:`, error);
    // Suppress common "user not in group" or "not enough rights" errors
  }
};

const deleteMessages = async (ctx, messageIds) => {
  if (!Array.isArray(messageIds)) messageIds = [messageIds];
  for (const messageId of messageIds) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
    } catch (error) {
      // console.error(`Error deleting message ${messageId}:`, error);
    }
  }
};

// Cron job storage
const cronJobs = new Map();

// --- Commands ---

bot.command('slot', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = convertToMaps(await getGroupData(groupId));

  if (groupData.state !== BOT_STATES.IDLE && groupData.state !== BOT_STATES.CLOSED) {
    return ctx.reply('Please end the current slot before starting a new one.');
  }

  // Cleanup expired mutes before starting new slot
  cleanupExpiredMutes(groupData);

  groupData.state = BOT_STATES.SLOT_OPEN;
  groupData.userLinks.clear();
  groupData.safeUsers.clear();
  groupData.scamUsers.clear();
  groupData.srList.clear();
  groupData.linkCount = 0;
  groupData.srCounter = 1;

  try {
    await ctx.telegram.setChatTitle(ctx.chat.id,
      `${ctx.chat.title.split(' ')[0]} {open}`);
  } catch (error) {
    console.log('No permission to change group name');
  }

  // Allow sending messages, but block media and previews
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: true,
    can_send_media_messages: false,
    can_send_other_messages: false,
    can_add_web_page_previews: true
  });

  await saveGroupData(groupId, groupData);

  const welcomeMsg = `🎰 **Slot opened!** Members can now drop their **X links**.\n\n` +
    `📌 **Rules:**\n` +
    `• Drop only **ONE** X link (must be a post link)\n` +
    `• No other messages allowed\n` +
    `• Dropping your link twice will get you **muted**\n` +
    `• Using a muted user's X post link will get you **muted**\n\n`;

  const sentMessage = await ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
  await ctx.pinChatMessage(sentMessage.message_id);

  startReminderJob(ctx, groupId);
});

bot.command('loc', async (ctx) => {
    const groupId = ctx.chat.id;
    const userId = ctx.from.id;

    // Check if admin
    if (!await isAdmin(ctx, userId)) {
        await ctx.deleteMessage();
        return;
    }

    let groupData = convertToMaps(await getGroupData(groupId));

    if (groupData.state !== BOT_STATES.SLOT_OPEN) {
        return ctx.reply('The slot is not currently open.');
    }

    groupData.state = BOT_STATES.LOCKED;

    try {
        await ctx.telegram.setChatTitle(ctx.chat.id,
            `${ctx.chat.title.split(' ')[0]} {Locked}`);
    } catch (error) {
        console.log('No permission to change group name');
    }

    // Restrict all messages
    await ctx.telegram.setChatPermissions(ctx.chat.id, {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
    });

    stopCronJobs(groupId); // Stop link dropping reminders

    await saveGroupData(groupId, groupData);

    await ctx.reply('🔒 **Group Locked!** Slot is closed. Admins can now start the SR check phase with /check.', { parse_mode: 'Markdown' });
});

bot.command('check', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = convertToMaps(await getGroupData(groupId));

  if (groupData.state !== BOT_STATES.SLOT_OPEN && groupData.state !== BOT_STATES.LOCKED) {
    return ctx.reply('No active slot session or the group has not been locked with /loc.');
  }

  groupData.state = BOT_STATES.CHECKING;

  try {
    await ctx.telegram.setChatTitle(ctx.chat.id,
      `${ctx.chat.title.split(' ')[0]} {Checking}`);
  } catch (error) {
    console.log('No permission to change group name');
  }

  // Allow only media messages
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: false,
    can_send_media_messages: true,
    can_send_other_messages: false,
    can_add_web_page_previews: false
  });

  await saveGroupData(groupId, groupData);

  const checkMsg = `🔍 **Checking phase started!**\n\n` +
    `📸 Now send your **SCREEN RECORD proof** (media only)\n` +
    `• Only photos, videos, files allowed\n` +
    `• Proofs from users in the SR list will require admin approval.\n\n` +
    `⚠️ If you are in the SR list, you must wait for admin approval after submitting new proof.`;

  const sentMessage = await ctx.reply(checkMsg, { parse_mode: 'Markdown' });
  await ctx.pinChatMessage(sentMessage.message_id);

  startSRReminderJob(ctx, groupId);
});

// ... (other command handlers: safe, scam, srlist, rl, sr, rm, total, mutels, muteall, end, clear, help remain the same as the original script, except for the state checks)

bot.command('end', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  let groupData = convertToMaps(await getGroupData(groupId));

  groupData.state = BOT_STATES.CLOSED;

  try {
    await ctx.telegram.setChatTitle(ctx.chat.id,
      `${ctx.chat.title.split(' ')[0]} {closed}`);
  } catch (error) {
    console.log('No permission to change group name');
  }

  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: false,
    can_send_media_messages: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false
  });

  stopCronJobs(groupId);

  // Clear only slot-specific data
  groupData.userLinks.clear();
  groupData.safeUsers.clear();
  groupData.scamUsers.clear();
  groupData.srList.clear();
  groupData.linkCount = 0;
  groupData.srCounter = 1;

  await saveGroupData(groupId, groupData);
  ctx.reply('✅ Slot ended. Get ready for the next one!');
});

// --- Message Handler ---

bot.on('message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;
  if (ctx.message.new_chat_members || ctx.message.left_chat_member) return;

  const groupId = ctx.chat.id;
  const userId = ctx.from.id.toString();
  let groupData = convertToMaps(await getGroupData(groupId));

  // Cleanup expired mutes on every message to ensure database is accurate
  cleanupExpiredMutes(groupData);

  if (groupData.state === BOT_STATES.SLOT_OPEN) {
    const messageText = ctx.message.text || '';
    const isLinkMessage = isXLink(messageText);
    const linkData = isLinkMessage ? getXLinkUsernameAndPost(messageText) : null;
    const xUsername = linkData ? linkData.xUsername : null;
    const postId = linkData ? linkData.postId : null;

    // Rule: User dropped a link twice
    if (groupData.userLinks.has(userId)) {
      if (isLinkMessage) {
        // Delete the new link AND the old link, then mute
        const existingLinkMessageId = groupData.userLinks.get(userId).messageId;
        await deleteMessages(ctx, [ctx.message.message_id, existingLinkMessageId]);
        await muteUser(ctx, groupData, userId, null, 30); // 30 mins
        groupData.userLinks.delete(userId); // Clear their link to prevent further checks
        await ctx.reply(`❌ **@${ctx.from.username || ctx.from.first_name}** muted for 30 minutes - dropped link twice.`, { parse_mode: 'Markdown' });
        await saveGroupData(groupId, groupData);
        return;
      } else {
        // Not a link, but they already dropped a link, so delete non-link message
        await ctx.deleteMessage();
        return;
      }
    }

    // New user dropping a link
    if (isLinkMessage) {

      if (!xUsername || !postId) {
        await ctx.deleteMessage();
        await ctx.reply('Invalid X post link format.');
        return;
      }

      // Check for duplicate X username/post ID
      let duplicateUser = null;
      for (const [id, data] of groupData.userLinks.entries()) {
        if (data.xUsername === xUsername && data.postId === postId) {
            duplicateUser = { userId: id, username: data.username, messageId: data.messageId };
            break;
        }
      }

      // Rule: Two different users dropped the same X link (same username AND same post ID)
      if (duplicateUser) {
        // Delete the new link AND the old link, then mute both users
        await deleteMessages(ctx, [ctx.message.message_id, duplicateUser.messageId]);
        await muteUser(ctx, groupData, userId, xUsername, 30); // 30 mins
        await muteUser(ctx, groupData, duplicateUser.userId, xUsername, 30); // 30 mins
        groupData.userLinks.delete(duplicateUser.userId); // Clear their link
        await ctx.reply(
            `❌ **@${ctx.from.username || ctx.from.first_name}** and **@${duplicateUser.username || 'User'}** muted for 30 minutes - dropped the same X link.`,
            { parse_mode: 'Markdown' }
        );
        await saveGroupData(groupId, groupData);
        return;
      }

      // Check if X username is in muted list (2-day mute hasn't ended)
      const isMutedUsername = groupData.mutedXUsernames.has(xUsername);

      if (isMutedUsername) {
        // Rule: User 1 drops a link which is muted for 2 days
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, userId, null, 30); // 30 mins, no X username saved for this rule
        await ctx.reply(
            `❌ **@${ctx.from.username || ctx.from.first_name}** muted for 30 minutes - used X link from muted user (**${xUsername}**).`,
            { parse_mode: 'Markdown' }
        );
        await saveGroupData(groupId, groupData);
        return;
      }

      // Valid link drop
      groupData.userLinks.set(userId, {
        username: ctx.from.username,
        xUsername: xUsername,
        postId: postId,
        timestamp: new Date(),
        messageId: ctx.message.message_id // Store the message ID for duplicate link check
      });

      groupData.linkCount++;
      await saveGroupData(groupId, groupData);

    } else {
      // Not a link
      await ctx.deleteMessage();
    }
  }

  else if (groupData.state === BOT_STATES.CHECKING) {
    // Only process messages from users who dropped a link
    if (!groupData.userLinks.has(userId)) {
        await ctx.deleteMessage();
        return;
    }

    const isInSRList = Array.from(groupData.srList.values()).some(data =>
      data.userId.toString() === userId
    );

    const hasMedia = ctx.message.photo || ctx.message.video ||
                    ctx.message.document || ctx.message.video_note;

    if (hasMedia) {
      // Media is allowed for check phase

      // Get user's SR counter ID if they are in the list
      const srEntry = Array.from(groupData.srList.entries()).find(([key, data]) => data.userId.toString() === userId);
      const srNumber = srEntry ? srEntry[0] : null;

      if (isInSRList) {
        const userLinkData = groupData.userLinks.get(userId);
        const xUsername = userLinkData ? userLinkData.xUsername : 'N/A';
        await ctx.reply(`**${srNumber}**: **@${ctx.from.username || ctx.from.first_name}** (X: ${xUsername}) submitted new proof. SR list - wait for approval`, { parse_mode: 'Markdown' });
      } else {
        // Safe user submitting first proof
        groupData.safeUsers.set(userId, {
          username: ctx.from.username,
          timestamp: new Date(),
          approved: true
        });

        // Reply in the required format
        await ctx.reply(`**${groupData.linkCount}**: @${ctx.from.username || ctx.from.first_name} Your SR has been recieved ✅`, { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });
        await saveGroupData(groupId, groupData);
      }
    } else {
      // Not media, delete the message
      await ctx.deleteMessage();
    }
  }

  else if (groupData.state === BOT_STATES.LOCKED) {
    // Delete all messages during the locked phase
    await ctx.deleteMessage();
  }
});

// --- Cron Job Functions ---

function startReminderJob(ctx, groupId) {
  // Stop existing job
  stopCronJobs(groupId);

  const job = cron.schedule('*/5 * * * *', async () => {
    const currentGroupData = convertToMaps(await getGroupData(groupId));
    if (currentGroupData.state === BOT_STATES.SLOT_OPEN) {
      try {
        const reminderMsg = await ctx.telegram.sendMessage(groupId, '⏰ **Keep dropping your X links!**', { parse_mode: 'Markdown' });
        // Attempt to pin, non-critical if it fails
        try { await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id); } catch(e) {}
      } catch (error) {
        console.log('Error sending reminder:', error);
      }
    }
  });

  cronJobs.set(`reminder_${groupId}`, job);
}

function startSRReminderJob(ctx, groupId) {
  // Stop existing job
  stopCronJobs(groupId);

  const job = cron.schedule('*/5 * * * *', async () => {
    const currentGroupData = convertToMaps(await getGroupData(groupId));
    if (currentGroupData.state === BOT_STATES.CHECKING) {
      try {
        const reminderMsg = await ctx.telegram.sendMessage(groupId, '📸 **Keep dropping your SR proof!** Media only.\n\n⚠️ SR list users: Submit proof and wait for admin approval', { parse_mode: 'Markdown' });
        // Attempt to pin, non-critical if it fails
        try { await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id); } catch(e) {}
      } catch (error) {
        console.log('Error sending SR reminder:', error);
      }
    }
  });

  cronJobs.set(`sr_reminder_${groupId}`, job);
}

function stopCronJobs(groupId) {
  const jobKeys = [`reminder_${groupId}`, `sr_reminder_${groupId}`];

  jobKeys.forEach(key => {
    const job = cronJobs.get(key);
    if (job) {
      job.stop();
      cronJobs.delete(key);
    }
  });
}
// Export the Express app for Render
module.exports = app;


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

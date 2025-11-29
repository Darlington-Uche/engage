const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./firebase');
const express = require('express');
require('dotenv').config();

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
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000)); // 2 days ago
  
  for (const [xUsername, muteData] of groupData.mutedXUsernames.entries()) {
    if (new Date(muteData.mutedAt) < twoDaysAgo) {
      groupData.mutedXUsernames.delete(xUsername);
    }
  }
};

// Database functions
const getGroupData = async (groupId) => {
  try {
    const doc = await db.collection('groups').doc(groupId.toString()).get();
    if (doc.exists) {
      return doc.data();
    }
    return getDefaultGroupData();
  } catch (error) {
    console.error('Error getting group data:', error);
    return getDefaultGroupData();
  }
};

const saveGroupData = async (groupId, data) => {
  try {
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
    userLinks: new Map(),
    safeUsers: new Map(),
    scamUsers: new Map(),
    srList: new Map(),
    mutedUsers: new Map(),
    mutedXUsernames: new Map(),
    linkCount: 0,
    srCounter: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
};

const convertToMaps = (data) => {
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
    
    // Store muted user
    groupData.mutedUsers.set(userId.toString(), {
      username: ctx.from.username,
      until: untilDate,
      xUsername: xUsername
    });

    // Only store X username for 2-day mutes (not 30-min mutes)
    if (xUsername && duration === 2 * 24 * 60) {
      groupData.mutedXUsernames.set(xUsername.toLowerCase(), {
        mutedAt: new Date(),
        mutedBy: ctx.from.id,
        xUsername: xUsername
      });
    }
    
  } catch (error) {
    console.error('Error muting user:', error);
  }
};

// Cron job storage
const cronJobs = new Map();

// Commands
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
  
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: true,
    can_send_media_messages: false,
    can_send_other_messages: false,
    can_add_web_page_previews: true
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
  
  startReminderJob(ctx, groupId);
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
  
  if (groupData.state !== BOT_STATES.SLOT_OPEN) {
    return ctx.reply('No active slot session.');
  }
  
  groupData.state = BOT_STATES.CHECKING;
  
  try {
    await ctx.telegram.setChatTitle(ctx.chat.id, 
      `${ctx.chat.title.split(' ')[0]} {Checking}`);
  } catch (error) {
    console.log('No permission to change group name');
  }
  
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: false,
    can_send_media_messages: true,
    can_send_other_messages: false,
    can_add_web_page_previews: false
  });
  
  await saveGroupData(groupId, groupData);
  
  const checkMsg = `🔍 Checking phase started!\n\n` +
    `📸 Now send your SCREEN RECORD proof (media only)\n` +
    `• Only photos, videos, files allowed\n` +
    `• Bot will track who submitted proof\n\n` +
    `⚠️ If you are in SR list, you must wait for admin approval after submitting new proof`;
  
  const sentMessage = await ctx.reply(checkMsg);
  await ctx.pinChatMessage(sentMessage.message_id);
  
  startSRReminderJob(ctx, groupId);
});

bot.command('safe', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  if (groupData.safeUsers.size === 0) {
    return ctx.reply('No safe users yet.');
  }
  
  let safeList = '✅ SAFE USERS (Submitted SR proof):\n\n';
  groupData.safeUsers.forEach((userData, userId) => {
    const xUsername = groupData.userLinks.get(userId)?.xUsername || 'N/A';
    safeList += `• @${userData.username || 'No username'} (X: ${xUsername})\n`;
  });
  
  ctx.reply(safeList);
});

bot.command('scam', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  const scamUsers = new Map();
  
  groupData.userLinks.forEach((userData, userId) => {
    if (!groupData.safeUsers.has(userId) && !groupData.srList.has(userId)) {
      scamUsers.set(userId, userData);
    }
  });
  
  if (scamUsers.size === 0) {
    return ctx.reply('No scam users detected.');
  }
  
  let scamList = '🚫 SCAM USERS (No SR proof):\n\n';
  scamUsers.forEach((userData, userId) => {
    scamList += `• @${userData.username || 'No username'} (X: ${userData.xUsername})\n`;
  });
  
  ctx.reply(scamList);
  groupData.scamUsers = scamUsers;
  await saveGroupData(groupId, groupData);
});

bot.command('srlist', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  if (groupData.srList.size === 0) {
    return ctx.reply('SR list is empty.');
  }
  
  let srList = '📋 SR LIST (Waiting for approval):\n\n';
  groupData.srList.forEach((data, number) => {
    const userLinkData = groupData.userLinks.get(data.userId.toString());
    const xUsername = userLinkData ? userLinkData.xUsername : 'N/A';
    srList += `${number}. @${data.username || 'No username'} (X: ${xUsername})\n`;
  });
  
  ctx.reply(srList);
});
bot.command('rl', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  const rulesMessage = `🌟 GROUP RULES 🌟
(Please read carefully)

1️⃣ Group opens only during session times.
Drop your Twitter (X) post link in the group during this period.

2️⃣ Only ONE X post link per user.
Multiple links are not allowed 🚫.

3️⃣ Group closes 1 hour 30 minutes after opening.
All shared links will be retweeted from a single TL ID 📄.

4️⃣ You MUST like all tweets retweeted in the TL ID —
Go one by one until you reach the final GIF tweet at the bottom.

5️⃣ After completing all likes, type "AD" or "All Done" in the group.
This step is mandatory ✔️.

📝 NOTE:
If admins request a Screen Recording (SR), you must send a clear recording showing your likes on the TL ID with your profile visible.

⚠️ ATTENTION:
Please follow all rules strictly.
Violators will be marked as scammers and banned 🚨.`;

  await ctx.reply(rulesMessage);
});

bot.command('sr', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  const targetUser = ctx.message.reply_to_message?.from || 
                    (ctx.message.entities && ctx.message.entities.find(e => e.type === 'text_mention')?.user);
  
  if (!targetUser) {
    return ctx.reply('Please reply to a user or tag them to use /sr');
  }
  
  const targetUserId = targetUser.id.toString();
  
  const isAlreadyInSR = Array.from(groupData.srList.values()).some(data => 
    data.userId.toString() === targetUserId
  );
  
  if (isAlreadyInSR) {
    return ctx.reply('❌ User is already in SR list.');
  }
  
  if (!groupData.userLinks.has(targetUserId)) {
    return ctx.reply('❌ This user did not drop any X link.');
  }
  
  const srNumber = groupData.srCounter++;
  groupData.srList.set(srNumber.toString(), {
    userId: targetUser.id,
    username: targetUser.username || targetUser.first_name
  });
  
  if (groupData.safeUsers.has(targetUserId)) {
    groupData.safeUsers.delete(targetUserId);
  }
  
  await saveGroupData(groupId, groupData);
  
  const userLinkData = groupData.userLinks.get(targetUserId);
  const xUsername = userLinkData ? userLinkData.xUsername : 'N/A';
  
  const warningMsg = `@${targetUser.username || targetUser.first_name} Looks like the screen record proof you dropped isn't clear enough or isn't for you (X: ${xUsername}). Please send the correct one or you will be flagged as scam and muted for days.\n\n📋 SR list - wait for approval`;
  ctx.reply(warningMsg);
});

bot.command('rm', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Usage: /rm <number>');
  }
  
  const number = args[1];
  if (groupData.srList.has(number)) {
    const removedUser = groupData.srList.get(number);
    groupData.srList.delete(number);
    
    const removedUserId = removedUser.userId.toString();
    const hasMedia = ctx.message.reply_to_message?.photo || ctx.message.reply_to_message?.video || 
                    ctx.message.reply_to_message?.document || ctx.message.reply_to_message?.video_note;
    
    if (hasMedia) {
      groupData.safeUsers.set(removedUserId, {
        username: removedUser.username,
        timestamp: new Date(),
        approved: true
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

bot.command('total', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  ctx.reply(`📊 Total X links dropped: ${groupData.linkCount}`);
});

// Show list of muted users and muted X usernames
bot.command('mutels', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  if (groupData.mutedUsers.size === 0 && groupData.mutedXUsernames.size === 0) {
    return ctx.reply('🔇 No muted users at the moment.');
  }
  
  let output = '';
  if (groupData.mutedUsers.size > 0) {
    output += '🔇 Muted users:\n\n';
    groupData.mutedUsers.forEach((data, userId) => {
      const untilDate = new Date(data.until * 1000);
      const remainingMs = Math.max(0, (data.until * 1000) - Date.now());
      const remainingMin = Math.ceil(remainingMs / (60 * 1000));
      output += `• @${data.username || 'No username'} (until ${untilDate.toLocaleString()} — ${remainingMin} min left)\n`;
    });
  }
  
  if (groupData.mutedXUsernames.size > 0) {
    output += '\n🔗 Muted X usernames (2-day mutes):\n\n';
    groupData.mutedXUsernames.forEach((data, key) => {
      const mutedAt = data.mutedAt ? new Date(data.mutedAt) : new Date();
      const mutedAgoMin = Math.ceil((Date.now() - mutedAt.getTime()) / (60 * 1000));
      output += `• ${data.xUsername} (muted ${mutedAgoMin} min ago)\n`;
    });
  }

  ctx.reply(output);
});

bot.command('muteall', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  let groupData = convertToMaps(await getGroupData(groupId));
  
  const args = ctx.message.text.split(' ');
  let duration = 2 * 24 * 60; // Default 2 days
  
  if (args.length > 1) {
    const timeMatch = args[1].match(/(\d+)d/);
    if (timeMatch) {
      duration = parseInt(timeMatch[1]) * 24 * 60;
    }
  }
  
  let mutedCount = 0;
  
  // Mute scam users first
  for (const [userId, userData] of groupData.userLinks.entries()) {
    const isScam = !groupData.safeUsers.has(userId) && !groupData.srList.has(userId);
    
    if (isScam) {
      const xUsername = userData.xUsername;
      await muteUser(ctx, groupData, userId, xUsername, duration);
      mutedCount++;
    }
  }
  
  // Mute SR list users
  groupData.srList.forEach(async (data) => {
    const userLinkData = groupData.userLinks.get(data.userId.toString());
    const xUsername = userLinkData ? userLinkData.xUsername : null;
    await muteUser(ctx, groupData, data.userId, xUsername, duration);
    mutedCount++;
  });
  
  await saveGroupData(groupId, groupData);
  ctx.reply(`🔇 Muted ${mutedCount} users for ${duration / (24 * 60)} days.`);
});

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

bot.command('clear', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const commandMessageId = ctx.message.message_id;
  
  // Send initial message
  const clearingMsg = await ctx.reply('🧹 Starting to clear messages...');
  
  // Run clearing in background without waiting
  (async () => {
    try {
      let messagesDeleted = 0;
      const startMessageId = ctx.message.message_id;
      const endTime = Date.now() + (5 * 60 * 1000); // 5 minutes
      
      let msgId = startMessageId - 1;
      let batchCount = 0;
      
      // Delete messages in batches of 50
      while (Date.now() < endTime && msgId > 0) {
        batchCount = 0;
        
        // Delete 50 messages in one batch
        while (batchCount < 50 && msgId > 0 && Date.now() < endTime) {
          try {
            await ctx.telegram.deleteMessage(groupId, msgId);
            messagesDeleted++;
            batchCount++;
          } catch (error) {
            // Message doesn't exist, continue
          }
          msgId--;
        }
        
        // Sleep for 10 seconds after each batch of 50
        if (msgId > 0 && Date.now() < endTime) {
          await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
        }
      }
      
      // Send final result
      const finalMsg = await ctx.telegram.sendMessage(groupId, `✅ Cleared ${messagesDeleted} messages.`);
      
      // Delete all three messages after 3 seconds
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(groupId, commandMessageId); // Delete /clear command
          await ctx.telegram.deleteMessage(groupId, clearingMsg.message_id); // Delete "Starting to clear..."
          await ctx.telegram.deleteMessage(groupId, finalMsg.message_id); // Delete final result
        } catch (error) {
          console.error('Error deleting messages:', error);
        }
      }, 3000);
      
    } catch (error) {
      console.error('Clear command error:', error);
    }
  })();
});

bot.command('help', async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  
  // Check if admin
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }
  
  const helpMsg = `🤖 **ENGAGE BOT - ADMIN COMMANDS**\n\n` +
    `📌 **SLOT MANAGEMENT:**\n` +
    `/slot - Start a new slot session\n` +
    `/check - Move to checking phase (SR proof)\n` +
    `/end - End current slot and close chat\n\n` +
    `📊 **USER LISTS:**\n` +
    `/safe - Show safe users (submitted SR proof)\n` +
    `/scam - Show scam users (no SR proof)\n` +
    `/srlist - Show SR list (waiting approval)\n` +
    `/total - Show total X links dropped\n\n` +
    `👤 **USER MANAGEMENT:**\n` +
    `/sr - Add user to SR list (reply to user)\n` +
    `/rm <number> - Remove user from SR list\n\n` +
    `🔇 **MUTING:**\n` +
    `/muteall - Mute all scam & SR list users (2 days)\n` +
    `/mutels - Show list of muted users & X usernames\n\n` +
    `⚠️ **NOTE:** Only admins can use these commands!\n` +
    `Non-admins will have command message deleted.`;
  
  ctx.reply(helpMsg);
});

// Message handler for slot phase
bot.on('message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;
  
  const groupId = ctx.chat.id;
  const userId = ctx.from.id.toString();
  let groupData = convertToMaps(await getGroupData(groupId));
  
  // Cleanup expired mutes
  cleanupExpiredMutes(groupData);
  
  if (groupData.state === BOT_STATES.SLOT_OPEN) {
    const messageText = ctx.message.text || '';
    
    // User already dropped a link - check for multiple links
    if (groupData.userLinks.has(userId)) {
      if (isXLink(messageText)) {
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, userId, null, 30); // 30 mins, no X username saved
        await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - multiple links detected.`);
        await saveGroupData(groupId, groupData);
        return;
      } else {
        await ctx.deleteMessage();
        return;
      }
    }
    
    // New user dropping a link
    if (isXLink(messageText)) {
      const xUsername = extractUsernameFromXLink(messageText);
      
      if (!xUsername) {
        await ctx.deleteMessage();
        await ctx.reply('Invalid X link format.');
        return;
      }
      
      // Check if X username is in muted list
      const isMutedUsername = groupData.mutedXUsernames.has(xUsername.toLowerCase());
      
      if (isMutedUsername) {
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, userId, xUsername, 30); // 30 mins, no X username saved for this
        await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - used muted user's X link (${xUsername}).`);
        await saveGroupData(groupId, groupData);
        return;
      }
      
      groupData.userLinks.set(userId, {
        username: ctx.from.username,
        xUsername: xUsername,
        timestamp: new Date()
      });
      
      groupData.linkCount++;
      await saveGroupData(groupId, groupData);
      
    } else {
      await ctx.deleteMessage();
    }
  }
  
  else if (groupData.state === BOT_STATES.CHECKING) {
    
    if (!groupData.userLinks.has(userId)) {
      return;
    }
    
    const isInSRList = Array.from(groupData.srList.values()).some(data => 
      data.userId.toString() === userId
    );
    
    const hasMedia = ctx.message.photo || ctx.message.video || 
                    ctx.message.document || ctx.message.video_note;
    
    if (hasMedia) {
      if (isInSRList) {
        const userLinkData = groupData.userLinks.get(userId);
        const xUsername = userLinkData ? userLinkData.xUsername : 'N/A';
        await ctx.reply(`@${ctx.from.username || ctx.from.first_name} (X: ${xUsername}) submitted new proof. SR list - wait for approval`);
      } else {
        groupData.safeUsers.set(userId, {
          username: ctx.from.username,
          timestamp: new Date(),
          approved: true
        });
        await ctx.reply(`@${ctx.from.username || ctx.from.first_name} your SR has been received ✅`);
        await saveGroupData(groupId, groupData);
      }
    }
  }
});

function startReminderJob(ctx, groupId) {
  const job = cron.schedule('*/5 * * * *', async () => {
    const currentGroupData = convertToMaps(await getGroupData(groupId));
    if (currentGroupData.state === BOT_STATES.SLOT_OPEN) {
      try {
        const reminderMsg = await ctx.telegram.sendMessage(groupId, '⏰ Keep dropping your X links!');
        await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id);
      } catch (error) {
        console.log('Error sending reminder:', error);
      }
    }
  });
  
  cronJobs.set(`reminder_${groupId}`, job);
}

function startSRReminderJob(ctx, groupId) {
  const job = cron.schedule('*/5 * * * *', async () => {
    const currentGroupData = convertToMaps(await getGroupData(groupId));
    if (currentGroupData.state === BOT_STATES.CHECKING) {
      try {
        const reminderMsg = await ctx.telegram.sendMessage(groupId, '📸 Keep dropping your SR proof! Media only.\n\n⚠️ SR list users: Submit proof and wait for admin approval');
        await ctx.telegram.pinChatMessage(groupId, reminderMsg.message_id);
      } catch (error) {
        console.log('Error sending SR reminder:', error);
      }
    }
  });
  
  cronJobs.set(`sr_reminder_${groupId}`, job);
}

function stopCronJobs(groupId) {
  const reminderJob = cronJobs.get(`reminder_${groupId}`);
  const srJob = cronJobs.get(`sr_reminder_${groupId}`);
  
  if (reminderJob) {
    reminderJob.stop();
    cronJobs.delete(`reminder_${groupId}`);
  }
  
  if (srJob) {
    srJob.stop();
    cronJobs.delete(`sr_reminder_${groupId}`);
  }
}
// Export the Express app for Render
module.exports = app;


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

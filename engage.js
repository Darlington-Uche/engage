const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./firebase');

const bot = new Telegraf("8500910728:AAHrHfzUOuMYblDN3-ILzTXwVqJLFmWBgeQ");

// Bot states
const BOT_STATES = {
  IDLE: 'idle',
  SLOT_OPEN: 'slot_open',
  CHECKING: 'checking',
  CLOSED: 'closed'
};

// Utility functions
const extractUsernameFromXLink = (url) => {
  const match = url.match(/https?:\/\/x\.com\/([^\/]+)/i) || 
                url.match(/https?:\/\/twitter\.com\/([^\/]+)/i);
  return match ? match[1] : null;
};

const isXLink = (text) => {
  return text && (text.includes('x.com/') || text.includes('twitter.com/'));
};

// NEW: Add automatic cleanup for expired muted X usernames
const cleanupExpiredMutes = (groupData) => {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000)); // 2 days ago
  
  for (const [xUsername, muteData] of groupData.mutedXUsernames.entries()) {
    if (muteData.mutedAt < twoDaysAgo) {
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

    // Also store the muted X username for future slot detection WITH TIMESTAMP
    if (xUsername) {
      groupData.mutedXUsernames.set(xUsername.toLowerCase(), {
        mutedAt: new Date(), // Add timestamp for cleanup
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
  let groupData = convertToMaps(await getGroupData(groupId));
  
  if (groupData.state !== BOT_STATES.IDLE && groupData.state !== BOT_STATES.CLOSED) {
    return ctx.reply('Please end the current slot before starting a new one.');
  }
  
  // NEW: Cleanup expired mutes before starting new slot
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
    `• Multiple links = 30min mute\n` +
    `• Using muted user's link = 30min mute`;
  
  const sentMessage = await ctx.reply(welcomeMsg);
  await ctx.pinChatMessage(sentMessage.message_id);
  
  startReminderJob(ctx, groupId);
});

bot.command('check', async (ctx) => {
  const groupId = ctx.chat.id;
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
    `• No text messages (automatically restricted by Telegram)\n` +
    `• Bot will track who submitted proof\n\n` +
    `⚠️ If you are in SR list, you must wait for admin approval after submitting new proof`;
  
  const sentMessage = await ctx.reply(checkMsg);
  await ctx.pinChatMessage(sentMessage.message_id);
  
  startSRReminderJob(ctx, groupId);
});

bot.command('safe', async (ctx) => {
  const groupId = ctx.chat.id;
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

bot.command('sr', async (ctx) => {
  const groupId = ctx.chat.id;
  let groupData = convertToMaps(await getGroupData(groupId));
  
  const targetUser = ctx.message.reply_to_message?.from || 
                    (ctx.message.entities && ctx.message.entities.find(e => e.type === 'text_mention')?.user);
  
  if (!targetUser) {
    return ctx.reply('Please reply to a user or tag them to use /sr');
  }
  
  const userId = targetUser.id.toString();
  
  const isAlreadyInSR = Array.from(groupData.srList.values()).some(data => 
    data.userId.toString() === userId
  );
  
  if (isAlreadyInSR) {
    return ctx.reply('❌ User is already in SR list.');
  }
  
  if (!groupData.userLinks.has(userId)) {
    return ctx.reply('❌ This user did not drop any X link.');
  }
  
  const srNumber = groupData.srCounter++;
  groupData.srList.set(srNumber.toString(), {
    userId: targetUser.id,
    username: targetUser.username || targetUser.first_name
  });
  
  if (groupData.safeUsers.has(userId)) {
    groupData.safeUsers.delete(userId);
  }
  
  await saveGroupData(groupId, groupData);
  
  const userLinkData = groupData.userLinks.get(userId);
  const xUsername = userLinkData ? userLinkData.xUsername : 'N/A';
  
  const warningMsg = `@${targetUser.username || targetUser.first_name} Looks like the screen record proof you dropped isn't clear enough or isn't for you (X: ${xUsername}). Please send the correct one or you will be flagged as scam and muted for days.\n\n📋 SR list - wait for approval`;
  ctx.reply(warningMsg);
});

bot.command('rm', async (ctx) => {
  const groupId = ctx.chat.id;
  let groupData = convertToMaps(await getGroupData(groupId));
  
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply('Usage: /rm <number>');
  }
  
  const number = args[1];
  if (groupData.srList.has(number)) {
    const removedUser = groupData.srList.get(number);
    groupData.srList.delete(number);
    
    const userId = removedUser.userId.toString();
    const hasMedia = ctx.message.reply_to_message?.photo || ctx.message.reply_to_message?.video || 
                    ctx.message.reply_to_message?.document || ctx.message.reply_to_message?.video_note;
    
    if (hasMedia) {
      groupData.safeUsers.set(userId, {
        username: removedUser.username,
        timestamp: new Date(),
        approved: true
      });
      await ctx.reply(`✅ Removed user ${number} from SR list and added to safe list.`);
    } else {
      await ctx.reply(`✅ Removed user ${number} from SR list. They can now submit media for approval.`);
    }
    
    await saveGroupData(groupId, groupData);
  } else {
    ctx.reply('❌ User not found in SR list.');
  }
});

bot.command('total', async (ctx) => {
  const groupId = ctx.chat.id;
  let groupData = convertToMaps(await getGroupData(groupId));
  
  ctx.reply(`📊 Total X links dropped: ${groupData.linkCount}`);
});

bot.command('muteall', async (ctx) => {
  const groupId = ctx.chat.id;
  let groupData = convertToMaps(await getGroupData(groupId));
  
  const args = ctx.message.text.split(' ');
  let duration = 2 * 24 * 60;
  
  if (args.length > 1) {
    const timeMatch = args[1].match(/(\d+)d/);
    if (timeMatch) {
      duration = parseInt(timeMatch[1]) * 24 * 60;
    }
  }
  
  for (const userId of groupData.scamUsers.keys()) {
    await muteUser(ctx, groupData, userId, null, duration);
  }
  
  groupData.srList.forEach((data) => {
    muteUser(ctx, groupData, data.userId, null, duration);
  });
  
  await saveGroupData(groupId, groupData);
  ctx.reply(`🔇 Muted all scam and SR list users for ${duration / (24 * 60)} days.`);
});

bot.command('end', async (ctx) => {
  const groupId = ctx.chat.id;
  let groupData = convertToMaps(await getGroupData(groupId));
  
  groupData.state = BOT_STATES.CLOSED;
  
  try {
    await ctx.telegram.setChatTitle(ctx.chat.id, 
      `${ctx.chat.title.split(' ')[0]} {closed}`);
  } catch (error) {
    console.log('No permission to change group name');
  }
  
  await ctx.telegram.setChatPermissions(ctx.chat.id, {
    can_send_messages: true,
    can_send_media_messages: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true
  });
  
  stopCronJobs(groupId);
  
  groupData.userLinks.clear();
  groupData.safeUsers.clear();
  groupData.scamUsers.clear();
  groupData.srList.clear();
  groupData.linkCount = 0;
  groupData.srCounter = 1;
  
  await saveGroupData(groupId, groupData);
  ctx.reply('✅ Slot ended. Cache cleared. Group returned to normal.\n\n⚠️ Muted users remain muted for their duration.');
});

bot.command('clear', async (ctx) => {
  try {
    let messagesDeleted = 0;
    let lastMessageId = ctx.message.message_id;
    
    while (messagesDeleted < 100) {
      const messages = await ctx.telegram.getChatHistory(ctx.chat.id, 100, lastMessageId);
      if (messages.length === 0) break;
      
      for (const message of messages) {
        try {
          await ctx.deleteMessage(message.message_id);
          messagesDeleted++;
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
        }
      }
      
      lastMessageId = messages[messages.length - 1].message_id;
    }
    
    ctx.reply(`🧹 Cleared ${messagesDeleted} messages.`);
  } catch (error) {
    ctx.reply('❌ Error clearing messages. Make sure I have admin permissions.');
  }
});

// Message handler for slot phase
bot.on('message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;
  
  const groupId = ctx.chat.id;
  let groupData = convertToMaps(await getGroupData(groupId));
  
  // NEW: Cleanup expired mutes before processing messages
  cleanupExpiredMutes(groupData);
  
  if (groupData.state === BOT_STATES.SLOT_OPEN) {
    const userId = ctx.from.id.toString();
    const messageText = ctx.message.text || '';
    
    if (groupData.userLinks.has(userId)) {
      await ctx.deleteMessage();
      await muteUser(ctx, groupData, userId, null, 30);
      await ctx.reply(`🔇 @${ctx.from.username || ctx.from.first_name} muted for 30 minutes - multiple links detected.`);
      await saveGroupData(groupId, groupData);
      return;
    }
    
    if (isXLink(messageText)) {
      const xUsername = extractUsernameFromXLink(messageText);
      
      if (!xUsername) {
        await ctx.deleteMessage();
        await ctx.reply('Invalid X link format.');
        return;
      }
      
      const isMutedUsername = groupData.mutedXUsernames.has(xUsername.toLowerCase());
      
      if (isMutedUsername) {
        await ctx.deleteMessage();
        await muteUser(ctx, groupData, userId, xUsername, 30);
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
    const userId = ctx.from.id.toString();
    
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

// Start bot
bot.launch().then(() => {
  console.log('Bot started successfully');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

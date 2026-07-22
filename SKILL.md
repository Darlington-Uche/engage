# SKILL.md — Engage Telegram Bot: Adding New Commands

## Overview
This document tells you exactly how to add new commands to the **Engage Telegram Bot**.

- **Language:** JavaScript (Node.js)
- **Framework:** Telegraf
- **Database:** Firebase Firestore
- **Entry file:** `alpha/alpha.js` (main bot), also `elite/alpha.js` and `xlike/xlike.js` for other instances
- **Bot token:** Loaded from `.env` as `process.env.BOT_ALPHA`

---

## Project Structure
```
engage-main/
├── alpha/
│   ├── alpha.js        ← Main bot logic (add commands here)
│   ├── firebase.js     ← Firebase connection
│   └── .env            ← Bot token + Firebase config
├── elite/
│   └── alpha.js        ← Elite bot instance (same structure)
├── xlike/
│   └── xlike.js        ← X like tracking bot
└── package.json
```

---

## How to Add a New Command

### Step 1 — Find the right section
Open `alpha/alpha.js`. Commands are grouped with section comments like:
```js
// ============= BOT COMMANDS =============
// ============= MUTE COMMAND WITH DURATION =============
// ============= BAN COMMAND =============
```
Add your new command **inside the correct section** or create a new section comment.

### Step 2 — Command template
Every command follows this exact pattern:
```js
bot.command('yourcommand', requireAllowedGroup, async (ctx) => {
  const groupId = ctx.chat.id;
  const userId = ctx.from.id;

  // 1. Admin check (required for most commands)
  if (!await isAdmin(ctx, userId)) {
    await ctx.deleteMessage();
    return;
  }

  // 2. Get group data from Firebase
  let groupData = await getGroupData(groupId);

  // 3. Your command logic here

  // 4. Save group data if you modified it
  await saveGroupData(groupId, groupData);

  // 5. Reply to user
  await ctx.reply('Your response here');
});
```

### Step 3 — Remove `requireAllowedGroup` if the command should work in ALL groups
Most commands use `requireAllowedGroup` middleware to restrict to allowed groups only. Remove it if the command should work everywhere (e.g. `/help`, `/mutelist`).

---

## Key Data Structures

### groupData (loaded via `getGroupData(groupId)`)
```js
{
  state: 'idle' | 'slot_open' | 'checking' | 'closed' | 'locked',
  locked: Boolean,
  userLinks: Map<userId, { tgUsername, tgUserId, xUsername, link, botMessageId, timestamp }>,
  safeUsers: Map<userId, { tgUsername, tgUserId, xUsername, timestamp, approved }>,
  scamUsers: Map<userId, { tgUsername, xUsername }>,
  srList: Map<srNumber, { userId, tgUsername }>,
  mutedUsers: Map<userId, { tgUsername, until, xUsername, mutedAt }>,
  mutedXUsernames: Map<xUsername, { xUsername, tgUsername, tgUserId, mutedAt, mutedBy }>,
  linkCount: Number,
  srCounter: Number,
  currentPinnedMessageId: Number | null,
  deadline: Number | null
}
```

### BOT_STATES
```js
const BOT_STATES = {
  IDLE: 'idle',
  SLOT_OPEN: 'slot_open',
  CHECKING: 'checking',
  CLOSED: 'closed',
  LOCKED: 'locked'
};
```

---

## Utility Functions Available (already defined, just call them)

| Function | What it does |
|---|---|
| `isAdmin(ctx, userId)` | Returns true if user is admin/creator |
| `muteUser(ctx, groupData, userId, xUsername, durationMinutes)` | Mutes a user |
| `getTargetUser(ctx)` | Gets target user from reply, mention, or ID |
| `getGroupData(groupId)` | Loads group data from Firebase (or cache) |
| `saveGroupData(groupId, data)` | Saves group data to Firebase |
| `getDurationText(minutes)` | Returns human-readable duration (e.g. "2 hours") |
| `extractUsernameFromXLink(url)` | Extracts X/Twitter username from URL |
| `isXLink(text)` | Returns true if text is an X/Twitter link |
| `requireAllowedGroup` | Middleware to restrict commands to allowed groups |

---

## Commands From the Help Menu That Need to Be Added

The following commands appear in the help menu but are **not yet implemented** in `alpha.js`. Add them:

### General Commands
| Command | What it should do |
|---|---|
| `/help` | ✅ Already exists |
| `/rule` | ✅ Already exists as `/rl` — add `/rule` as an alias |
| `/start` | Show bot info/welcome message |

### Session Commands
| Command | What it should do |
|---|---|
| `/slot` or `/s` | Alias for `/open` — start a slot session |
| `/loc` or `/l` | ✅ Already exists as `/loc` — add `/l` as alias |
| `/reopen` | Unlock the group (reverse of `/loc`), set `groupData.locked = false`, restore chat permissions |
| `/end` or `/e` | ✅ Already exists as `/end` — add `/e` as alias |
| `/clear` | ✅ Already exists |
| `/tag` | Tag/mention all group members in a message |
| `/delete` | Delete all messages in the group (bulk delete) |

### List & Stats Commands
| Command | What it should do |
|---|---|
| `/list` | ✅ Already exists |
| `/total` | ✅ Already exists |
| `/double` | Find users who submitted multiple links (check `userLinks` for duplicates) |
| `/scam` | ✅ Already exists |
| `/safe` | ✅ Already exists |
| `/new` | List users who joined during the current session |
| `/mutelist` | ✅ Already exists |
| `/banlist` | Show banned users + banned X accounts (combine Telegram bans + `mutedXUsernames`) |
| `/srlist` | ✅ Already exists |
| `/link` | ✅ Already exists |

### Mute Commands
| Command | What it should do |
|---|---|
| `/mute [time]` | ✅ Already exists |
| `/unmute` | ✅ Already exists |
| `/unmuteall` | Unmute ALL currently muted users in `groupData.mutedUsers` |
| `/muteunsafe [time]` | Mute all users NOT in `safeUsers` (i.e., everyone who hasn't submitted proof) |
| `/unmuteunsafe` | Unmute all users who were muted via `/muteunsafe` |
| `/mutesr [time]` | Mute all users currently in `srList` |
| `/approvenew` | Approve all users marked as "new" (add them to safeUsers) |
| `/unmutenew` | Unmute all users in the "new users" list |
| `/d1` | Delete the submitted link of the replied-to user (remove from `userLinks`) |
| `/mutenew` | Toggle whether new users are automatically muted on join |

### Ban Commands
| Command | What it should do |
|---|---|
| `/ban` | ✅ Already exists |
| `/unban` | ✅ Already exists |
| `/ball` | Federation ban — ban user across ALL allowed groups in `ALLOWED_GROUP_IDS` |
| `/unball` | Federation unban — unban user across ALL allowed groups |
| `/tban @username` | Ban a Twitter/X account (add to `mutedXUsernames` permanently) — alias for `/xban` |
| `/unbantwitter @username` | Unban a Twitter/X account — alias for `/xunban` |

### Check & Moderation
| Command | What it should do |
|---|---|
| `/check` | ✅ Already exists |
| `/sr` | ✅ Already exists |
| `/add` | Add user to the safe/ad list (mark as completed) — reply to user |
| `/setwarnlimit` | Set the max number of warnings before auto-mute (store in groupData or Firebase config) |

### Pin & Message Commands
| Command | What it should do |
|---|---|
| `/p` | Pin a "drop link" message — send and pin a standard slot message |
| `/setrs`, `/setrs2`, `/setrs3`, `/setrs4` | Store up to 4 custom pin messages in Firebase config per group |
| `/rs1`, `/rs2`, `/rs3`, `/rs4` | Send and pin the corresponding custom message set by `/setrs` |

### Settings & Config
| Command | What it should do |
|---|---|
| `/settings` | Show current group settings (auto-start, pin interval, auto-close) |
| `/setwelcome` | Set a custom welcome message for new members (store in Firebase) |
| `/welcome` | Toggle welcome message on/off |
| `/anonmode` | Toggle anonymous admin mode (hide which admin ran a command) |
| `/refresh_admins` | Force-refresh the admin cache for the group |
| `/links` | Show all submitted links by group (PM only — send via DM) |

### Bot Owner Commands
| Command | What it should do |
|---|---|
| `/panel` | Show admin panel with all bot owner controls |
| `/managegroups` | List and manage allowed groups |
| `/addgroup` | Add a group ID to `ALLOWED_GROUP_IDS` (persist to Firebase) |
| `/removegroup` | Remove a group ID from `ALLOWED_GROUP_IDS` |
| `/addbotadmin` | Add a Telegram user as bot admin (store in Firebase) |
| `/removebotadmin` | Remove a bot admin |
| `/listbotadmins` | List all bot admins |
| `/msg` | Broadcast a message to all allowed groups |

---

## How to Add Firebase-Persisted Config (for settings like welcome message)

```js
// Save a config value
await db.collection('config').doc('welcome_message').set({
  message: 'Your welcome text here',
  enabled: true,
  groupId: groupId
}, { merge: true });

// Read a config value
const doc = await db.collection('config').doc('welcome_message').get();
if (doc.exists) {
  const { message, enabled } = doc.data();
}
```

---

## How to Add an Alias Command

To make `/s` work the same as `/slot`:
```js
// Define the handler once
async function handleSlotOpen(ctx) {
  // ... same logic as /open
}

// Register under multiple names
bot.command('slot', requireAllowedGroup, handleSlotOpen);
bot.command('s', requireAllowedGroup, handleSlotOpen);
```

---

## How to Implement `/ball` (Federation Ban)

```js
bot.command('ball', requireAllowedGroup, async (ctx) => {
  const userId = ctx.from.id;
  if (!await isAdmin(ctx, userId)) { await ctx.deleteMessage(); return; }

  const targetUser = await getTargetUser(ctx);
  if (!targetUser) return ctx.reply('Reply to a user to federation ban them.');

  // Ban in all allowed groups
  for (const gId of ALLOWED_GROUP_IDS) {
    try {
      await ctx.telegram.banChatMember(gId, targetUser.id);
    } catch (e) {
      console.log(`Could not ban in group ${gId}:`, e.message);
    }
  }

  await ctx.reply(`🚫 ${targetUser.username || targetUser.first_name} banned from all groups.`);
});
```

---

## Important Rules to Follow

1. **Always check `isAdmin`** before any moderation command — delete the message and return silently if not admin.
2. **Always call `saveGroupData`** after modifying `groupData`.
3. **Use `requireAllowedGroup` middleware** unless the command should work in all chats.
4. **Use `parse_mode: "Markdown"` or `"HTML"`** for formatted replies. Use HTML when the text contains usernames with underscores (Markdown breaks on underscores).
5. **Admin messages are completely ignored** in the `bot.on('message')` handler — do not change this behavior.
6. **Do not break the `bot.on('message')` handler** — it manages slot and checking phase logic for all users.
7. **Duration format:** `10s` = seconds (convert to minutes), `5m` = minutes, `2h` = hours, `3d` = days. The `getDurationText()` helper already handles formatting.
8. **Group title updates** use `ctx.telegram.setChatTitle()` — wrap in try/catch as the bot may not have permission.

---

## Testing Checklist After Adding Commands

- [ ] Command is admin-only (if it should be)
- [ ] Command works when replying to a user
- [ ] Command works with `@username` mention
- [ ] `saveGroupData` is called if `groupData` was modified
- [ ] Error cases return friendly messages
- [ ] No crashes on missing/undefined values (use optional chaining `?.`)
- [ ] Firebase reads/writes are wrapped in try/catch

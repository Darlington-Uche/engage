# 🎰 Engage Bot - Telegram Slot Manager

A powerful Telegram bot for managing slot sessions with X (Twitter) link verification, screen record proof checking, and automatic user muting.

## 📋 Features

- **Slot Management** - Open/close slots with automated phases
- **Link Verification** - Track X usernames and prevent duplicate submissions
- **Screen Record Proof** - Verify users with media submissions
- **Auto-Muting** - Automatic muting system with 30-min and 2-day durations
- **SR List** - Pending approval system for suspicious proofs
- **Mute Persistence** - X usernames stay muted across slots (2-day auto-cleanup)
- **Admin Only** - Secure command access (admin verification)
- **Firebase Integration** - Cloud data storage and persistence

## 🚀 Getting Started

### Prerequisites
- Node.js v14+
- Firebase account with Firestore database
- Telegram Bot Token

### Installation

1. **Clone or download the project**
```bash
cd engage
npm install
```

2. **Install dependencies**
```bash
npm install telegraf node-cron firebase
```

3. **Setup Firebase**
- Create a Firebase project
- Download credentials JSON
- Create `firebase.js` with your config

4. **Configure Bot Token**
- Replace bot token in `engage.js`:
```javascript
const bot = new Telegraf("YOUR_BOT_TOKEN_HERE");
```

5. **Start the bot**
```bash
node engage.js
```

## 📖 Commands

### 🎰 Slot Management (Admin Only)
| Command | Description |
|---------|-------------|
| `/slot` | Start a new slot session |
| `/check` | Move to checking phase (users submit SR proof) |
| `/end` | End slot and close chat |

### 📊 User Lists (Admin Only)
| Command | Description |
|---------|-------------|
| `/safe` | Show safe users (submitted valid proof) |
| `/scam` | Show scam users (no proof) |
| `/srlist` | Show SR list (waiting approval) |
| `/total` | Show total X links dropped |

### 👤 User Management (Admin Only)
| Command | Description |
|---------|-------------|
| `/sr` | Add user to SR list (reply to message) |
| `/rm <number>` | Remove user from SR list |

### 🔇 Muting (Admin Only)
| Command | Description |
|---------|-------------|
| `/muteall` | Mute all scam & SR list users for 2 days |
| `/mutels` | Show muted users and X usernames |

### 📋 Information (Admin Only)
| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/clear` | Delete up to 100 messages |

## 🎯 How It Works

### Slot Phase
1. Admin uses `/slot` to open a new slot
2. Members drop ONE X link (https://x.com/username format)
3. Multiple links = 30-min mute
4. Muted X usernames can't be used = 30-min mute
5. Bot tracks all submissions

### Checking Phase
1. Admin uses `/check` to start checking phase
2. Members submit SCREEN RECORD proof (media only)
3. Bot identifies who submitted proof (safe users)
4. Admin uses `/sr` to flag suspicious proofs (SR list)
5. Admin uses `/rm` to approve users from SR list

### Muting System
- **30-min mutes**: Multiple links, muted X links (temporary)
- **2-day mutes**: Scam users (X username saved globally)
- **Auto-cleanup**: Muted X usernames expire after 2 days
- **Persistence**: X usernames stay muted across multiple slots

### User Categories
- **Safe Users** ✅ - Submitted valid screen record proof
- **Scam Users** 🚫 - No proof provided
- **SR List** 📋 - Waiting for admin approval
- **Muted Users** 🔇 - Can't participate (30-min or 2-day)

## 📊 Data Structure

### Group Data
```javascript
{
  state: 'slot_open' | 'checking' | 'closed' | 'idle',
  userLinks: Map<userId, {username, xUsername, timestamp}>,
  safeUsers: Map<userId, {username, timestamp, approved}>,
  scamUsers: Map<userId, {username, xUsername}>,
  srList: Map<number, {userId, username}>,
  mutedUsers: Map<userId, {username, until, xUsername}>,
  mutedXUsernames: Map<xUsername, {mutedAt, mutedBy, xUsername}>,
  linkCount: number,
  srCounter: number
}
```

## ⚙️ Configuration

### Mute Durations
```javascript
30 minutes = 30 (default for violations)
2 days = 2 * 24 * 60 (for scam users)
```

### Reminder Jobs
- Every 5 minutes during slot phase
- Every 5 minutes during checking phase

## 🔒 Security

- ✅ Admin-only commands with verification
- ✅ Non-admin command messages auto-deleted
- ✅ Firebase secure rules required
- ✅ Input validation for X links
- ✅ Rate limiting on API calls

## 📁 File Structure
```
engage/
├── engage.js          # Main bot code
├── firebase.js        # Firebase configuration
├── package.json       # Dependencies
└── README.md          # This file
```

## 🛠️ Troubleshooting

### Bot not responding
- Check bot token is valid
- Verify bot has admin rights in group
- Check Firebase connection

### Links not being recognized
- X links must be in format: `https://x.com/username` or `https://twitter.com/username`
- Check URL is complete and valid

### Muting not working
- Bot must be admin in group
- Ensure user isn't already restricted
- Check Telegram restrictions aren't conflicting

## 📝 Notes

- Only X/Twitter links are supported
- Case-insensitive X username matching
- Auto-cleanup of expired 2-day mutes at next `/slot`
- Firebase Firestore required for data persistence
- Commands work only in groups, not private chats

## 📧 Support

For issues or feature requests, check bot logs:
```bash
node engage.js 2>&1 | tee bot.log
```

## 📜 License

MIT License - Use freely but at your own risk.

---

**Last Updated:** November 25, 2025
**Bot Version:** 1.0
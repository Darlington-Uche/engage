// ============= RENDER HEALTH CHECK SERVER =============
// Render's free Web Service needs an open port to consider the deploy
// healthy, and something for UptimeRobot to ping. This doesn't touch
// bot logic at all - it just keeps the process alive as a "web service".
require('http')
  .createServer((req, res) => res.end('ok'))
  .listen(process.env.PORT || 3000, () => {
    console.log(`✅ Health check server listening on port ${process.env.PORT || 3000}`);
  });

// ============= LOAD ALL BOTS =============
// Each file below calls startBot()/bot.launch() itself as soon as it's
// required, so just requiring them here boots all of them in this one process.
console.log('🚀 Starting all bots...');

require('./xlike/xlike.js');
require('./alpha/alpha.js');
require('./elite/alpha.js');
require('./xtracking/xtracking.js');
// NOTE: root xtracking.js is NOT loaded here on purpose - it uses the
// same BOT_TEST token as xtracking/xtracking.js and the two would fight
// over the same Telegram long-poll connection (409 Conflict + crash loop).

console.log('🚀 All bot modules loaded.');

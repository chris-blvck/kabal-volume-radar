import 'dotenv/config';
import { getDb } from './database/db';
import { startScanner } from './scanner/tokenScanner';
import { startTracker } from './tracker/performanceTracker';
import { startPinnedUpdater } from './tracker/pinnedMessage';
import { startWalletTracker, setWalletAlertFn } from './scanner/walletTracker';
import { startWatchlistChecker } from './tracker/watchlist';
import { initCallQueue } from './tracker/callQueue';
import { startDailyRecap } from './tracker/dailyRecap';
import { createManagementBot } from './bot/managementBot';
import { postSmartMoneyAlert, getChannelBot } from './bot/channelBot';

async function main() {
  console.log('\uD83E\uDD85 Kabal Volume Radar starting\u2026');

  getDb();
  console.log('\u2705 Database ready');

  const mgmtBot = createManagementBot();
  await mgmtBot.launch();
  console.log('\u2705 Management bot online');

  const channelBot = getChannelBot();

  initCallQueue(channelBot);
  console.log('\u2705 Call queue ready');

  startScanner();
  console.log('\u2705 Token scanner running');

  startTracker();
  console.log('\u2705 Performance tracker running');

  startPinnedUpdater(channelBot);
  console.log('\u2705 Pinned Top-10 updater running');

  setWalletAlertFn(async (msg) => postSmartMoneyAlert(msg));
  startWalletTracker();
  console.log('\u2705 Wallet tracker running');

  startWatchlistChecker(mgmtBot);
  console.log('\u2705 Watchlist checker running');

  startDailyRecap(channelBot);
  console.log('\u2705 Daily recap scheduled');

  console.log('\uD83D\uDE80 Kabal Volume Radar is LIVE');

  process.once('SIGINT',  () => { mgmtBot.stop('SIGINT');  channelBot.stop('SIGINT');  });
  process.once('SIGTERM', () => { mgmtBot.stop('SIGTERM'); channelBot.stop('SIGTERM'); });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

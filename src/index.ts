import 'dotenv/config';
import { getDb } from './database/db';
import { startScanner } from './scanner/tokenScanner';
import { startTracker } from './tracker/performanceTracker';
import { startPinnedUpdater } from './tracker/pinnedMessage';
import { startWalletTracker, setWalletAlertFn } from './scanner/walletTracker';
import { createManagementBot } from './bot/managementBot';
import { postSmartMoneyAlert } from './bot/channelBot';
import { Telegraf } from 'telegraf';

async function main() {
  console.log('🦅 Kabal Volume Radar starting…');

  // Database
  getDb();
  console.log('✅ Database ready');

  // Management bot (user-facing)
  const mgmtBot = createManagementBot();
  await mgmtBot.launch();
  console.log('✅ Management bot online');

  // Channel bot (for posting calls & updates)
  // The channel bot instance is managed internally in channelBot.ts
  // We need a reference to start the pinned updater
  const channelBot = new Telegraf(process.env.CHANNEL_BOT_TOKEN!);

  // Token scanner (algo calls)
  startScanner();
  console.log('✅ Token scanner running');

  // Performance tracker (milestone updates)
  startTracker();
  console.log('✅ Performance tracker running');

  // Live pinned Top-10 message
  startPinnedUpdater(channelBot);
  console.log('✅ Pinned Top-10 updater running');

  // Wallet tracker (smart money alerts)
  setWalletAlertFn(async (msg) => postSmartMoneyAlert(msg));
  startWalletTracker();
  console.log('✅ Wallet tracker running');

  console.log('🚀 Kabal Volume Radar is LIVE');

  process.once('SIGINT',  () => { mgmtBot.stop('SIGINT');  channelBot.stop('SIGINT');  });
  process.once('SIGTERM', () => { mgmtBot.stop('SIGTERM'); channelBot.stop('SIGTERM'); });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

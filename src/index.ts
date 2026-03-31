import 'dotenv/config';
import { getDb } from './database/db';
import { startScanner } from './scanner/tokenScanner';
import { startTracker } from './tracker/performanceTracker';
import { createManagementBot } from './bot/managementBot';

async function main() {
  console.log('\uD83E\uDD85 Kabal Volume Radar starting\u2026');

  getDb();
  console.log('\u2705 Database ready');

  const mgmtBot = createManagementBot();
  await mgmtBot.launch();
  console.log('\u2705 Management bot online');

  startScanner();
  console.log('\u2705 Token scanner running');

  startTracker();
  console.log('\u2705 Performance tracker running');

  console.log('\uD83D\uDE80 Kabal Volume Radar is LIVE');

  process.once('SIGINT',  () => { mgmtBot.stop('SIGINT');  });
  process.once('SIGTERM', () => { mgmtBot.stop('SIGTERM'); });
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

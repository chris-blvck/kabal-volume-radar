/**
 * Daily Recap
 * ───────────────────────────────────────────────────────────────────
 * Posts top-5 calls of the last 24h to the free channel at 09:00 UTC.
 * Drives engagement and showcases performance to non-Pro users.
 */

import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { getDb } from '../database/db';
import { fmtMcap } from '../utils/formatMessage';
import { config } from '../config';

export function startDailyRecap(bot: Telegraf): void {
  cron.schedule('0 9 * * *', () => postDailyRecap(bot), { timezone: 'UTC' } as any);
  console.log('[DailyRecap] Scheduled at 09:00 UTC');
}

async function postDailyRecap(bot: Telegraf): Promise<void> {
  const db    = getDb();
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;

  const allCalls = db.prepare(`
    SELECT c.id, c.symbol, c.market_cap_at_call,
           COALESCE(MAX(cu.ath_multiplier), 1.0) AS ath
    FROM calls c
    LEFT JOIN call_updates cu ON cu.call_id = c.id
    WHERE c.called_at > ?
    GROUP BY c.id
    ORDER BY ath DESC
  `).all(since) as any[];

  if (!allCalls.length) return;

  const totalCalls = allCalls.length;
  const wins2x     = allCalls.filter(c => c.ath >= 2).length;
  const wins5x     = allCalls.filter(c => c.ath >= 5).length;
  const winRate2x  = Math.round((wins2x / totalCalls) * 100);
  const top5       = allCalls.slice(0, 5);
  const medals     = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49', '4\uFE0F\u20E3', '5\uFE0F\u20E3'];

  let msg = `\uD83D\uDCCA <b>Kabal Radar \u2014 Daily Recap</b>\n\n`;
  msg += `<b>Top Calls (last 24h)</b>\n`;

  top5.forEach((c, i) => {
    const mcap = c.market_cap_at_call ?? 0;
    const icon = c.ath >= 5 ? '\uD83D\uDE80' : c.ath >= 2 ? '\u2705' : '\uD83D\uDCC9';
    msg += `${medals[i]} <b>$${c.symbol}</b> \u2014 <b>${(c.ath as number).toFixed(1)}x</b>`;
    if (mcap > 0) msg += `  <i>${fmtMcap(mcap)}</i>`;
    msg += `  ${icon}\n`;
  });

  msg += `\n\uD83D\uDCDE <b>${totalCalls}</b> calls today`;
  msg += `  \u00B7  \uD83C\uDFAF 2x rate: <b>${winRate2x}%</b>`;
  if (wins5x > 0) msg += `  \u00B7  5x: <b>${wins5x}</b>`;
  msg += `\n\n`;

  const proLink = config.telegram.proChannelId
    ? `<a href="https://t.me/${config.telegram.proChannelId.replace('@', '')}">Join Pro</a>`
    : 'Pro';
  msg += `\uD83D\uDC8E ${proLink} \u2014 get calls instantly before the free channel`;

  try {
    await bot.telegram.sendMessage(
      config.telegram.trendingChannelId, msg, { parse_mode: 'HTML' },
    );
    console.log('[DailyRecap] Posted successfully');
  } catch (err: any) {
    console.error('[DailyRecap] Error:', err.message);
  }
}

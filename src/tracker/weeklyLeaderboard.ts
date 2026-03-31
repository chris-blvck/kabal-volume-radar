/**
 * Weekly Leaderboard
 * Posts the top-10 calls of the week every Sunday at 20:00 UTC.
 */
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { getDb } from '../database/db';
import { fmtMcap, multBar } from '../utils/formatMessage';
import { config } from '../config';

export function startWeeklyLeaderboard(bot: Telegraf): void {
  cron.schedule('0 20 * * 0', () => postWeeklyLeaderboard(bot), { timezone: 'UTC' } as any);
  console.log('[WeeklyLeaderboard] Scheduled every Sunday 20:00 UTC');
}

async function postWeeklyLeaderboard(bot: Telegraf): Promise<void> {
  const db    = getDb();
  const since = Math.floor(Date.now() / 1000) - 7 * 86_400;

  const allCalls = db.prepare(`
    SELECT c.id, c.symbol, c.market_cap_at_call, c.called_at,
           COALESCE(MAX(cu.ath_multiplier), 1.0) AS ath
    FROM calls c
    LEFT JOIN call_updates cu ON cu.call_id = c.id
    WHERE c.called_at > ?
    GROUP BY c.id
    ORDER BY ath DESC
    LIMIT 10
  `).all(since) as any[];

  if (!allCalls.length) return;

  const allForStats = db.prepare(`
    SELECT COALESCE(MAX(cu.ath_multiplier), 1.0) AS ath
    FROM calls c
    LEFT JOIN call_updates cu ON cu.call_id = c.id
    WHERE c.called_at > ?
    GROUP BY c.id
  `).all(since) as any[];

  const total     = allForStats.length;
  const wins2x    = allForStats.filter(c => c.ath >= 2).length;
  const wins5x    = allForStats.filter(c => c.ath >= 5).length;
  const wins10x   = allForStats.filter(c => c.ath >= 10).length;
  const avgMult   = total > 0 ? allForStats.reduce((s, c) => s + c.ath, 0) / total : 1;
  const medals    = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];

  let msg = `\uD83C\uDFC6 <b>Kabal Radar \u2014 Weekly Leaderboard</b>\n\n`;
  msg += `<b>Top Calls This Week</b>\n`;

  allCalls.forEach((c, i) => {
    const mult = c.ath as number;
    const mcap = c.market_cap_at_call ?? 0;
    const icon = mult >= 10 ? '\uD83D\uDD25' : mult >= 5 ? '\uD83D\uDE80' : mult >= 2 ? '\u2705' : '\uD83D\uDCC9';
    msg += `${i < 3 ? medals[i] : `${i + 1}.`} <b>$${c.symbol}</b> \u2014 <b>${mult.toFixed(1)}x</b>  ${icon}`;
    if (mcap > 0) msg += `  <i>${fmtMcap(mcap)}</i>`;
    msg += `\n<code>${multBar(mult)}</code>\n`;
  });

  msg += `\n\uD83D\uDCCA <b>Week Stats</b>\n`;
  msg += `\uD83D\uDCDE Calls: <b>${total}</b>  \u00B7  Avg: <b>${avgMult.toFixed(1)}x</b>\n`;
  msg += `\uD83C\uDFAF 2x: <b>${wins2x}</b>  \u00B7  5x: <b>${wins5x}</b>  \u00B7  10x: <b>${wins10x}</b>\n`;

  const proLink = config.telegram.proChannelId
    ? `<a href="https://t.me/${config.telegram.proChannelId.replace('@', '')}">Join Pro</a>`
    : 'Pro';
  msg += `\n\uD83D\uDC8E ${proLink} \u2014 receive calls instantly before the free channel`;

  try {
    await bot.telegram.sendMessage(config.telegram.trendingChannelId, msg, { parse_mode: 'HTML' });
    console.log('[WeeklyLeaderboard] Posted');
  } catch (err: any) {
    console.error('[WeeklyLeaderboard] Error:', err.message);
  }
}

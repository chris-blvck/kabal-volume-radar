/**
 * Graduation Tracker
 * ───────────────────────────────────────────────────────────────────
 * Detects when pump.fun tokens complete their bonding curve
 * and migrate to Raydium — one of the strongest bullish signals.
 * Posts alerts to the Pro channel every 3 minutes.
 */

import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import { getPumpGraduated, PumpToken } from '../scanner/pumpFun';
import { getTokenByAddress } from '../scanner/dexscreener';
import { getDb } from '../database/db';
import { config } from '../config';
import { fmtMcap, fmtPct } from '../utils/formatMessage';

const alertedMints = new Set<string>();

function loadAlerted(): void {
  try {
    const row = getDb().prepare("SELECT value FROM kv WHERE key='graduated_mints'").get() as any;
    if (row?.value) (JSON.parse(row.value) as string[]).forEach(m => alertedMints.add(m));
  } catch { /* fresh start */ }
}

function saveAlerted(): void {
  const arr = [...alertedMints].slice(-300);
  getDb().prepare("INSERT OR REPLACE INTO kv (key,value) VALUES ('graduated_mints',?)").run(JSON.stringify(arr));
}

async function checkGraduations(bot: Telegraf): Promise<void> {
  const graduates = await getPumpGraduated(20);
  const fresh     = graduates.filter(g => g.mint && !alertedMints.has(g.mint));
  if (!fresh.length) return;

  for (const grad of fresh) {
    alertedMints.add(grad.mint);
    const ca   = grad.mint;
    const pair = await getTokenByAddress(ca);
    const mcap = pair?.marketCap ?? pair?.fdv ?? grad.usd_market_cap ?? 0;
    const pc1h = pair?.priceChange?.h1 ?? 0;
    const vol1h = pair?.volume?.h1 ?? 0;

    let msg = `\uD83C\uDF93 <b>GRADUATION ALERT</b>\n\n`;
    msg += `<b>$${grad.symbol || pair?.baseToken.symbol || '???'}</b> \u2014 pump.fun \u2192 <b>Raydium</b>\n\n`;
    msg += `<code>${ca}</code>\n\n`;
    if (mcap > 0)  msg += `\uD83D\uDCB0 MCap: <b>${fmtMcap(mcap)}</b>\n`;
    if (vol1h > 0) msg += `\uD83D\uDCCA Vol/1h: <b>${fmtMcap(vol1h)}</b>\n`;
    if (pc1h !== 0) msg += `\uD83D\uDCC8 1h: <b>${fmtPct(pc1h)}</b>\n`;
    msg += `\n<i>Bonding curve completed \u2014 community conviction signal.</i>`;

    const target = config.telegram.proChannelId || config.telegram.trendingChannelId;
    try {
      await bot.telegram.sendMessage(target, msg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '\uD83D\uDCCA DexScreener', url: pair?.url ?? `https://dexscreener.com/solana/${ca}` },
              { text: '\u26A1 GMGN', url: `https://gmgn.ai/sol/token/${ca}` },
            ],
            [
              { text: '\uD83D\uDD25 Axiom', url: `https://axiom.trade/meme/${ca}` },
              { text: '\uD83E\uDE84 Photon', url: `https://photon-sol.tinyastro.io/en/lp/${ca}` },
            ],
          ],
        },
      });
      console.log(`[GraduationTracker] Alerted $${grad.symbol}`);
    } catch (err: any) {
      console.error('[GraduationTracker]', err.message);
    }
    await sleep(1_500);
  }
  saveAlerted();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function startGraduationTracker(bot: Telegraf): void {
  loadAlerted();
  checkGraduations(bot);
  cron.schedule('*/3 * * * *', () => checkGraduations(bot));
  console.log('[GraduationTracker] Started \u2014 polling every 3min');
}

/**
 * User Watchlist
 * ────────────────────────────────────────────────────────────────────
 * Users can watch any token and get notified when it hits a target
 * multiplier from their entry price.
 *
 * Commands: /watch <CA> [2x|5x|10x]   /watchlist   /unwatch <CA>
 */

import cron from 'node-cron';
import { getDb } from '../database/db';
import { getTokenByAddress } from '../scanner/dexscreener';
import { Telegraf } from 'telegraf';
import { fmtMcap, fmtPct } from '../utils/formatMessage';

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id     INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      price_at_add    REAL NOT NULL,
      mcap_at_add     REAL,
      target_mult     REAL NOT NULL DEFAULT 2.0,
      alerted_at      INTEGER,
      added_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(telegram_id, contract_address)
    );
  `);
}

// ── CRUD ────────────────────────────────────────────────────────────────

export async function addToWatchlist(
  telegramId: number,
  ca:         string,
  targetMult: number = 2.0,
): Promise<{ ok: boolean; msg: string }> {
  ensureTable();
  const pair = await getTokenByAddress(ca);
  if (!pair) return { ok: false, msg: 'Token not found on DexScreener.' };

  const price = parseFloat(pair.priceUsd ?? '0');
  if (price === 0) return { ok: false, msg: 'Could not fetch token price.' };

  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO watchlist
        (telegram_id, contract_address, symbol, price_at_add, mcap_at_add, target_mult)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(telegramId, ca, pair.baseToken.symbol, price,
      pair.marketCap ?? pair.fdv ?? 0, targetMult);

    return {
      ok:  true,
      msg: `✅ Watching <b>$${pair.baseToken.symbol}</b> \u2014 alert at <b>${targetMult}x</b>`,
    };
  } catch {
    return { ok: false, msg: 'Already in watchlist (updated target).' };
  }
}

export function removeFromWatchlist(telegramId: number, ca: string): void {
  ensureTable();
  getDb().prepare('DELETE FROM watchlist WHERE telegram_id = ? AND contract_address = ?').run(telegramId, ca);
}

export function getUserWatchlist(telegramId: number) {
  ensureTable();
  return getDb().prepare(
    'SELECT * FROM watchlist WHERE telegram_id = ? ORDER BY added_at DESC'
  ).all(telegramId) as any[];
}

// ── Price-check loop ──────────────────────────────────────────────────────

let _bot: Telegraf;

async function checkWatchlist(): Promise<void> {
  ensureTable();
  const items = getDb().prepare(
    'SELECT * FROM watchlist WHERE alerted_at IS NULL'
  ).all() as any[];

  if (!items.length) return;

  // Deduplicate CAs to reduce API calls
  const uniqueCAs = [...new Set(items.map((i: any) => i.contract_address as string))];
  const priceMap  = new Map<string, number>();
  const mcapMap   = new Map<string, number>();

  for (const ca of uniqueCAs) {
    try {
      const pair = await getTokenByAddress(ca);
      if (pair) {
        priceMap.set(ca, parseFloat(pair.priceUsd ?? '0'));
        mcapMap.set(ca,  pair.marketCap ?? pair.fdv ?? 0);
      }
    } catch { /* skip */ }
    await sleep(300);
  }

  for (const item of items) {
    const currentPrice = priceMap.get(item.contract_address) ?? 0;
    if (currentPrice === 0) continue;

    const mult = item.price_at_add > 0 ? currentPrice / item.price_at_add : 1;
    if (mult < item.target_mult) continue;

    // Target hit — notify user
    const currentMcap = mcapMap.get(item.contract_address) ?? 0;
    const pctChange   = (mult - 1) * 100;

    const msg =
      `🔔 <b>Watchlist Alert!</b>\n\n` +
      `$${item.symbol} hit your <b>${item.target_mult}x target</b>!\n\n` +
      `💰 MCap: ${fmtMcap(currentMcap)}\n` +
      `📈 Gain: <b>${fmtPct(pctChange)}</b> (<b>${mult.toFixed(1)}x</b>)\n\n` +
      `<code>${item.contract_address}</code>`;

    try {
      await _bot.telegram.sendMessage(item.telegram_id, msg, { parse_mode: 'HTML' });
      // Mark as alerted so we don’t spam
      getDb().prepare('UPDATE watchlist SET alerted_at = unixepoch() WHERE id = ?').run(item.id);
      console.log(`[Watchlist] Alerted ${item.telegram_id} about $${item.symbol} (${mult.toFixed(1)}x)`);
    } catch { /* user might have blocked bot */ }

    await sleep(200);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function startWatchlistChecker(bot: Telegraf): void {
  _bot = bot;
  console.log('[Watchlist] Starting price checker, interval: 5min');
  checkWatchlist();
  cron.schedule('*/5 * * * *', () => checkWatchlist());
}

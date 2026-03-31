import { Telegraf } from 'telegraf';
import cron from 'node-cron';
import { getRecentCalls, getAthForCall, getDb } from '../database/db';
import { getTokenByAddress } from '../scanner/dexscreener';
import { config } from '../config';

let _bot: Telegraf;
let _pinnedMsgId: number | null = null;

// Persist pinned message ID across restarts using a simple kv table
function loadPinnedId(): void {
  try {
    getDb().exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
    const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get('pinned_msg_id') as any;
    if (row?.value) _pinnedMsgId = parseInt(row.value);
  } catch { /* ignore */ }
}

function savePinnedId(id: number): void {
  try {
    getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('pinned_msg_id', ?)").run(String(id));
  } catch { /* ignore */ }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

async function buildTop10(): Promise<string> {
  const calls = getRecentCalls(20);
  if (!calls.length) return '🏆 <b>TOP 10 TRENDING</b> | Kabal Radar\n\n<i>No calls yet…</i>';

  // Fetch live data for each call (batched, with fallback)
  const enriched = await Promise.all(
    calls.map(async (call) => {
      try {
        const pair        = await getTokenByAddress(call.contract_address);
        const currentMcap = pair?.marketCap ?? pair?.fdv ?? 0;
        const callMcap    = call.market_cap_at_call ?? currentMcap;
        const multiplier  = callMcap > 0 ? currentMcap / callMcap : 1;
        const ath         = getAthForCall(call.id);
        return { call, multiplier, currentMcap, ath };
      } catch {
        return { call, multiplier: 1, currentMcap: 0, ath: 1 };
      }
    })
  );

  // Sort by current multiplier descending
  const ranked = enriched.sort((a, b) => b.multiplier - a.multiplier).slice(0, 10);

  const medals = ['🥇', '🥈', '🥉'];
  let msg = '🏆 <b>TOP 10 TRENDING</b> | Kabal Radar\n\n';

  ranked.forEach(({ call, currentMcap, multiplier, ath }, i) => {
    const prefix  = i < 3 ? medals[i] : `${i + 1}.`;
    const mcapStr = currentMcap > 0 ? fmt(currentMcap) : '?';

    let perfStr: string;
    if (multiplier >= 2) {
      perfStr = `<b>${multiplier.toFixed(1)}x</b>`;
    } else if (multiplier > 1) {
      perfStr = `+${((multiplier - 1) * 100).toFixed(0)}%`;
    } else {
      perfStr = `${((multiplier - 1) * 100).toFixed(0)}%`;
    }

    const athStr = ath >= 2 ? ` │ ATH ${ath.toFixed(1)}x` : '';
    msg += `${prefix} <b>$${call.symbol}</b> │ ${mcapStr} │ ${perfStr}${athStr}\n`;
  });

  msg += `\n🕐 ${new Date().toUTCString()}`;
  return msg;
}

export async function updatePinnedMessage(): Promise<void> {
  if (!_bot) return;
  try {
    const text    = await buildTop10();
    const channel = config.telegram.trendingChannelId;

    if (_pinnedMsgId) {
      try {
        await _bot.telegram.editMessageText(channel, _pinnedMsgId, undefined, text, { parse_mode: 'HTML' });
        return;
      } catch (e: any) {
        if (e.message?.includes('message is not modified')) return;
        _pinnedMsgId = null; // stale — send a fresh one
      }
    }

    // Send a new message and pin it
    const sent = await _bot.telegram.sendMessage(channel, text, { parse_mode: 'HTML' });
    _pinnedMsgId = sent.message_id;
    savePinnedId(_pinnedMsgId);
    try {
      await _bot.telegram.pinChatMessage(channel, _pinnedMsgId, { disable_notification: true });
    } catch { /* needs admin + pin permission */ }
  } catch (err: any) {
    console.error('[PinnedMessage] Error:', err.message);
  }
}

export function startPinnedUpdater(bot: Telegraf): void {
  _bot = bot;
  loadPinnedId();
  console.log('[PinnedMessage] Starting — interval: 5min');
  updatePinnedMessage();
  cron.schedule('*/5 * * * *', () => updatePinnedMessage());
}

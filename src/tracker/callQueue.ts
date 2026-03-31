/**
 * Call Queue — Pro delay system
 * ────────────────────────────────────────────────────────────────────
 * Pro channel  → posted IMMEDIATELY
 * Free channel → posted after PRO_DELAY_MINUTES (default 5min)
 *
 * This gives Pro subscribers a meaningful edge and drives upgrades.
 */

import { Telegraf } from 'telegraf';
import { ScoredToken } from '../scanner/filters';
import { HolderAnalysis } from '../scanner/helius';
import { formatCallMessage } from '../utils/formatMessage';
import { updateCallMessageId } from '../database/db';
import { config } from '../config';

interface QueuedPost {
  callId:    number;
  token:     ScoredToken;
  holders?:  HolderAnalysis;
  channelId: string;
  executeAt: number;
}

const queue: QueuedPost[] = [];
let   _bot: Telegraf;

export function initCallQueue(bot: Telegraf): void {
  _bot = bot;
  setInterval(flushQueue, 15_000); // check every 15s
  console.log(`[CallQueue] Pro delay: ${config.proDelay.minutes}min`);
}

/** Schedule a post to a channel after a delay (0 = immediate). */
export function schedulePost(
  callId:    number,
  token:     ScoredToken,
  channelId: string,
  delayMs:   number,
  holders?:  HolderAnalysis,
): void {
  if (delayMs <= 0) {
    sendPost(callId, token, channelId, holders); // fire immediately
    return;
  }
  queue.push({ callId, token, holders, channelId, executeAt: Date.now() + delayMs });
}

async function flushQueue(): Promise<void> {
  const now = Date.now();
  const due = queue.filter(q => q.executeAt <= now);
  for (const item of due) {
    queue.splice(queue.indexOf(item), 1);
    await sendPost(item.callId, item.token, item.channelId, item.holders);
  }
}

async function sendPost(
  callId:    number,
  token:     ScoredToken,
  channelId: string,
  holders?:  HolderAnalysis,
): Promise<void> {
  if (!_bot) return;
  try {
    const p       = token.pair;
    const ca      = p.baseToken.address;
    const text    = formatCallMessage(token, holders);
    const kb      = buildKeyboard(p.url, ca);
    let   sent: any;

    if (p.info?.imageUrl) {
      try {
        sent = await _bot.telegram.sendPhoto(channelId, p.info.imageUrl,
          { caption: text, parse_mode: 'HTML', reply_markup: kb });
      } catch {
        sent = await _bot.telegram.sendMessage(channelId, text,
          { parse_mode: 'HTML', reply_markup: kb });
      }
    } else {
      sent = await _bot.telegram.sendMessage(channelId, text,
        { parse_mode: 'HTML', reply_markup: kb });
    }

    if (sent?.message_id) updateCallMessageId(callId, sent.message_id);
    console.log(`[CallQueue] Posted $${p.baseToken.symbol} → ${channelId}`);
  } catch (err: any) {
    console.error('[CallQueue] Error:', err.message);
  }
}

function buildKeyboard(dexUrl: string, ca: string) {
  return {
    inline_keyboard: [
      [
        { text: '📊 DexScreener', url: dexUrl },
        { text: '⚡ GMGN',          url: `https://gmgn.ai/sol/token/${ca}` },
      ],
      [
        { text: '🔥 Axiom', url: `https://axiom.trade/meme/${ca}` },
        { text: '🟢 BullX', url: `https://bullx.io/terminal?chainId=1399811149&address=${ca}` },
      ],
    ],
  };
}

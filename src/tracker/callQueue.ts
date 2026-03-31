/**
 * Call Queue — Pro delay system + Pro DM alerts
 * ───────────────────────────────────────────────────────────────────
 * Pro channel  → posted IMMEDIATELY + DM to Pro subscribers
 * Free channel → posted after PRO_DELAY_MINUTES (default 5min)
 */

import { Telegraf } from 'telegraf';
import { ScoredToken } from '../scanner/filters';
import { HolderAnalysis } from '../scanner/helius';
import { formatCallMessage } from '../utils/formatMessage';
import { updateCallMessageId, getProSubscribersForDM } from '../database/db';
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
  setInterval(flushQueue, 15_000);
  console.log(`[CallQueue] Pro delay: ${config.proDelay.minutes}min`);
}

export function schedulePost(
  callId:    number,
  token:     ScoredToken,
  channelId: string,
  delayMs:   number,
  holders?:  HolderAnalysis,
): void {
  if (delayMs <= 0) {
    sendPost(callId, token, channelId, holders);
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
    const p    = token.pair;
    const ca   = p.baseToken.address;
    const text = formatCallMessage(token, holders);
    const kb   = buildKeyboard(p.url, ca);
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

    // DM Pro subscribers when posting to Pro channel
    if (channelId === config.telegram.proChannelId && config.telegram.proChannelId) {
      const subs = getProSubscribersForDM();
      if (subs.length) void dmProSubscribers(subs, text, ca, p.url);
    }
  } catch (err: any) {
    console.error('[CallQueue] Error:', err.message);
  }
}

async function dmProSubscribers(
  subs:   number[],
  text:   string,
  ca:     string,
  dexUrl: string,
): Promise<void> {
  const dmText = text + '\n\n<i>\uD83D\uDD14 Pro DM alert \u00B7 /notify off to disable</i>';
  const kb = buildKeyboard(dexUrl, ca);
  for (const userId of subs) {
    try {
      await _bot.telegram.sendMessage(userId, dmText, { parse_mode: 'HTML', reply_markup: kb });
    } catch { /* user hasn't started the bot or blocked it */ }
    await sleep(120); // avoid Telegram rate limit
  }
}

function buildKeyboard(dexUrl: string, ca: string) {
  return {
    inline_keyboard: [
      [
        { text: '\uD83D\uDCCA DexScreener', url: dexUrl },
        { text: '\u26A1 GMGN',             url: `https://gmgn.ai/sol/token/${ca}` },
      ],
      [
        { text: '\uD83D\uDD25 Axiom',   url: `https://axiom.trade/meme/${ca}` },
        { text: '\uD83E\uDE84 Photon',  url: `https://photon-sol.tinyastro.io/en/lp/${ca}` },
      ],
      [
        { text: '\uD83D\uDFE2 BullX',   url: `https://bullx.io/terminal?chainId=1399811149&address=${ca}` },
        { text: '\u2694\uFE0F Trojan',  url: `https://t.me/solana_trojanbot?start=${ca}` },
      ],
    ],
  };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

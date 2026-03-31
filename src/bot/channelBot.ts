import { Telegraf } from 'telegraf';
import { ScoredToken } from '../scanner/filters';
import { HolderAnalysis } from '../scanner/helius';
import { saveCall } from '../database/db';
import { schedulePost } from '../tracker/callQueue';
import { config } from '../config';

let _bot: Telegraf;

export function getChannelBot(): Telegraf {
  if (!_bot) _bot = new Telegraf(config.telegram.channelBotToken);
  return _bot;
}

/**
 * Post a token call:
 *  - Pro channel   → IMMEDIATE (if PRO_CHANNEL_ID is set)
 *  - Free channel  → delayed by PRO_DELAY_MINUTES
 */
export async function postCall(
  token:   ScoredToken,
  source:  'algo' | 'fasttrack' = 'algo',
  holders?: HolderAnalysis,
): Promise<void> {
  const p  = token.pair;
  const ca = p.baseToken.address;

  // Persist to DB immediately so tracker picks it up right away
  const callId = saveCall({
    contract_address:        ca,
    symbol:                  p.baseToken.symbol,
    name:                    p.baseToken.name,
    chain:                   p.chainId,
    dex_id:                  p.dexId,
    pair_address:            p.pairAddress,
    market_cap_at_call:      p.marketCap ?? p.fdv,
    price_at_call:           parseFloat(p.priceUsd ?? '0'),
    volume_1h_at_call:       p.volume?.h1,
    price_change_1h_at_call: p.priceChange?.h1,
    liquidity_at_call:       p.liquidity?.usd,
    image_url:               p.info?.imageUrl,
    website:                 token.website,
    twitter:                 token.twitter,
    telegram_url:            token.telegramUrl,
    dexscreener_url:         p.url,
    is_cto:                  token.isCto,
    is_dexscreener_paid:     token.isDexscreenerPaid,
    source,
  });

  const proChannel  = config.telegram.proChannelId;
  const freeChannel = config.telegram.trendingChannelId;
  const delayMs     = config.proDelay.minutes * 60_000;

  // Pro channel — always immediate
  if (proChannel) {
    schedulePost(callId, token, proChannel, 0, holders);
  }

  // Free channel — delayed when Pro channel exists, otherwise immediate
  const freeDelay = proChannel ? delayMs : 0;
  schedulePost(callId, token, freeChannel, freeDelay, holders);
}

/** Post a plain text update (milestone, smart money, etc.). */
export async function postUpdateToChannel(text: string, replyTo?: number): Promise<void> {
  try {
    await getChannelBot().telegram.sendMessage(
      config.telegram.trendingChannelId, text,
      { parse_mode: 'HTML', ...(replyTo ? { reply_to_message_id: replyTo } : {}) },
    );
  } catch (err: any) {
    console.error('[ChannelBot] Update error:', err.message);
  }
}

/** Broadcast a message to pro channel (or free channel as fallback). */
export async function postSmartMoneyAlert(text: string): Promise<void> {
  const target = config.telegram.proChannelId || config.telegram.trendingChannelId;
  try {
    await getChannelBot().telegram.sendMessage(target, text, { parse_mode: 'HTML' });
  } catch (err: any) {
    console.error('[ChannelBot] SmartMoney error:', err.message);
  }
}

import { Telegraf } from 'telegraf';
import { ScoredToken } from '../scanner/filters';
import { HolderAnalysis } from '../scanner/helius';
import { saveCall, updateCallMessageId } from '../database/db';
import { formatCallMessage } from '../utils/formatMessage';
import { config } from '../config';

let _bot: Telegraf;

function getBot(): Telegraf {
  if (!_bot) _bot = new Telegraf(config.telegram.channelBotToken);
  return _bot;
}

export async function postCall(
  token: ScoredToken,
  source: 'algo' | 'fasttrack' = 'algo',
  holders?: HolderAnalysis
): Promise<void> {
  const p  = token.pair;
  const ca = p.baseToken.address;

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

  const text     = formatCallMessage(token, holders);
  const keyboard = buildKeyboard(p.url, ca);
  const channel  = config.telegram.trendingChannelId;
  const bot      = getBot();

  try {
    let sent: any;
    if (p.info?.imageUrl) {
      try {
        sent = await bot.telegram.sendPhoto(channel, p.info.imageUrl, { caption: text, parse_mode: 'HTML', reply_markup: keyboard });
      } catch {
        sent = await bot.telegram.sendMessage(channel, text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } else {
      sent = await bot.telegram.sendMessage(channel, text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
    if (sent?.message_id) updateCallMessageId(callId, sent.message_id);
    console.log(`[ChannelBot] Posted $${p.baseToken.symbol}`);
  } catch (err: any) {
    console.error('[ChannelBot] Post error:', err.message);
  }
}

export async function postUpdateToChannel(text: string, replyTo?: number): Promise<void> {
  try {
    await getBot().telegram.sendMessage(
      config.telegram.trendingChannelId, text,
      { parse_mode: 'HTML', ...(replyTo ? { reply_to_message_id: replyTo } : {}) }
    );
  } catch (err: any) {
    console.error('[ChannelBot] Update error:', err.message);
  }
}

export async function postSmartMoneyAlert(text: string): Promise<void> {
  try {
    // Post to pro channel if configured, otherwise main channel
    const target = config.telegram.proChannelId || config.telegram.trendingChannelId;
    await getBot().telegram.sendMessage(target, text, { parse_mode: 'HTML' });
  } catch (err: any) {
    console.error('[ChannelBot] SmartMoney error:', err.message);
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

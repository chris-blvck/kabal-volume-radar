import { Telegraf, Markup } from 'telegraf';
import { config } from '../config';
import { verifyPayment, extractTxSig } from '../utils/solana';
import {
  isProSubscriber, saveProSubscriber,
  saveFastTrack, updateFastTrackStatus,
} from '../database/db';

interface UserState { step: string; data: Record<string, any>; }
const states = new Map<number, UserState>();
const set = (id: number, step: string, data: Record<string, any> = {}) => states.set(id, { step, data });
const get = (id: number) => states.get(id) ?? null;
const clear = (id: number) => states.delete(id);

const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('\uD83D\uDE80 Fast-Track', 'fasttrack'), Markup.button.callback('\uD83D\uDCE2 Advertise', 'advertise')],
  [Markup.button.callback('\uD83D\uDC8E Pro Access',  'pro'),       Markup.button.callback('\uD83C\uDD98 Support',   'support')],
  [Markup.button.callback('\uD83D\uDCCB Disclaimer', 'disclaimer')],
]);

function welcomeText(): string {
  return (
    `\uD83D\uDDA5 <b>Kabal Volume Radar</b>\n\n` +
    `Track the hottest Solana tokens before they pump.\n\n` +
    `<b>Quick links:</b>\n` +
    `\uD83D\uDCE1 Trending channel: ${config.telegram.trendingChannelId}\n\n` +
    `<i>Choose an option below:</i>`
  );
}

export function createManagementBot(): Telegraf {
  const bot = new Telegraf(config.telegram.managementBotToken);

  // ── Entry points ───────────────────────────────────────────────
  bot.start(ctx => { clear(ctx.from.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });
  bot.command('menu', ctx => { clear(ctx.from.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });

  // ── Fast-Track ─────────────────────────────────────────────────
  bot.action('fasttrack', async ctx => {
    await ctx.answerCbQuery();
    set(ctx.from!.id, 'ft_ca');
    await ctx.reply(
      `\uD83D\uDE80 <b>Fast-Track Your Token</b>\n\n` +
      `Your token will be featured in Kabal Radar trending channel.\n\n` +
      `Send the token <b>contract address (CA)</b>:`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  bot.action(/^ft_dur_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const hours = parseInt(ctx.match[1]);
    const state = get(ctx.from!.id);
    if (!state?.data.ca) return ctx.reply('Session expired.', MAIN_MENU);

    const priceMap: Record<number, number> = {
      3:  config.pricing.fastTrack3hSol,
      12: config.pricing.fastTrack12hSol,
      24: config.pricing.fastTrack24hSol,
    };
    const price = priceMap[hours];
    const ftId  = saveFastTrack({ contract_address: state.data.ca, submitter_chat_id: ctx.from!.id, duration_hours: hours, sol_amount: price });
    set(ctx.from!.id, 'ft_payment', { ...state.data, hours, price, ftId });

    await ctx.reply(
      `\uD83D\uDE80 <b>Fast-Track Order</b>\n\n` +
      `Token: <code>${state.data.ca}</code>\n` +
      `Duration: <b>${hours}H</b>\n` +
      `Amount: <b>${price} SOL</b>\n\n` +
      `\uD83D\uDCE4 Send <b>exactly ${price} SOL</b> to:\n<code>${config.solana.paymentWallet}</code>\n\n` +
      `Then reply with your <b>Solscan TX URL</b>.`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── Pro Access ─────────────────────────────────────────────────
  bot.action('pro', async ctx => {
    await ctx.answerCbQuery();
    if (isProSubscriber(ctx.from!.id)) {
      return ctx.reply('\u2705 <b>You already have an active Pro subscription!</b>', { parse_mode: 'HTML', ...backBtn() });
    }
    set(ctx.from!.id, 'pro_payment');
    await ctx.reply(
      `\uD83D\uDC8E <b>Kabal Pro Access</b>\n\n` +
      `Faster alerts, deeper data, exclusive Pro channel.\n\n` +
      `\uD83D\uDCB0 Price: <b>${config.pricing.proMonthlySol} SOL / month</b>\n\n` +
      `\uD83D\uDCE4 Send <b>exactly ${config.pricing.proMonthlySol} SOL</b> to:\n<code>${config.solana.paymentWallet}</code>\n\n` +
      `Reply with your <b>Solscan TX URL</b>.`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── Advertise ──────────────────────────────────────────────────
  bot.action('advertise', async ctx => {
    await ctx.answerCbQuery();
    set(ctx.from!.id, 'ad_text');
    await ctx.reply(
      `\uD83D\uDCE2 <b>Advertise in Kabal Radar</b>\n\n` +
      `\uD83D\uDCB0 24H Ad: <b>${config.pricing.advertise24hSol} SOL</b>\n\n` +
      `Send your <b>ad message / link</b>:`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── Support / Disclaimer ───────────────────────────────────────
  bot.action('support', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `\uD83C\uDD98 <b>Support</b>\n\nContact our admin: @KabalRadarAdmin`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  bot.action('disclaimer', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `\u26A0\uFE0F <b>Disclaimer</b>\n\nKabal Radar is a trending algorithm tool. Nothing posted constitutes financial advice. Always DYOR. Crypto is high risk.`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  bot.action('back_menu', async ctx => {
    await ctx.answerCbQuery();
    clear(ctx.from!.id);
    await ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU });
  });

  // ── Text handler (state machine) ───────────────────────────────
  bot.on('text', async ctx => {
    const uid   = ctx.from.id;
    const text  = ctx.message.text.trim();
    const state = get(uid);
    if (!state) return;

    switch (state.step) {
      case 'ft_ca': {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
          return ctx.reply('\u274C Invalid CA. Please send a valid Solana contract address.', backBtn());
        }
        set(uid, 'ft_dur', { ca: text });
        await ctx.reply(
          `\u2705 Token: <code>${text}</code>\n\nSelect duration:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(`3H \u2014 ${config.pricing.fastTrack3hSol} SOL`,  'ft_dur_3'),
                Markup.button.callback(`12H \u2014 ${config.pricing.fastTrack12hSol} SOL`, 'ft_dur_12'),
              ],
              [Markup.button.callback(`24H \u2014 ${config.pricing.fastTrack24hSol} SOL`, 'ft_dur_24')],
              [Markup.button.callback('\u00AB Back', 'back_menu')],
            ]),
          }
        );
        break;
      }

      case 'ft_payment':   await handlePayment(ctx, state, 'fasttrack'); break;
      case 'pro_payment':  await handlePayment(ctx, state, 'pro');       break;

      case 'ad_text': {
        set(uid, 'ad_payment', { text });
        await ctx.reply(
          `\uD83D\uDCCB <b>Ad Preview:</b>\n\n${text}\n\n` +
          `\uD83D\uDCB0 Price: <b>${config.pricing.advertise24hSol} SOL</b> (24H)\n\n` +
          `\uD83D\uDCE4 Send <b>exactly ${config.pricing.advertise24hSol} SOL</b> to:\n<code>${config.solana.paymentWallet}</code>\n\n` +
          `Reply with your Solscan TX URL.`,
          { parse_mode: 'HTML', ...backBtn() }
        );
        break;
      }

      case 'ad_payment': await handlePayment(ctx, state, 'advertise'); break;
    }
  });

  return bot;
}

async function handlePayment(
  ctx: any,
  state: UserState,
  type: 'fasttrack' | 'pro' | 'advertise'
): Promise<void> {
  const uid  = ctx.from.id;
  const text = ctx.message.text.trim();
  const sig  = extractTxSig(text);

  if (!sig) {
    return ctx.reply('\u274C Please paste a valid Solscan transaction URL or signature.');
  }

  await ctx.reply('\uD83D\uDD0D Verifying payment\u2026');

  const expectedSol =
    type === 'pro'       ? config.pricing.proMonthlySol :
    type === 'fasttrack' ? state.data.price             :
                           config.pricing.advertise24hSol;

  const result = await verifyPayment(sig, config.solana.paymentWallet, expectedSol);

  if (!result.valid) {
    return ctx.reply(
      `\u274C Payment not verified: ${result.error}\n\nCheck the TX and try again.`,
      Markup.inlineKeyboard([[Markup.button.callback('\u00AB Back', 'back_menu')]])
    );
  }

  clear(uid);

  if (type === 'pro') {
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86_400;
    saveProSubscriber({
      telegram_id: uid,
      telegram_username: ctx.from.username,
      payment_tx: sig,
      sol_amount: result.amount!,
      expires_at: expiresAt,
    });
    await ctx.reply(
      '\u2705 <b>Pro Access Activated!</b>\n\n\uD83D\uDC8E Your subscription is active for 30 days.',
      { parse_mode: 'HTML', ...MAIN_MENU }
    );

  } else if (type === 'fasttrack') {
    const hours     = state.data.hours;
    const expiresAt = Math.floor(Date.now() / 1000) + hours * 3600;
    updateFastTrackStatus(state.data.ftId, 'active', sig, expiresAt);
    await ctx.reply(
      `\u2705 <b>Fast-Track Confirmed!</b>\n\nYour token will be featured for <b>${hours}H</b>. Sit tight!`,
      { parse_mode: 'HTML', ...MAIN_MENU }
    );

  } else {
    // Notify admins
    for (const adminId of config.telegram.adminIds) {
      try {
        await ctx.telegram.sendMessage(
          adminId,
          `\uD83D\uDCE2 <b>New Ad</b>\nFrom: @${ctx.from.username ?? uid}\nTX: ${sig}\n\n${state.data.text}`,
          { parse_mode: 'HTML' }
        );
      } catch { /* ignore */ }
    }
    await ctx.reply(
      '\u2705 <b>Ad Received!</b>\n\nYour ad will be posted within 24H after review.',
      { parse_mode: 'HTML', ...MAIN_MENU }
    );
  }
}

function backBtn() {
  return Markup.inlineKeyboard([[Markup.button.callback('\u00AB Back', 'back_menu')]]);
}

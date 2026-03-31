import { Telegraf, Markup } from 'telegraf';
import { config } from '../config';
import { verifyPayment, extractTxSig } from '../utils/solana';
import { fmtMcap, formatStatsMessage } from '../utils/formatMessage';
import {
  isProSubscriber, saveProSubscriber,
  saveFastTrack, updateFastTrackStatus,
  getRecentCalls, getAthForCall, getActiveFastTracks, getDb,
} from '../database/db';
import { addWallet, removeWallet, getAllWallets } from '../scanner/walletTracker';

// ── State machine ──────────────────────────────────────────────────

interface State { step: string; data: Record<string, any>; }
const states = new Map<number, State>();
const set   = (id: number, step: string, data: Record<string, any> = {}) => states.set(id, { step, data });
const get   = (id: number) => states.get(id) ?? null;
const clear = (id: number) => states.delete(id);
const isAdmin = (id: number) => config.telegram.adminIds.includes(id);

// ── Keyboards ──────────────────────────────────────────────────

const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('🚀 Fast-Track', 'fasttrack'), Markup.button.callback('📢 Advertise', 'advertise')],
  [Markup.button.callback('💎 Pro Access',  'pro'),       Markup.button.callback('🆘 Support',   'support')],
  [Markup.button.callback('🏆 Top 10',      'top10'),     Markup.button.callback('📋 Disclaimer', 'disclaimer')],
]);

const backBtn = () => Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_menu')]]);

function welcomeText(): string {
  return (
    `🖥 <b>Kabal Volume Radar</b>\n\n` +
    `Track the hottest Solana tokens before they pump.\n\n` +
    `📡 Trending: ${config.telegram.trendingChannelId}\n\n` +
    `<i>Choose an option below:</i>`
  );
}

// ── Bot factory ──────────────────────────────────────────────────

export function createManagementBot(): Telegraf {
  const bot = new Telegraf(config.telegram.managementBotToken);

  // — Entry
  bot.start(ctx => { clear(ctx.from.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });
  bot.command('menu', ctx => { clear(ctx.from.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });

  // ── ADMIN COMMANDS ──────────────────────────────────────────

  // /stats — bot performance
  bot.command('stats', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    const totalCalls    = (db.prepare('SELECT COUNT(*) as c FROM calls').get() as any).c;
    const calls24h      = (db.prepare("SELECT COUNT(*) as c FROM calls WHERE called_at > unixepoch() - 86400").get() as any).c;
    const proSubs       = (db.prepare("SELECT COUNT(*) as c FROM pro_subscribers WHERE expires_at > unixepoch()").get() as any).c;
    const activeFT      = getActiveFastTracks().length;
    const bestRow       = db.prepare(`
      SELECT c.symbol, MAX(cu.ath_multiplier) as ath
      FROM call_updates cu JOIN calls c ON c.id = cu.call_id
    `).get() as any;

    const msg = formatStatsMessage({
      totalCalls, calls24h,
      bestMultiplier: bestRow?.ath ?? 1,
      bestSymbol:     bestRow?.symbol ?? '—',
      proSubscribers: proSubs,
      activeFastTracks: activeFT,
    });
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // /wallets — manage tracked wallets
  bot.command('wallets', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.split(' ').slice(1);

    if (!args.length) {
      const list = getAllWallets();
      if (!list.length) return ctx.reply('No wallets tracked yet.\n\nUsage:\n/wallets add <address> <label>\n/wallets remove <address>');
      const lines = list.map(w => `${w.emoji ?? '👤'} <b>${w.label}</b>\n<code>${w.address}</code>`).join('\n\n');
      return ctx.reply(`👤 <b>Tracked Wallets (${list.length})</b>\n\n${lines}`, { parse_mode: 'HTML' });
    }

    if (args[0] === 'add' && args[1] && args[2]) {
      const [, address, ...labelParts] = args;
      addWallet(address, labelParts.join(' '));
      return ctx.reply(`✅ Added wallet: <b>${labelParts.join(' ')}</b>\n<code>${address}</code>`, { parse_mode: 'HTML' });
    }

    if (args[0] === 'remove' && args[1]) {
      removeWallet(args[1]);
      return ctx.reply(`✅ Wallet removed.`);
    }

    return ctx.reply('Usage:\n/wallets — list\n/wallets add <address> <label>\n/wallets remove <address>');
  });

  // ── TOP 10 (public) ──────────────────────────────────────────

  bot.action('top10', async ctx => {
    await ctx.answerCbQuery();
    const calls = getRecentCalls(10);
    if (!calls.length) return ctx.reply('📤 No calls yet.');

    const medals = ['🥇', '🥈', '🥉'];
    let msg = '🏆 <b>Recent Calls</b>\n\n';
    calls.forEach((c, i) => {
      const ath    = getAthForCall(c.id);
      const prefix = i < 3 ? medals[i] : `${i + 1}.`;
      const athStr = ath >= 2 ? ` | ATH ${ath.toFixed(1)}x` : '';
      msg += `${prefix} <b>$${c.symbol}</b> | ${fmtMcap(c.market_cap_at_call ?? 0)}${athStr}\n`;
    });

    await ctx.reply(msg, { parse_mode: 'HTML', ...backBtn() });
  });

  // ── FAST-TRACK ─────────────────────────────────────────────

  bot.action('fasttrack', async ctx => {
    await ctx.answerCbQuery();
    set(ctx.from!.id, 'ft_ca');
    await ctx.reply(
      `🚀 <b>Fast-Track Your Token</b>\n\n` +
      `Get your token featured in Kabal Radar trending channel.\n\n` +
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
      3: config.pricing.fastTrack3hSol, 12: config.pricing.fastTrack12hSol, 24: config.pricing.fastTrack24hSol,
    };
    const price = priceMap[hours];
    const ftId  = saveFastTrack({ contract_address: state.data.ca, submitter_chat_id: ctx.from!.id, duration_hours: hours, sol_amount: price });
    set(ctx.from!.id, 'ft_payment', { ...state.data, hours, price, ftId });

    await ctx.reply(
      `🚀 <b>Fast-Track Order</b>\n\n` +
      `Token: <code>${state.data.ca}</code>\n` +
      `Duration: <b>${hours}H</b>  Amount: <b>${price} SOL</b>\n\n` +
      `📤 Send <b>exactly ${price} SOL</b> to:\n<code>${config.solana.paymentWallet}</code>\n\n` +
      `Then reply with your <b>Solscan TX URL</b>.`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── PRO ──────────────────────────────────────────────────────────

  bot.action('pro', async ctx => {
    await ctx.answerCbQuery();
    if (isProSubscriber(ctx.from!.id)) {
      return ctx.reply('✅ <b>You already have an active Pro subscription!</b>', { parse_mode: 'HTML', ...backBtn() });
    }
    set(ctx.from!.id, 'pro_payment');
    await ctx.reply(
      `💎 <b>Kabal Pro Access</b>\n\n` +
      `Faster alerts · deeper data · exclusive Pro channel.\n\n` +
      `💰 Price: <b>${config.pricing.proMonthlySol} SOL / month</b>\n\n` +
      `📤 Send <b>exactly ${config.pricing.proMonthlySol} SOL</b> to:\n<code>${config.solana.paymentWallet}</code>\n\n` +
      `Reply with your <b>Solscan TX URL</b>.`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── ADVERTISE ───────────────────────────────────────────────

  bot.action('advertise', async ctx => {
    await ctx.answerCbQuery();
    set(ctx.from!.id, 'ad_text');
    await ctx.reply(
      `📢 <b>Advertise in Kabal Radar</b>\n\n💰 24H: <b>${config.pricing.advertise24hSol} SOL</b>\n\nSend your <b>ad message / link</b>:`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── MISC ────────────────────────────────────────────────────────────

  bot.action('support', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply('🆘 <b>Support</b>\n\nContact: @KabalRadarAdmin', { parse_mode: 'HTML', ...backBtn() });
  });

  bot.action('disclaimer', async ctx => {
    await ctx.answerCbQuery();
    await ctx.reply(
      '⚠️ <b>Disclaimer</b>\n\nKabal Radar is an algorithmic trending tool. Nothing posted is financial advice. Always DYOR. Crypto is high risk.',
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  bot.action('back_menu', async ctx => {
    await ctx.answerCbQuery();
    clear(ctx.from!.id);
    await ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU });
  });

  // ── TEXT HANDLER (state machine) ─────────────────────────────

  bot.on('text', async ctx => {
    const uid   = ctx.from.id;
    const text  = ctx.message.text.trim();
    const state = get(uid);
    if (!state) return;

    switch (state.step) {
      case 'ft_ca': {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text))
          return ctx.reply('❌ Invalid CA. Please send a valid Solana address.', backBtn());
        set(uid, 'ft_dur', { ca: text });
        return ctx.reply(
          `✅ Token: <code>${text}</code>\n\nSelect duration:`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(`3H — ${config.pricing.fastTrack3hSol} SOL`,  'ft_dur_3'),
                Markup.button.callback(`12H — ${config.pricing.fastTrack12hSol} SOL`, 'ft_dur_12'),
              ],
              [Markup.button.callback(`24H — ${config.pricing.fastTrack24hSol} SOL`, 'ft_dur_24')],
              [Markup.button.callback('« Back', 'back_menu')],
            ]),
          }
        );
      }
      case 'ft_payment':  return handlePayment(ctx, state, 'fasttrack');
      case 'pro_payment': return handlePayment(ctx, state, 'pro');
      case 'ad_text': {
        set(uid, 'ad_payment', { text });
        return ctx.reply(
          `📋 <b>Ad Preview:</b>\n\n${text}\n\n💰 <b>${config.pricing.advertise24hSol} SOL</b> (24H)\n\n` +
          `📤 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with Solscan TX URL.`,
          { parse_mode: 'HTML', ...backBtn() }
        );
      }
      case 'ad_payment': return handlePayment(ctx, state, 'advertise');
    }
  });

  return bot;
}

// ── Payment verification ─────────────────────────────────────────────

async function handlePayment(
  ctx: any,
  state: State,
  type: 'fasttrack' | 'pro' | 'advertise'
): Promise<void> {
  const uid = ctx.from.id;
  const sig = extractTxSig(ctx.message.text.trim());
  if (!sig) return ctx.reply('❌ Paste a valid Solscan TX URL or signature.');

  await ctx.reply('🔍 Verifying payment…');

  const amount =
    type === 'pro'       ? config.pricing.proMonthlySol :
    type === 'fasttrack' ? state.data.price             :
                           config.pricing.advertise24hSol;

  const result = await verifyPayment(sig, config.solana.paymentWallet, amount);
  if (!result.valid) {
    return ctx.reply(`❌ Not verified: ${result.error}`, Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_menu')]]));
  }

  clear(uid);

  if (type === 'pro') {
    saveProSubscriber({
      telegram_id: uid, telegram_username: ctx.from.username,
      payment_tx: sig, sol_amount: result.amount!,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400,
    });
    return ctx.reply('✅ <b>Pro Access Activated!</b>\n\n💎 Active for 30 days.', { parse_mode: 'HTML', ...MAIN_MENU });
  }

  if (type === 'fasttrack') {
    const expiresAt = Math.floor(Date.now() / 1000) + state.data.hours * 3600;
    updateFastTrackStatus(state.data.ftId, 'active', sig, expiresAt);
    return ctx.reply(`✅ <b>Fast-Track Confirmed!</b>\n\nFeatured for <b>${state.data.hours}H</b>. Sit tight!`, { parse_mode: 'HTML', ...MAIN_MENU });
  }

  // Advertise — notify admins
  for (const adminId of config.telegram.adminIds) {
    try {
      await ctx.telegram.sendMessage(adminId,
        `📢 <b>New Ad</b>\nFrom: @${ctx.from.username ?? uid}\nTX: ${sig}\n\n${state.data.text}`,
        { parse_mode: 'HTML' }
      );
    } catch { /* ignore */ }
  }
  return ctx.reply('✅ <b>Ad Received!</b>\n\nWill be posted within 24H after review.', { parse_mode: 'HTML', ...MAIN_MENU });
}

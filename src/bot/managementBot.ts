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
import { manualCall } from '../scanner/tokenScanner';
import { postSmartMoneyAlert } from './channelBot';

interface State { step: string; data: Record<string, any>; }
const states   = new Map<number, State>();
const set      = (id: number, step: string, data: Record<string, any> = {}) => states.set(id, { step, data });
const get      = (id: number) => states.get(id) ?? null;
const clear    = (id: number) => states.delete(id);
const isAdmin  = (id: number) => config.telegram.adminIds.includes(id);

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
    `📡 Channel: ${config.telegram.trendingChannelId}\n\n` +
    `<i>Choose an option below:</i>`
  );
}

export function createManagementBot(): Telegraf {
  const bot = new Telegraf(config.telegram.managementBotToken);

  // ── Entry points ───────────────────────────────────────────────────
  bot.start(ctx => { clear(ctx.from.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });
  bot.command('menu', ctx => { clear(ctx.from.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });

  // ── ADMIN: /call <CA> ─────────────────────────────────────────
  bot.command('call', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const ca = ctx.message.text.split(' ')[1]?.trim();
    if (!ca) return ctx.reply('Usage: /call <contract_address>');
    await ctx.reply('🔍 Fetching token data…');
    const result = await manualCall(ca);
    return ctx.reply(result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`);
  });

  // ── ADMIN: /broadcast <message> ──────────────────────────────
  bot.command('broadcast', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const text = ctx.message.text.replace('/broadcast', '').trim();
    if (!text) return ctx.reply('Usage: /broadcast <message>');
    await postSmartMoneyAlert(text); // reuses the channel posting fn
    return ctx.reply('✅ Broadcast sent to channel.');
  });

  // ── ADMIN: /stats ──────────────────────────────────────────────
  bot.command('stats', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const db       = getDb();
    const total    = (db.prepare('SELECT COUNT(*) as c FROM calls').get() as any).c;
    const c24h     = (db.prepare("SELECT COUNT(*) as c FROM calls WHERE called_at > unixepoch()-86400").get() as any).c;
    const pros     = (db.prepare("SELECT COUNT(*) as c FROM pro_subscribers WHERE expires_at > unixepoch()").get() as any).c;
    const best     = db.prepare(`
      SELECT c.symbol, MAX(cu.ath_multiplier) as ath
      FROM call_updates cu JOIN calls c ON c.id = cu.call_id
    `).get() as any;
    await ctx.reply(formatStatsMessage({
      totalCalls: total, calls24h: c24h,
      bestMultiplier: best?.ath ?? 1, bestSymbol: best?.symbol ?? '—',
      proSubscribers: pros, activeFastTracks: getActiveFastTracks().length,
    }), { parse_mode: 'HTML' });
  });

  // ── ADMIN: /wallets ────────────────────────────────────────────
  bot.command('wallets', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) {
      const list = getAllWallets();
      if (!list.length) return ctx.reply('No wallets tracked.\n\n/wallets add <addr> <label>\n/wallets remove <addr>');
      const lines = list.map(w => `${w.emoji ?? '👤'} <b>${w.label}</b>\n<code>${w.address}</code>`).join('\n\n');
      return ctx.reply(`<b>Tracked Wallets (${list.length})</b>\n\n${lines}`, { parse_mode: 'HTML' });
    }
    if (args[0] === 'add' && args[1] && args[2]) {
      addWallet(args[1], args.slice(2).join(' '));
      return ctx.reply(`✅ Added: <b>${args.slice(2).join(' ')}</b>`, { parse_mode: 'HTML' });
    }
    if (args[0] === 'remove' && args[1]) {
      removeWallet(args[1]); return ctx.reply('✅ Removed.');
    }
    return ctx.reply('/wallets | /wallets add <addr> <label> | /wallets remove <addr>');
  });

  // ── TOP 10 (public button) ─────────────────────────────────────
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
    return ctx.reply(msg, { parse_mode: 'HTML', ...backBtn() });
  });

  // ── FAST-TRACK ───────────────────────────────────────────────
  bot.action('fasttrack', async ctx => {
    await ctx.answerCbQuery();
    set(ctx.from!.id, 'ft_ca');
    return ctx.reply(
      `🚀 <b>Fast-Track Your Token</b>\n\nSend the token <b>contract address (CA)</b>:`,
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
    return ctx.reply(
      `🚀 <b>Fast-Track</b>\n\nCA: <code>${state.data.ca}</code>\n` +
      `Duration: <b>${hours}H</b>  →  <b>${price} SOL</b>\n\n` +
      `📤 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with Solscan TX URL.`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── PRO ──────────────────────────────────────────────────────────
  bot.action('pro', async ctx => {
    await ctx.answerCbQuery();
    if (isProSubscriber(ctx.from!.id)) return ctx.reply('✅ Already subscribed!', backBtn());
    set(ctx.from!.id, 'pro_payment');
    return ctx.reply(
      `💎 <b>Pro Access — ${config.pricing.proMonthlySol} SOL/month</b>\n\n` +
      `⚡ Faster alerts  🔎 Deeper data  💎 Exclusive channel\n\n` +
      `📤 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with Solscan TX URL.`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── ADVERTISE ───────────────────────────────────────────────
  bot.action('advertise', async ctx => {
    await ctx.answerCbQuery();
    set(ctx.from!.id, 'ad_text');
    return ctx.reply(
      `📢 <b>Advertise — ${config.pricing.advertise24hSol} SOL / 24H</b>\n\nSend your ad text or link:`,
      { parse_mode: 'HTML', ...backBtn() }
    );
  });

  // ── MISC ────────────────────────────────────────────────────────────
  bot.action('support',    async ctx => { await ctx.answerCbQuery(); return ctx.reply('🆘 Contact: @KabalRadarAdmin', backBtn()); });
  bot.action('disclaimer', async ctx => { await ctx.answerCbQuery(); return ctx.reply('⚠️ Nothing here is financial advice. Always DYOR.', backBtn()); });
  bot.action('back_menu',  async ctx => { await ctx.answerCbQuery(); clear(ctx.from!.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });

  // ── TEXT (state machine) ────────────────────────────────────────
  bot.on('text', async ctx => {
    const uid   = ctx.from.id;
    const text  = ctx.message.text.trim();
    const state = get(uid);
    if (!state) return;

    switch (state.step) {
      case 'ft_ca': {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text))
          return ctx.reply('❌ Invalid CA.', backBtn());
        set(uid, 'ft_dur', { ca: text });
        return ctx.reply(
          `✅ <code>${text}</code>\n\nSelect duration:`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([
            [Markup.button.callback(`3H — ${config.pricing.fastTrack3hSol} SOL`, 'ft_dur_3'), Markup.button.callback(`12H — ${config.pricing.fastTrack12hSol} SOL`, 'ft_dur_12')],
            [Markup.button.callback(`24H — ${config.pricing.fastTrack24hSol} SOL`, 'ft_dur_24')],
            [Markup.button.callback('« Back', 'back_menu')],
          ]) }
        );
      }
      case 'ft_payment':  return handlePayment(ctx, state, 'fasttrack');
      case 'pro_payment': return handlePayment(ctx, state, 'pro');
      case 'ad_text': {
        set(uid, 'ad_payment', { text });
        return ctx.reply(
          `📋 Preview:\n\n${text}\n\n💰 ${config.pricing.advertise24hSol} SOL (24H)\n\n` +
          `📤 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with Solscan TX URL.`,
          { parse_mode: 'HTML', ...backBtn() }
        );
      }
      case 'ad_payment': return handlePayment(ctx, state, 'advertise');
    }
  });

  return bot;
}

async function handlePayment(ctx: any, state: State, type: 'fasttrack' | 'pro' | 'advertise') {
  const uid = ctx.from.id;
  const sig = extractTxSig(ctx.message.text.trim());
  if (!sig) return ctx.reply('❌ Paste a valid Solscan TX URL or signature.');

  await ctx.reply('🔍 Verifying…');
  const amount = type === 'pro' ? config.pricing.proMonthlySol
    : type === 'fasttrack' ? state.data.price : config.pricing.advertise24hSol;

  const result = await verifyPayment(sig, config.solana.paymentWallet, amount);
  if (!result.valid)
    return ctx.reply(`❌ ${result.error}`, Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_menu')]]));

  clear(uid);

  if (type === 'pro') {
    saveProSubscriber({ telegram_id: uid, telegram_username: ctx.from.username, payment_tx: sig, sol_amount: result.amount!, expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400 });
    return ctx.reply('✅ <b>Pro Access Activated! 💎</b>\n\n30 days.', { parse_mode: 'HTML', ...MAIN_MENU });
  }
  if (type === 'fasttrack') {
    updateFastTrackStatus(state.data.ftId, 'active', sig, Math.floor(Date.now() / 1000) + state.data.hours * 3600);
    return ctx.reply(`✅ <b>Fast-Track active for ${state.data.hours}H!</b>`, { parse_mode: 'HTML', ...MAIN_MENU });
  }
  for (const adminId of config.telegram.adminIds) {
    try { await ctx.telegram.sendMessage(adminId, `📢 <b>New Ad</b>\n@${ctx.from.username ?? uid}\nTX: ${sig}\n\n${state.data.text}`, { parse_mode: 'HTML' }); } catch { /* ignore */ }
  }
  return ctx.reply('✅ <b>Ad received — will be posted within 24H.</b>', { parse_mode: 'HTML', ...MAIN_MENU });
}

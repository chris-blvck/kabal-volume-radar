import { Telegraf, Markup } from 'telegraf';
import { config } from '../config';
import { verifyPayment, extractTxSig } from '../utils/solana';
import { fmtMcap, formatStatsMessage } from '../utils/formatMessage';
import {
  isProSubscriber, saveProSubscriber,
  saveFastTrack, updateFastTrackStatus,
  getRecentCalls, getAthForCall, getActiveFastTracks, getDb,
  getTrackRecord, setNotificationPref,
} from '../database/db';
import { addWallet, removeWallet, getAllWallets } from '../scanner/walletTracker';
import { addToWatchlist, removeFromWatchlist, getUserWatchlist } from '../tracker/watchlist';
import { manualCall } from '../scanner/tokenScanner';
import { postSmartMoneyAlert } from './channelBot';
import {
  registerReferral, getReferrerId, recordEarning,
  getReferralStats, getPendingPayouts, markPaidOut,
} from '../referral';

interface State { step: string; data: Record<string, any>; }
const states  = new Map<number, State>();
const set     = (id: number, step: string, data: Record<string, any> = {}) => states.set(id, { step, data });
const get     = (id: number) => states.get(id) ?? null;
const clear   = (id: number) => states.delete(id);
const isAdmin = (id: number) => config.telegram.adminIds.includes(id);

const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback('\uD83D\uDE80 Fast-Track', 'fasttrack'), Markup.button.callback('\uD83D\uDCE2 Advertise', 'advertise')],
  [Markup.button.callback('\uD83D\uDC8E Pro Access',  'pro'),       Markup.button.callback('\uD83C\uDD98 Support',   'support')],
  [Markup.button.callback('\uD83C\uDFC6 Top 10',      'top10'),     Markup.button.callback('\uD83D\uDC65 Referral',  'referral')],
  [Markup.button.callback('\uD83D\uDCCB Disclaimer',  'disclaimer')],
]);
const backBtn = () => Markup.inlineKeyboard([[Markup.button.callback('\u00AB Back', 'back_menu')]]);

function welcomeText() {
  return (
    `\uD83D\uDDA5 <b>Kabal Volume Radar</b>\n\n` +
    `Track the hottest Solana tokens before they pump.\n\n` +
    `\uD83D\uDCE1 Channel: ${config.telegram.trendingChannelId}\n\n` +
    `<i>Choose an option below:</i>`
  );
}

export function createManagementBot(): Telegraf {
  const bot = new Telegraf(config.telegram.managementBotToken);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.start(ctx => {
    clear(ctx.from.id);
    const param = (ctx.message as any).text?.split(' ')[1];
    if (param?.startsWith('ref_')) {
      const referrerId = parseInt(param.replace('ref_', ''));
      if (!isNaN(referrerId)) registerReferral(referrerId, ctx.from.id);
    }
    return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU });
  });

  bot.command('menu', ctx => { clear(ctx.from.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.command('help', ctx => {
    const isPro = isProSubscriber(ctx.from.id);
    let msg = `\uD83E\uDD16 <b>Kabal Volume Radar \u2014 Commands</b>\n\n`;
    msg += `<b>General</b>\n`;
    msg += `/start \u2014 Main menu\n`;
    msg += `/record \u2014 30-day track record\n`;
    msg += `/watch &lt;CA&gt; [mult] \u2014 Watch a token, DM at target\n`;
    msg += `/unwatch &lt;CA&gt; \u2014 Remove from watchlist\n`;
    msg += `/watchlist \u2014 View your watchlist\n`;
    msg += `/help \u2014 This message\n`;
    if (isPro) {
      msg += `\n<b>Pro \uD83D\uDC8E</b>\n`;
      msg += `/notify on \u2014 Enable DM alerts for new calls\n`;
      msg += `/notify off \u2014 Disable DM alerts\n`;
    } else {
      msg += `\n<i>\uD83D\uDC8E Upgrade to Pro for instant DM alerts on every call.</i>\n`;
    }
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── /notify (Pro only) ──────────────────────────────────────────────
  bot.command('notify', ctx => {
    if (!isProSubscriber(ctx.from.id))
      return ctx.reply('\uD83D\uDC8E This feature is for Pro subscribers.\n\nUse the menu to upgrade.', MAIN_MENU);
    const arg = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (arg !== 'on' && arg !== 'off')
      return ctx.reply('Usage: /notify on | /notify off');
    setNotificationPref(ctx.from.id, arg === 'on');
    return ctx.reply(
      arg === 'on'
        ? '\uD83D\uDD14 DM alerts <b>enabled</b>. You will be notified on every new call.'
        : '\uD83D\uDD15 DM alerts <b>disabled</b>.',
      { parse_mode: 'HTML' },
    );
  });

  // ── /record ──────────────────────────────────────────────────────────────
  bot.command('record', async ctx => {
    const rec = getTrackRecord(30);
    if (rec.totalCalls === 0) return ctx.reply('\uD83D\uDCCA No calls recorded yet. Stay tuned!');
    let msg = `\uD83D\uDCCA <b>Kabal Radar \u2014 Track Record (30d)</b>\n\n`;
    msg += `\uD83D\uDCDE Total calls: <b>${rec.totalCalls}</b>\n\n`;
    msg += `\uD83C\uDFC6 <b>Win Rates</b>\n`;
    msg += `  2x: <b>${rec.winRate2x}%</b>  5x: <b>${rec.winRate5x}%</b>  10x: <b>${rec.winRate10x}%</b>\n\n`;
    msg += `\uD83D\uDCC8 Avg return: <b>${rec.avgMultiplier.toFixed(1)}x</b>\n`;
    if (rec.bestCall) msg += `\uD83D\uDD25 Best call: <b>$${rec.bestCall.symbol}</b> @ <b>${rec.bestCall.multiplier.toFixed(1)}x</b>\n`;
    if (rec.recentCalls.length) {
      msg += `\n<b>Recent Calls</b>\n`;
      const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
      rec.recentCalls.forEach((c, i) => {
        const icon = c.ath >= 5 ? '\uD83D\uDE80' : c.ath >= 2 ? '\u2705' : '\uD83D\uDCC9';
        msg += `${i < 3 ? medals[i] : icon} <b>$${c.symbol}</b> | ${fmtMcap(c.mcapAtCall)} | <b>${c.ath.toFixed(1)}x</b>\n`;
      });
    }
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── /watch ─────────────────────────────────────────────────────────────────
  bot.command('watch', async ctx => {
    const parts = ctx.message.text.split(' ').slice(1);
    const ca = parts[0]?.trim();
    if (!ca) return ctx.reply('Usage: /watch <CA> [target_multiplier]\nExample: /watch AbC123\u2026 3.0');
    const targetMult = parts[1] ? parseFloat(parts[1].replace('x', '')) : 2.0;
    if (isNaN(targetMult) || targetMult <= 1) return ctx.reply('\u274C Target must be > 1 (e.g. 2, 3.5, 10)');
    await ctx.reply('\uD83D\uDD0D Fetching token\u2026');
    const result = await addToWatchlist(ctx.from.id, ca, targetMult);
    return ctx.reply(result.msg, { parse_mode: 'HTML' });
  });

  // ── /unwatch ──────────────────────────────────────────────────────────────
  bot.command('unwatch', ctx => {
    const ca = ctx.message.text.split(' ')[1]?.trim();
    if (!ca) return ctx.reply('Usage: /unwatch <CA>');
    removeFromWatchlist(ctx.from.id, ca);
    return ctx.reply('\u2705 Removed from watchlist.');
  });

  // ── /watchlist ────────────────────────────────────────────────────────────
  bot.command('watchlist', ctx => {
    const items = getUserWatchlist(ctx.from.id);
    if (!items.length) return ctx.reply('\uD83D\uDCCB Your watchlist is empty.\n\nUse /watch <CA> [target] to add tokens.');
    let msg = `\uD83D\uDCCB <b>Your Watchlist (${items.length})</b>\n\n`;
    items.forEach(item => {
      const status = item.alerted_at ? '\u2705 alerted' : `\u23F3 target ${item.target_mult}x`;
      msg += `<b>$${item.symbol}</b> \u2014 ${status}\n`;
      msg += `  Entry: ${fmtMcap(item.mcap_at_add ?? 0)}  <code>${item.contract_address}</code>\n\n`;
    });
    msg += `<i>Remove: /unwatch &lt;CA&gt;</i>`;
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── REFERRAL ───────────────────────────────────────────────────────────
  bot.action('referral', async ctx => {
    await ctx.answerCbQuery();
    const uid   = ctx.from!.id;
    const stats = getReferralStats(uid);
    const link  = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
    let msg = `\uD83D\uDC65 <b>Your Referral Program</b>\n\n`;
    msg += `\uD83D\uDD17 Your link:\n<code>${link}</code>\n\n`;
    msg += `\uD83D\uDC64 Referrals: <b>${stats.totalReferrals}</b>\n`;
    msg += `\uD83D\uDCB0 Pending: <b>${stats.pendingEarnSol.toFixed(4)} SOL</b>\n`;
    msg += `\uD83C\uDFC6 Total earned: <b>${stats.totalEarnSol.toFixed(4)} SOL</b>\n\n`;
    msg += `<i>Earn ${config.referral.commissionPct}% of every payment your referrals make.\nAdmin pays out pending earnings on request.</i>`;
    return ctx.reply(msg, { parse_mode: 'HTML', ...backBtn() });
  });

  // ── ADMIN commands ───────────────────────────────────────────────────
  bot.command('payouts', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const args    = ctx.message.text.split(' ').slice(1);
    const payouts = getPendingPayouts();
    if (args[0] === 'paid' && args[1]) { markPaidOut(parseInt(args[1])); return ctx.reply(`\u2705 Marked user ${args[1]} as paid out.`); }
    if (!payouts.length) return ctx.reply('No pending payouts.');
    let msg = '\uD83D\uDCB0 <b>Pending Payouts</b>\n\n';
    payouts.forEach(p => { msg += `User <code>${p.referrer_id}</code>: <b>${p.total_sol.toFixed(4)} SOL</b> (${p.count} payments)\n`; });
    msg += `\n<i>/payouts paid &lt;userId&gt; \u2014 mark as paid</i>`;
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  bot.command('call', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const ca = ctx.message.text.split(' ')[1]?.trim();
    if (!ca) return ctx.reply('Usage: /call <CA>');
    await ctx.reply('\uD83D\uDD0D Fetching\u2026');
    const result = await manualCall(ca);
    return ctx.reply(result.ok ? `\u2705 ${result.msg}` : `\u274C ${result.msg}`);
  });

  bot.command('broadcast', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const text = ctx.message.text.replace('/broadcast', '').trim();
    if (!text) return ctx.reply('Usage: /broadcast <message>');
    await postSmartMoneyAlert(text);
    return ctx.reply('\u2705 Sent.');
  });

  bot.command('stats', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const db    = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM calls').get() as any).c;
    const c24h  = (db.prepare("SELECT COUNT(*) as c FROM calls WHERE called_at > unixepoch()-86400").get() as any).c;
    const pros  = (db.prepare("SELECT COUNT(*) as c FROM pro_subscribers WHERE expires_at > unixepoch()").get() as any).c;
    const best  = db.prepare('SELECT c.symbol, MAX(cu.ath_multiplier) as ath FROM call_updates cu JOIN calls c ON c.id=cu.call_id').get() as any;
    return ctx.reply(formatStatsMessage({
      totalCalls: total, calls24h: c24h,
      bestMultiplier: best?.ath ?? 1, bestSymbol: best?.symbol ?? '\u2014',
      proSubscribers: pros, activeFastTracks: getActiveFastTracks().length,
    }), { parse_mode: 'HTML' });
  });

  bot.command('wallets', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (!args.length) {
      const list = getAllWallets();
      if (!list.length) return ctx.reply('None.\n/wallets add <addr> <label>\n/wallets remove <addr>');
      return ctx.reply(list.map(w => `${w.emoji ?? '\uD83D\uDC64'} <b>${w.label}</b>\n<code>${w.address}</code>`).join('\n\n'), { parse_mode: 'HTML' });
    }
    if (args[0] === 'add'    && args[1] && args[2]) { addWallet(args[1], args.slice(2).join(' ')); return ctx.reply('\u2705 Added.'); }
    if (args[0] === 'remove' && args[1])            { removeWallet(args[1]);                        return ctx.reply('\u2705 Removed.'); }
    return ctx.reply('/wallets | /wallets add <addr> <label> | /wallets remove <addr>');
  });

  // ── Menu buttons ──────────────────────────────────────────────────────
  bot.action('top10', async ctx => {
    await ctx.answerCbQuery();
    const calls = getRecentCalls(10);
    if (!calls.length) return ctx.reply('No calls yet.');
    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    let msg = '\uD83C\uDFC6 <b>Recent Calls</b>\n\n';
    calls.forEach((c, i) => {
      const ath = getAthForCall(c.id);
      msg += `${i < 3 ? medals[i] : `${i+1}.`} <b>$${c.symbol}</b> | ${fmtMcap(c.market_cap_at_call ?? 0)}${ath >= 2 ? ` | ATH ${ath.toFixed(1)}x` : ''}\n`;
    });
    return ctx.reply(msg, { parse_mode: 'HTML', ...backBtn() });
  });

  bot.action('fasttrack', async ctx => {
    await ctx.answerCbQuery(); set(ctx.from!.id, 'ft_ca');
    return ctx.reply(`\uD83D\uDE80 <b>Fast-Track</b>\n\nSend the token CA:`, { parse_mode: 'HTML', ...backBtn() });
  });

  bot.action(/^ft_dur_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    const hours = parseInt(ctx.match[1]);
    const state = get(ctx.from!.id);
    if (!state?.data.ca) return ctx.reply('Session expired.', MAIN_MENU);
    const priceMap: Record<number, number> = { 3: config.pricing.fastTrack3hSol, 12: config.pricing.fastTrack12hSol, 24: config.pricing.fastTrack24hSol };
    const price = priceMap[hours];
    const ftId  = saveFastTrack({ contract_address: state.data.ca, submitter_chat_id: ctx.from!.id, duration_hours: hours, sol_amount: price });
    set(ctx.from!.id, 'ft_payment', { ...state.data, hours, price, ftId });
    return ctx.reply(
      `\uD83D\uDE80 <b>Fast-Track</b> \u2014 CA: <code>${state.data.ca}</code>\n${hours}H \u2192 <b>${price} SOL</b>\n\n\uD83D\uDCE4 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with Solscan TX URL.`,
      { parse_mode: 'HTML', ...backBtn() },
    );
  });

  bot.action('pro', async ctx => {
    await ctx.answerCbQuery();
    if (isProSubscriber(ctx.from!.id)) return ctx.reply('\u2705 Already subscribed!', backBtn());
    set(ctx.from!.id, 'pro_payment');
    return ctx.reply(
      `\uD83D\uDC8E <b>Pro \u2014 ${config.pricing.proMonthlySol} SOL/month</b>\n\u26A1 Instant calls \u00B7 DM alerts \u00B7 Pro channel\n\n\uD83D\uDCE4 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with Solscan TX URL.`,
      { parse_mode: 'HTML', ...backBtn() },
    );
  });

  bot.action('advertise', async ctx => {
    await ctx.answerCbQuery(); set(ctx.from!.id, 'ad_text');
    return ctx.reply(`\uD83D\uDCE2 <b>Advertise \u2014 ${config.pricing.advertise24hSol} SOL/24H</b>\n\nSend your ad text or link:`, { parse_mode: 'HTML', ...backBtn() });
  });

  bot.action('support',    async ctx => { await ctx.answerCbQuery(); return ctx.reply('\uD83C\uDD98 Contact: @KabalRadarAdmin', backBtn()); });
  bot.action('disclaimer', async ctx => { await ctx.answerCbQuery(); return ctx.reply('\u26A0\uFE0F Not financial advice. DYOR.', backBtn()); });
  bot.action('back_menu',  async ctx => { await ctx.answerCbQuery(); clear(ctx.from!.id); return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU }); });

  // ── Text handler ────────────────────────────────────────────────────────
  bot.on('text', async ctx => {
    const uid = ctx.from.id; const text = ctx.message.text.trim(); const state = get(uid);
    if (!state) return;
    switch (state.step) {
      case 'ft_ca': {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return ctx.reply('\u274C Invalid CA.', backBtn());
        set(uid, 'ft_dur', { ca: text });
        return ctx.reply(`\u2705 <code>${text}</code>\n\nDuration:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback(`3H \u2014 ${config.pricing.fastTrack3hSol} SOL`, 'ft_dur_3'), Markup.button.callback(`12H \u2014 ${config.pricing.fastTrack12hSol} SOL`, 'ft_dur_12')],
          [Markup.button.callback(`24H \u2014 ${config.pricing.fastTrack24hSol} SOL`, 'ft_dur_24')],
          [Markup.button.callback('\u00AB Back', 'back_menu')],
        ]) });
      }
      case 'ft_payment':  return handlePayment(ctx, state, 'fasttrack');
      case 'pro_payment': return handlePayment(ctx, state, 'pro');
      case 'ad_text': {
        set(uid, 'ad_payment', { text });
        return ctx.reply(`\uD83D\uDCCB Preview:\n\n${text}\n\n${config.pricing.advertise24hSol} SOL\n\uD83D\uDCE4 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with Solscan TX URL.`, { parse_mode: 'HTML', ...backBtn() });
      }
      case 'ad_payment': return handlePayment(ctx, state, 'advertise');
    }
  });

  return bot;
}

async function handlePayment(ctx: any, state: State, type: 'fasttrack' | 'pro' | 'advertise') {
  const uid = ctx.from.id;
  const sig = extractTxSig(ctx.message.text.trim());
  if (!sig) return ctx.reply('\u274C Paste a valid Solscan TX URL.');
  await ctx.reply('\uD83D\uDD0D Verifying\u2026');

  const amount = type === 'pro'       ? config.pricing.proMonthlySol
               : type === 'fasttrack' ? state.data.price
               : config.pricing.advertise24hSol;

  const result = await verifyPayment(sig, config.solana.paymentWallet, amount);
  if (!result.valid)
    return ctx.reply(`\u274C ${result.error}`, Markup.inlineKeyboard([[Markup.button.callback('\u00AB Back', 'back_menu')]]));

  clear(uid);

  const referrerId = getReferrerId(uid);
  if (referrerId) recordEarning({ referrerId, refereeId: uid, paymentType: type, grossSol: result.amount!, paymentTx: sig });

  if (type === 'pro') {
    saveProSubscriber({ telegram_id: uid, telegram_username: ctx.from.username, payment_tx: sig, sol_amount: result.amount!, expires_at: Math.floor(Date.now()/1000) + 30*86_400 });
    return ctx.reply('\u2705 <b>Pro activated! \uD83D\uDC8E 30 days.\nUse /notify on to enable DM call alerts.</b>', { parse_mode: 'HTML', ...MAIN_MENU });
  }
  if (type === 'fasttrack') {
    updateFastTrackStatus(state.data.ftId, 'active', sig, Math.floor(Date.now()/1000) + state.data.hours * 3600);
    return ctx.reply(`\u2705 <b>Fast-Track active for ${state.data.hours}H!</b>`, { parse_mode: 'HTML', ...MAIN_MENU });
  }
  for (const adminId of config.telegram.adminIds) {
    try { await ctx.telegram.sendMessage(adminId, `\uD83D\uDCE2 <b>New Ad</b>\n@${ctx.from.username ?? uid}\nTX: ${sig}\n\n${state.data.text}`, { parse_mode: 'HTML' }); } catch { /* ignore */ }
  }
  return ctx.reply('\u2705 <b>Ad received \u2014 posted within 24H.</b>', { parse_mode: 'HTML', ...MAIN_MENU });
}

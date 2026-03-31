import { Telegraf, Markup } from 'telegraf';
import { config } from '../config';
import { verifyPayment, extractTxSig } from '../utils/solana';
import { fmtMcap, fmtPct, fmtVol, formatStatsMessage } from '../utils/formatMessage';
import {
  isProSubscriber, saveProSubscriber,
  saveFastTrack, updateFastTrackStatus,
  getRecentCalls, getAthForCall, getActiveFastTracks, getDb,
  getTrackRecord, setNotificationPref, isAlreadyCalled,
} from '../database/db';
import { addWallet, removeWallet, getAllWallets } from '../scanner/walletTracker';
import { addToWatchlist, removeFromWatchlist, getUserWatchlist } from '../tracker/watchlist';
import { manualCall } from '../scanner/tokenScanner';
import { postSmartMoneyAlert } from './channelBot';
import { getTokenByAddress } from '../scanner/dexscreener';
import { getMintInfo } from '../scanner/mintCheck';
import { getRugcheckReport, rugRiskLabel, topRisks } from '../scanner/rugcheck';
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
    `<i>Use /help to see all commands.</i>`
  );
}

export function createManagementBot(): Telegraf {
  const bot = new Telegraf(config.telegram.managementBotToken);

  // ── /start ────────────────────────────────────────────────────────────
  bot.start(ctx => {
    clear(ctx.from.id);
    const param = (ctx.message as any).text?.split(' ')[1];
    if (param?.startsWith('ref_')) {
      const referrerId = parseInt(param.replace('ref_', ''));
      if (!isNaN(referrerId)) registerReferral(referrerId, ctx.from.id);
    }
    return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU });
  });

  bot.command('menu', ctx => {
    clear(ctx.from.id);
    return ctx.reply(welcomeText(), { parse_mode: 'HTML', ...MAIN_MENU });
  });

  // ── /help ─────────────────────────────────────────────────────────────
  bot.command('help', ctx => {
    const isPro = isProSubscriber(ctx.from.id);
    let msg = `\uD83E\uDD16 <b>Kabal Volume Radar \u2014 Commands</b>\n\n`;
    msg += `/start \u2014 Main menu\n`;
    msg += `/check &lt;CA&gt; \u2014 Quick token analysis\n`;
    msg += `/record \u2014 30-day track record\n`;
    msg += `/watch &lt;CA&gt; [mult] \u2014 Watch a token, DM at target\n`;
    msg += `/unwatch &lt;CA&gt; \u2014 Remove from watchlist\n`;
    msg += `/watchlist \u2014 View your watchlist\n`;
    msg += `/help \u2014 This message\n`;
    if (isPro) {
      msg += `\n<b>Pro \uD83D\uDC8E</b>\n`;
      msg += `/notify on|off \u2014 Toggle DM alerts for new calls\n`;
    } else {
      msg += `\n<i>\uD83D\uDC8E Upgrade to Pro for instant DM alerts on every call.</i>`;
    }
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── /check <CA> ───────────────────────────────────────────────────────
  bot.command('check', async ctx => {
    const ca = ctx.message.text.split(' ')[1]?.trim();
    if (!ca) return ctx.reply('Usage: /check <CA>');

    await ctx.reply('\uD83D\uDD0D Analyzing\u2026');

    const [pair, rugReport] = await Promise.all([
      getTokenByAddress(ca),
      getRugcheckReport(ca),
    ]);

    if (!pair) return ctx.reply('\u274C Token not found on DexScreener.');

    const mcap   = pair.marketCap ?? pair.fdv ?? 0;
    const vol1h  = pair.volume?.h1 ?? 0;
    const buys   = pair.txns?.h1?.buys  ?? 0;
    const sells  = pair.txns?.h1?.sells ?? 0;
    const pc1h   = pair.priceChange?.h1 ?? 0;
    const pc5m   = pair.priceChange?.m5 ?? 0;
    const liq    = pair.liquidity?.usd  ?? 0;
    const ageH   = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : null;
    const called = isAlreadyCalled(ca);

    let msg = `\uD83D\uDD0D <b>$${pair.baseToken.symbol} \u2014 Quick Check</b>\n`;
    msg += `<code>${ca}</code>\n\n`;

    msg += `\uD83D\uDCB0 MCap: <b>${fmtMcap(mcap)}</b>`;
    if (ageH !== null) msg += `  \uD83D\uDD52 Age: <b>${ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(1)}h`}</b>`;
    msg += '\n';
    msg += `\uD83D\uDCC8 5m: ${fmtPct(pc5m)}  1h: ${fmtPct(pc1h)}\n`;
    msg += `\uD83D\uDCCA Vol/1h: ${fmtVol(vol1h)}  \uD83D\uDCA7 Liq: ${fmtVol(liq)}\n`;
    msg += `\uD83D\uDD04 ${buys}\u2191 / ${sells}\u2193  (${buys + sells > 0 ? Math.round((buys / (buys + sells)) * 100) : 0}% buys)\n`;

    // Rugcheck score
    if (rugReport) {
      msg += `\n\uD83D\uDEE1 <b>Rug Score:</b> ${rugRiskLabel(rugReport.scoreNormalised)}  <i>(${rugReport.scoreNormalised}/100)</i>\n`;
      const risks = topRisks(rugReport, 2);
      if (risks.length) msg += `  \u26A0\uFE0F ${risks.join(' \u00B7 ')}\n`;
    }

    // Mint check
    const mintInfo = await getMintInfo(ca);
    if (mintInfo) {
      msg += `\n\uD83D\uDD12 Mint: ${mintInfo.mintAuthorityRevoked ? '\u2705' : '\u274C'}  `;
      msg += `Freeze: ${mintInfo.freezeAuthorityRevoked ? '\u2705' : '\u274C'}`;
      if (mintInfo.isPumpFunNative) msg += `  <i>(pump.fun)</i>`;
      msg += '\n';
    }

    if (called) msg += `\n<i>\u2139\uFE0F Already called by Kabal Radar</i>\n`;

    return ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '\uD83D\uDCCA DexScreener', url: pair.url },
          { text: '\u26A1 GMGN', url: `https://gmgn.ai/sol/token/${ca}` },
        ]],
      },
    });
  });

  // ── /notify ───────────────────────────────────────────────────────────
  bot.command('notify', ctx => {
    if (!isProSubscriber(ctx.from.id))
      return ctx.reply('\uD83D\uDC8E Pro only. Use the menu to upgrade.', MAIN_MENU);
    const arg = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (arg !== 'on' && arg !== 'off') return ctx.reply('Usage: /notify on | /notify off');
    setNotificationPref(ctx.from.id, arg === 'on');
    return ctx.reply(
      arg === 'on' ? '\uD83D\uDD14 DM alerts <b>enabled</b>.' : '\uD83D\uDD15 DM alerts <b>disabled</b>.',
      { parse_mode: 'HTML' },
    );
  });

  // ── /record ───────────────────────────────────────────────────────────
  bot.command('record', ctx => {
    const rec = getTrackRecord(30);
    if (rec.totalCalls === 0) return ctx.reply('\uD83D\uDCCA No calls yet. Stay tuned!');
    let msg = `\uD83D\uDCCA <b>Kabal Radar \u2014 Track Record (30d)</b>\n\n`;
    msg += `\uD83D\uDCDE Calls: <b>${rec.totalCalls}</b>\n`;
    msg += `\uD83C\uDFC6 2x: <b>${rec.winRate2x}%</b>  5x: <b>${rec.winRate5x}%</b>  10x: <b>${rec.winRate10x}%</b>\n`;
    msg += `\uD83D\uDCC8 Avg: <b>${rec.avgMultiplier.toFixed(1)}x</b>\n`;
    if (rec.bestCall) msg += `\uD83D\uDD25 Best: <b>$${rec.bestCall.symbol}</b> @ <b>${rec.bestCall.multiplier.toFixed(1)}x</b>\n`;
    if (rec.recentCalls.length) {
      msg += `\n<b>Recent</b>\n`;
      rec.recentCalls.slice(0, 8).forEach(c => {
        const icon = c.ath >= 5 ? '\uD83D\uDE80' : c.ath >= 2 ? '\u2705' : '\uD83D\uDCC9';
        msg += `${icon} <b>$${c.symbol}</b> ${fmtMcap(c.mcapAtCall)} \u2192 <b>${c.ath.toFixed(1)}x</b>\n`;
      });
    }
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── /watch /unwatch /watchlist ────────────────────────────────────────
  bot.command('watch', async ctx => {
    const parts = ctx.message.text.split(' ').slice(1);
    const ca = parts[0]?.trim();
    if (!ca) return ctx.reply('Usage: /watch <CA> [target]\nExample: /watch AbC\u2026 3');
    const mult = parts[1] ? parseFloat(parts[1].replace('x', '')) : 2.0;
    if (isNaN(mult) || mult <= 1) return ctx.reply('\u274C Target must be > 1');
    await ctx.reply('\uD83D\uDD0D Fetching\u2026');
    const result = await addToWatchlist(ctx.from.id, ca, mult);
    return ctx.reply(result.msg, { parse_mode: 'HTML' });
  });

  bot.command('unwatch', ctx => {
    const ca = ctx.message.text.split(' ')[1]?.trim();
    if (!ca) return ctx.reply('Usage: /unwatch <CA>');
    removeFromWatchlist(ctx.from.id, ca);
    return ctx.reply('\u2705 Removed.');
  });

  bot.command('watchlist', ctx => {
    const items = getUserWatchlist(ctx.from.id);
    if (!items.length) return ctx.reply('\uD83D\uDCCB Empty.\n\n/watch <CA> [target] to add.');
    let msg = `\uD83D\uDCCB <b>Watchlist (${items.length})</b>\n\n`;
    items.forEach(item => {
      msg += `<b>$${item.symbol}</b> \u2014 ${item.alerted_at ? '\u2705 alerted' : `\u23F3 ${item.target_mult}x`}\n`;
      msg += `  ${fmtMcap(item.mcap_at_add ?? 0)}  <code>${item.contract_address}</code>\n\n`;
    });
    msg += `<i>/unwatch &lt;CA&gt; to remove</i>`;
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── REFERRAL ──────────────────────────────────────────────────────────
  bot.action('referral', async ctx => {
    await ctx.answerCbQuery();
    const uid   = ctx.from!.id;
    const stats = getReferralStats(uid);
    const link  = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
    let msg = `\uD83D\uDC65 <b>Referral</b>\n\n`;
    msg += `\uD83D\uDD17 <code>${link}</code>\n\n`;
    msg += `\uD83D\uDC64 Referrals: <b>${stats.totalReferrals}</b>\n`;
    msg += `\uD83D\uDCB0 Pending: <b>${stats.pendingEarnSol.toFixed(4)} SOL</b>\n`;
    msg += `\uD83C\uDFC6 Total: <b>${stats.totalEarnSol.toFixed(4)} SOL</b>\n\n`;
    msg += `<i>Earn ${config.referral.commissionPct}% of every payment your referrals make.</i>`;
    return ctx.reply(msg, { parse_mode: 'HTML', ...backBtn() });
  });

  // ── ADMIN ─────────────────────────────────────────────────────────────
  bot.command('payouts', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (args[0] === 'paid' && args[1]) { markPaidOut(parseInt(args[1])); return ctx.reply(`\u2705 Paid out user ${args[1]}.`); }
    const payouts = getPendingPayouts();
    if (!payouts.length) return ctx.reply('No pending payouts.');
    let msg = '\uD83D\uDCB0 <b>Pending Payouts</b>\n\n';
    payouts.forEach(p => { msg += `<code>${p.referrer_id}</code>: <b>${p.total_sol.toFixed(4)} SOL</b> (${p.count})\n`; });
    return ctx.reply(msg + `\n<i>/payouts paid &lt;id&gt;</i>`, { parse_mode: 'HTML' });
  });

  bot.command('call', async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const ca = ctx.message.text.split(' ')[1]?.trim();
    if (!ca) return ctx.reply('Usage: /call <CA>');
    await ctx.reply('\uD83D\uDD0D Fetching\u2026');
    const r = await manualCall(ca);
    return ctx.reply(r.ok ? `\u2705 ${r.msg}` : `\u274C ${r.msg}`);
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
    return ctx.reply('/wallets add <addr> <label> | /wallets remove <addr>');
  });

  // ── Menu actions ──────────────────────────────────────────────────────
  bot.action('top10', async ctx => {
    await ctx.answerCbQuery();
    const calls = getRecentCalls(10);
    if (!calls.length) return ctx.reply('No calls yet.');
    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    let msg = '\uD83C\uDFC6 <b>Recent Calls</b>\n\n';
    calls.forEach((c, i) => {
      const ath = getAthForCall(c.id);
      msg += `${i < 3 ? medals[i] : `${i + 1}.`} <b>$${c.symbol}</b> | ${fmtMcap(c.market_cap_at_call ?? 0)}${ath >= 2 ? ` | <b>${ath.toFixed(1)}x</b>` : ''}\n`;
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
    const pm: Record<number, number> = { 3: config.pricing.fastTrack3hSol, 12: config.pricing.fastTrack12hSol, 24: config.pricing.fastTrack24hSol };
    const price = pm[hours];
    const ftId  = saveFastTrack({ contract_address: state.data.ca, submitter_chat_id: ctx.from!.id, duration_hours: hours, sol_amount: price });
    set(ctx.from!.id, 'ft_payment', { ...state.data, hours, price, ftId });
    return ctx.reply(
      `\uD83D\uDE80 <b>Fast-Track</b> \u2014 <code>${state.data.ca}</code>\n${hours}H \u2192 <b>${price} SOL</b>\n\n\uD83D\uDCE4 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with TX URL or signature.`,
      { parse_mode: 'HTML', ...backBtn() },
    );
  });

  bot.action('pro', async ctx => {
    await ctx.answerCbQuery();
    if (isProSubscriber(ctx.from!.id)) return ctx.reply('\u2705 Already subscribed!', backBtn());
    set(ctx.from!.id, 'pro_payment');
    return ctx.reply(
      `\uD83D\uDC8E <b>Pro \u2014 ${config.pricing.proMonthlySol} SOL/month</b>\n\u26A1 Instant calls \u00B7 DM alerts \u00B7 Pro channel\n\n\uD83D\uDCE4 Send to:\n<code>${config.solana.paymentWallet}</code>\n\nReply with TX URL or signature.`,
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

  // ── Text handler ──────────────────────────────────────────────────────
  bot.on('text', async ctx => {
    const uid = ctx.from.id; const text = ctx.message.text.trim(); const state = get(uid);
    if (!state) return;
    switch (state.step) {
      case 'ft_ca': {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return ctx.reply('\u274C Invalid CA.', backBtn());
        set(uid, 'ft_dur', { ca: text });
        return ctx.reply(`\u2705 <code>${text}</code>\n\nSelect duration:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback(`3H \u2014 ${config.pricing.fastTrack3hSol} SOL`, 'ft_dur_3'), Markup.button.callback(`12H \u2014 ${config.pricing.fastTrack12hSol} SOL`, 'ft_dur_12')],
          [Markup.button.callback(`24H \u2014 ${config.pricing.fastTrack24hSol} SOL`, 'ft_dur_24')],
          [Markup.button.callback('\u00AB Back', 'back_menu')],
        ]) });
      }
      case 'ft_payment':  return handlePayment(ctx, state, 'fasttrack');
      case 'pro_payment': return handlePayment(ctx, state, 'pro');
      case 'ad_text': {
        set(uid, 'ad_payment', { text });
        return ctx.reply(`\uD83D\uDCCB Preview:\n\n${text}\n\n${config.pricing.advertise24hSol} SOL\n\uD83D\uDCE4 <code>${config.solana.paymentWallet}</code>\n\nReply with TX URL.`, { parse_mode: 'HTML', ...backBtn() });
      }
      case 'ad_payment': return handlePayment(ctx, state, 'advertise');
    }
  });

  return bot;
}

async function handlePayment(ctx: any, state: State, type: 'fasttrack' | 'pro' | 'advertise') {
  const uid = ctx.from.id;
  const sig = extractTxSig(ctx.message.text.trim());
  if (!sig) return ctx.reply('\u274C Paste a valid Solscan TX URL or signature.');
  await ctx.reply('\uD83D\uDD0D Verifying\u2026');

  const amount = type === 'pro' ? config.pricing.proMonthlySol
    : type === 'fasttrack'     ? state.data.price
    : config.pricing.advertise24hSol;

  const result = await verifyPayment(sig, config.solana.paymentWallet, amount);
  if (!result.valid)
    return ctx.reply(`\u274C ${result.error}`, Markup.inlineKeyboard([[Markup.button.callback('\u00AB Back', 'back_menu')]]));

  clear(uid);

  const referrerId = getReferrerId(uid);
  if (referrerId) recordEarning({ referrerId, refereeId: uid, paymentType: type, grossSol: result.amount!, paymentTx: sig });

  if (type === 'pro') {
    saveProSubscriber({ telegram_id: uid, telegram_username: ctx.from.username, payment_tx: sig, sol_amount: result.amount!, expires_at: Math.floor(Date.now() / 1000) + 30 * 86_400 });
    return ctx.reply('\u2705 <b>Pro activated! \uD83D\uDC8E 30 days.\nUse /notify on to enable DM call alerts.</b>', { parse_mode: 'HTML', ...MAIN_MENU });
  }
  if (type === 'fasttrack') {
    updateFastTrackStatus(state.data.ftId, 'active', sig, Math.floor(Date.now() / 1000) + state.data.hours * 3600);
    return ctx.reply(`\u2705 <b>Fast-Track active for ${state.data.hours}H!</b>`, { parse_mode: 'HTML', ...MAIN_MENU });
  }
  for (const adminId of config.telegram.adminIds) {
    try { await ctx.telegram.sendMessage(adminId, `\uD83D\uDCE2 <b>New Ad</b>\n@${ctx.from.username ?? uid}\nTX: ${sig}\n\n${state.data.text}`, { parse_mode: 'HTML' }); } catch { /* ignore */ }
  }
  return ctx.reply('\u2705 <b>Ad received \u2014 goes live within 24H.</b>', { parse_mode: 'HTML', ...MAIN_MENU });
}

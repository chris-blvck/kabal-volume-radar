import { ScoredToken } from '../scanner/filters';
import { HolderAnalysis } from '../scanner/helius';

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtMcap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

export function fmtVol(n: number): string { return fmtMcap(n); }

export function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function bool(v: boolean): string  { return v ? '✅' : '❌'; }

function riskBadge(level: HolderAnalysis['riskLevel']): string {
  return level === 'LOW' ? '🟢 LOW' : level === 'MEDIUM' ? '🟡 MEDIUM' : '🔴 HIGH';
}

// ── Call alert ──────────────────────────────────────────────────────────────────

export function formatCallMessage(token: ScoredToken, holders?: HolderAnalysis | null): string {
  const p      = token.pair;
  const mcap   = p.marketCap ?? p.fdv ?? 0;
  const vol1h  = p.volume?.h1 ?? 0;
  const pc1h   = p.priceChange?.h1 ?? 0;
  const pc6h   = p.priceChange?.h6 ?? 0;
  const buys   = p.txns?.h1?.buys ?? 0;
  const sells  = p.txns?.h1?.sells ?? 0;
  const liq    = p.liquidity?.usd ?? 0;
  const sym    = p.baseToken.symbol;
  const name   = p.baseToken.name;
  const ca     = p.baseToken.address;

  // Header
  let msg = `🎯 <b>$${sym}</b> is now on Kabal Radar\n`;
  msg += `─────────────────────────\n`;
  msg += `<b>${name}</b>\n\n`;
  msg += `<code>${ca}</code>\n\n`;

  // Market data
  msg += `💰 <b>Market Cap:</b> ${fmtMcap(mcap)}\n`;
  msg += `📈 <b>Price:</b> 1h ${fmtPct(pc1h)}  6h ${fmtPct(pc6h)}\n`;
  msg += `📊 <b>Volume 1h:</b> ${fmtVol(vol1h)}\n`;
  msg += `💧 <b>Liquidity:</b> ${fmtVol(liq)}\n`;
  msg += `🔄 <b>Txns 1h:</b> ${buys} buys / ${sells} sells\n\n`;

  // Security checks
  msg += `🔒 <b>Security</b>\n`;
  msg += `  DexScreener Paid: ${bool(token.isDexscreenerPaid)}\n`;
  msg += `  CTO: ${bool(token.isCto)}\n`;

  if (holders) {
    msg += `  Bundle Risk: ${riskBadge(holders.riskLevel)}\n`;
    msg += `  Top Holder: ${holders.topHolderPct.toFixed(1)}%  Top 10: ${holders.top10Pct.toFixed(1)}%\n`;
    if (holders.warning) msg += `  ⚠️ ${holders.warning}\n`;
  }
  msg += '\n';

  // Algo signals
  if (token.reasons.length) {
    msg += `⚡ <b>Signals:</b> <i>${token.reasons.slice(0, 4).join(' · ')}</i>\n\n`;
  }

  // Links
  const links: string[] = [];
  if (token.website)     links.push(`<a href="${token.website}">🌐 Website</a>`);
  if (token.twitter)     links.push(`<a href="${token.twitter}">🐦 Twitter</a>`);
  if (token.telegramUrl) links.push(`<a href="${token.telegramUrl}">💬 Telegram</a>`);
  if (links.length) msg += links.join('  ') + '\n';

  return msg;
}

// ── Performance update ───────────────────────────────────────────────────────

export function formatUpdateMessage(
  call: any,
  currentMcap: number,
  percentChange: number,
  milestone: string
): string {
  const mult = (call.market_cap_at_call ?? 0) > 0
    ? currentMcap / call.market_cap_at_call
    : 1;

  let msg = `📊 <b>Update for $${call.symbol}</b>\n`;
  msg += `─────────────────────────\n`;
  msg += `⏱ <b>Milestone:</b> ${milestone}\n`;
  msg += `💰 <b>Market Cap:</b> ${fmtMcap(currentMcap)}\n`;
  msg += `📈 <b>Since Call:</b> ${fmtPct(percentChange)}`;
  if (mult >= 2) msg += ` (<b>${mult.toFixed(1)}x</b>)`;
  msg += '\n';

  if (mult >= 10)      msg += '\n🔥🔥🔥 <b>10x+ FROM CALL!</b> 🔥🔥🔥';
  else if (mult >= 5)  msg += '\n🚀🚀 <b>5x FROM CALL!</b>';
  else if (mult >= 2)  msg += '\n✅ <b>2x FROM CALL!</b>';

  if (call.dexscreener_url) msg += `\n\n<a href="${call.dexscreener_url}">🔍 DexScreener</a>`;
  return msg;
}

// ── Stats message ─────────────────────────────────────────────────────────────────────

export function formatStatsMessage(stats: {
  totalCalls: number;
  calls24h: number;
  bestMultiplier: number;
  bestSymbol: string;
  proSubscribers: number;
  activeFastTracks: number;
}): string {
  return (
    `📊 <b>Kabal Radar — Stats</b>\n\n` +
    `📞 Total calls: <b>${stats.totalCalls}</b>\n` +
    `🕒 Calls (24h): <b>${stats.calls24h}</b>\n` +
    `🏆 Best call: <b>$${stats.bestSymbol} ${stats.bestMultiplier.toFixed(1)}x</b>\n` +
    `💎 Pro subscribers: <b>${stats.proSubscribers}</b>\n` +
    `🚀 Active fast-tracks: <b>${stats.activeFastTracks}</b>\n`
  );
}

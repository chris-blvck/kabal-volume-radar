import { ScoredToken } from '../scanner/filters';
import { HolderAnalysis } from '../scanner/helius';

export function fmtMcap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
export function fmtVol(n: number): string { return fmtMcap(n); }
export function fmtPct(n: number): string { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }

function bool(v: boolean) { return v ? '✅' : '❌'; }
function riskBadge(level: HolderAnalysis['riskLevel']) {
  return level === 'LOW' ? '🟢 LOW' : level === 'MEDIUM' ? '🟡 MED' : '🔴 HIGH';
}

export function formatCallMessage(token: ScoredToken, holders?: HolderAnalysis | null): string {
  const p     = token.pair;
  const mcap  = p.marketCap ?? p.fdv ?? 0;
  const vol1h = p.volume?.h1  ?? 0;
  const pc1h  = p.priceChange?.h1 ?? 0;
  const pc6h  = p.priceChange?.h6 ?? 0;
  const pc5m  = p.priceChange?.m5 ?? 0;
  const buys  = p.txns?.h1?.buys  ?? 0;
  const sells = p.txns?.h1?.sells ?? 0;
  const liq   = p.liquidity?.usd  ?? 0;
  const ca    = p.baseToken.address;

  let msg = `🎯 <b>$${p.baseToken.symbol}</b> — Kabal Radar\n`;
  msg += `<b>${p.baseToken.name}</b>\n\n`;
  msg += `<code>${ca}</code>\n\n`;

  // Market data
  msg += `💰 <b>MCap:</b> ${fmtMcap(mcap)}`;
  if (p.pairCreatedAt) {
    const ageH = (Date.now() - p.pairCreatedAt) / 3_600_000;
    msg += `  🕒 <b>Age:</b> ${ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(1)}h`}`;
  }
  msg += '\n';
  msg += `📈 <b>Price:</b> 5m ${fmtPct(pc5m)}  1h ${fmtPct(pc1h)}  6h ${fmtPct(pc6h)}\n`;
  msg += `📊 <b>Vol 1h:</b> ${fmtVol(vol1h)}  💧 <b>Liq:</b> ${fmtVol(liq)}\n`;
  msg += `🔄 <b>Txns 1h:</b> ${buys}↑ / ${sells}↓  ` +
         `(${buys + sells > 0 ? ((buys / (buys + sells)) * 100).toFixed(0) : 0}% buys)\n\n`;

  // Security
  msg += `🔒 <b>Security</b>\n`;
  msg += `  Dex Paid: ${bool(token.isDexscreenerPaid)}  CTO: ${bool(token.isCto)}\n`;

  if (token.mintInfo) {
    const m = token.mintInfo;
    msg += `  Mint: ${bool(m.mintAuthorityRevoked)}  Freeze: ${bool(m.freezeAuthorityRevoked)}`;
    if (m.isPumpFunNative) msg += ` <i>(pump.fun)</i>`;
    msg += '\n';
  }

  if (holders) {
    msg += `  Bundle: ${riskBadge(holders.riskLevel)}`;
    msg += `  Top10: ${holders.top10Pct.toFixed(1)}%\n`;
    if (holders.warning) msg += `  ⚠️ <i>${holders.warning}</i>\n`;
  }

  // Warnings from mint check
  if (token.warnings.length) {
    msg += `\n⚠️ <b>Warnings:</b> <i>${token.warnings.join(' · ')}</i>\n`;
  }

  // Algo signals
  if (token.reasons.length) {
    msg += `\n⚡ <b>Signals:</b> <i>${token.reasons.slice(0, 4).join(' · ')}</i>\n`;
  }

  // Social links
  const links: string[] = [];
  if (token.website)     links.push(`<a href="${token.website}">🌐 Web</a>`);
  if (token.twitter)     links.push(`<a href="${token.twitter}">🐦 Twitter</a>`);
  if (token.telegramUrl) links.push(`<a href="${token.telegramUrl}">💬 TG</a>`);
  if (links.length) msg += `\n${links.join('  ')}\n`;

  return msg;
}

export function formatUpdateMessage(
  call: any,
  currentMcap: number,
  percentChange: number,
  milestone: string
): string {
  const mult = (call.market_cap_at_call ?? 0) > 0 ? currentMcap / call.market_cap_at_call : 1;
  let msg = `📊 <b>$${call.symbol} — ${milestone} update</b>\n\n`;
  msg += `💰 MCap: <b>${fmtMcap(currentMcap)}</b>\n`;
  msg += `📈 Since call: <b>${fmtPct(percentChange)}</b>`;
  if (mult >= 2) msg += ` (<b>${mult.toFixed(1)}x</b>)`;
  msg += '\n';
  if (mult >= 10)     msg += '\n🔥🔥 <b>10x+ FROM CALL!</b>';
  else if (mult >= 5) msg += '\n🚀 <b>5x FROM CALL!</b>';
  else if (mult >= 2) msg += '\n✅ <b>2x FROM CALL!</b>';
  if (call.dexscreener_url) msg += `\n\n<a href="${call.dexscreener_url}">🔍 DexScreener</a>`;
  return msg;
}

export function formatStatsMessage(stats: {
  totalCalls:      number;
  calls24h:        number;
  bestMultiplier:  number;
  bestSymbol:      string;
  proSubscribers:  number;
  activeFastTracks: number;
}): string {
  return (
    `📊 <b>Kabal Radar — Stats</b>\n\n` +
    `📞 Total calls: <b>${stats.totalCalls}</b>\n` +
    `🕒 Last 24h: <b>${stats.calls24h}</b>\n` +
    `🏆 Best call: <b>$${stats.bestSymbol}</b> @ <b>${stats.bestMultiplier.toFixed(1)}x</b>\n` +
    `💎 Pro subscribers: <b>${stats.proSubscribers}</b>\n` +
    `🚀 Active fast-tracks: <b>${stats.activeFastTracks}</b>\n`
  );
}

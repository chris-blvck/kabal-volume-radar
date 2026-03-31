import { ScoredToken } from '../scanner/filters';
import { HolderAnalysis } from '../scanner/helius';

export function fmtMcap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
export function fmtVol(n: number): string { return fmtMcap(n); }
export function fmtPct(n: number): string { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }

/** Visual signal strength bar: 🔥🔥🔥⬛⬛ (score / 100 scaled to 5 dots) */
export function heatBar(score: number): string {
  const filled = Math.min(5, Math.max(0, Math.round((score / 100) * 5)));
  return '\uD83D\uDD25'.repeat(filled) + '\u2B1B'.repeat(5 - filled);
}

function bool(v: boolean) { return v ? '\u2705' : '\u274C'; }
function riskBadge(level: HolderAnalysis['riskLevel']) {
  return level === 'LOW' ? '\uD83D\uDFE2 LOW' : level === 'MEDIUM' ? '\uD83D\uDFE1 MED' : '\uD83D\uDD34 HIGH';
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

  let msg = `\uD83C\uDFAF <b>$${p.baseToken.symbol}</b> \u2014 Kabal Radar\n`;
  msg += `<b>${p.baseToken.name}</b>\n`;
  msg += `<code>${ca}</code>\n\n`;

  // Signal heat bar
  msg += `\uD83C\uDF21 <b>Signal:</b> ${heatBar(token.score)}\n\n`;

  // Market data
  msg += `\uD83D\uDCB0 <b>MCap:</b> ${fmtMcap(mcap)}`;
  if (p.pairCreatedAt) {
    const ageH = (Date.now() - p.pairCreatedAt) / 3_600_000;
    msg += `  \uD83D\uDD52 <b>Age:</b> ${ageH < 1 ? `${Math.round(ageH * 60)}m` : `${ageH.toFixed(1)}h`}`;
  }
  msg += '\n';
  msg += `\uD83D\uDCC8 <b>Price:</b> 5m ${fmtPct(pc5m)}  1h ${fmtPct(pc1h)}  6h ${fmtPct(pc6h)}\n`;
  msg += `\uD83D\uDCCA <b>Vol 1h:</b> ${fmtVol(vol1h)}  \uD83D\uDCA7 <b>Liq:</b> ${fmtVol(liq)}\n`;
  msg += `\uD83D\uDD04 <b>Txns 1h:</b> ${buys}\u2191 / ${sells}\u2193  ` +
         `(${buys + sells > 0 ? ((buys / (buys + sells)) * 100).toFixed(0) : 0}% buys)\n\n`;

  // Security
  msg += `\uD83D\uDD12 <b>Security</b>\n`;
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
    if (holders.warning) msg += `  \u26A0\uFE0F <i>${holders.warning}</i>\n`;
  }

  // Warnings
  if (token.warnings.length) {
    msg += `\n\u26A0\uFE0F <b>Warnings:</b> <i>${token.warnings.join(' \u00B7 ')}</i>\n`;
  }

  // Algo signals
  if (token.reasons.length) {
    msg += `\n\u26A1 <b>Signals:</b> <i>${token.reasons.slice(0, 4).join(' \u00B7 ')}</i>\n`;
  }

  // Social links
  const links: string[] = [];
  if (token.website)     links.push(`<a href="${token.website}">\uD83C\uDF10 Web</a>`);
  if (token.twitter)     links.push(`<a href="${token.twitter}">\uD83D\uDC26 Twitter</a>`);
  if (token.telegramUrl) links.push(`<a href="${token.telegramUrl}">\uD83D\uDCAC TG</a>`);
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
  let msg = `\uD83D\uDCCA <b>$${call.symbol} \u2014 ${milestone} update</b>\n\n`;
  msg += `\uD83D\uDCB0 MCap: <b>${fmtMcap(currentMcap)}</b>\n`;
  msg += `\uD83D\uDCC8 Since call: <b>${fmtPct(percentChange)}</b>`;
  if (mult >= 2) msg += ` (<b>${mult.toFixed(1)}x</b>)`;
  msg += '\n';
  if (mult >= 10)     msg += '\n\uD83D\uDD25\uD83D\uDD25 <b>10x+ FROM CALL!</b>';
  else if (mult >= 5) msg += '\n\uD83D\uDE80 <b>5x FROM CALL!</b>';
  else if (mult >= 2) msg += '\n\u2705 <b>2x FROM CALL!</b>';
  if (call.dexscreener_url) msg += `\n\n<a href="${call.dexscreener_url}">\uD83D\uDD0D DexScreener</a>`;
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
    `\uD83D\uDCCA <b>Kabal Radar \u2014 Stats</b>\n\n` +
    `\uD83D\uDCDE Total calls: <b>${stats.totalCalls}</b>\n` +
    `\uD83D\uDD52 Last 24h: <b>${stats.calls24h}</b>\n` +
    `\uD83C\uDFC6 Best call: <b>$${stats.bestSymbol}</b> @ <b>${stats.bestMultiplier.toFixed(1)}x</b>\n` +
    `\uD83D\uDC8E Pro subscribers: <b>${stats.proSubscribers}</b>\n` +
    `\uD83D\uDE80 Active fast-tracks: <b>${stats.activeFastTracks}</b>\n`
  );
}

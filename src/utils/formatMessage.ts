import { ScoredToken } from '../scanner/filters';

function fmtMcap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function bool(v: boolean): string { return v ? '\u2705' : '\u274c'; }

export function formatCallMessage(token: ScoredToken): string {
  const p = token.pair;
  const mcap   = p.marketCap || p.fdv || 0;
  const vol1h  = p.volume?.h1 || 0;
  const pc1h   = p.priceChange?.h1 || 0;
  const buys   = p.txns?.h1?.buys || 0;
  const sells  = p.txns?.h1?.sells || 0;
  const liq    = p.liquidity?.usd || 0;
  const sym    = p.baseToken.symbol;
  const name   = p.baseToken.name;
  const ca     = p.baseToken.address;

  let msg = `\uD83C\uDFAF <b>$${sym}</b> is now on Kabal Radar\n\n`;
  msg += `<b>${name}</b>\n\n`;
  msg += `<code>${ca}</code>\n\n`;
  msg += `\uD83D\uDCB0 Market Cap: <b>${fmtMcap(mcap)}</b>\n`;
  msg += `\uD83D\uDCC8 Price Change 1h: <b>${fmtPct(pc1h)}</b>\n`;
  msg += `\uD83D\uDCCA Volume 1h: <b>${fmtVol(vol1h)}</b>\n`;
  msg += `\uD83D\uDCA7 Liquidity: <b>${fmtVol(liq)}</b>\n`;
  msg += `\uD83D\uDD04 Txns 1h: <b>${buys} buys / ${sells} sells</b>\n\n`;
  msg += `DexScreener Paid: ${bool(token.isDexscreenerPaid)}\n`;
  msg += `CTO: ${bool(token.isCto)}\n`;

  if (token.reasons.length) {
    msg += `\n\uD83D\uDD0D <i>${token.reasons.slice(0, 3).join(' \u00b7 ')}</i>\n`;
  }

  const links: string[] = [];
  if (token.website)    links.push(`<a href="${token.website}">\uD83C\uDF10 Website</a>`);
  if (token.twitter)    links.push(`<a href="${token.twitter}">\uD83D\uDC26 Twitter</a>`);
  if (token.telegramUrl) links.push(`<a href="${token.telegramUrl}">\uD83D\uDCAC Telegram</a>`);
  if (links.length) msg += `\n${links.join('  ')}\n`;

  return msg;
}

export function formatUpdateMessage(
  call: any,
  currentMcap: number,
  percentChange: number,
  milestone: string
): string {
  const multiplier = (call.market_cap_at_call || 0) > 0
    ? currentMcap / call.market_cap_at_call
    : 1;

  let msg = `\uD83D\uDCCA <b>Update for $${call.symbol}</b>\n\n`;
  msg += `\u23F1 Milestone: <b>${milestone}</b>\n`;
  msg += `\uD83D\uDCB0 Market Cap: <b>${fmtMcap(currentMcap)}</b>\n`;
  msg += `\uD83D\uDCC8 Since Call: <b>${fmtPct(percentChange)}</b>`;
  if (multiplier >= 2) msg += ` (<b>${multiplier.toFixed(1)}x</b>)`;
  msg += '\n';

  if (multiplier >= 10)     msg += '\n\uD83D\uDD25\uD83D\uDD25\uD83D\uDD25 <b>10x+ FROM CALL!</b>';
  else if (multiplier >= 5) msg += '\n\uD83D\uDE80\uD83D\uDE80 <b>5x FROM CALL!</b>';
  else if (multiplier >= 2) msg += '\n\u2705 <b>2x FROM CALL!</b>';

  if (call.dexscreener_url) msg += `\n\n<a href="${call.dexscreener_url}">\uD83D\uDD0D DexScreener</a>`;
  return msg;
}

export function formatTop10Message(tokens: ScoredToken[]): string {
  const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
  let msg = '\uD83C\uDFC6 <b>TOP 10 TRENDING</b> | Kabal Radar\n\n';
  tokens.slice(0, 10).forEach((t, i) => {
    const p = t.pair;
    const mcap = p.marketCap || p.fdv || 0;
    const pc1h = p.priceChange?.h1 || 0;
    const prefix = i < 3 ? medals[i] : `${i + 1}.`;
    msg += `${prefix} <b>$${p.baseToken.symbol}</b> | ${fmtMcap(mcap)} | ${fmtPct(pc1h)}\n`;
  });
  msg += `\n\uD83D\uDD50 ${new Date().toUTCString()}`;
  return msg;
}

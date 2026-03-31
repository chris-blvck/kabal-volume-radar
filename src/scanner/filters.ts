import { DexPair } from './dexscreener';
import { MintInfo, mintRiskDelta } from './mintCheck';
import { config } from '../config';

export interface ScoredToken {
  pair:              DexPair;
  score:             number;
  reasons:           string[];
  warnings:          string[];
  isCto:             boolean;
  isDexscreenerPaid: boolean;
  website?:          string;
  twitter?:          string;
  telegramUrl?:      string;
  mintInfo?:         MintInfo;
}

export function scoreAndFilterTokens(
  pairs:    DexPair[],
  mintInfos?: Map<string, MintInfo | null>
): ScoredToken[] {
  const cfg = config.scanner;
  const results: ScoredToken[] = [];

  for (const pair of pairs) {
    if (pair.chainId !== 'solana') continue;

    const isPumpFun = pair.dexId === 'pumpfun'
      || pair.dexId === 'pump.fun'
      || (pair.url ?? '').includes('pump.fun');
    const isRaydium  = pair.dexId === 'raydium';
    const isMeteora  = pair.dexId === 'meteora';
    if (!isPumpFun && !isRaydium && !isMeteora) continue;

    const mcap = pair.marketCap ?? pair.fdv ?? 0;
    if (mcap < cfg.minMarketCap || mcap > cfg.maxMarketCap) continue;

    const liq = pair.liquidity?.usd ?? 0;
    if (liq < 2_000) continue;

    const vol1h = pair.volume?.h1 ?? 0;
    if (vol1h < cfg.minVolume1h) continue;

    const pc1h = pair.priceChange?.h1 ?? 0;
    if (pc1h < cfg.minPriceChange1h) continue;

    const buys1h  = pair.txns?.h1?.buys  ?? 0;
    const sells1h = pair.txns?.h1?.sells ?? 0;
    const ratio   = sells1h > 0 ? buys1h / sells1h : buys1h;
    if (ratio < cfg.minBuySellRatio) continue;

    if (pair.pairCreatedAt) {
      const ageH = (Date.now() - pair.pairCreatedAt) / 3_600_000;
      if (ageH > cfg.maxTokenAgeHours) continue;
    }

    const mint      = mintInfos?.get(pair.baseToken.address) ?? undefined;
    const { score, reasons, warnings } = calculateScore(pair, ratio, mint ?? null);

    // Hard-skip if freeze authority is active (configurable)
    if (cfg.skipHighRiskBundles && warnings.some(w => w.includes('Freeze'))) continue;

    const website    = pair.info?.websites?.[0]?.url;
    const twitter    = pair.info?.socials?.find(s => s.type === 'twitter')?.url;
    const telegramUrl = pair.info?.socials?.find(s => s.type === 'telegram')?.url;

    results.push({
      pair,
      score,
      reasons,
      warnings,
      isCto:             isPumpFun && !!(pair.info?.websites?.length || pair.info?.socials?.length),
      isDexscreenerPaid: !!(pair.boosts?.active),
      website,
      twitter,
      telegramUrl,
      mintInfo: mint,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

function calculateScore(
  pair:          DexPair,
  buySellRatio:  number,
  mint:          MintInfo | null
): { score: number; reasons: string[]; warnings: string[] } {
  let score       = 0;
  const reasons:  string[] = [];
  const warnings: string[] = [];

  const vol1h  = pair.volume?.h1  ?? 0;
  const vol6h  = pair.volume?.h6  ?? 0;
  const vol24h = pair.volume?.h24 ?? 0;
  const pc1h   = pair.priceChange?.h1 ?? 0;
  const pc5m   = pair.priceChange?.m5 ?? 0;
  const buys1h = pair.txns?.h1?.buys  ?? 0;
  const buys6h = pair.txns?.h6?.buys  ?? 0;
  const liq    = pair.liquidity?.usd  ?? 0;

  // ─ 1. Volume absolute (0–28) ─────────────────────────────────
  if (vol1h > 100_000)     { score += 28; reasons.push('Massive 1h volume'); }
  else if (vol1h > 50_000) { score += 22; reasons.push('Very high 1h volume'); }
  else if (vol1h > 20_000) { score += 16; reasons.push('High 1h volume'); }
  else if (vol1h > 10_000) { score += 10; }
  else if (vol1h > 5_000)  { score += 6; }

  // ─ 2. Volume MOMENTUM — 1h vs 6h avg (0–20) ───────────────────
  const avgHourly6h = vol6h > 0 ? vol6h / 6 : 0;
  if (avgHourly6h > 0) {
    const momentum = vol1h / avgHourly6h;
    if (momentum > 5)      { score += 20; reasons.push(`${momentum.toFixed(0)}x volume spike`); }
    else if (momentum > 3) { score += 14; reasons.push(`${momentum.toFixed(1)}x volume spike`); }
    else if (momentum > 2) { score += 8;  reasons.push('Accelerating volume'); }
    else if (momentum > 1.5) { score += 4; }
  }

  // ─ 3. Buy count momentum (0–15) ────────────────────────────
  const avgBuys6h = buys6h > 0 ? buys6h / 6 : 0;
  if (avgBuys6h > 0 && buys1h / avgBuys6h > 2) {
    score += 10;
    reasons.push('Buy count accelerating');
  }
  if (buys1h > 500)      { score += 15; reasons.push('500+ buys in 1h'); }
  else if (buys1h > 200) { score += 10; reasons.push('200+ buys in 1h'); }
  else if (buys1h > 100) { score += 6; }
  else if (buys1h > 50)  { score += 3; }

  // ─ 4. Price action (0–22) ─────────────────────────────────
  if (pc1h > 150)      { score += 22; reasons.push('150%+ in 1h'); }
  else if (pc1h > 100) { score += 18; reasons.push('100%+ in 1h'); }
  else if (pc1h > 50)  { score += 13; reasons.push('50%+ in 1h'); }
  else if (pc1h > 25)  { score += 8; }
  else if (pc1h > 10)  { score += 4; }

  // Short-term momentum: 5m candle still ripping
  if (pc5m > 10) { score += 6; reasons.push(`Still ripping: +${pc5m.toFixed(0)}% 5m`); }

  // ─ 5. Buy/sell pressure (0–18) ─────────────────────────────
  if (buySellRatio > 4)      { score += 18; reasons.push('Extreme buy pressure'); }
  else if (buySellRatio > 3) { score += 14; reasons.push('Very strong buy pressure'); }
  else if (buySellRatio > 2) { score += 9; reasons.push('Strong buy pressure'); }
  else if (buySellRatio > 1.5) { score += 5; }

  // ─ 6. Social presence (0–10) ──────────────────────────────
  const hasSocials = !!(pair.info?.websites?.length || pair.info?.socials?.length);
  if (hasSocials) {
    score += 10;
    if (pair.info?.socials?.find(s => s.type === 'twitter'))  reasons.push('Has Twitter');
    if (pair.info?.socials?.find(s => s.type === 'telegram')) reasons.push('Has Telegram');
  }

  // ─ 7. DexScreener boost (0–5) ─────────────────────────────
  if (pair.boosts?.active) { score += 5; reasons.push('DexScreener paid'); }

  // ─ 8. Vol/liquidity efficiency (0–10) ───────────────────────
  const vlRatio = liq > 0 ? vol1h / liq : 0;
  if (vlRatio > 3)      { score += 10; reasons.push('Very high vol/liq'); }
  else if (vlRatio > 2) { score += 6; }
  else if (vlRatio > 1) { score += 3; }

  // ─ 9. Mint info bonus/malus ───────────────────────────────
  if (mint) {
    const { delta, flags } = mintRiskDelta(mint);
    score += delta;
    for (const f of flags) {
      if (f.startsWith('❌') || f.startsWith('⚠')) warnings.push(f);
      else reasons.push(f);
    }
  }

  return { score, reasons, warnings };
}

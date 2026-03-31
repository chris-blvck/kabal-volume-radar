import { DexPair } from './dexscreener';
import { config } from '../config';

export interface ScoredToken {
  pair: DexPair;
  score: number;
  reasons: string[];
  isCto: boolean;
  isDexscreenerPaid: boolean;
  website?: string;
  twitter?: string;
  telegramUrl?: string;
}

export function scoreAndFilterTokens(pairs: DexPair[]): ScoredToken[] {
  const cfg = config.scanner;
  const results: ScoredToken[] = [];

  for (const pair of pairs) {
    if (pair.chainId !== 'solana') continue;

    const isPumpFun = pair.dexId === 'pumpfun' || pair.dexId === 'pump.fun' || (pair.url || '').includes('pump.fun');
    const isRaydium = pair.dexId === 'raydium';
    if (!isPumpFun && !isRaydium) continue;

    const mcap = pair.marketCap || pair.fdv || 0;
    if (mcap < cfg.minMarketCap || mcap > cfg.maxMarketCap) continue;

    const liquidity = pair.liquidity?.usd || 0;
    if (liquidity < 2_000) continue;

    const vol1h = pair.volume?.h1 || 0;
    if (vol1h < cfg.minVolume1h) continue;

    const priceChange1h = pair.priceChange?.h1 || 0;
    if (priceChange1h < cfg.minPriceChange1h) continue;

    const buys1h = pair.txns?.h1?.buys || 0;
    const sells1h = pair.txns?.h1?.sells || 0;
    const buySellRatio = sells1h > 0 ? buys1h / sells1h : buys1h;
    if (buySellRatio < cfg.minBuySellRatio) continue;

    if (pair.pairCreatedAt) {
      const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;
      if (ageHours > cfg.maxTokenAgeHours) continue;
    }

    const { score, reasons } = calculateScore(pair, buySellRatio);

    const website = pair.info?.websites?.[0]?.url;
    const twitter = pair.info?.socials?.find(s => s.type === 'twitter')?.url;
    const telegramUrl = pair.info?.socials?.find(s => s.type === 'telegram')?.url;
    const isDexscreenerPaid = !!(pair.boosts?.active);
    const isCto = isPumpFun && !!(pair.info?.websites?.length || pair.info?.socials?.length);

    results.push({ pair, score, reasons, isCto, isDexscreenerPaid, website, twitter, telegramUrl });
  }

  return results.sort((a, b) => b.score - a.score);
}

function calculateScore(pair: DexPair, buySellRatio: number): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const vol1h = pair.volume?.h1 || 0;
  const vol6h = pair.volume?.h6 || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const buys1h = pair.txns?.h1?.buys || 0;
  const liquidity = pair.liquidity?.usd || 0;

  // Volume (0-30)
  if (vol1h > 50_000)      { score += 30; reasons.push('Very high 1h volume'); }
  else if (vol1h > 20_000) { score += 20; reasons.push('High 1h volume'); }
  else if (vol1h > 10_000) { score += 15; reasons.push('Good 1h volume'); }
  else if (vol1h > 5_000)  { score += 10; }

  // Price action (0-25)
  if (priceChange1h > 100)     { score += 25; reasons.push('100%+ in 1h'); }
  else if (priceChange1h > 50) { score += 20; reasons.push('50%+ in 1h'); }
  else if (priceChange1h > 25) { score += 15; }
  else if (priceChange1h > 10) { score += 10; }

  // Buy pressure (0-20)
  if (buySellRatio > 3)      { score += 20; reasons.push('Very high buy pressure'); }
  else if (buySellRatio > 2) { score += 15; reasons.push('Strong buy pressure'); }
  else if (buySellRatio > 1.5) { score += 10; }

  // Transaction count — community interest (0-15)
  if (buys1h > 500)      { score += 15; reasons.push('500+ buys in 1h'); }
  else if (buys1h > 200) { score += 10; reasons.push('200+ buys in 1h'); }
  else if (buys1h > 100) { score += 7; }
  else if (buys1h > 50)  { score += 4; }

  // Social presence (0-10)
  if (pair.info?.websites?.length || pair.info?.socials?.length) {
    score += 10;
    if (pair.info?.socials?.find(s => s.type === 'twitter'))  reasons.push('Has Twitter');
    if (pair.info?.socials?.find(s => s.type === 'telegram')) reasons.push('Has Telegram');
  }

  // DexScreener boost (0-5)
  if (pair.boosts?.active) { score += 5; reasons.push('DexScreener paid'); }

  // Vol/liquidity ratio (0-10)
  const volLiqRatio = liquidity > 0 ? vol1h / liquidity : 0;
  if (volLiqRatio > 2)      { score += 10; reasons.push('High vol/liq ratio'); }
  else if (volLiqRatio > 1) { score += 5; }

  // Volume acceleration vs 6h average (0-10)
  const avgHourly6h = vol6h > 0 ? vol6h / 6 : 0;
  if (avgHourly6h > 0 && vol1h > avgHourly6h * 2) {
    score += 10;
    reasons.push('Accelerating volume');
  }

  return { score, reasons };
}

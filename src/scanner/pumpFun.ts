/**
 * Pump.fun API — free, no key required
 * Source 7 for the scanner + graduation detection
 */
import axios from 'axios';

const BASE = 'https://frontend-api.pump.fun';

export interface PumpToken {
  mint:              string;
  name:              string;
  symbol:            string;
  image_uri:         string;
  created_timestamp: number;
  usd_market_cap:    number;
  complete:          boolean;  // true = graduated to Raydium
  raydium_pool?:     string;
}

/** Most recently traded tokens on pump.fun — catches launches before DexScreener indexes them */
export async function getPumpNewMints(limit = 30): Promise<string[]> {
  try {
    const { data } = await axios.get(`${BASE}/coins`, {
      params: { limit, sort: 'last_trade_timestamp', order: 'DESC', includeNsfw: false },
      timeout: 10_000,
    });
    return (data as PumpToken[]).map(t => t.mint).filter(Boolean);
  } catch {
    return [];
  }
}

/** Tokens that just completed their bonding curve and migrated to Raydium */
export async function getPumpGraduated(limit = 20): Promise<PumpToken[]> {
  try {
    const { data } = await axios.get(`${BASE}/coins`, {
      params: { limit, sort: 'last_reply', order: 'DESC', includeNsfw: false },
      timeout: 10_000,
    });
    return (data as PumpToken[]).filter(t => t.complete === true);
  } catch {
    return [];
  }
}

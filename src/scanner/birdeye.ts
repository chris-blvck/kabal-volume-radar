import axios from 'axios';
import { config } from '../config';

const BASE = 'https://public-api.birdeye.so';

export interface BirdeyeToken {
  address:              string;
  symbol:               string;
  name:                 string;
  liquidity:            number;
  price:                number;
  marketCap:            number;
  v24h:                 number;  // volume 24h
  v1h?:                 number;  // volume 1h (when available)
  v1hChangePercent?:    number;
  v24hChangePercent:    number;
  priceChange24hPercent: number;
  buy24h:               number;
  sell24h:              number;
  uniqueWallet24h:      number;
  logoURI?:             string;
  extensions?: {
    twitter?:   string;
    telegram?:  string;
    website?:   string;
  };
}

/** Fetch tokens sorted by 1h volume-change percent — best signal for momentum. */
export async function getTrendingByVolumeMomentum(limit = 50): Promise<BirdeyeToken[]> {
  if (!config.birdeye.apiKey) return [];
  try {
    const res = await axios.get(`${BASE}/defi/tokenlist`, {
      headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
      params: {
        sort_by:        'v24hChangePercent',
        sort_type:      'desc',
        offset:         0,
        limit,
        min_liquidity:  2_000,
        min_market_cap: 5_000,
        max_market_cap: 1_000_000, // keep small-caps only
      },
      timeout: 12_000,
    });
    return res.data?.data?.tokens ?? [];
  } catch {
    return [];
  }
}

/** Fetch newest listings — recently created tokens with growing activity. */
export async function getNewListings(limit = 30): Promise<BirdeyeToken[]> {
  if (!config.birdeye.apiKey) return [];
  try {
    const res = await axios.get(`${BASE}/defi/v3/token/new-listing`, {
      headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
      params: { limit, meme_platform_enabled: true },
      timeout: 12_000,
    });
    // new-listing returns { items: [...] }
    const items: any[] = res.data?.data?.items ?? [];
    return items.map(i => ({
      address:               i.address,
      symbol:                i.symbol ?? '',
      name:                  i.name ?? '',
      liquidity:             i.liquidity ?? 0,
      price:                 i.price ?? 0,
      marketCap:             i.marketCap ?? i.fdv ?? 0,
      v24h:                  i.volume24h ?? 0,
      v24hChangePercent:     0,
      priceChange24hPercent: i.priceChange24h ?? 0,
      buy24h:                0,
      sell24h:               0,
      uniqueWallet24h:       0,
    }));
  } catch {
    return [];
  }
}

/** Get extended token overview (socials, description, etc.). */
export async function getTokenOverview(address: string): Promise<BirdeyeToken | null> {
  if (!config.birdeye.apiKey) return null;
  try {
    const res = await axios.get(`${BASE}/defi/token_overview`, {
      headers: { 'X-API-KEY': config.birdeye.apiKey, 'x-chain': 'solana' },
      params:  { address },
      timeout: 10_000,
    });
    return res.data?.data ?? null;
  } catch {
    return null;
  }
}

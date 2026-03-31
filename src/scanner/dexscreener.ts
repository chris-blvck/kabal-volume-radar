import axios, { AxiosInstance } from 'axios';

const client: AxiosInstance = axios.create({
  baseURL: 'https://api.dexscreener.com',
  timeout: 10_000,
});

export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  liquidity?: { usd?: number; base: number; quote: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ label: string; url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
  boosts?: { active: number };
}

export interface TokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  description?: string;
  links?: Array<{ type: string; label?: string; url: string }>;
}

export async function searchPairs(query: string): Promise<DexPair[]> {
  try {
    const res = await client.get(`/latest/dex/search?q=${encodeURIComponent(query)}`);
    return res.data?.pairs || [];
  } catch {
    return [];
  }
}

export async function getTokenByAddress(address: string): Promise<DexPair | null> {
  try {
    const res = await client.get(`/latest/dex/tokens/${address}`);
    const pairs: DexPair[] = res.data?.pairs || [];
    return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null;
  } catch {
    return null;
  }
}

export async function getLatestTokenProfiles(): Promise<TokenProfile[]> {
  try {
    const res = await client.get('/token-profiles/latest/v1');
    return res.data || [];
  } catch {
    return [];
  }
}

export async function getTokensByAddresses(addresses: string[]): Promise<DexPair[]> {
  if (!addresses.length) return [];
  const results: DexPair[] = [];
  const chunks = chunkArray(addresses, 30);
  for (const chunk of chunks) {
    try {
      const res = await client.get(`/latest/dex/tokens/${chunk.join(',')}`);
      results.push(...(res.data?.pairs || []));
      await sleep(300);
    } catch {
      // continue
    }
  }
  return results;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

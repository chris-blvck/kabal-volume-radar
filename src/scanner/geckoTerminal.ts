/**
 * GeckoTerminal — free on-chain DEX data, no API key required.
 * Used to discover trending + new Solana pools as additional scanner sources.
 */
import axios from 'axios';

const BASE    = 'https://api.geckoterminal.com/api/v2';
const HEADERS = { Accept: 'application/json;version=20230302' };

/** Extract base-token mint addresses from a GeckoTerminal pools response. */
function extractAddresses(pools: any[]): string[] {
  return pools
    .map(p => (p.relationships?.base_token?.data?.id as string | undefined)?.replace('solana_', '') ?? '')
    .filter(a => a.length >= 32);
}

/** Top trending pools on Solana right now (by 24h volume). */
export async function getGeckoTrendingAddresses(limit = 20): Promise<string[]> {
  try {
    const { data } = await axios.get(
      `${BASE}/networks/solana/trending_pools`,
      { params: { page: 1 }, headers: HEADERS, timeout: 10_000 },
    );
    return extractAddresses((data.data ?? []).slice(0, limit));
  } catch {
    return [];
  }
}

/** Newest pools on Solana (by creation time). */
export async function getGeckoNewPoolAddresses(limit = 20): Promise<string[]> {
  try {
    const { data } = await axios.get(
      `${BASE}/networks/solana/new_pools`,
      { params: { page: 1 }, headers: HEADERS, timeout: 10_000 },
    );
    return extractAddresses((data.data ?? []).slice(0, limit));
  } catch {
    return [];
  }
}

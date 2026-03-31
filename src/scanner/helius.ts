import axios from 'axios';
import { config } from '../config';

const RPC = () => `https://mainnet.helius-rpc.com/?api-key=${config.helius.apiKey}`;
const API = () => `https://api.helius.xyz/v0`;

export interface HolderAnalysis {
  topHolderPct: number;   // % held by #1 holder (relative to top-20 supply)
  top10Pct:     number;   // % held by top 10
  isBundled:    boolean;
  riskLevel:    'LOW' | 'MEDIUM' | 'HIGH';
  warning?:     string;
}

/** Analyse the top-20 holders of a SPL token. */
export async function analyzeHolders(mintAddress: string): Promise<HolderAnalysis | null> {
  if (!config.helius.apiKey) return null;
  try {
    const res = await axios.post(RPC(), {
      jsonrpc: '2.0', id: 1,
      method: 'getTokenLargestAccounts',
      params: [mintAddress, { commitment: 'confirmed' }],
    }, { timeout: 10_000 });

    const accounts: Array<{ uiAmount: number }> = res.data?.result?.value ?? [];
    if (!accounts.length) return null;

    const total = accounts.reduce((s, a) => s + (a.uiAmount ?? 0), 0);
    if (total === 0) return null;

    const sorted = [...accounts].sort((a, b) => b.uiAmount - a.uiAmount);
    const pct = (a: { uiAmount: number }) => (a.uiAmount / total) * 100;

    const topHolderPct = pct(sorted[0]);
    const top10Pct     = sorted.slice(0, 10).reduce((s, a) => s + pct(a), 0);

    let riskLevel: HolderAnalysis['riskLevel'] = 'LOW';
    let warning: string | undefined;

    if (topHolderPct > 30) {
      riskLevel = 'HIGH';
      warning = `Top holder owns ${topHolderPct.toFixed(1)}% — possible rug`;
    } else if (topHolderPct > 20 || top10Pct > 65) {
      riskLevel = 'MEDIUM';
      warning = `Concentrated holders (top10: ${top10Pct.toFixed(1)}%)`;
    }

    const isBundled = topHolderPct > 20 || top10Pct > 65;
    return { topHolderPct, top10Pct, isBundled, riskLevel, warning };
  } catch {
    return null;
  }
}

// ── Wallet transaction tracking ───────────────────────────────────────────────

export interface WalletSwap {
  signature: string;
  tokenMint: string;
  type:      'buy' | 'sell';
  timestamp: number;
  amountUsd?: number;
}

/** Returns recent SWAP transactions for a wallet via Helius Enhanced API. */
export async function getRecentSwaps(walletAddress: string, limit = 10): Promise<WalletSwap[]> {
  if (!config.helius.apiKey) return [];
  try {
    const res = await axios.get(
      `${API()}/addresses/${walletAddress}/transactions`,
      { params: { 'api-key': config.helius.apiKey, limit, type: 'SWAP' }, timeout: 12_000 }
    );
    const swaps: WalletSwap[] = [];
    for (const tx of (res.data ?? [])) {
      for (const t of (tx.tokenTransfers ?? [])) {
        const isBuy  = t.toUserAccount   === walletAddress && t.mint;
        const isSell = t.fromUserAccount === walletAddress && t.mint;
        if (isBuy || isSell) {
          swaps.push({
            signature: tx.signature,
            tokenMint: t.mint,
            type:      isBuy ? 'buy' : 'sell',
            timestamp: tx.timestamp,
            amountUsd: t.tokenAmount,
          });
          break; // one entry per tx
        }
      }
    }
    return swaps;
  } catch {
    return [];
  }
}

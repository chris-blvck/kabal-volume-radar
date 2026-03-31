import axios from 'axios';
import { config } from '../config';

export interface MintInfo {
  mintAuthorityRevoked:   boolean; // true = safe (no one can print more tokens)
  freezeAuthorityRevoked: boolean; // true = safe (no one can freeze wallets)
  decimals:               number;
  supplyBillions:         number;  // normalised supply
  isPumpFunNative:        boolean; // mint authority IS the pump.fun program (expected)
}

// Pump.fun bonding curve program — having this as mint authority is normal & expected
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

export async function getMintInfo(mintAddress: string): Promise<MintInfo | null> {
  try {
    const res = await axios.post(
      config.solana.rpcUrl,
      {
        jsonrpc: '2.0', id: 1,
        method:  'getAccountInfo',
        params:  [mintAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      },
      { timeout: 8_000 }
    );

    const info = res.data?.result?.value?.data?.parsed?.info;
    if (!info) return null;

    const mintAuth   = info.mintAuthority   as string | null;
    const freezeAuth = info.freezeAuthority as string | null;
    const decimals   = (info.decimals as number) ?? 6;
    const rawSupply  = parseFloat(info.supply ?? '0');
    const supply     = rawSupply / Math.pow(10, decimals);

    return {
      mintAuthorityRevoked:   !mintAuth,
      freezeAuthorityRevoked: !freezeAuth,
      decimals,
      supplyBillions:   supply / 1e9,
      isPumpFunNative:  mintAuth === PUMP_FUN_PROGRAM,
    };
  } catch {
    return null;
  }
}

/**
 * Returns a risk score delta based on mint info.
 * Negative = risky, positive = safe signals.
 */
export function mintRiskDelta(info: MintInfo): { delta: number; flags: string[] } {
  let delta = 0;
  const flags: string[] = [];

  // Freeze authority is always a red flag unless revoked
  if (!info.freezeAuthorityRevoked) {
    delta -= 20;
    flags.push('❌ Freeze auth active');
  }

  // Non-pump.fun mint authority that’s not revoked = someone can print tokens
  if (!info.mintAuthorityRevoked && !info.isPumpFunNative) {
    delta -= 15;
    flags.push('⚠️ Mint auth not revoked');
  }

  // Pump.fun native is neutral — expected before migration
  if (info.isPumpFunNative) {
    flags.push('✅ Pump.fun native');
  }

  // Revoked mint authority = good signal
  if (info.mintAuthorityRevoked) {
    delta += 5;
    flags.push('✅ Mint revoked');
  }

  return { delta, flags };
}

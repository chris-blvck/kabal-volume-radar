import cron from 'node-cron';
import {
  searchPairs, getLatestTokenProfiles,
  getTokensByAddresses, getTokenByAddress, DexPair,
} from './dexscreener';
import { getTrendingByVolumeMomentum, getNewListings } from './birdeye';
import { getGeckoTrendingAddresses, getGeckoNewPoolAddresses } from './geckoTerminal';
import { scoreAndFilterTokens, ScoredToken } from './filters';
import { analyzeHolders } from './helius';
import { getMintInfo, MintInfo } from './mintCheck';
import { isAlreadyCalled, getActiveFastTracks } from '../database/db';
import { config } from '../config';
import { postCall } from '../bot/channelBot';

let lastCallTime  = 0;
let callsThisHour = 0;
let hourResetTime = Date.now();

export async function scanTokens(): Promise<void> {
  console.log(`[Scanner] Scan at ${new Date().toISOString()}`);
  try {
    if (Date.now() - hourResetTime > 3_600_000) { callsThisHour = 0; hourResetTime = Date.now(); }
    if (callsThisHour >= config.scanner.maxCallsPerHour) return;

    const allPairs: DexPair[] = [];

    // ─ Source 1: DexScreener pump.fun search
    for (const q of ['pump.fun', 'pumpfun']) {
      allPairs.push(...await searchPairs(q));
      await sleep(400);
    }

    // ─ Source 2: DexScreener latest profiles
    const profiles     = await getLatestTokenProfiles();
    const profileAddrs = profiles.filter(p => p.chainId === 'solana').slice(0, 20).map(p => p.tokenAddress);
    if (profileAddrs.length) allPairs.push(...await getTokensByAddresses(profileAddrs));

    // ─ Source 3: Birdeye volume-momentum
    const birdeyeTrending = await getTrendingByVolumeMomentum(50);
    if (birdeyeTrending.length)
      allPairs.push(...await getTokensByAddresses(birdeyeTrending.map(t => t.address)));

    // ─ Source 4: Birdeye new listings
    const newListings = await getNewListings(30);
    if (newListings.length)
      allPairs.push(...await getTokensByAddresses(newListings.map(t => t.address)));

    // ─ Source 5: GeckoTerminal trending (no API key needed)
    const geckoTrending = await getGeckoTrendingAddresses(20);
    if (geckoTrending.length) {
      allPairs.push(...await getTokensByAddresses(geckoTrending));
      await sleep(300);
    }

    // ─ Source 6: GeckoTerminal new pools (no API key needed)
    const geckoNew = await getGeckoNewPoolAddresses(20);
    if (geckoNew.length)
      allPairs.push(...await getTokensByAddresses(geckoNew));

    // Deduplicate
    const seen   = new Set<string>();
    const unique = allPairs.filter(p => {
      if (seen.has(p.baseToken.address)) return false;
      seen.add(p.baseToken.address);
      return true;
    });
    console.log(`[Scanner] ${unique.length} unique pairs from ${allPairs.length} raw`);

    // Batch mint info
    const mintInfoMap = new Map<string, MintInfo | null>();
    await Promise.all(unique.map(async p => {
      mintInfoMap.set(p.baseToken.address, await getMintInfo(p.baseToken.address));
    }));

    const scored = scoreAndFilterTokens(unique, mintInfoMap);
    console.log(`[Scanner] ${scored.length} passed filters`);

    // Fast-tracks first
    for (const ft of getActiveFastTracks()) {
      if (!isAlreadyCalled(ft.contract_address)) await processFastTrack(ft);
    }

    // Algo calls
    for (const token of scored) {
      const addr = token.pair.baseToken.address;
      if (isAlreadyCalled(addr)) continue;
      if (Date.now() - lastCallTime < config.scanner.callCooldownMinutes * 60_000) continue;

      const holders = await analyzeHolders(addr);
      if (config.scanner.skipHighRiskBundles && holders?.riskLevel === 'HIGH') {
        console.log(`[Scanner] Skip $${token.pair.baseToken.symbol} — HIGH bundle risk`);
        continue;
      }

      console.log(`[Scanner] Calling $${token.pair.baseToken.symbol} (score: ${token.score})`);
      await postCall(token, 'algo', holders ?? undefined);
      lastCallTime = Date.now();
      callsThisHour++;
      if (callsThisHour >= config.scanner.maxCallsPerHour) break;
    }
  } catch (err: any) {
    console.error('[Scanner] Error:', err.message);
  }
}

export async function manualCall(contractAddress: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const pair = await getTokenByAddress(contractAddress);
    if (!pair) return { ok: false, msg: 'Token not found on DexScreener.' };
    const mintInfo = await getMintInfo(contractAddress);
    const scored   = scoreAndFilterTokens([pair], new Map([[contractAddress, mintInfo]]));
    const token: ScoredToken = scored[0] ?? {
      pair, score: 0, reasons: ['Manual call'], warnings: [],
      isCto: false, isDexscreenerPaid: false, mintInfo: mintInfo ?? undefined,
    };
    const holders = await analyzeHolders(contractAddress);
    await postCall(token, 'algo', holders ?? undefined);
    return { ok: true, msg: `Called $${pair.baseToken.symbol} successfully.` };
  } catch (err: any) {
    return { ok: false, msg: `Error: ${err.message}` };
  }
}

async function processFastTrack(ft: any): Promise<void> {
  try {
    const pairs = await getTokensByAddresses([ft.contract_address]);
    if (!pairs.length) return;
    const mintMap = new Map([[ft.contract_address, await getMintInfo(ft.contract_address)]]);
    const scored  = scoreAndFilterTokens(pairs, mintMap);
    const token: ScoredToken = scored[0] ?? {
      pair: pairs[0], score: 0, reasons: ['Fast-Track'], warnings: [],
      isCto: false, isDexscreenerPaid: false,
    };
    await postCall(token, 'fasttrack', await analyzeHolders(ft.contract_address) ?? undefined);
  } catch (err: any) {
    console.error('[Scanner] Fast-track error:', err.message);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function startScanner(): void {
  console.log(`[Scanner] Starting — interval: ${config.scanner.intervalMinutes}min, sources: DexScreener x2, Birdeye x2, GeckoTerminal x2`);
  scanTokens();
  cron.schedule(`*/${config.scanner.intervalMinutes} * * * *`, () => scanTokens());
}

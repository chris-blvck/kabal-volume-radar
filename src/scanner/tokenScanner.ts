import cron from 'node-cron';
import { searchPairs, getLatestTokenProfiles, getTokensByAddresses, DexPair } from './dexscreener';
import { scoreAndFilterTokens, ScoredToken } from './filters';
import { analyzeHolders } from './helius';
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

    // 1. Pump.fun search
    const allPairs: DexPair[] = [];
    for (const q of ['pump.fun', 'pumpfun']) {
      allPairs.push(...await searchPairs(q));
      await sleep(400);
    }

    // 2. Latest DexScreener profiles (tokens with socials = community-driven)
    const profiles = await getLatestTokenProfiles();
    const addrs = profiles.filter(p => p.chainId === 'solana').slice(0, 20).map(p => p.tokenAddress);
    if (addrs.length) allPairs.push(...await getTokensByAddresses(addrs));

    // Deduplicate by base token address
    const seen = new Set<string>();
    const unique = allPairs.filter(p => { const k = p.baseToken.address; if (seen.has(k)) return false; seen.add(k); return true; });
    console.log(`[Scanner] ${unique.length} unique pairs`);

    const scored = scoreAndFilterTokens(unique);
    console.log(`[Scanner] ${scored.length} passed filters`);

    // Process fast-tracks first
    for (const ft of getActiveFastTracks()) {
      if (!isAlreadyCalled(ft.contract_address)) await processFastTrack(ft);
    }

    // Algo calls
    for (const token of scored) {
      const addr = token.pair.baseToken.address;
      if (isAlreadyCalled(addr)) continue;

      const cooldownMs = config.scanner.callCooldownMinutes * 60_000;
      if (Date.now() - lastCallTime < cooldownMs) continue;

      // Enrich with holder analysis before posting
      const holders = await analyzeHolders(addr);

      // Skip HIGH risk bundles (configurable)
      if (holders?.riskLevel === 'HIGH') {
        console.log(`[Scanner] Skipping $${token.pair.baseToken.symbol} — HIGH bundle risk`);
        continue;
      }

      console.log(`[Scanner] Calling $${token.pair.baseToken.symbol} (score: ${token.score}, risk: ${holders?.riskLevel ?? 'unknown'})`);
      await postCall(token, 'algo', holders ?? undefined);
      lastCallTime = Date.now();
      callsThisHour++;
      if (callsThisHour >= config.scanner.maxCallsPerHour) break;
    }
  } catch (err: any) {
    console.error('[Scanner] Error:', err.message);
  }
}

async function processFastTrack(ft: any): Promise<void> {
  try {
    const pairs = await getTokensByAddresses([ft.contract_address]);
    if (!pairs.length) return;
    const scored = scoreAndFilterTokens(pairs);
    const token: ScoredToken = scored[0] ?? {
      pair: pairs[0], score: 0, reasons: ['Fast-Track'], isCto: false, isDexscreenerPaid: false,
    };
    const holders = await analyzeHolders(ft.contract_address);
    await postCall(token, 'fasttrack', holders ?? undefined);
  } catch (err: any) {
    console.error('[Scanner] Fast-track error:', err.message);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function startScanner(): void {
  console.log(`[Scanner] Starting — interval: ${config.scanner.intervalMinutes}min`);
  scanTokens();
  cron.schedule(`*/${config.scanner.intervalMinutes} * * * *`, () => scanTokens());
}

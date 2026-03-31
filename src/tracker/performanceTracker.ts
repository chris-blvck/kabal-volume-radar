import cron from 'node-cron';
import { getActiveCallsForTracking, saveCallUpdate, getAthForCall } from '../database/db';
import { getTokenByAddress } from '../scanner/dexscreener';
import { formatUpdateMessage } from '../utils/formatMessage';
import { postUpdateToChannel } from '../bot/channelBot';

const MILESTONES = [
  { label: '30m', minutes: 30 },
  { label: '1h',  minutes: 60 },
  { label: '3h',  minutes: 180 },
  { label: '6h',  minutes: 360 },
  { label: '12h', minutes: 720 },
  { label: '24h', minutes: 1440 },
];

// callId -> milestones already posted
const postedMilestones = new Map<number, Set<string>>();

export async function trackCalls(): Promise<void> {
  const calls = getActiveCallsForTracking();
  if (!calls.length) return;
  console.log(`[Tracker] Tracking ${calls.length} calls`);

  for (const call of calls) {
    try {
      await trackOne(call);
      await sleep(400);
    } catch (err: any) {
      console.error(`[Tracker] Error for $${call.symbol}:`, err.message);
    }
  }
}

async function trackOne(call: any): Promise<void> {
  const pair = await getTokenByAddress(call.contract_address);
  if (!pair) return;

  const currentMcap   = pair.marketCap || pair.fdv || 0;
  const callMcap      = call.market_cap_at_call || currentMcap;
  const percentChange = callMcap > 0 ? ((currentMcap - callMcap) / callMcap) * 100 : 0;
  const multiplier    = callMcap > 0 ? currentMcap / callMcap : 1;
  const prevAth       = getAthForCall(call.id);

  saveCallUpdate({
    call_id: call.id,
    market_cap: currentMcap,
    price: parseFloat(pair.priceUsd || '0'),
    percent_change: percentChange,
    ath_multiplier: Math.max(multiplier, prevAth),
  });

  const minutesSinceCall = (Date.now() - call.called_at * 1000) / 60_000;
  if (!postedMilestones.has(call.id)) postedMilestones.set(call.id, new Set());
  const posted = postedMilestones.get(call.id)!;

  for (const ms of MILESTONES) {
    if (minutesSinceCall >= ms.minutes && !posted.has(ms.label)) {
      posted.add(ms.label);
      // Only post if notable change or key milestone
      if (Math.abs(percentChange) >= 10 || ['1h', '3h', '6h'].includes(ms.label)) {
        const msg = formatUpdateMessage(call, currentMcap, percentChange, ms.label);
        await postUpdateToChannel(msg, call.message_id ?? undefined);
        console.log(`[Tracker] $${call.symbol} ${ms.label}: ${percentChange.toFixed(1)}%`);
      }
      break;
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function startTracker(): void {
  console.log('[Tracker] Starting performance tracker');
  trackCalls();
  cron.schedule('*/10 * * * *', () => trackCalls());
}

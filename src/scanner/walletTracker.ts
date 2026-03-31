import cron from 'node-cron';
import { getRecentSwaps } from './helius';
import { getTokenByAddress } from './dexscreener';
import { config } from '../config';
import { getDb } from '../database/db';

export interface TrackedWallet {
  address: string;
  label:   string;
  emoji?:  string;
}

const DEFAULT_WALLETS: TrackedWallet[] = [];

type AlertFn = (message: string, ca: string) => Promise<void>;
let alertFn: AlertFn | null = null;
export function setWalletAlertFn(fn: AlertFn): void { alertFn = fn; }

// ── Multi-wallet convergence tracking ───────────────────────────────────────
// If 2+ tracked wallets buy the same token within 30 min → convergence alert
const convergenceMap = new Map<string, { labels: string[]; firstSeen: number }>();
const CONVERGE_WINDOW = 30 * 60 * 1000;

function recordBuy(ca: string, label: string): string[] {
  const now = Date.now();
  for (const [k, v] of convergenceMap)
    if (now - v.firstSeen > CONVERGE_WINDOW) convergenceMap.delete(k);

  const entry = convergenceMap.get(ca);
  if (!entry) { convergenceMap.set(ca, { labels: [label], firstSeen: now }); return []; }
  if (!entry.labels.includes(label)) entry.labels.push(label);
  return entry.labels.length >= 2 ? [...entry.labels] : [];
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      address TEXT PRIMARY KEY, label TEXT NOT NULL,
      emoji TEXT DEFAULT '\uD83D\uDC64', added_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS wallet_last_seen (
      address TEXT PRIMARY KEY, signature TEXT NOT NULL
    );
  `);
}

export function getAllWallets(): TrackedWallet[] {
  ensureTable();
  const rows = getDb().prepare('SELECT address,label,emoji FROM tracked_wallets').all() as any[];
  return [...DEFAULT_WALLETS, ...rows.map(r => ({ address: r.address, label: r.label, emoji: r.emoji }))];
}
export function addWallet(address: string, label: string, emoji = '\uD83D\uDC64'): void {
  ensureTable();
  getDb().prepare('INSERT OR REPLACE INTO tracked_wallets (address,label,emoji) VALUES (?,?,?)').run(address, label, emoji);
}
export function removeWallet(address: string): void {
  ensureTable();
  getDb().prepare('DELETE FROM tracked_wallets WHERE address=?').run(address);
}
function getLastSeen(address: string): string | null {
  ensureTable();
  return (getDb().prepare('SELECT signature FROM wallet_last_seen WHERE address=?').get(address) as any)?.signature ?? null;
}
function setLastSeen(address: string, sig: string): void {
  getDb().prepare('INSERT OR REPLACE INTO wallet_last_seen (address,signature) VALUES (?,?)').run(address, sig);
}

// ── Scanning ──────────────────────────────────────────────────────────────────

async function checkWallet(wallet: TrackedWallet): Promise<void> {
  const swaps  = await getRecentSwaps(wallet.address, 5);
  if (!swaps.length) return;

  const lastSig = getLastSeen(wallet.address);
  const isFirst = !lastSig;
  setLastSeen(wallet.address, swaps[0].signature);
  if (isFirst) return;

  const lastIdx  = swaps.findIndex(s => s.signature === lastSig);
  const newSwaps = lastIdx === -1 ? swaps.slice(0, 1) : swaps.slice(0, lastIdx);

  for (const swap of newSwaps) {
    if (swap.type !== 'buy') continue;
    const pair = await getTokenByAddress(swap.tokenMint);
    if (!pair || pair.chainId !== 'solana') continue;
    const mcap = pair.marketCap ?? pair.fdv ?? 0;
    if (mcap > 5_000_000) continue;

    const sym   = pair.baseToken.symbol;
    const ca    = swap.tokenMint;
    const emoji = wallet.emoji ?? '\uD83D\uDC64';

    // Check convergence (2+ wallets on same token)
    const converged = recordBuy(ca, wallet.label);

    let msg: string;
    if (converged.length >= 2) {
      msg = `\uD83D\uDEA8 <b>SMART MONEY CONVERGENCE</b>\n\n`;
      msg += `<b>${converged.length} tracked wallets</b> all bought <b>$${sym}</b>!\n\n`;
      msg += converged.map(l => `\u2022 ${l}`).join('\n') + '\n\n';
      msg += `<code>${ca}</code>\n\n`;
      msg += `\uD83D\uDCB0 MCap: <b>${fmtMcap(mcap)}</b>\n`;
      msg += `\uD83D\uDCC8 1h: <b>${fmtPct(pair.priceChange?.h1 ?? 0)}</b>  `;
      msg += `\uD83D\uDCCA Vol/1h: <b>${fmtVol(pair.volume?.h1 ?? 0)}</b>\n\n`;
      msg += `<a href="${pair.url}">\uD83D\uDD0D DexScreener</a>  <a href="https://gmgn.ai/sol/token/${ca}">\u26A1 GMGN</a>`;
      console.log(`[WalletTracker] CONVERGENCE on $${sym} (${converged.join(', ')})`);
    } else {
      msg = `\uD83D\uDD0E <b>Smart Money Alert</b>\n\n`;
      msg += `${emoji} <b>${wallet.label}</b> bought <b>$${sym}</b>\n\n`;
      msg += `<code>${ca}</code>\n\n`;
      msg += `\uD83D\uDCB0 MCap: <b>${fmtMcap(mcap)}</b>\n`;
      msg += `\uD83D\uDCC8 1h: <b>${fmtPct(pair.priceChange?.h1 ?? 0)}</b>  `;
      msg += `\uD83D\uDCCA Vol/1h: <b>${fmtVol(pair.volume?.h1 ?? 0)}</b>\n\n`;
      msg += `<a href="${pair.url}">\uD83D\uDD0D DexScreener</a>  <a href="https://gmgn.ai/sol/token/${ca}">\u26A1 GMGN</a>`;
      console.log(`[WalletTracker] ${wallet.label} bought $${sym}`);
    }

    if (alertFn) await alertFn(msg, ca);
    await sleep(400);
  }
}

async function scanAll(): Promise<void> {
  const wallets = getAllWallets();
  if (!wallets.length) return;
  for (const w of wallets) {
    try { await checkWallet(w); } catch { /* continue */ }
    await sleep(500);
  }
}

function fmtMcap(n: number) { return n >= 1e6 ? `$${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(1)}k` : `$${n.toFixed(0)}`; }
function fmtVol(n: number)  { return fmtMcap(n); }
function fmtPct(n: number)  { return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; }
function sleep(ms: number)  { return new Promise(r => setTimeout(r, ms)); }

export function startWalletTracker(): void {
  if (!config.helius.apiKey) { console.log('[WalletTracker] Skipped \u2014 no Helius API key'); return; }
  const wallets = getAllWallets();
  if (!wallets.length) { console.log('[WalletTracker] No wallets configured'); return; }
  console.log(`[WalletTracker] Tracking ${wallets.length} wallets, convergence window: 30min`);
  scanAll();
  cron.schedule('*/2 * * * *', () => scanAll());
}

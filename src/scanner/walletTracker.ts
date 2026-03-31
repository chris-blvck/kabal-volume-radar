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

// Seed list of known Solana alpha wallets — extend via /wallets admin command
const DEFAULT_WALLETS: TrackedWallet[] = [
  // Add real wallets here. Examples:
  // { address: 'AbC123...', label: 'Murad', emoji: '💎' },
];

type AlertFn = (message: string, ca: string) => Promise<void>;
let alertFn: AlertFn | null = null;

export function setWalletAlertFn(fn: AlertFn): void { alertFn = fn; }

// ── Persistence in DB ──────────────────────────────────────────────────────

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      address TEXT PRIMARY KEY,
      label   TEXT NOT NULL,
      emoji   TEXT DEFAULT '👤',
      added_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS wallet_last_seen (
      address   TEXT PRIMARY KEY,
      signature TEXT NOT NULL
    );
  `);
}

export function getAllWallets(): TrackedWallet[] {
  ensureTable();
  const rows = getDb().prepare('SELECT address, label, emoji FROM tracked_wallets').all() as any[];
  return [...DEFAULT_WALLETS, ...rows.map(r => ({ address: r.address, label: r.label, emoji: r.emoji }))];
}

export function addWallet(address: string, label: string, emoji = '👤'): void {
  ensureTable();
  getDb().prepare('INSERT OR REPLACE INTO tracked_wallets (address, label, emoji) VALUES (?, ?, ?)').run(address, label, emoji);
}

export function removeWallet(address: string): void {
  ensureTable();
  getDb().prepare('DELETE FROM tracked_wallets WHERE address = ?').run(address);
}

function getLastSeen(address: string): string | null {
  ensureTable();
  const row = getDb().prepare('SELECT signature FROM wallet_last_seen WHERE address = ?').get(address) as any;
  return row?.signature ?? null;
}

function setLastSeen(address: string, signature: string): void {
  getDb().prepare('INSERT OR REPLACE INTO wallet_last_seen (address, signature) VALUES (?, ?)').run(address, signature);
}

// ── Scanning ───────────────────────────────────────────────────────────

async function checkWallet(wallet: TrackedWallet): Promise<void> {
  const swaps = await getRecentSwaps(wallet.address, 5);
  if (!swaps.length) return;

  const lastSig  = getLastSeen(wallet.address);
  const isFirst  = !lastSig;

  // Mark latest as seen
  setLastSeen(wallet.address, swaps[0].signature);

  // On first run, just record — don’t spam old alerts
  if (isFirst) return;

  // Find swaps newer than lastSig
  const lastIdx = swaps.findIndex(s => s.signature === lastSig);
  const newSwaps = lastIdx === -1 ? swaps.slice(0, 1) : swaps.slice(0, lastIdx);

  for (const swap of newSwaps) {
    if (swap.type !== 'buy') continue;

    const pair = await getTokenByAddress(swap.tokenMint);
    if (!pair) continue;
    if (pair.chainId !== 'solana') continue;

    const mcap = pair.marketCap ?? pair.fdv ?? 0;
    if (mcap > 5_000_000) continue; // skip large caps — not relevant for early calls

    const sym   = pair.baseToken.symbol;
    const ca    = swap.tokenMint;
    const emoji = wallet.emoji ?? '👤';

    const msg =
      `🔎 <b>Smart Money Alert</b>\n\n` +
      `${emoji} <b>${wallet.label}</b> just bought <b>$${sym}</b>\n\n` +
      `<code>${ca}</code>\n\n` +
      `💰 MCap: <b>${fmtMcap(mcap)}</b>\n` +
      `📈 1h: <b>${fmtPct(pair.priceChange?.h1 ?? 0)}</b>  ` +
      `📊 Vol 1h: <b>${fmtVol(pair.volume?.h1 ?? 0)}</b>\n\n` +
      `<a href="${pair.url}">🔍 DexScreener</a>  ` +
      `<a href="https://gmgn.ai/sol/token/${ca}">⚡ GMGN</a>`;

    console.log(`[WalletTracker] ${wallet.label} bought $${sym}`);
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
  if (!config.helius.apiKey) {
    console.log('[WalletTracker] Skipped — no Helius API key');
    return;
  }
  const wallets = getAllWallets();
  if (!wallets.length) {
    console.log('[WalletTracker] No wallets configured — add them via /wallets in the management bot');
    return;
  }
  console.log(`[WalletTracker] Tracking ${wallets.length} wallets, interval: 2min`);
  scanAll();
  cron.schedule('*/2 * * * *', () => scanAll());
}

import Database from 'better-sqlite3';
import { config } from '../config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      chain TEXT NOT NULL DEFAULT 'solana',
      dex_id TEXT,
      pair_address TEXT,
      market_cap_at_call REAL,
      price_at_call REAL,
      volume_1h_at_call REAL,
      price_change_1h_at_call REAL,
      liquidity_at_call REAL,
      image_url TEXT,
      website TEXT,
      twitter TEXT,
      telegram_url TEXT,
      dexscreener_url TEXT,
      is_cto INTEGER DEFAULT 0,
      is_dexscreener_paid INTEGER DEFAULT 0,
      source TEXT DEFAULT 'algo',
      called_at INTEGER NOT NULL DEFAULT (unixepoch()),
      message_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS call_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER NOT NULL REFERENCES calls(id),
      market_cap REAL,
      price REAL,
      percent_change REAL,
      ath_multiplier REAL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      milestone TEXT
    );

    CREATE TABLE IF NOT EXISTS fast_track_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT NOT NULL,
      submitter_chat_id INTEGER NOT NULL,
      duration_hours INTEGER NOT NULL,
      sol_amount REAL NOT NULL,
      payment_tx TEXT,
      status TEXT DEFAULT 'pending',
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS pro_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL UNIQUE,
      telegram_username TEXT,
      payment_tx TEXT NOT NULL,
      sol_amount REAL NOT NULL,
      subscribed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS advertise_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submitter_chat_id INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      link TEXT,
      sol_amount REAL NOT NULL,
      payment_tx TEXT,
      status TEXT DEFAULT 'pending',
      duration_hours INTEGER DEFAULT 24,
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_calls_address ON calls(contract_address);
    CREATE INDEX IF NOT EXISTS idx_calls_called_at ON calls(called_at);
    CREATE INDEX IF NOT EXISTS idx_call_updates_call_id ON call_updates(call_id);
  `);
}

export function saveCall(call: {
  contract_address: string;
  symbol: string;
  name: string;
  chain?: string;
  dex_id?: string;
  pair_address?: string;
  market_cap_at_call?: number;
  price_at_call?: number;
  volume_1h_at_call?: number;
  price_change_1h_at_call?: number;
  liquidity_at_call?: number;
  image_url?: string;
  website?: string;
  twitter?: string;
  telegram_url?: string;
  dexscreener_url?: string;
  is_cto?: boolean;
  is_dexscreener_paid?: boolean;
  source?: string;
  message_id?: number;
}): number {
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO calls (
      contract_address, symbol, name, chain, dex_id, pair_address,
      market_cap_at_call, price_at_call, volume_1h_at_call, price_change_1h_at_call,
      liquidity_at_call, image_url, website, twitter, telegram_url, dexscreener_url,
      is_cto, is_dexscreener_paid, source, message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    call.contract_address, call.symbol, call.name,
    call.chain || 'solana', call.dex_id || null, call.pair_address || null,
    call.market_cap_at_call || null, call.price_at_call || null,
    call.volume_1h_at_call || null, call.price_change_1h_at_call || null,
    call.liquidity_at_call || null, call.image_url || null,
    call.website || null, call.twitter || null,
    call.telegram_url || null, call.dexscreener_url || null,
    call.is_cto ? 1 : 0, call.is_dexscreener_paid ? 1 : 0,
    call.source || 'algo', call.message_id || null
  );
  if (result.lastInsertRowid) return result.lastInsertRowid as number;
  // Already exists — return existing id
  const row = getDb().prepare('SELECT id FROM calls WHERE contract_address = ?').get(call.contract_address) as any;
  return row.id;
}

export function getCallByAddress(address: string) {
  return getDb().prepare('SELECT * FROM calls WHERE contract_address = ?').get(address) as any;
}

export function isAlreadyCalled(address: string): boolean {
  return !!getCallByAddress(address);
}

export function getRecentCalls(limit = 10) {
  return getDb().prepare('SELECT * FROM calls ORDER BY called_at DESC LIMIT ?').all(limit) as any[];
}

export function updateCallMessageId(callId: number, messageId: number): void {
  getDb().prepare('UPDATE calls SET message_id = ? WHERE id = ?').run(messageId, callId);
}

export function saveCallUpdate(update: {
  call_id: number;
  market_cap?: number;
  price?: number;
  percent_change?: number;
  ath_multiplier?: number;
  milestone?: string;
}): void {
  getDb().prepare(`
    INSERT INTO call_updates (call_id, market_cap, price, percent_change, ath_multiplier, milestone)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    update.call_id, update.market_cap || null, update.price || null,
    update.percent_change || null, update.ath_multiplier || null, update.milestone || null
  );
}

export function getAthForCall(callId: number): number {
  const row = getDb().prepare(
    'SELECT MAX(ath_multiplier) as ath FROM call_updates WHERE call_id = ?'
  ).get(callId) as any;
  return row?.ath || 1;
}

export function getActiveCallsForTracking() {
  return getDb().prepare(`
    SELECT * FROM calls
    WHERE called_at > unixepoch() - 48*3600
    ORDER BY called_at DESC
  `).all() as any[];
}

export function saveProSubscriber(sub: {
  telegram_id: number;
  telegram_username?: string;
  payment_tx: string;
  sol_amount: number;
  expires_at: number;
}): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO pro_subscribers (telegram_id, telegram_username, payment_tx, sol_amount, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sub.telegram_id, sub.telegram_username || null, sub.payment_tx, sub.sol_amount, sub.expires_at);
}

export function isProSubscriber(telegramId: number): boolean {
  const row = getDb().prepare(
    'SELECT id FROM pro_subscribers WHERE telegram_id = ? AND expires_at > unixepoch()'
  ).get(telegramId) as any;
  return !!row;
}

export function saveFastTrack(ft: {
  contract_address: string;
  submitter_chat_id: number;
  duration_hours: number;
  sol_amount: number;
  payment_tx?: string;
  status?: string;
  expires_at?: number;
}): number {
  const result = getDb().prepare(`
    INSERT INTO fast_track_queue (contract_address, submitter_chat_id, duration_hours, sol_amount, payment_tx, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ft.contract_address, ft.submitter_chat_id, ft.duration_hours, ft.sol_amount,
    ft.payment_tx || null, ft.status || 'pending', ft.expires_at || null
  );
  return result.lastInsertRowid as number;
}

export function updateFastTrackStatus(id: number, status: string, paymentTx?: string, expiresAt?: number): void {
  getDb().prepare(
    'UPDATE fast_track_queue SET status = ?, payment_tx = COALESCE(?, payment_tx), expires_at = COALESCE(?, expires_at) WHERE id = ?'
  ).run(status, paymentTx || null, expiresAt || null, id);
}

export function getActiveFastTracks() {
  return getDb().prepare(
    "SELECT * FROM fast_track_queue WHERE status = 'active' AND expires_at > unixepoch()"
  ).all() as any[];
}

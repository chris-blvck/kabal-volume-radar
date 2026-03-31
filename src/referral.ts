/**
 * Referral system
 * ─────────────────────────────────────────────────────────────────────
 * Every user gets a unique referral link:  /start ref_<userId>
 * When a referee pays for Pro or Fast-Track, the referrer earns
 * REFERRAL_PCT% of the payment (tracked off-chain for now —
 * admin reviews and pays out manually via /payouts command).
 */

import { getDb } from './database/db';
import { config } from './config';

function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      referrer_id   INTEGER NOT NULL,
      referee_id    INTEGER NOT NULL,
      registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (referee_id)
    );

    CREATE TABLE IF NOT EXISTS referral_earnings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id   INTEGER NOT NULL,
      referee_id    INTEGER NOT NULL,
      payment_type  TEXT NOT NULL,   -- 'pro' | 'fasttrack' | 'advertise'
      gross_sol     REAL NOT NULL,
      earn_sol      REAL NOT NULL,
      payment_tx    TEXT,
      paid_out      INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referral_earnings(referrer_id);
  `);
}

/** Register a referral when a new user clicks a referral link. */
export function registerReferral(referrerId: number, refereeId: number): void {
  if (referrerId === refereeId) return; // can’t refer yourself
  ensureTables();
  try {
    getDb().prepare(
      'INSERT OR IGNORE INTO referrals (referrer_id, referee_id) VALUES (?, ?)'
    ).run(referrerId, refereeId);
  } catch { /* ignore */ }
}

/** Returns the referrer ID for a given referee, if any. */
export function getReferrerId(refereeId: number): number | null {
  ensureTables();
  const row = getDb().prepare('SELECT referrer_id FROM referrals WHERE referee_id = ?').get(refereeId) as any;
  return row?.referrer_id ?? null;
}

/** Record earnings when a referee pays. Called after successful payment verification. */
export function recordEarning(params: {
  referrerId:  number;
  refereeId:   number;
  paymentType: 'pro' | 'fasttrack' | 'advertise';
  grossSol:    number;
  paymentTx:   string;
}): void {
  ensureTables();
  const pct     = config.referral.commissionPct / 100;
  const earnSol = parseFloat((params.grossSol * pct).toFixed(4));
  getDb().prepare(`
    INSERT INTO referral_earnings (referrer_id, referee_id, payment_type, gross_sol, earn_sol, payment_tx)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(params.referrerId, params.refereeId, params.paymentType, params.grossSol, earnSol, params.paymentTx);
}

export interface ReferralStats {
  totalReferrals:  number;
  pendingEarnSol:  number;
  totalEarnSol:    number;
  recentReferrals: Array<{ refereeId: number; registeredAt: number }>;
}

export function getReferralStats(referrerId: number): ReferralStats {
  ensureTables();
  const db = getDb();

  const totalReferrals = (db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ?').get(referrerId) as any).c;
  const pending = (db.prepare(
    'SELECT COALESCE(SUM(earn_sol),0) as s FROM referral_earnings WHERE referrer_id = ? AND paid_out = 0'
  ).get(referrerId) as any).s;
  const total = (db.prepare(
    'SELECT COALESCE(SUM(earn_sol),0) as s FROM referral_earnings WHERE referrer_id = ?'
  ).get(referrerId) as any).s;
  const recent = db.prepare(
    'SELECT referee_id, registered_at FROM referrals WHERE referrer_id = ? ORDER BY registered_at DESC LIMIT 5'
  ).all(referrerId) as any[];

  return {
    totalReferrals,
    pendingEarnSol: parseFloat(pending),
    totalEarnSol:   parseFloat(total),
    recentReferrals: recent.map(r => ({ refereeId: r.referee_id, registeredAt: r.registered_at })),
  };
}

/** Admin: list all unpaid earnings with totals per referrer. */
export function getPendingPayouts() {
  ensureTables();
  return getDb().prepare(`
    SELECT referrer_id, SUM(earn_sol) as total_sol, COUNT(*) as count
    FROM referral_earnings
    WHERE paid_out = 0
    GROUP BY referrer_id
    ORDER BY total_sol DESC
  `).all() as Array<{ referrer_id: number; total_sol: number; count: number }>;
}

/** Admin: mark all pending earnings for a referrer as paid. */
export function markPaidOut(referrerId: number): void {
  ensureTables();
  getDb().prepare('UPDATE referral_earnings SET paid_out = 1 WHERE referrer_id = ? AND paid_out = 0').run(referrerId);
}

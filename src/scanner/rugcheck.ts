/**
 * Rugcheck.xyz — free rug-pull risk analysis
 * No API key required.
 */
import axios from 'axios';

const BASE = 'https://api.rugcheck.xyz/v1';

export interface RugcheckSummary {
  score:           number; // raw (lower = safer)
  scoreNormalised: number; // 0–100 (lower = safer)
  risks: Array<{
    name:        string;
    description: string;
    score:       number;
    level:       'info' | 'warn' | 'danger';
  }>;
}

export async function getRugcheckReport(mint: string): Promise<RugcheckSummary | null> {
  try {
    const { data } = await axios.get(`${BASE}/tokens/${mint}/report/summary`, { timeout: 8_000 });
    return {
      score:           data.score            ?? 9999,
      scoreNormalised: data.score_normalised  ?? 100,
      risks:           data.risks             ?? [],
    };
  } catch {
    return null;
  }
}

/** Human-readable risk label based on normalised score (0–100). */
export function rugRiskLabel(scoreNorm: number): string {
  if (scoreNorm <= 20) return '\uD83D\uDFE2 SAFE';
  if (scoreNorm <= 50) return '\uD83D\uDFE1 WARN';
  return '\uD83D\uDD34 DANGER';
}

/** Top danger-level risk names (for display in call message). */
export function topRisks(report: RugcheckSummary, max = 2): string[] {
  return report.risks
    .filter(r => r.level === 'danger' || r.level === 'warn')
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(r => r.name);
}

import axios from 'axios';
import { config } from '../config';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface PaymentResult {
  valid: boolean;
  amount?: number;
  error?: string;
}

export async function verifyPayment(
  txSignature: string,
  expectedRecipient: string,
  expectedAmountSol: number,
  toleranceSol = 0.01
): Promise<PaymentResult> {
  try {
    const res = await axios.post(config.solana.rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        txSignature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ],
    }, { timeout: 15_000 });

    const tx = res.data?.result;
    if (!tx)          return { valid: false, error: 'Transaction not found' };
    if (tx.meta?.err) return { valid: false, error: 'Transaction failed on-chain' };

    const allInstructions = [
      ...(tx.transaction?.message?.instructions || []),
      ...((tx.meta?.innerInstructions || []).flatMap((i: any) => i.instructions || [])),
    ];

    for (const ix of allInstructions) {
      if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
        const { destination, lamports } = ix.parsed.info;
        const amountSol = lamports / LAMPORTS_PER_SOL;
        if (
          destination.toLowerCase() === expectedRecipient.toLowerCase() &&
          Math.abs(amountSol - expectedAmountSol) <= toleranceSol
        ) {
          return { valid: true, amount: amountSol };
        }
      }
    }

    return { valid: false, error: 'Payment amount or recipient mismatch' };
  } catch (err: any) {
    return { valid: false, error: `RPC error: ${err.message}` };
  }
}

export function extractTxSig(input: string): string | null {
  // Accept raw sig or solscan/explorer URLs
  const urlMatch = input.match(/(?:solscan\.io\/tx\/|explorer\.solana\.com\/tx\/)([A-Za-z0-9]{80,})/); 
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9]{80,}$/.test(input)) return input;
  return null;
}

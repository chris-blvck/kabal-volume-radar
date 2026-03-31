import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  telegram: {
    managementBotToken: required('MANAGEMENT_BOT_TOKEN'),
    channelBotToken:    required('CHANNEL_BOT_TOKEN'),
    trendingChannelId:  required('TRENDING_CHANNEL_ID'),
    proChannelId:       process.env.PRO_CHANNEL_ID  || '',
    adminIds:           (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean),
  },
  solana: {
    paymentWallet: required('SOL_PAYMENT_WALLET'),
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  },
  helius: {
    // Free key at https://helius.dev — enables holder analysis & wallet tracker
    apiKey: process.env.HELIUS_API_KEY || '',
  },
  birdeye: {
    // Free key at https://birdeye.so/developer — enables trending & new listing sources
    apiKey: process.env.BIRDEYE_API_KEY || '',
  },
  scanner: {
    intervalMinutes:     Number(process.env.SCAN_INTERVAL_MINUTES) || 3,
    minMarketCap:        Number(process.env.MIN_MARKET_CAP)        || 10_000,
    maxMarketCap:        Number(process.env.MAX_MARKET_CAP)        || 800_000,
    minVolume1h:         Number(process.env.MIN_VOLUME_1H)         || 3_000,
    minPriceChange1h:    Number(process.env.MIN_PRICE_CHANGE_1H)   || 10,
    minBuySellRatio:     Number(process.env.MIN_BUY_SELL_RATIO)    || 1.2,
    maxTokenAgeHours:    Number(process.env.MAX_TOKEN_AGE_HOURS)   || 48,
    callCooldownMinutes: Number(process.env.CALL_COOLDOWN_MINUTES) || 15,
    maxCallsPerHour:     Number(process.env.MAX_CALLS_PER_HOUR)    || 5,
    skipHighRiskBundles: process.env.SKIP_HIGH_RISK_BUNDLES !== 'false',
  },
  proDelay: {
    // Minutes free channel waits after Pro channel receives a call
    minutes: Number(process.env.PRO_DELAY_MINUTES) || 5,
  },
  pricing: {
    fastTrack3hSol:  Number(process.env.FAST_TRACK_3H_SOL)  || 1.2,
    fastTrack12hSol: Number(process.env.FAST_TRACK_12H_SOL) || 2.2,
    fastTrack24hSol: Number(process.env.FAST_TRACK_24H_SOL) || 3.2,
    advertise24hSol: Number(process.env.ADVERTISE_24H_SOL)  || 3.5,
    proMonthlySol:   Number(process.env.PRO_MONTHLY_SOL)    || 0.7,
  },
  referral: {
    // % of each payment earned by the referrer
    commissionPct: Number(process.env.REFERRAL_COMMISSION_PCT) || 10,
  },
  db: {
    path: process.env.DB_PATH || './kabal.db',
  },
};

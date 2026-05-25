import dotenv from 'dotenv';

dotenv.config();

export const APP_NAME = 'Apex';
export const APP_VERSION = '3.0.0';
export const DB_PATH = process.env.DB_PATH || './apex.sqlite';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_MINT  = 'So11111111111111111111111111111111111111111';

// Telegram
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
export const TELEGRAM_TOPIC_ID  = process.env.TELEGRAM_TOPIC_ID;

// Solana / Helius
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const SOLANA_WS_URL  = process.env.SOLANA_WS_URL  || `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// GMGN
export const GMGN_API_KEY        = process.env.GMGN_API_KEY;
export const GMGN_ENABLED        = process.env.GMGN_ENABLED !== 'false';
export const GMGN_CACHE_TTL_MS   = Number(process.env.GMGN_CACHE_TTL_MS || 5 * 60 * 1000);

// Jupiter
export const JUPITER_API_KEY        = process.env.JUPITER_API_KEY || '';
export const JUPITER_SWAP_BASE_URL  = process.env.JUPITER_SWAP_BASE_URL || 'https://api.jup.ag/swap/v2';
export const JUPITER_SLIPPAGE_BPS   = Number(process.env.JUPITER_SLIPPAGE_BPS || 300);

// Wallet (live mode)
export const SOLANA_PRIVATE_KEY              = process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
export const LIVE_MIN_SOL_RESERVE_LAMPORTS   = Math.floor(Number(process.env.LIVE_MIN_SOL_RESERVE || 0.05) * 1_000_000_000);

// LLM
export const ENABLE_LLM     = process.env.ENABLE_LLM !== 'false';
export const LLM_BASE_URL   = process.env.LLM_BASE_URL || 'https://api.minimax.io/v1';
export const LLM_API_KEY    = process.env.LLM_API_KEY || '';
export const LLM_MODEL      = process.env.LLM_MODEL || 'MiniMax-M2.7';
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60_000);

// Charon signal server
export const SIGNAL_SERVER_URL = process.env.SIGNAL_SERVER_URL || 'https://api.thecharon.xyz/api';
export const SIGNAL_SERVER_KEY = process.env.SIGNAL_SERVER_KEY || '';
export const SIGNAL_POLL_MS    = Number(process.env.SIGNAL_POLL_MS || 30_000);

// Loop intervals
export const POSITION_CHECK_MS         = Number(process.env.POSITION_CHECK_MS || 10_000);
export const WATCHLIST_MONITOR_MS      = Number(process.env.WATCHLIST_MONITOR_MS || 30_000);
export const WATCHLIST_REVALIDATE_MS   = Number(process.env.WATCHLIST_REVALIDATE_MS || 10 * 60 * 1000);
export const WATCHLIST_STATUS_PUSH_MS  = Number(process.env.WATCHLIST_STATUS_PUSH_MS || 5 * 60 * 1000);

export const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export function validateConfig() {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!TELEGRAM_CHAT_ID)   throw new Error('TELEGRAM_CHAT_ID is required.');
  if (!HELIUS_API_KEY && (!process.env.SOLANA_RPC_URL || !process.env.SOLANA_WS_URL)) {
    throw new Error('HELIUS_API_KEY is required unless SOLANA_RPC_URL and SOLANA_WS_URL are set.');
  }
  if (GMGN_ENABLED && !GMGN_API_KEY) throw new Error('GMGN_API_KEY is required unless GMGN_ENABLED=false.');
}

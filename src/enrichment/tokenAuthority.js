// SPL Token mint authority guard.
// Active mint authority = HARD reject (dev can mint unlimited supply).
// Active freeze authority = score penalty.
//
// Mint account layout (82 bytes):
//   offset 0:  mint_authority (4-byte COption tag + 32-byte pubkey)
//   offset 36: supply (8 u64)
//   offset 44: decimals (1)
//   offset 45: is_initialized (1)
//   offset 46: freeze_authority (4-byte COption tag + 32-byte pubkey)
import axios from 'axios';
import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

const authorityCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function readOption(buf, offset) {
  const tag = buf.readUInt32LE(offset);
  return tag === 1;
}

export async function fetchTokenAuthority(mint, { useCache = true } = {}) {
  if (!mint) return null;
  const cached = authorityCache.get(mint);
  if (useCache && cached && now() - cached.at < CACHE_TTL_MS) return cached.data;
  try {
    const res = await axios.post(SOLANA_RPC_URL, {
      jsonrpc: '2.0', id: 1,
      method: 'getAccountInfo',
      params: [mint, { encoding: 'base64', commitment: 'confirmed' }],
    }, { timeout: 8000, headers: { ...JSON_HEADERS, 'content-type': 'application/json' } });
    const value = res.data?.result?.value;
    if (!value || !Array.isArray(value.data)) {
      const data = { checked: false, error: 'mint account not found' };
      authorityCache.set(mint, { at: now(), data });
      return data;
    }
    const buf = Buffer.from(value.data[0], 'base64');
    if (buf.length < 82) {
      const data = { checked: false, error: `account too small (${buf.length} bytes)` };
      authorityCache.set(mint, { at: now(), data });
      return data;
    }
    const mintAuthorityActive = readOption(buf, 0);
    const freezeAuthorityActive = readOption(buf, 46);
    const owner = value.owner || null;
    const data = {
      checked: true,
      mintAuthorityActive,
      freezeAuthorityActive,
      programOwner: owner,
      isToken2022: owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      fetchedAtMs: now(),
    };
    authorityCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    console.log(`[authority] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    const data = { checked: false, error: err.message };
    authorityCache.set(mint, { at: now() - CACHE_TTL_MS + 60_000, data });
    return data;
  }
}

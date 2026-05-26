// Token authority guard — Phase 2 defensive layer.
// Reads SPL Token / Token-2022 mint authority + freeze authority via Solana RPC.
// Active mint authority = HARD reject (dev can mint unlimited supply).
// Active freeze authority = score penalty (dev can freeze user wallets).
//
// References:
//   - SPL Token mint layout: https://github.com/solana-labs/solana-program-library/tree/master/token
//   - Token-2022: https://spl.solana.com/token-2022
// Mint account layout (82 bytes):
//   offset 0:  mint_authority (4 bytes COption tag + 32 bytes pubkey)
//   offset 36: supply (8 bytes u64)
//   offset 44: decimals (1 byte)
//   offset 45: is_initialized (1 byte)
//   offset 46: freeze_authority (4 bytes COption tag + 32 bytes pubkey)
//
// Token-2022 mint extends past 82 bytes with extensions; the base layout above is identical.
// We only need the authority option tags, so reading first 82 bytes is sufficient.

import axios from 'axios';
import { SOLANA_RPC_URL, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

const authorityCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function readOption(buf, offset) {
  // COption<Pubkey>: first 4 bytes is option tag (1 = some, 0 = none, little-endian u32),
  // followed by 32-byte pubkey (only meaningful if tag == 1).
  const tag = buf.readUInt32LE(offset);
  return tag === 1;
}

export async function fetchTokenAuthority(mint, { useCache = true } = {}) {
  if (!mint) return null;
  const cached = authorityCache.get(mint);
  if (useCache && cached && now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const res = await axios.post(SOLANA_RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
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
    const status = err.response?.status || '';
    console.log(`[authority] ${mint.slice(0, 8)}... ${status} ${err.message}`);
    const data = { checked: false, error: err.message };
    // Don't cache transient errors as long; allow retry sooner.
    authorityCache.set(mint, { at: now() - CACHE_TTL_MS + 60_000, data });
    return data;
  }
}

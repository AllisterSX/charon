// Execution router — buy / sell wrapper around Jupiter Ultra v2.
// In dry_run mode, no Jupiter call is made; we only record a synthetic trade.

import { WSOL_MINT } from '../config.js';
import { tradingMode } from '../db/positions.js';
import { executeJupiterSwap, fetchLiveTokenBalance } from '../liveExecutor.js';
import { estimateTokenAmountFromSol } from '../enrichment/jupiter.js';

export async function executeBuy({ mint, sizeSol, entryPrice }) {
  const mode = tradingMode();
  if (mode !== 'live') {
    const tokenAmountEst = await estimateTokenAmountFromSol(sizeSol, entryPrice).catch(() => null);
    return {
      executed: false,
      mode,
      signature: null,
      tokenAmountEst,
      tokenAmountRaw: null,
    };
  }

  const lamports = Math.floor(Number(sizeSol) * 1_000_000_000);
  const result = await executeJupiterSwap({
    inputMint: WSOL_MINT,
    outputMint: mint,
    amount: lamports,
  });
  return {
    executed: true,
    mode,
    signature: result.signature,
    tokenAmountEst: null,
    tokenAmountRaw: result.outputAmount || null,
    raw: result,
  };
}

export async function executeSell({ mint, tokenAmountRaw, sellFraction = 1.0 }) {
  const mode = tradingMode();
  if (mode !== 'live') {
    return { executed: false, mode, signature: null };
  }
  let raw = tokenAmountRaw;
  if (!raw) {
    raw = await fetchLiveTokenBalance(mint);
    if (!raw) return { executed: false, mode, signature: null, error: 'no_token_balance' };
  }
  let sellAmount = BigInt(raw);
  if (sellFraction > 0 && sellFraction < 1) {
    sellAmount = (sellAmount * BigInt(Math.round(sellFraction * 10000))) / 10000n;
  }
  if (sellAmount <= 0n) return { executed: false, mode, signature: null, error: 'sell_amount_zero' };
  const result = await executeJupiterSwap({
    inputMint: mint,
    outputMint: WSOL_MINT,
    amount: sellAmount.toString(),
  });
  return {
    executed: true,
    mode,
    signature: result.signature,
    raw: result,
  };
}

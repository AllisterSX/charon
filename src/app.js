import { setDefaultResultOrder } from 'node:dns';
import {
  APP_NAME, APP_VERSION,
  SIGNAL_POLL_MS, POSITION_CHECK_MS,
  validateConfig,
} from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { sendTelegram } from './telegram/send.js';
import { fetchSignals, setCandidateHandler } from './signals/charonServer.js';
import { fetchGmgnTrending, setTrendingHandler } from './signals/gmgnTrending.js';
import { processSignal } from './pipeline/screen.js';
import { monitorPositions } from './execution/positions.js';
import { startDailyReportScheduler } from './learning/dailyReport.js';
import { makeFailureTracker } from './utils.js';
import { pruneChartCache } from './db/chartCache.js';

setDefaultResultOrder('ipv4first');

export async function startApex() {
  validateConfig();
  initDb();
  initLiveExecution();
  setupTelegram();

  // Both signal sources feed into the same pipeline (direct TA entry).
  setCandidateHandler(processSignal);
  setTrendingHandler(processSignal);

  const alert = (msg) => sendTelegram(msg);
  const trackSignals    = makeFailureTracker('signals',     alert);
  const trackTrending   = makeFailureTracker('gmgn-trend',  alert);
  const trackPositions  = makeFailureTracker('positions',   alert);

  // Initial fetch.
  await fetchSignals().catch(err => console.log(`[signals] initial fetch failed: ${err.message}`));

  // Signal loops
  setInterval(() => trackSignals(() => fetchSignals()), SIGNAL_POLL_MS);
  setInterval(() => trackTrending(() => fetchGmgnTrending()), 60_000);

  // Position monitor (probe eval + exits)
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  // Cache pruning, hourly.
  setInterval(() => { try { pruneChartCache(); } catch {} }, 60 * 60 * 1000);

  // Daily report
  startDailyReportScheduler({ hourWib: 7, minute: 0 });

  console.log(`[bot] ${APP_NAME} v${APP_VERSION} started (direct TA entry mode)`);
  try { await sendTelegram(`🦅 <b>${APP_NAME}</b> v${APP_VERSION} online (direct TA entry)`); } catch {}
}

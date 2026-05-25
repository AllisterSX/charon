import { setDefaultResultOrder } from 'node:dns';
import {
  APP_NAME, APP_VERSION,
  SIGNAL_POLL_MS, POSITION_CHECK_MS,
  WATCHLIST_MONITOR_MS, WATCHLIST_STATUS_PUSH_MS,
  validateConfig,
} from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { sendTelegram, sendWatchlistSummary } from './telegram/send.js';
import { fetchSignals, setCandidateHandler } from './signals/charonServer.js';
import { processSignal } from './pipeline/screen.js';
import { monitorWatchlist } from './watchlist/monitor.js';
import { monitorPositions } from './execution/positions.js';
import { startDailyReportScheduler } from './learning/dailyReport.js';
import { makeFailureTracker } from './utils.js';
import { pruneChartCache } from './db/chartCache.js';
import { pruneWatchlistTicks } from './db/watchlist.js';

setDefaultResultOrder('ipv4first');

export async function startApex() {
  validateConfig();
  initDb();
  initLiveExecution();
  setupTelegram();

  setCandidateHandler(processSignal);

  const alert = (msg) => sendTelegram(msg);
  const trackSignals    = makeFailureTracker('signals',     alert);
  const trackWatchlist  = makeFailureTracker('watchlist',   alert);
  const trackPositions  = makeFailureTracker('positions',   alert);

  // Initial fetch (best-effort).
  await fetchSignals().catch(err => console.log(`[signals] initial fetch failed: ${err.message}`));

  setInterval(() => trackSignals(() => fetchSignals()), SIGNAL_POLL_MS);
  setInterval(() => trackWatchlist(() => monitorWatchlist()), WATCHLIST_MONITOR_MS);
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  // Periodic watchlist status push.
  setInterval(() => sendWatchlistSummary().catch(() => {}), WATCHLIST_STATUS_PUSH_MS);

  // Cache + tick pruning, hourly.
  setInterval(() => {
    try { pruneChartCache(); } catch {}
    try { pruneWatchlistTicks(); } catch {}
  }, 60 * 60 * 1000);

  startDailyReportScheduler({ hourWib: 7, minute: 0 });

  console.log(`[bot] ${APP_NAME} v${APP_VERSION} started`);
  try { await sendTelegram(`🦅 <b>${APP_NAME}</b> v${APP_VERSION} online`); } catch {}
}

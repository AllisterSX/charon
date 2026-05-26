import { startCharon } from './src/app.js';
import { mkdirSync } from 'node:fs';

// Ensure logs/ exists for PM2 file logger.
try { mkdirSync('./logs', { recursive: true }); } catch {}

let shuttingDown = false;
function gracefulExit(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, exiting...`);
  // Give in-flight async ops a moment to settle. PM2 kill_timeout is 5s.
  setTimeout(() => process.exit(code), 1500);
}

process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught:', err);
  gracefulExit('uncaughtException', 1);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandled rejection:', err);
  // Don't exit on bad promises — log and continue, the failure tracker will alert if pattern repeats.
});

startCharon().catch((error) => {
  console.error(error);
  process.exit(1);
});

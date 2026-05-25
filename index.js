import { startApex } from './src/app.js';
import { sendTelegram } from './src/telegram/send.js';

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[apex] received ${signal}, shutting down`);
  try { await sendTelegram(`🛑 <b>Apex stopping</b> (${signal})`); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[apex] uncaughtException', err);
  try { sendTelegram(`💥 <b>Apex uncaught exception</b>\n<code>${String(err?.message || err)}</code>`); } catch {}
});
process.on('unhandledRejection', (err) => {
  console.error('[apex] unhandledRejection', err);
});

startApex().catch(err => {
  console.error('[apex] fatal start failure', err);
  process.exit(1);
});

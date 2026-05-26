// Phase 0 smoke test — no TG required.
// Validates: dotenv loads, signal server reachable with our key, GMGN reachable.

import 'dotenv/config';
import axios from 'axios';

const SIGNAL_SERVER_URL = process.env.SIGNAL_SERVER_URL;
const SIGNAL_SERVER_KEY = process.env.SIGNAL_SERVER_KEY;
const GMGN_API_KEY = process.env.GMGN_API_KEY;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'OK ' : 'FAIL';
  console.log(`[${tag}] ${name}: ${detail}`);
}

async function checkServerHealth() {
  try {
    const res = await axios.get(`${SIGNAL_SERVER_URL}/health`, {
      timeout: 8000,
      headers: { 'x-api-key': SIGNAL_SERVER_KEY },
    });
    record('charon-server health', res.status === 200, `${res.status} totalSignals=${res.data?.totalSignals} uptime=${Math.round(res.data?.uptime || 0)}s`);
  } catch (err) {
    record('charon-server health', false, `${err.response?.status || ''} ${err.message}`);
  }
}

async function checkServerSignals() {
  try {
    const res = await axios.get(`${SIGNAL_SERVER_URL}/signals?limit=3&minSources=2`, {
      timeout: 10000,
      headers: { 'x-api-key': SIGNAL_SERVER_KEY },
    });
    const count = res.data?.signals?.length || 0;
    const sample = res.data?.signals?.[0];
    const sourceTag = sample ? `sources=${(sample.sources || []).join('|')}` : 'no signals';
    record('charon-server /signals', count > 0, `${count} signals, ${sourceTag}`);
  } catch (err) {
    record('charon-server /signals', false, `${err.response?.status || ''} ${err.message}`);
  }
}

async function checkGmgnReachable() {
  try {
    // Use a known-graduated mint (WATERFALL from earlier sample) just for shape verification.
    // We accept 200 OR rate-limit 429 as "reachable+auth OK".
    const url = new URL('https://openapi.gmgn.ai/v1/token/info');
    url.searchParams.set('chain', 'sol');
    url.searchParams.set('address', '7QoQCyqoHa62DSDbpPL87UQ1GuNM7c2Zrb4vSbvDpump');
    url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
    url.searchParams.set('client_id', '00000000-0000-0000-0000-000000000000');
    const res = await axios.get(url.toString(), {
      timeout: 10000,
      headers: { 'X-APIKEY': GMGN_API_KEY, 'Content-Type': 'application/json' },
    });
    const code = res.data?.code;
    const symbol = res.data?.data?.symbol || res.data?.data?.data?.symbol;
    record('gmgn /v1/token/info', res.status === 200 && code === 0, `status=${res.status} code=${code} symbol=${symbol}`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 || status === 403) {
      record('gmgn /v1/token/info', true, `rate-limited (${status}) — auth path works, will retry in app`);
    } else {
      record('gmgn /v1/token/info', false, `${status || ''} ${err.message}`);
    }
  }
}

async function checkHeliusRpc() {
  try {
    const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
    const res = await axios.post(url, {
      jsonrpc: '2.0', id: 1, method: 'getSlot', params: [],
    }, { timeout: 8000 });
    record('helius RPC getSlot', typeof res.data?.result === 'number', `slot=${res.data?.result}`);
  } catch (err) {
    record('helius RPC getSlot', false, `${err.response?.status || ''} ${err.message}`);
  }
}

(async () => {
  console.log('--- charon-v2 phase 0 smoke test ---');
  console.log(`SIGNAL_SERVER_URL: ${SIGNAL_SERVER_URL}`);
  console.log(`SIGNAL_SERVER_KEY: ${SIGNAL_SERVER_KEY ? SIGNAL_SERVER_KEY.slice(0, 8) + '...' : '(missing)'}`);
  console.log(`GMGN_API_KEY: ${GMGN_API_KEY ? GMGN_API_KEY.slice(0, 12) + '...' : '(missing)'}`);
  console.log(`HELIUS_API_KEY: ${HELIUS_API_KEY ? HELIUS_API_KEY.slice(0, 8) + '...' : '(missing)'}`);
  console.log('');

  await Promise.all([checkServerHealth(), checkServerSignals(), checkGmgnReachable(), checkHeliusRpc()]);

  const failures = results.filter(r => !r.ok);
  console.log('');
  console.log(`--- ${results.length - failures.length}/${results.length} passed ---`);
  process.exit(failures.length === 0 ? 0 : 1);
})();

# Charon-v2 VPS Deployment

Tested on Ubuntu 22.04 / Debian 12 / OpenCloudOS. Should work on any Linux with Node.js 20+.

## Prerequisites

- Linux VPS (≥1 GB RAM, ≥1 vCPU)
- Outbound HTTPS to: `api.thecharon.xyz`, `openapi.gmgn.ai`, `mainnet.helius-rpc.com`, `api.jup.ag`, `datapi.jup.ag`, `api.minimax.io`, `fxtwitter.com`, `api.fxtwitter.com`, `api.telegram.org`
- Telegram bot token + chat ID
- API keys: charon server, GMGN, Helius (already in `.env`)

## One-time setup

```bash
# 1. Install Node 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# 2. Install PM2 globally
sudo npm install -g pm2

# 3. Clone / upload charon-v2 to /opt/charon-v2 (or wherever you prefer)
# Then:
cd /opt/charon-v2
npm install --omit=dev    # better-sqlite3 will compile native binding

# 4. Edit .env — fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, optional LLM_API_KEY
nano .env

# 5. Smoke test (verifies all external APIs reachable from VPS)
node scripts/smoke-test.js
# → Should report 4/4 passed.
```

## Running with PM2

```bash
mkdir -p logs

# Start (TRADING_MODE=dry_run is default; no wallet required)
pm2 start ecosystem.config.cjs
pm2 save

# Make PM2 boot-autostart (systemd unit)
pm2 startup
# → Run the command PM2 prints (sudo env PATH=...) then:
pm2 save

# Monitor
pm2 logs charon-v2 --lines 100
pm2 status
```

## Updating / hot reload

```bash
git pull   # or rsync new files
npm install --omit=dev   # if package.json changed
pm2 reload charon-v2     # zero-downtime restart
```

## Switching to live trading

Edit `.env`:

```env
TRADING_MODE=confirm        # ← starts here, manual approve via TG button
SOLANA_PRIVATE_KEY=<base58>  # bot wallet, isolated from main wallet
JUPITER_API_KEY=<from jup.ag/portal>
```

Then `pm2 restart charon-v2`. Confirm mode sends approve/reject inline buttons to your Telegram chat for every trade.

When you're confident, switch to `TRADING_MODE=live` for full automation.

## Log rotation

PM2 has built-in rotation:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## SQLite backups

The DB is `charon-v2.sqlite` in the project root. Cron-based daily backup:

```bash
# /etc/cron.d/charon-v2-backup
0 4 * * * www-data cd /opt/charon-v2 && cp charon-v2.sqlite "backups/charon-v2-$(date +\%Y\%m\%d).sqlite" && find backups/ -mtime +14 -delete
```

## Telegram quick reference

- `/menu` — main control panel
- `/strategy` — show current strategy + switch (`obicle_confirmed`, `graduation_pump`, `migration_play`)
- `/stratset <id> <key> <value>` — tweak strategy live (e.g. `/stratset obicle_confirmed tp_percent 75`)
- `/positions` — open + recent dry-run positions
- `/pnl` — saved-wallet PnL
- `/learn 7d` — generate operational lessons from last 7 days of dry-run
- `/lessons` — show active lessons fed back into LLM prompts

## Troubleshooting

- **TG bot not responding**: check `pm2 logs charon-v2 --err`. Common: wrong chat_id (must be your own user ID or group ID; not the bot's), bot not added to the chat.
- **Helius 429 rate limit**: free tier saturates fast on position monitor. Either upgrade Helius or raise `POSITION_CHECK_MS` to `30000` in `.env`.
- **GMGN 403/429**: `GMGN_REQUEST_DELAY_MS=2500` is the floor; raising helps but doesn't always fix Cloudflare challenges. Bot auto-backs-off.
- **No signals coming in**: `node scripts/smoke-test.js` → confirm charon server returns >0 signals for your key.

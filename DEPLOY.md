# Deploy — Apex on VPS (Tencent OpenCloudOS 9.4)

## Build the deploy zip (Windows)

From `c:\Project\Apex\apex`:

```cmd
:: 1. Pre-flight checks
npm install
npm run check
npm run smoke

:: 2. Build the zip (no node_modules, no .env, no *.sqlite, no logs)
powershell -Command "Compress-Archive -Path index.js,package.json,package-lock.json,ecosystem.config.cjs,.env.example,.gitignore,README.md,DEPLOY.md,CHANGELOG.md,scripts,src,specs -DestinationPath ..\apex-deploy.zip -Force"
```

Verify the zip — it MUST NOT contain any of:

- `node_modules/`
- `.env`
- `*.sqlite*`
- `logs/`
- `.vscode/` / `.idea/`

## VPS bootstrap (run as `apex` user)

```bash
# 1. Stop charon-v2 only after acceptance — for now they coexist.
mkdir -p /home/apex/apex
cd /home/apex/apex

# 2. Upload + extract
unzip /tmp/apex-deploy.zip -d /home/apex/apex
cp .env.example .env
nano .env

# 3. Linux-native node_modules (NEVER copy from Windows)
rm -rf node_modules
npm install --omit=dev

# 4. Smoke check on Linux box
npm run check
node scripts/smoke-test.js

# 5. PM2
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
# Run the sudo command pm2 startup prints to enable boot autostart.

# 6. Verify
pm2 list                       # 'apex' should be 'online'
pm2 logs apex --lines 50       # expect [bot] Apex v3.0.0 started
```

## .env essentials

| Key | Notes |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot |
| `TELEGRAM_CHAT_ID`   | Operator chat (only this chat is authorized) |
| `TELEGRAM_TOPIC_ID`  | Optional supergroup topic |
| `SIGNAL_SERVER_URL`  | `https://api.thecharon.xyz/api` |
| `SIGNAL_SERVER_KEY`  | Charon API key |
| `HELIUS_API_KEY`     | Used for SPL mint authority + RPC |
| `GMGN_API_KEY`       | Token info enrichment (price, mcap, fees) |
| `JUPITER_API_KEY`    | Required for live mode |
| `SOLANA_PRIVATE_KEY` | Required for live mode (base58 or `[…]` JSON array) |
| `LLM_API_KEY`        | OpenAI-compatible endpoint |
| `TRADING_MODE`       | `dry_run` (default) / `confirm` / `live` |

## Backup + log rotation

```bash
# /etc/cron.d/apex-backup
0 3 * * * apex /usr/bin/sqlite3 /home/apex/apex/apex.sqlite ".backup /home/apex/apex/backups/apex-$(date +\%F).sqlite" && find /home/apex/apex/backups -name 'apex-*.sqlite' -mtime +14 -delete
```

```bash
# Already installed globally on this VPS
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```

## Coexistence with charon-v2

During the cutover (~7 days), both bots run side-by-side under PM2:

```
pm2 list
# 0 │ charon │ online │ /home/apex/charon
# 1 │ apex   │ online │ /home/apex/apex
```

Use distinct `.env` files (different DB filename, different chat / topic ID) so the
notifications don't intermix.

## Rollback

```bash
pm2 stop apex
pm2 delete apex
# charon-v2 untouched
```

DB and code stay on disk for forensics; archive after 30 days.

## Update workflow

```bash
# After re-uploading new apex-deploy.zip:
cd /home/apex/apex
unzip -o /tmp/apex-deploy.zip
rm -rf node_modules
npm install --omit=dev
pm2 reload apex
```

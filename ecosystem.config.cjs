// PM2 ecosystem for Apex VPS deployment
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup           # follow output to enable boot autostart
//   pm2 logs apex
//   pm2 reload apex       # zero-downtime reload after .env or code update

module.exports = {
  apps: [{
    name: 'apex',
    script: 'index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
    },
    min_uptime: '30s',
    max_restarts: 10,
    restart_delay: 5000,
    error_file: './logs/apex.error.log',
    out_file: './logs/apex.out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    kill_timeout: 5000,
    listen_timeout: 8000,
    shutdown_with_message: true,
  }],
};

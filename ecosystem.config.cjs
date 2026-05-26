// PM2 ecosystem for charon-v2 VPS deployment
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # follow output to enable boot autostart
//   pm2 logs charon-v2
//   pm2 reload charon-v2   # zero-downtime reload after .env or code update

module.exports = {
  apps: [{
    name: 'charon-v2',
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
    // Restart policy
    min_uptime: '30s',
    max_restarts: 10,
    restart_delay: 5000,
    // Logs
    error_file: './logs/charon-v2.error.log',
    out_file: './logs/charon-v2.out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // Graceful shutdown
    kill_timeout: 5000,
    listen_timeout: 8000,
    shutdown_with_message: true,
  }],
};

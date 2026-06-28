/**
 * PM2 process config for the WeRgame backend.
 *
 * Usage on the server (from the backend/ folder):
 *   npm install -g pm2          # once
 *   pm2 start ecosystem.config.js
 *   pm2 save                    # persist across reboots
 *   pm2 startup                 # print the command to enable boot startup, then run it
 *
 * Handy commands:
 *   pm2 status                  # see if it's online / how many restarts
 *   pm2 logs wergame-backend    # tail logs
 *   pm2 restart wergame-backend # manual restart after deploy
 */
module.exports = {
  apps: [
    {
      name: 'wergame-backend',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      // Auto-restart on crash, with backoff so a crash loop doesn't hammer the CPU.
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      // Restart if memory grows beyond this (guards against slow leaks).
      max_memory_restart: '500M',
      // Do NOT watch files in production (would restart on every log write).
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

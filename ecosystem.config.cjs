module.exports = {
  apps: [
    {
      name: 'hunter-backend',
      cwd: '/opt/hunter/backend',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      exp_backoff_restart_delay: 5000,
      min_uptime: '10s',
      restart_delay: 2000,
      max_memory_restart: '350M',
      kill_timeout: 5000,
      listen_timeout: 8000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

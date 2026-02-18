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
      min_uptime: '10s',
      restart_delay: 2000,
      kill_timeout: 5000,
      listen_timeout: 8000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

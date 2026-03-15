module.exports = {
  apps: [
    {
      name: "gateway",
      script: "server.js",
      cwd: "/var/www/eulenai",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "bildungsplan",
      script: "server.js",
      cwd: "/var/www/eulenai/bildungsplan",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "leichte-sprache",
      script: "server.js",
      cwd: "/var/www/eulenai/leichte-sprache",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "unterrichtsplanung",
      script: "server.js",
      cwd: "/var/www/eulenai/unterrichtsplanung",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

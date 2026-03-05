module.exports = {
  apps: [
    {
      name: "bildungsplan_assistent",
      script: "server.js",
      cwd: "/var/www/bildungsplan",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

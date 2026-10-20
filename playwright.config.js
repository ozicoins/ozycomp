// Playwright config for the Electron e2e tests. The unit suite uses node:test
// (npm test); these boot the real app and need a display + electron binary.
const { defineConfig } = require('playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.e2e.js',
  timeout: 90_000,
  retries: 0,
  workers: 1,                 // one Electron instance at a time
  reporter: [['list']],
});

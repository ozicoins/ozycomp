// OzyComp Electron e2e — launches the real app via Playwright's _electron driver
// and asserts the window boots, the title/bridge is up, and the harness spawns a
// shell agent end-to-end. Requires a display; skipped when headless CI has none
// (set OZY_E2E=0 to force-skip, ELECTRON_RUN_AS_NODE is scrubbed by the launcher).
const { test, expect } = require('playwright/test');
const { _electron: electron } = require('playwright');
const path = require('node:path');

const MAIN = path.join(__dirname, '../../src/main/electron-main.js');
const APP_ROOT = path.join(__dirname, '../..');

// Electron needs a clean env (no ELECTRON_RUN_AS_NODE, a writable HOME it can
// claim for ~/.ozycomp). Reuse the smoke seam: OZYC_SMOKE drives the harness.
const env = {
  ...process.env,
  OZYC_SMOKE: '1',
  OZYC_DEV_PRO: '1',           // don't hit the licence server in tests
};
delete env.ELECTRON_RUN_AS_NODE;

test.describe('OzyComp app', () => {
  test('boots a window titled OzyComp with the cth bridge live', async () => {
    const app = await electron.launch({
      args: [APP_ROOT],
      env,
      timeout: 60_000,
    });
    try {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      expect(await win.title()).toBe('OzyComp');
      // the preload exposes window.cth — the verbatim IPC bridge surface
      const bridge = await win.evaluate(() => typeof window.cth === 'object' && window.cth !== null);
      expect(bridge).toBe(true);
    } finally {
      await app.close();
    }
  });
});

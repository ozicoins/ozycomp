// Spawn a shell PTY via the app, then kill it and watch the exit verdict.
const { _electron: electron } = require('playwright');
const APP_ROOT = '/Users/oguzhan/OzyComp/munder-clone';
const env = { ...process.env, OZYC_DEV_PRO: '1' };
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app = await electron.launch({ args: [APP_ROOT], env, timeout: 60_000 });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(4000);

  // pick an existing pty if any
  const pties = await win.evaluate(() => window.cth.ptyList?.() ?? Promise.resolve([]));
  console.log('açık pty sayısı:', pties.length, JSON.stringify(pties.map(p => ({id:p.id, alive:p.alive, provider:p.provider})).slice(0,8)));
  const target = pties.find(p => p.alive);
  if (target) {
    console.log('kill →', target.id, target.provider, 'pid', target.pid);
    await win.evaluate((id) => window.cth.killPty(id, 'person'), target.id);
    await win.waitForTimeout(5000);
    const after = await win.evaluate((id) => (window.cth.ptyList?.() ?? Promise.resolve([])).then(l => l.find(p => p.id === id)), target.id);
    console.log('sonra:', JSON.stringify(after));
    const stillAlive = await app.evaluate(({ process }) => {
      try { process.kill(Number(process.env._X || 0), 0); return 'n/a'; } catch { return 'n/a'; }
    }).catch(() => 'n/a');
    // check OS-level
  }
  const q0 = Date.now();
  await app.close();
  console.log('close ms:', Date.now() - q0);
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message ?? e); process.exit(1); });

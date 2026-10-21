// Packaged-app verification: office skin, roster merge (316 agents), quit speed.
const { _electron: electron } = require('playwright');
const APP_ROOT = '/Users/oguzhan/OzyComp/munder-clone';
const env = { ...process.env, OZYC_DEV_PRO: '1' };
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app = await electron.launch({ args: [APP_ROOT], env, timeout: 60_000 });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(6000);

  const res = await win.evaluate(async () => {
    const out = { text: document.body.innerText.slice(0, 4000) };
    try { out.reg = await window.cth.hiveRegistry(); } catch (e) { out.regErr = String(e); }
    try { out.dir = await window.cth.hiveAgentDirectory(); } catch (e) { out.dirErr = String(e); }
    try { out.skin = localStorage.getItem('cth.skin'); } catch {}
    out.hasCanvas = !!document.querySelector('canvas');
    out.hasSvg = !!document.querySelector('svg');
    return out;
  });

  const agents = res.dir?.agents ?? [];
  const live = agents.filter(a => !a.archived);
  const archived = agents.filter(a => a.archived);
  console.log('=== DOĞRULAMA ===');
  console.log('skin:', res.skin, '| canvas:', res.hasCanvas, '| svg:', res.hasSvg);
  console.log('directory agents:', agents.length, '| live:', live.length, '| archived:', archived.length);
  console.log('registry godId:', res.reg?.godId, '| god archived:', res.reg?.agents?.[res.reg?.godId]?.archived);
  console.log('gate text present:', /oturum aç|sign in|lisans|license|kayıt/i.test(res.text) ? 'EVET!' : 'hayır');
  console.log('metin örnek:', JSON.stringify(res.text.slice(0, 800)));

  const q0 = Date.now();
  await app.close();
  console.log('=== app.close() süresi:', Date.now() - q0, 'ms ===');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message ?? e); process.exit(1); });

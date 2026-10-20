'use strict';
/**
 * IPC registry — every ported group module exports `register(ctx)` where ctx is
 * the verbatim dep bag wired in electron-main. We require each file lazily so a
 * missing optional subsystem (teams, realtime…) logs and skips instead of
 * crashing boot.
 */
const fs = require('node:fs');
const path = require('node:path');
function registerAll(ctx, log = console.error) {
  const dir = __dirname;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.js') || f === 'index.js') continue;
    const name = f.replace(/\.js$/, '');
    try {
      const mod = require(path.join(dir, f));
      if (typeof mod.register === 'function') mod.register(ctx);
      else log(`[ipc] ${name}: no register export, skipped`);
    } catch (e) {
      log(`[ipc] ${name}: register failed — ${e?.message ?? e}`);
    }
  }
}
module.exports = { registerAll };

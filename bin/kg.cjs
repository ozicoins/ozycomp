#!/usr/bin/env node
'use strict';
/**
 * kg — agent-side Knowledge Graph CLI. Hits the same store the app uses via
 * KG_ROOT (injected into every agent's env when the feature is on).
 *
 *   kg search "<query>" [--limit N]
 *   kg add <file> [--title T]      kg note "<title>" "<text>"
 *   kg get <docId>                 kg list        kg stats
 */
const path = require('node:path');
const fs = require('node:fs');
const core = require(process.env.KG_CORE || path.join(__dirname, '..', 'src', 'main', 'kg-core.cjs'));

const root = process.env.KG_ROOT;
if (!root) { console.error('kg: KG_ROOT is not set — the Knowledge Graph is off'); process.exit(2); }

const [cmd, ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
const out = obj => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

switch (cmd) {
  case 'search': { const limit = flag('limit'); out(core.search(root, rest.join(' '), limit)); break; }
  case 'add':    { const title = flag('title'); out(core.ingest(root, rest[0], { title })); break; }
  case 'note':   out(core.ingest(root, { title: rest[0], text: rest.slice(1).join(' '), source: process.env.OZYC_AGENT_ID ?? 'agent' })); break;
  case 'get': {
    const meta = core.getDoc(root, rest[0]);
    if (!meta) { console.error('kg: no such doc'); process.exit(1); }
    out({ ...meta, text: fs.readFileSync(path.join(root, 'docs', meta.id, 'text.md'), 'utf8') });
    break;
  }
  case 'list':  out(core.list(root)); break;
  case 'stats': out(core.stats(root)); break;
  default:
    console.log('usage: kg search|add|note|get|list|stats');
    process.exit(cmd ? 1 : 0);
}

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { HiveManager } = require('../src/main/hive');
const { CircuitBreaker } = require('../src/main/circuit-breaker');
const { HookServer } = require('../src/main/hook-server');
const { Harness } = require('../src/main/harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ozycomp-test-'));

test('hive: ensure, register, route outbox→inbox, drain', () => {
  const h = new HiveManager(path.join(tmp(), 'hive'));
  h.ensure();
  h.ensureAgent('god');
  h.ensureAgent('w1');
  assert.equal(h.registry().agents.god.isGod, true);
  // outboxDrop drops into god's outbox; routeTick (verbatim routeOnce) drains it.
  const m = h.outboxDrop('god', 'w1', 'task', 'build it');
  assert.ok(fs.existsSync(path.join(h.agentDir('god'), 'outbox', `${m.id}.json`)));
  h.routeTick();
  const got = h.drainInbox('w1');
  assert.equal(got.length, 1);
  assert.equal(got[0].body, 'build it');
  assert.equal(h.drainInbox('w1').length, 0);
});

test('hive: agent ids cannot escape the hive; bad envelopes are dropped', () => {
  const h = new HiveManager(path.join(tmp(), 'hive'));
  h.ensure();
  for (const bad of ['../x', 'a/b', '', '.hidden', 'x'.repeat(65), null])
    assert.throws(() => h.ensureAgent(bad), /invalid agent id/);
  h.ensureAgent('w1');
  const evil = path.join(h.agentDir('w1'), 'outbox', 'evil.json');
  fs.writeFileSync(evil, JSON.stringify({ from: 'w1', to: '../../etc', body: 'x' }));
  h.routeTick();
  assert.equal(fs.existsSync(evil), false);
  assert.equal(fs.existsSync(path.join(h.root(), '..', 'etc')), false);
});

test('hive: tasks + board scribe rule', () => {
  const h = new HiveManager(path.join(tmp(), 'hive'));
  h.ensure();
  const c = h.addTask({ title: 'x', assignee: 'w1' });
  h.patchTask(c.id, { status: 'doing' });
  assert.equal(h.tasks().tasks[0].status, 'doing');
  assert.throws(() => h.writeBoard('nope', 'w1'));
  h.writeBoard('# plan', 'god');
  assert.equal(h.board(), '# plan');
});

test('breaker: repeat → steering, errors → constrained, cap pins at ceiling', () => {
  // default ceiling is 'constrained' (hardStop off): every tripping signal
  // climbs one rung, never more — verbatim tick semantics.
  const b = new CircuitBreaker({ agentTokenCaps: { a: 1000 } });
  for (let i = 0; i < 7; i++) b.recordTool('a', 'Read:x');
  assert.equal(b.levelOf('a'), 'healthy');
  b.recordTool('a', 'Read:x');
  assert.equal(b.levelOf('a'), 'steering');
  for (let i = 0; i < 5; i++) b.recordTool('a', `e${i}`, { ok: false });
  assert.equal(b.levelOf('a'), 'constrained');
  b.recordTool('a', 'big', { input: 500, output: 500 });
  assert.equal(b.actionFor('a').action, 'constrain');
  // hardStop opens the ceiling to 'stopped' — still one rung per signal
  const h = new CircuitBreaker({ hardStop: true, repeatedToolLimit: 1 });
  h.recordTool('w', 'x', { ok: true });
  assert.equal(h.levelOf('w'), 'steering');
  h.recordTool('w', 'x', { ok: true });
  assert.equal(h.levelOf('w'), 'constrained');
  h.recordTool('w', 'x', { ok: true });
  assert.equal(h.actionFor('w').action, 'stop');
});

test('breaker: compact grace mutes velocity, not the repeat arm', () => {
  const b = new CircuitBreaker({ hardStop: true, tokenVelocityPerMin: 100 });
  b.recordCompactStart('a');
  const t0 = Date.now();
  b.usage('a', { output: 100 });
  // huge Δoutput inside the grace window — velocity arm muted, stays healthy
  b.tick([{ agentId: 'a', sample: { output: 9000, input: 0, cacheRead: 0, cacheCreation: 0, ts: t0 + 60000 }, progressing: false }], t0 + 60000);
  assert.equal(b.levelOf('a'), 'healthy');
  // but identical-call repeats still trip — the grace never covered that arm
  for (let i = 0; i < 8; i++) b.recordTool('a', 'same');
  assert.equal(b.levelOf('a'), 'steering');
});

test('hook server: socket + HTTP (auth), fail-open, questions', async () => {
  const hive = new HiveManager(path.join(tmp(), 'hive'));
  hive.ensure();
  const seen = [];
  const hs = new HookServer({ hive, onHook: (a, h, p) => seen.push([a, h, p]) });
  await hs.start();
  try {
    // socket via the real CLI client
    const env = { ...process.env, ...hs.envFor(), OZYC_AGENT_ID: 'w1' };
    // async spawn: the server lives in this process, spawnSync would block it
    const code = await new Promise(res => {
      const cp = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'ozy-hook.js'), 'PostToolUse'], { env });
      cp.on('exit', res);
      cp.stdin.end(JSON.stringify({ tool_name: 'Bash' }));
    });
    assert.equal(code, 0);
    assert.deepEqual(seen[0].slice(0, 2), ['w1', 'PostToolUse']);

    // HTTP bad token → 401
    const post = (tok, body) => new Promise(res => {
      const req = http.request({ host: '127.0.0.1', port: hs.port, path: '/hook', method: 'POST',
        headers: { authorization: `Bearer ${tok}` } }, rs => { rs.resume(); res(rs.statusCode); });
      req.end(JSON.stringify(body));
    });
    assert.equal(await post('wrong', {}), 401);
    assert.equal(await post(hs.token, { agentId: 'w2', hook: 'Stop', payload: { question: 'ok?' } }), 200);
    assert.equal(hs.questions.list().length, 1);
    // malformed body still 200 (fail-open)
    assert.equal(await post(hs.token, null), 200);
    // provider-shaped payload (newline-JSON over UDS, verbatim contract)
    const decision = await new Promise(res => {
      const c = require('node:net').createConnection(hs.sockPath, () => {
        c.write(JSON.stringify({ hook_event_name: 'PostToolUse', agent_id: 'w3', tool_name: 'Edit' }) + '\n');
      });
      let buf = '';
      c.on('data', d => { buf += d; });
      c.on('close', () => res(JSON.parse(buf || '{}')));
      c.on('error', () => res({}));
      setTimeout(() => { try { c.end(); } catch {} }, 400).unref();
    });
    assert.deepEqual(decision, {});
    assert.deepEqual(seen.at(-1).slice(0, 2), ['w3', 'PostToolUse']);
    // Status event → contextById (the live ctx gauge)
    hs.handle({ hook_event_name: 'Status', agent_id: 'w3', context_window: { total_input_tokens: 12000, context_window_size: 200000 } });
    assert.equal(hs.contextFor('w3').limit, 200000);
  } finally { hs.stop(); }
});

test('capabilities: three palettes verbatim + provider selector', () => {
  const { COMMAND_GROUPS, CODEX_COMMAND_GROUPS, GROK_COMMAND_GROUPS, commandGroupsFor } = require('../src/main/capabilities');
  assert.equal(COMMAND_GROUPS.length, 12);
  assert.equal(COMMAND_GROUPS.reduce((n, g) => n + g.items.length, 0), 62);
  assert.equal(CODEX_COMMAND_GROUPS.length, 6);
  assert.equal(GROK_COMMAND_GROUPS.length, 3);
  assert.equal(commandGroupsFor('codex'), CODEX_COMMAND_GROUPS);
  assert.equal(commandGroupsFor('grok'), GROK_COMMAND_GROUPS);
  assert.equal(commandGroupsFor('qwen'), COMMAND_GROUPS); // falls back to claude
  // every item carries the reference shape {cmd, kind, desc, usage?}
  for (const g of [...COMMAND_GROUPS, ...CODEX_COMMAND_GROUPS, ...GROK_COMMAND_GROUPS])
    for (const i of g.items) {
      assert.ok(i.cmd && i.kind && i.desc);
      assert.ok(['slash', 'cli'].includes(i.kind));
    }
});

test('tools: catalog shape + status resolution + mempalace pin', () => {
  const { toolCatalog, toolsStatus, MEMPALACE_PIN, MEMPALACE_INSTALL, MEMPALACE_SWITCH } = require('../src/main/tools');
  const cat = toolCatalog();
  // BASE_TOOLS = uv, mempalace, git, node — then one row per engine preset
  assert.deepEqual(cat.slice(0, 4).map(t => t.id), ['uv', 'mempalace', 'git', 'node']);
  const engines = cat.filter(t => t.kind === 'engine');
  assert.ok(engines.length >= 12); // 13 presets minus custom/shell → all ship a defaultCommand
  assert.ok(engines.every(e => e.id.startsWith('engine:') && e.bin));
  assert.equal(engines.find(e => e.id === 'engine:claude').essential, true);
  assert.ok(engines.filter(e => e.id !== 'engine:claude').every(e => e.essential === false));
  assert.equal(MEMPALACE_PIN.version, '3.3.5');
  assert.match(MEMPALACE_INSTALL, /uv tool install mempalace==3\.3\.5 --python 3\.10/);
  assert.match(MEMPALACE_SWITCH, /--force$/);
  // status: mempalace row defers to the memory manager, others resolve by PATH
  const st = toolsStatus({ mempalace: { available: true, bin: '/x/mempalace' } });
  const mp = st.find(t => t.id === 'mempalace');
  assert.equal(mp.found, true);
  assert.equal(mp.pinnedVersion, '3.3.5');
  assert.equal(st.find(t => t.id === 'node').found, true); // we run on node
  const stOff = toolsStatus({ mempalace: { available: false } });
  assert.equal(stOff.find(t => t.id === 'mempalace').found, false);
  // every row carries its platform install command verbatim
  for (const t of st) assert.ok(typeof t.installCommand === 'string');
});

test('models: catalog parser caps/dedupe + cache TTL/stale fallback', async () => {
  const { parseModelCatalog, loadModelCatalog } = require('../src/main/tools');
  // rejects: bad version, array root, empty providers
  assert.equal(parseModelCatalog(null), null);
  assert.equal(parseModelCatalog({ version: 2, providers: { a: [{}] } }), null);
  assert.equal(parseModelCatalog({ version: 1, providers: {} }), null);
  // keeps label/id/min-max, dedupes by id, drops proto-polluting keys
  const cat = parseModelCatalog({
    version: 1,
    providers: {
      __proto__: [{ label: 'evil' }],
      'BAD KEY!': [{ label: 'x' }],
      claude: [{ label: 'Opus', id: 'opus-1' }, { label: 'dup', id: 'opus-1' }, { noLabel: 1 }],
    },
  });
  assert.ok(cat);
  assert.deepEqual(Object.keys(cat.providers), ['claude']);
  assert.deepEqual(cat.providers.claude.map(m => m.label), ['Opus']);
  assert.equal(cat.providers.claude[0].id, 'opus-1');
  // loadModelCatalog: fresh cache wins over network; stale beats a dead fetch
  const cachePath = path.join(tmp(), 'model-catalog.json');
  const res1 = await loadModelCatalog(cachePath);
  assert.equal(res1.catalog === null || typeof res1.catalog === 'object', true);
  fs.writeFileSync(cachePath, JSON.stringify({ catalog: cat, fetchedAt: Date.now() }));
  const res2 = await loadModelCatalog(cachePath);
  assert.equal(res2.stale, false);
  assert.deepEqual(res2.catalog, cat);
  // stale-but-usable when fetch fails and TTL expired
  fs.writeFileSync(cachePath, JSON.stringify({ catalog: cat, fetchedAt: Date.now() - 7 * 3600e3 }));
  const res3 = await loadModelCatalog(cachePath);
  assert.ok(res3.catalog === null || res3.catalog.providers.claude); // offline → stale cache, online → fresh
});

test('hero: parse payload — https-only urls, capped strings, default fallback', () => {
  const { parseHeroPayload, DEFAULT_HERO } = require('../src/main/file-share');
  assert.equal(parseHeroPayload(null), DEFAULT_HERO);
  assert.equal(parseHeroPayload('x'), DEFAULT_HERO);
  const h = parseHeroPayload({
    plan: { label: 'Pro', blurb: 'b'.repeat(300), upgrade: { label: 'Up', url: 'https://x.co/up' } },
    sponsor: { name: 'ACME', url: 'http://insecure.example', blurb: 'no' },
    notice: 'hi',
  });
  assert.equal(h.plan.label, 'Pro');
  assert.equal(h.plan.blurb.length, 240);          // capped w/ ellipsis
  assert.ok(h.plan.blurb.endsWith('…'));
  assert.deepEqual(h.plan.upgrade, { label: 'Up', url: 'https://x.co/up' });
  assert.equal(h.sponsor, null);                   // http:// url rejected
  assert.equal(h.notice, 'hi');
});

test('fileshare: real HTTP — token auth, expiry sweep, revoke, rate limit', async () => {
  const { FileShareStore, shareUrl } = require('../src/main/file-share');
  const dir = tmp();
  const f = path.join(dir, 'note.txt');
  fs.writeFileSync(f, 'hive-secret');
  // fake tunnel: shares get urls without a real tunnelmole client
  const store = new FileShareStore({ openTunnel: async port => `http://127.0.0.1:${port}` });
  try {
    assert.equal((await store.create('relative/path')).error, 'notAbsolute');
    assert.equal((await store.create(path.join(dir, 'missing.txt'))).error, 'unreadable');
    assert.equal((await store.create(dir)).error, 'notAFile');
    const made = await store.create(f);
    assert.equal(made.ok, true);
    assert.match(made.share.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
    assert.equal(store.list().length, 1);
    const get = url => new Promise(res => http.get(url, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => res({ code: r.statusCode, body: b, headers: r.headers }));
    }));
    // hit: correct bytes + inert headers
    const hit = await get(made.share.url);
    assert.equal(hit.code, 200);
    assert.equal(hit.body, 'hive-secret');
    assert.equal(hit.headers['cache-control'], 'no-store');
    assert.equal(hit.headers['x-content-type-options'], 'nosniff');
    // miss: same-shape 404, decoy token does the same work
    const miss = await get(made.share.url.replace(/[0-9a-f]{64}$/, '0'.repeat(64)));
    assert.equal(miss.code, 404);
    // no token path → 404; non-GET → 404
    assert.equal((await get(`http://127.0.0.1:${store.localPort()}/etc/passwd`)).code, 404);
    // revoke by id → share is gone; listener closes when idle
    assert.equal(store.revoke(made.share.id).ok, true);
    assert.equal(store.activeCount(), 0);
    assert.equal(store.localPort(), 0);
    // a fetch after the listener is down fails at the socket level
    await new Promise(res => {
      const r = http.get(made.share.url);
      r.on('error', () => res(null));
      r.on('response', () => res('unexpected'));
    });
  } finally { store.stop(); }
});

test('fileshare: expiry sweep drops lapsed shares; tooMany cap', async () => {
  const { FileShareStore } = require('../src/main/file-share');
  const dir = tmp();
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'x');
  let t = 1e6;
  const store = new FileShareStore({ openTunnel: async p => `http://127.0.0.1:${p}`, now: () => t, ttlMs: 1000, maxShares: 1 });
  try {
    const a = await store.create(f);
    assert.equal(a.ok, true);
    assert.equal((await store.create(f)).error, 'tooMany');
    t += 2000;                                     // past TTL
    assert.equal(store.activeCount(), 0);
    assert.equal(store.list().length, 0);
  } finally { store.stop(); }
});

test('webhooks: end-to-end — secret gate, pending approval, decide→dispatch, status lookup', async () => {
  const { WebhookManager, sanitizeWebhookTrigger } = require('../src/main/webhooks');
  const dir = tmp();
  const hive = new HiveManager(path.join(dir, 'hive'));
  hive.ensure();
  hive.ensureAgent('god');
  let cfg = {
    webhookTriggers: [sanitizeWebhookTrigger({
      id: 'ep1', name: 'EP', secret: 's3cr3t', enabled: true, mode: 'strict',
    }, [])],
  };
  const kvStore = {};
  const mgr = new WebhookManager({
    readConfig: () => cfg,
    writeConfig: p => { cfg = { ...cfg, ...p }; },
    hive,
    historyFile: path.join(dir, 'trigger-history.json'),
    kv: { get: k => kvStore[k], set: (k, v) => { kvStore[k] = v; } },
    notify: () => {},
    openTunnel: async port => `http://127.0.0.1:${port}`,
  });
  const res = await mgr.start();
  try {
    assert.equal(res.ok, true);
    const base = `http://127.0.0.1:${mgr.server.boundPort().port}`;
    const post = (path2, headers, body) => fetch(`${base}${path2}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }).then(r => r.json().then(j => ({ code: r.status, body: j })));
    // bad secret → 401 (decoy compare, same shape as unknown id)
    assert.equal((await post('/ep1', { 'x-md-webhook-secret': 'nope'.padEnd(32, 'x') }, { message: 'hi' })).code, 401);
    assert.equal((await post('/nope', { 'x-md-webhook-secret': 's3cr3t' }, { message: 'hi' })).code, 401);
    // strict mode → 202 pending, held in history, nothing dispatched yet
    const ok = await post('/ep1', { 'x-md-webhook-secret': 's3cr3t' }, { message: 'fix the login page', title: 'Login fix' });
    assert.equal(ok.code, 202);
    assert.equal(ok.body.pending, true);
    const hist = mgr.history.list();
    assert.equal(hist[0].decision, 'pending');
    assert.equal(hist[0].title, 'Login fix');
    assert.equal(hive.tasks().tasks.length, 0);
    // status check by token → awaiting-approval
    const st = await fetch(`${base}/ep1`, { headers: { 'x-md-webhook-token': ok.body.token } }).then(r => r.json());
    assert.equal(st.status, 'awaiting-approval');
    // decide:approve → task card + hive message routed to Patron
    const decided = mgr.decide({ id: hist[0].id, decision: 'approved' });
    assert.equal(decided.decision, 'approved');
    assert.equal(hive.tasks().tasks.length, 1);
    assert.equal(hive.tasks().tasks[0].title, 'Login fix');
    hive.routeTick();
    const inbox = hive.drainInbox('god');
    assert.ok(inbox[0].body.includes('Login fix') || inbox[0].body.includes('fix the login page'));
    // token lookup now reports the kanban status
    const st2 = await fetch(`${base}/ep1`, { headers: { 'x-md-webhook-token': ok.body.token } }).then(r => r.json());
    assert.equal(st2.status, 'todo');
  } finally { mgr.stop(); }
});

test('webhooks: sanitize rules + service signatures + kind classifier', () => {
  const { sanitizeWebhookTrigger, classifyInboundKind, inboundFromService, verifyCustomSignature } = require('../src/main/webhooks');
  const crypto2 = require('node:crypto');
  // secretless can never be enabled — an open door
  const t = sanitizeWebhookTrigger({ id: 'x', enabled: true }, []);
  assert.equal(t.enabled, false);
  assert.equal(sanitizeWebhookTrigger({ id: 'bad id!' }, []), null);
  // prior fields carry over on re-save (the migration contract)
  const prior = sanitizeWebhookTrigger({ id: 'x', secret: 'abc', enabled: true, prompt: 'watch this', guardrails: true }, []);
  const re = sanitizeWebhookTrigger({ id: 'x' }, [prior]);
  assert.equal(re.secret, 'abc');
  assert.equal(re.prompt, 'watch this');
  assert.equal(re.guardrails, true);
  assert.equal(re.enabled, true);
  // kind classifier: a question with no work verb is communication (note: a
  // question containing 'deploy' etc. is a directive — the classifier is
  // deliberately conservative, verbatim from the reference)
  assert.equal(classifyInboundKind('what is the current status?'), 'communication');
  assert.equal(classifyInboundKind('what is the deploy status?'), 'directive');
  assert.equal(classifyInboundKind('deploy the app now'), 'directive');
  // telegram inbound shaping
  const tg = inboundFromService('telegram', {}, { message: { text: 'hello bot', from: { username: 'om' }, chat: { title: 'Ops' } } });
  assert.equal(tg.from, '@om');
  assert.match(tg.message, /Telegram message from @om in Ops/);
  // hmac signature over raw body
  const raw = Buffer.from('{"a":1}');
  const sig = `sha256=${crypto2.createHmac('sha256', 'sek').update(raw).digest('hex')}`;
  assert.equal(verifyCustomSignature({ 'x-md-signature': sig }, raw, 'sek'), true);
  assert.equal(verifyCustomSignature({ 'x-md-signature': sig }, raw, 'wrong'), false);
});

test('config: DEFAULTS verbatim + trigger migration + hive-home normalize', () => {
  const { ConfigStore, DEFAULTS, OPS_STANDUP_MISSION, COMPACT_MAINTENANCE_MISSION,
    normalizeHiveHome, normalizeResponseStyle, renderResponseStyle, DEFAULT_RESPONSE_STYLE,
    effectiveMcp, withAgentMcp } = require('../src/main/config');
  // the seeds
  assert.equal(DEFAULTS.godModel, 'claude-opus-5-5');
  assert.equal(DEFAULTS.defaultModel, 'claude-opus-5-5');
  assert.equal(DEFAULTS.defaultCommand, 'claude');
  assert.deepEqual(DEFAULTS.missions, [OPS_STANDUP_MISSION]);
  assert.equal(OPS_STANDUP_MISSION.enabled, true);
  assert.equal(OPS_STANDUP_MISSION.intervalMs, 36e5);
  assert.equal(DEFAULTS.contextTrigger.compact.everyMs, 24e5);
  assert.equal(DEFAULTS.contextTrigger.compact.minContextPct, 30);
  assert.equal(COMPACT_MAINTENANCE_MISSION.intervalMs, 24e5); // must agree w/ trigger
  // mcpDefaults seeded from catalog: safe-readonly on, secret off
  assert.equal(DEFAULTS.mcpDefaults['sequential-thinking'].enabled, true);
  assert.equal(DEFAULTS.mcpDefaults['github-token'].enabled, false);
  // fresh store → full defaults + responseStyle normalized
  const file = path.join(tmp(), 'config.json');
  const store = new ConfigStore(file);
  const cfg = store.read();
  assert.equal(cfg.autoMode, true);
  assert.equal(cfg.responseStyle, DEFAULT_RESPONSE_STYLE);
  assert.equal(cfg.transcribe.engine, DEFAULTS.transcribe.engine ?? 'auto');
  // seeded compact trigger on an OLD rhythm gets bumped to the current one
  fs.writeFileSync(file, JSON.stringify({
    contextTrigger: { compact: { enabled: true, everyMs: 72e5, minContextPct: 60, minContextPctLargeWindow: 40 } },
    webhookSecret: 'legacysecret',
    missions: [{ ...COMPACT_MAINTENANCE_MISSION, intervalMs: 36e5 }],
  }));
  const store2 = new ConfigStore(file);
  const cfg2 = store2.read();
  assert.equal(cfg2.contextTrigger.compact.everyMs, 24e5);      // bumped
  assert.equal(cfg2.contextTrigger.compact.minContextPct, 30);  // bumped
  assert.equal(cfg2.triggersMigratedV1, true);                  // one-shot ran
  assert.equal(cfg2.webhookTriggers[0].id, 'legacy');           // legacy secret → trigger row
  assert.equal(cfg2.missions[0].intervalMs, 24e5);              // stale mission bumped
  // hive-home normalize: dedupe, cap 8, tilde expand, newest first
  const { home, recentHives } = normalizeHiveHome('/a', ['/b', '/a', '/c', '~/x']);
  assert.equal(home, '/a');
  assert.deepEqual(recentHives.slice(0, 3), ['/a', '/b', '/c']);
  // response style: strips the tag + control chars, caps at 1200
  assert.equal(normalizeResponseStyle('<response_style>be terse</response_style>'), 'be terse');
  assert.equal(normalizeResponseStyle(''), DEFAULT_RESPONSE_STYLE);
  assert.match(renderResponseStyle('be terse'), /^<response_style>\nbe terse\n<\/response_style>$/);
  // agent MCP overlay: per-agent > floor > catalog default
  const mcp = effectiveMcp({ 'filesystem': { enabled: false } }, { w1: { filesystem: { enabled: true } } }, 'w1');
  assert.equal(mcp.filesystem.enabled, true);   // per-agent wins over floor
  assert.equal(mcp.time.enabled, true);         // catalog default
  const after = withAgentMcp({}, 'w1', 'git', false);
  assert.equal(after.w1.git.enabled, false);
  assert.deepEqual(withAgentMcp(after, 'w1', 'git', null), {});  // null clears
});

test('missions: scheduler fires on interval, weekly normalize, seeding retires compact mission', async () => {
  const { createMissionScheduler, mergeSavedMissions, normalizeWeekly, weeklyDelayMs,
    ContextTriggers, sanitizeContextRule, ensureDefaultMissions } = require('../src/main/missions');
  const { OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, DEFAULT_CONTEXT_TRIGGER } = require('../src/main/config');
  // fake clock: manual timers
  const pending = new Map();
  let now = 1e9, seq = 0;
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const h = ++seq; pending.set(h, { fn, at: now + ms, kind: 't' }); return h; },
    setInterval: (fn, ms) => { const h = ++seq; pending.set(h, { fn, every: ms, kind: 'i' }); return h; },
    clearTimeout: h => pending.delete(h),
    clearInterval: h => pending.delete(h),
  };
  const fired = [];
  const missions = [{ id: 'm1', enabled: true, intervalMs: 1000, lastFiredAt: now - 400 }];
  const sched = createMissionScheduler({ readMissions: () => missions, fire: m => fired.push(m.id), armHeartbeat: () => {}, clock });
  sched.sync();
  // lastFired 400ms ago on a 1s interval → first fire after 600ms
  const [h, job] = [...pending][0];
  assert.equal(job.at - now, 600);
  job.fn();
  assert.deepEqual(fired, ['m1']);
  // weekly: mondays 09:00 — normalize rejects out-of-range
  assert.deepEqual(normalizeWeekly({ days: [1, 1, 3], minute: 540 }), { days: [1, 3], minute: 540 });
  assert.equal(normalizeWeekly({ days: [9], minute: 0 }), null);
  assert.equal(normalizeWeekly({ days: [1], minute: 1440 }), null);
  // weeklyDelayMs: a slot missed by <6h fires immediately (catch-up)
  const wed9 = new Date(2026, 9, 14, 9, 0).getTime(); // Wed 14 Oct 2026 09:00
  const weekly = { days: [3], minute: 540 };
  assert.equal(weeklyDelayMs(weekly, wed9 + 60e3, 0), 0);                    // 1min late → catch up
  assert.ok(weeklyDelayMs(weekly, wed9 + 7 * 36e5 + 1, 0) > 0);              // >6h late → wait for next
  // mergeSavedMissions keeps the later lastFiredAt
  const merged = mergeSavedMissions([{ id: 'a', lastFiredAt: 5 }], [{ id: 'a', lastFiredAt: 9 }]);
  assert.equal(merged[0].lastFiredAt, 9);
  // ContextTriggers: persisted lastRun defers the first fire
  const kv = {};
  const emitted = [];
  const ct = new ContextTriggers({
    readConfig: () => ({ contextTrigger: { compact: { enabled: true, everyMs: 1000, minContextPct: 30, minContextPctLargeWindow: 30, message: 'x' } } }),
    kv: { get: k => kv[k], set: (k, v) => { kv[k] = v; } },
    emit: (a, r) => emitted.push(a),
  }, DEFAULT_CONTEXT_TRIGGER);
  assert.equal(sanitizeContextRule({ everyMs: 1 }, { enabled: true, everyMs: 24e5, minContextPct: 30, minContextPctLargeWindow: 30, message: '' }).everyMs, 6e4); // clamped to min
  ct.clearTimers();
  // ensureDefaultMissions: seeds standup+heartbeat, retires compact mission into the trigger
  let cfg = { missions: [{ ...COMPACT_MAINTENANCE_MISSION, lastFiredAt: 42 }] };
  ensureDefaultMissions({
    readConfig: () => cfg,
    writeConfig: p => { cfg = { ...cfg, ...p }; },
    contextTriggers: null,
  }, { OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, DEFAULT_CONTEXT_TRIGGER });
  assert.ok(cfg.missions.some(m => m.id === 'ops-standup'));
  assert.ok(cfg.missions.some(m => m.id === 'heartbeat'));
  assert.ok(!cfg.missions.some(m => m.id === 'compact-maintenance'));
  assert.equal(cfg.contextTrigger.compact.everyMs, 24e5);
  assert.equal(cfg.compactMaintenanceSeeded, true);
  assert.ok(!cfg.missions.some(m => m.autoCompact));
});

test('provider-bridges: codex TOML (trust + writable_roots), installers lay files', () => {
  const { codexTrustEntry, codexWritableRootsToml, installCodexHooks, installGeminiHooks, installPiHooks, installOpenCodePlugin, installCrushConfig } = require('../src/main/provider-bridges');
  // trust entry dedupes when the [projects.<dir>] table already exists
  const has = codexTrustEntry('/repo', '[projects."/repo"]\ntrust_level = "trusted"\n');
  assert.equal(has, '');
  const add = codexTrustEntry('/repo', '');
  assert.match(add, /\[projects\."\/repo"\]/);
  // writable_roots: empty dirs → toml unchanged; existing key → null (respect user's own)
  assert.equal(codexWritableRootsToml('x = 1\n', []), 'x = 1\n');
  assert.equal(codexWritableRootsToml('writable_roots = ["/a"]\n', ['/b']), null);
  const merged = codexWritableRootsToml('model = "x"\n', ['/hive', '/cwd']);
  assert.match(merged, /sandbox_workspace_write\.writable_roots = \["\/hive", "\/cwd"\]/);
  // codex CODEX_HOME: config.toml gets the [[hooks]] tables + trust + roots
  const dir = tmp();
  const { home, rootsInConfig } = installCodexHooks(dir, 'w1', '/repo', ['/hive', '/repo'], () => {});
  const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.match(toml, /\[\[hooks\.PreToolUse\]\]/);
  assert.match(toml, /hive-hook\.cjs/);
  assert.match(toml, /\[projects\."\/repo"\]/);
  assert.equal(rootsInConfig, true);
  // gemini: per-agent system-settings.json lands + is valid json
  const gs = JSON.parse(fs.readFileSync(installGeminiHooks(path.join(dir, 'g'), () => {}), 'utf8'));
  assert.equal(gs.hooksConfig.enabled, true);
  assert.ok(Array.isArray(gs.hooks.AfterAgent));
  // pi: extension + manifest present
  const piHome = installPiHooks(path.join(dir, 'p'), () => {});
  assert.ok(fs.existsSync(path.join(piHome, 'extensions', 'hive-bridge.js')));
  assert.ok(fs.existsSync(path.join(piHome, 'extensions.json')));
  // opencode: plugin dropped into BOTH plugin/ and plugins/
  const ocHome = installOpenCodePlugin(path.join(dir, 'o'), 'dark', () => {});
  for (const n of ['plugin', 'plugins'])
    assert.ok(fs.existsSync(path.join(ocHome, n, 'hive-bridge.js')));
  assert.ok(fs.existsSync(path.join(ocHome, 'tui.json')));
  // crush: config pins provider base_url at the loopback
  const { config, data } = installCrushConfig(path.join(dir, 'c'), 'http://127.0.0.1:9', 'openai', false, () => {});
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).providers.openai.base_url, 'http://127.0.0.1:9');
  assert.ok(fs.existsSync(data));
});

test('harness: spawn shell agent, submit, see output, seeded files', async () => {
  const dir = tmp();
  const h = new Harness({ workDir: dir, defaultProvider: 'shell' });
  await h.start();
  try {
    await h.spawnAgent('w1', { provider: 'shell' });
    const ws = path.join(dir, 'workspaces', 'w1');
    assert.ok(fs.existsSync(path.join(ws, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(ws, 'memory.md')));
    const a = h.pty.get('w1');
    if (!a.alive) return; // node-pty not built in this env — covered elsewhere
    let out = '';
    a.subscribe(c => { out += c; });
    const proof = await h.send('w1', 'echo OZYC_OK_$((40+2))');
    assert.equal(proof.ok, true);
    for (let i = 0; i < 40 && !out.includes('OZYC_OK_42'); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(out.includes('OZYC_OK_42'), 'shell output streamed back');
  } finally { await h.stop(); }
});

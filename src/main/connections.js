'use strict';
/**
 * Connections — verbatim port of the reference's agent-driven connection
 * requests (out/main/index.js ~17689-18085 + ~36578-36660): each agent may drop
 * a JSON request into its own `agents/<id>/connections/requests/` folder; a 3s
 * timer picks it up, validates it, applies the op (webhook.* / slack.set /
 * defaults.set / mission.*) and writes the outcome next door under `results/`
 * (24h TTL, secret results mode 0600). A shared `connections/README.md` +
 * `state.json` (no secrets) are republished into the hive root after every
 * pass. The injected prompt points agents at that README — this file is the
 * engine behind it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeWeekly } = require('./missions');
const { isWebhookAuth, isWebhookSource } = require('./webhooks');

const REQUEST_MAX_BYTES = 16 * 1024;
const RESULT_TTL_MS = 24 * 60 * 60 * 1e3;
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const AGENT_ID = /^[A-Za-z0-9._-]{1,80}$/;
const OPS = ['webhook.add', 'webhook.edit', 'webhook.remove', 'webhook.rotateSecret', 'slack.set', 'defaults.set', 'mission.add', 'mission.edit', 'mission.remove', 'mission.list'];
const MISSION_MIN_INTERVAL_MS = 15 * 6e4;
const MISSION_MAX_INTERVAL_MS = 7 * 24 * 60 * 6e4;
const AGENT_MISSION_CAP = 20;
const MISSION_ADMIN = 'god';
const SLACK_MODES = ['socket', 'polling', 'webhook'];

const WEBHOOK_FIELDS = {
  name: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 120,
  description: (v) => typeof v === 'string' && v.length <= 200,
  source: isWebhookSource,
  auth: isWebhookAuth,
  to: (v) => typeof v === 'string' && (v === '' || AGENT_ID.test(v)),
  prompt: (v) => typeof v === 'string' && v.length <= 2e3,
  schema: (v) => {
    if (typeof v !== 'string' || v.length > 8e3) return false;
    try { JSON.parse(v); return true; } catch { return false; }
  },
  mode: (v) => v === 'strict' || v === 'allow-all' || v === 'communication-only',
  guardrails: (v) => typeof v === 'boolean',
  enabled: (v) => typeof v === 'boolean',
};
const SLACK_FIELDS = {
  enabled: (v) => typeof v === 'boolean',
  mode: (v) => typeof v === 'string' && SLACK_MODES.includes(v),
  botToken: (v) => typeof v === 'string' && v.length <= 300,
  appToken: (v) => typeof v === 'string' && v.length <= 300,
  signingSecret: (v) => typeof v === 'string' && v.length <= 300,
  channelId: (v) => typeof v === 'string' && v.length <= 40,
  proactivePosting: (v) => typeof v === 'boolean',
  pollSeconds: (v) => typeof v === 'number' && Number.isFinite(v),
  catchupSeconds: (v) => typeof v === 'number' && Number.isFinite(v),
};
const MISSION_FIELDS = {
  label: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 120,
  body: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 4e3,
  to: (v) => typeof v === 'string' && AGENT_ID.test(v),
  intervalMs: (v) => typeof v === 'number' && Number.isInteger(v),
  weekly: (v) => normalizeWeekly(v) !== null,
  enabled: (v) => typeof v === 'boolean',
};
const DEFAULT_FIELDS = {
  webhookResponder: (v) => typeof v === 'string' && (v === '' || AGENT_ID.test(v)),
  responder: (v) => typeof v === 'string' && (v === '' || AGENT_ID.test(v)),
};
const OP_KEYS = {
  'webhook.add': { required: ['webhook'], optional: [] },
  'webhook.edit': { required: ['webhookId', 'webhook'], optional: [] },
  'webhook.remove': { required: ['webhookId'], optional: [] },
  'webhook.rotateSecret': { required: ['webhookId'], optional: [] },
  'slack.set': { required: ['slack'], optional: [] },
  'defaults.set': { required: ['defaults'], optional: [] },
  'mission.add': { required: ['mission'], optional: [] },
  'mission.edit': { required: ['missionId', 'mission'], optional: [] },
  'mission.remove': { required: ['missionId'], optional: [] },
  'mission.list': { required: [], optional: [] },
};

function missionSummary(m, from) {
  return {
    id: m.id,
    label: m.label,
    to: m.to,
    body: m.body,
    enabled: m.enabled,
    ...(m.weekly ? { weekly: m.weekly } : { intervalMs: m.intervalMs }),
    kind: m.kind ?? 'dispatch',
    createdBy: m.createdBy ?? '',
    ...(m.lastFiredAt ? { lastFiredAt: new Date(m.lastFiredAt).toISOString() } : {}),
    ...(from !== undefined ? { canChange: canChangeMission(m, from) } : {}),
  };
}
function canChangeMission(m, from) {
  return from === MISSION_ADMIN || (!!m.createdBy && m.createdBy === from);
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function checkFields(o, allowed, what) {
  if (!isObj(o)) return `${what} must be an object`;
  const keys = Object.keys(o);
  if (keys.length === 0) return `${what} is empty`;
  for (const k of keys) {
    if (!(k in allowed)) return `unknown field ${what}.${k}`;
    if (!allowed[k](o[k])) return `bad value for ${what}.${k}`;
  }
  return null;
}
function validateRequest(raw) {
  if (!isObj(raw)) return { ok: false, error: 'the request must be a JSON object' };
  if (typeof raw.id !== 'string' || !SAFE_ID.test(raw.id)) return { ok: false, error: 'id must match ^[A-Za-z0-9._-]{1,64}$' };
  if (typeof raw.op !== 'string' || !OPS.includes(raw.op)) return { ok: false, error: `unknown op; one of ${OPS.join(', ')}` };
  const op = raw.op;
  const spec = OP_KEYS[op];
  for (const k of Object.keys(raw)) {
    if (k === 'id' || k === 'op') continue;
    if (!spec.required.includes(k) && !spec.optional.includes(k)) return { ok: false, error: `unknown field ${k} for ${op}` };
  }
  for (const k of spec.required) if (!(k in raw)) return { ok: false, error: `${op} needs ${k}` };
  if ('webhookId' in raw && (typeof raw.webhookId !== 'string' || !SAFE_ID.test(raw.webhookId))) return { ok: false, error: 'bad webhookId' };
  if ('missionId' in raw && (typeof raw.missionId !== 'string' || !AGENT_ID.test(raw.missionId))) return { ok: false, error: 'bad missionId' };
  let err = null;
  if (op === 'webhook.add') {
    err = checkFields(raw.webhook, WEBHOOK_FIELDS, 'webhook');
    if (!err && !('name' in raw.webhook)) err = 'webhook.add needs webhook.name';
  }
  if (op === 'webhook.edit') err = checkFields(raw.webhook, { ...WEBHOOK_FIELDS, secret: (v) => typeof v === 'string' && /^\S{16,256}$/.test(v) }, 'webhook');
  if (op === 'slack.set') err = checkFields(raw.slack, SLACK_FIELDS, 'slack');
  if (op === 'defaults.set') err = checkFields(raw.defaults, DEFAULT_FIELDS, 'defaults');
  if (op === 'mission.add') {
    err = checkFields(raw.mission, MISSION_FIELDS, 'mission');
    const m = raw.mission;
    if (!err && !('label' in m)) err = 'mission.add needs mission.label';
    if (!err && !('body' in m)) err = 'mission.add needs mission.body';
    if (!err && !('to' in m)) err = 'mission.add needs mission.to';
    if (!err && !('intervalMs' in m) && !('weekly' in m)) err = 'mission.add needs mission.intervalMs or mission.weekly';
  }
  if (op === 'mission.edit') err = checkFields(raw.mission, MISSION_FIELDS, 'mission');
  if (err) return { ok: false, error: err };
  return { ok: true, req: raw };
}
function authExample(auth) {
  if (auth === 'bearer') return 'Authorization: Bearer <secret>';
  if (auth === 'hmac') return 'x-md-signature: sha256=<hex HMAC-SHA256 of the body, keyed with the secret>';
  return 'x-md-webhook-secret: <secret>';
}
function checkMissionSchedule(m) {
  if ('intervalMs' in m) {
    const ms = m.intervalMs;
    if (ms < MISSION_MIN_INTERVAL_MS) throw new Error(`intervalMs must be at least ${MISSION_MIN_INTERVAL_MS} (15 minutes)`);
    if (ms > MISSION_MAX_INTERVAL_MS) throw new Error(`intervalMs must be at most ${MISSION_MAX_INTERVAL_MS} (7 days)`);
  }
}
function checkMissionTarget(to, deps) {
  const ids = deps.agentIds?.();
  if (ids && !ids.includes(to)) throw new Error(`no agent ${to}`);
}
function applyMissionRequest(req, deps, from) {
  if (!deps.listMissions || !deps.saveMissions) throw new Error('scheduled missions are not available in this build');
  const list = deps.listMissions();
  const mine = (id) => {
    const m = list.find((x) => x.id === id);
    if (!m) throw new Error(`no mission ${id}`);
    if (!canChangeMission(m, from)) throw new Error(m.createdBy ? `mission ${id} belongs to ${m.createdBy}` : `mission ${id} is the founder's; only ${MISSION_ADMIN} may change it`);
    return m;
  };
  switch (req.op) {
    case 'mission.list':
      return { missions: list.map((m) => missionSummary(m, from)) };
    case 'mission.add': {
      if (list.filter((m) => m.createdBy).length >= AGENT_MISSION_CAP) throw new Error(`agents already hold ${AGENT_MISSION_CAP} missions on this floor; remove one first`);
      checkMissionSchedule(req.mission);
      const f = req.mission;
      checkMissionTarget(f.to, deps);
      const weekly = f.weekly !== undefined ? normalizeWeekly(f.weekly) ?? undefined : undefined;
      const m = {
        id: `m_${from.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}_${deps.now().toString(36)}`,
        label: f.label.trim(),
        // A weekly mission keeps a day as its interval, like the screen's new one.
        intervalMs: f.intervalMs ?? 864e5,
        ...(weekly ? { weekly } : {}),
        to: f.to,
        body: f.body,
        enabled: f.enabled ?? true,
        kind: 'dispatch',
        createdBy: from,
      };
      while (list.some((x) => x.id === m.id)) m.id += 'x';
      deps.saveMissions([...list, m]);
      return { missionId: m.id };
    }
    case 'mission.edit': {
      const prior = mine(req.missionId);
      checkMissionSchedule(req.mission);
      if (typeof req.mission.to === 'string') checkMissionTarget(req.mission.to, deps);
      const next = { ...prior, ...req.mission, id: prior.id };
      if (req.mission.weekly !== undefined) next.weekly = normalizeWeekly(req.mission.weekly) ?? undefined;
      else if (req.mission.intervalMs !== undefined) delete next.weekly;
      if (typeof req.mission.label === 'string') next.label = req.mission.label.trim();
      deps.saveMissions(list.map((x) => x.id === prior.id ? next : x));
      return { missionId: prior.id };
    }
    case 'mission.remove': {
      mine(req.missionId);
      deps.saveMissions(list.filter((x) => x.id !== req.missionId));
      return { missionId: req.missionId };
    }
  }
}
function applyRequest(req, deps, from = '') {
  if (req.op === 'mission.add' || req.op === 'mission.edit' || req.op === 'mission.remove' || req.op === 'mission.list') return applyMissionRequest(req, deps, from);
  const list = deps.listWebhooks();
  const find = (id) => {
    const w = list.find((x) => x.id === id);
    if (!w) throw new Error(`no webhook ${id}`);
    return w;
  };
  switch (req.op) {
    case 'webhook.add': {
      const w = {
        id: deps.newWebhookId(),
        name: '',
        secret: deps.mintSecret(),
        enabled: true,
        mode: 'strict',
        schema: '',
        createdAt: deps.now(),
        guardrails: true,
      };
      Object.assign(w, req.webhook);
      w.name = w.name.trim();
      const saved = deps.saveWebhooks([...list, w]).find((x) => x.id === w.id);
      if (!saved) throw new Error('the webhook was not stored');
      return { webhookId: saved.id, url: deps.endpointUrl(saved.id), secret: saved.secret, ...(saved.source ? {} : { sends: authExample(saved.auth) }) };
    }
    case 'webhook.edit': {
      const prior = find(req.webhookId);
      if ('secret' in req.webhook && prior.source !== 'linear') throw new Error('only a Linear webhook takes a secret; use webhook.rotateSecret');
      const next = { ...prior, ...req.webhook, id: prior.id };
      if (!('secret' in req.webhook)) next.secret = prior.secret;
      const saved = deps.saveWebhooks(list.map((x) => x.id === prior.id ? next : x)).find((x) => x.id === prior.id);
      if (!saved) throw new Error('the webhook was not stored');
      return { webhookId: saved.id, url: deps.endpointUrl(saved.id) };
    }
    case 'webhook.remove': {
      find(req.webhookId);
      deps.saveWebhooks(list.filter((x) => x.id !== req.webhookId));
      return { webhookId: req.webhookId };
    }
    case 'webhook.rotateSecret': {
      const prior = find(req.webhookId);
      if (prior.source === 'linear') throw new Error('Linear makes its own signing secret; set it in Settings');
      const secret = deps.mintSecret();
      deps.saveWebhooks(list.map((x) => x.id === prior.id ? { ...x, secret } : x));
      return { webhookId: prior.id, url: deps.endpointUrl(prior.id), secret };
    }
    case 'slack.set':
      deps.applySlack(req.slack);
      return {};
    case 'defaults.set':
      deps.setDefaults(req.defaults);
      return {};
  }
}
function writeResult(dir, r) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${r.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', { mode: r.secret ? 0o600 : 0o644 });
  if (r.secret) fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
function sweepResults(dir, now) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (now - fs.statSync(p).mtimeMs > RESULT_TTL_MS) fs.unlinkSync(p);
    } catch {
    }
  }
}
const README = `# Connections: set them up yourself

OzyComp applies connection requests that an agent writes into its OWN folder:

    $AGENT_DIR/connections/requests/<anything>.json

One request per file, at most 16 KB. The app reads it within a few seconds,
removes it (it may hold a token), and writes the outcome to

    $AGENT_DIR/connections/results/<request id>.json

Results are removed after 24 hours. A result that holds a secret is readable by
you only. Never copy a secret into a message, a card or a log.

The current picture, with no secret or token in it, is in
connections/state.json next to this file.

Every request has "id" (letters, digits, dot, dash, underscore; up to 64) and
"op". Any other field, or an unknown op, is refused and nothing is applied.

  {"id":"r1","op":"webhook.add","webhook":{"name":"Support desk","to":"<agent id>","prompt":"Draft a reply.","auth":"bearer"}}
      webhook fields: name (required), description, source (custom|github|linear|telegram),
      auth (header|bearer|hmac, blank webhooks only), to (agent id, "" = default agent),
      prompt, schema (JSON Schema as a string), mode (strict|allow-all|communication-only),
      guardrails (bool), enabled (bool, default true)
      result: webhookId, url (empty until the server has a public address), secret, sends
  {"id":"r2","op":"webhook.edit","webhookId":"wh-...","webhook":{"to":"<agent id>"}}
      the same fields, plus secret for a Linear webhook (the signing secret Linear shows)
  {"id":"r3","op":"webhook.remove","webhookId":"wh-..."}
  {"id":"r4","op":"webhook.rotateSecret","webhookId":"wh-..."}
  {"id":"r5","op":"slack.set","slack":{"enabled":true,"botToken":"xoxb-...","appToken":"xapp-...","channelId":"C0123"}}
      slack fields: enabled, mode (socket|polling|webhook), botToken, appToken,
      signingSecret, channelId, proactivePosting, pollSeconds, catchupSeconds
  {"id":"r6","op":"defaults.set","defaults":{"webhookResponder":"<agent id>","responder":"<agent id>"}}
      webhookResponder: who takes a webhook that names no agent; responder: who answers Slack

SCHEDULED MISSIONS (Automations > Schedules): a message sent to an agent on a timer.

  {"id":"r7","op":"mission.add","mission":{"label":"Board update","to":"<agent id>","body":"Run your board update.","intervalMs":43200000}}
      mission fields: label (required), body (required, what the agent is told),
      to (required, an agent id), intervalMs (at least 900000 = 15 minutes, at most 7 days)
      or weekly {"days":[1,2,3,4,5],"minute":540} (0 = Sunday; minute of the day, 540 = 09:00),
      enabled (bool, default true)
      result: missionId
  {"id":"r8","op":"mission.edit","missionId":"m_...","mission":{"enabled":false}}
      the same fields; setting intervalMs switches a weekly mission back to an interval
  {"id":"r9","op":"mission.remove","missionId":"m_..."}
  {"id":"r10","op":"mission.list"}
      result: missions, each with canChange (whether you may edit or remove it)

  Rules: you may change only the missions you made. The founder's own and the
  built in ones are god's to change. At most 20 agent made missions per floor.
  The current list is also in state.json under "missions".

Everything you do here is logged with your agent id, and shows in Settings >
Connections and in Automations (a mission you made says so on its row).
`;
function writeIfChanged(file, body) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
  } catch {
  }
  fs.mkdirSync(path.join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}
function publishConnectionState(deps) {
  const root = deps.hiveRoot();
  if (!root) return;
  const dir = path.join(root, 'connections');
  writeIfChanged(path.join(dir, 'README.md'), README);
  writeIfChanged(path.join(dir, 'state.json'), JSON.stringify(deps.snapshot(), null, 2) + '\n');
}
function processConnectionRequests(deps) {
  const root = deps.hiveRoot();
  if (!root) return 0;
  const agentsDir = path.join(root, 'agents');
  if (!fs.existsSync(agentsDir)) return 0;
  let handled = 0;
  let changed = false;
  for (const from of fs.readdirSync(agentsDir)) {
    if (!AGENT_ID.test(from)) continue;
    const base = path.join(agentsDir, from, 'connections');
    const reqDir = path.join(base, 'requests');
    const resDir = path.join(base, 'results');
    sweepResults(resDir, deps.now());
    if (!fs.existsSync(reqDir)) continue;
    for (const f of fs.readdirSync(reqDir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(reqDir, f);
      const stem = f.slice(0, -5);
      const fallbackId = SAFE_ID.test(stem) ? stem : `bad-${deps.now()}`;
      const at = new Date(deps.now()).toISOString();
      let result;
      let claimed = {};
      try {
        const st = fs.lstatSync(p);
        if (!st.isFile()) throw new Error('not a plain file');
        if (st.size > REQUEST_MAX_BYTES) throw new Error(`larger than ${REQUEST_MAX_BYTES} bytes`);
        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
          throw new Error('not valid JSON');
        }
        if (isObj(parsed)) claimed = parsed;
        const v = validateRequest(parsed);
        if (!v.ok) throw new Error(v.error);
        const out = applyRequest(v.req, deps, from);
        result = { id: v.req.id, op: v.req.op, from, at, ok: true, ...out };
        if (v.req.op !== 'mission.list') changed = true;
      } catch (e) {
        const id = typeof claimed.id === 'string' && SAFE_ID.test(claimed.id) ? claimed.id : fallbackId;
        const op = typeof claimed.op === 'string' && OPS.includes(claimed.op) ? claimed.op : '';
        result = { id, op, from, at, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        fs.unlinkSync(p);
      } catch {
      }
      try {
        writeResult(resDir, result);
      } catch {
      }
      deps.log({ kind: 'connections', from, request: result.id, op: result.op, ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.webhookId ? { webhookId: result.webhookId } : {}), ...(result.missionId ? { missionId: result.missionId } : {}) });
      handled++;
    }
  }
  if (changed) deps.onChanged?.();
  publishConnectionState(deps);
  return handled;
}

/** The verbatim 3-second sweep (ref ~36646). Returns {stop} so the quit/reset
 *  stop lists can disarm it. */
function startConnectionRequests(deps) {
  if (deps._timer) return { stop: () => {} };
  deps._timer = setInterval(() => {
    try {
      processConnectionRequests(deps);
    } catch (e) {
      console.error('[connections]', e instanceof Error ? e.message : e);
    }
  }, 3e3);
  deps._timer.unref?.();
  return {
    stop: () => { try { clearInterval(deps._timer); } catch {} deps._timer = null; },
  };
}

module.exports = {
  processConnectionRequests, publishConnectionState, startConnectionRequests,
  validateRequest, applyRequest, applyMissionRequest, missionSummary, authExample,
  OPS, AGENT_ID, REQUEST_MAX_BYTES, RESULT_TTL_MS,
};

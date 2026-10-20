'use strict';
/**
 * Mission scheduler — verbatim from the reference. A mission is a recurring
 * (or weekly-calendar) hive message to an agent; the scheduler keeps timers
 * per mission id, re-arms when the config list changes (missionsArmingKey),
 * catches up a missed weekly slot inside a 6h window, and preserves
 * lastFiredAt across saves (mergeSavedMissions).
 *
 * Heartbeat-kind missions defer to deps.armHeartbeat (the quiet-detector owns
 * those); compact-kind missions fire deps.fire like any other.
 */
const WEEKLY_CATCHUP_MS = 6 * 60 * 60 * 1e3;
const ARMING_POLL_MS = 2e3;

function normalizeWeekly(w) {
  if (!w || typeof w !== 'object') return null;
  const raw = w;
  if (!Array.isArray(raw.days)) return null;
  const days = [...new Set(
    raw.days.filter(d => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6),
  )].sort((a, b) => a - b);
  if (days.length === 0) return null;
  const minute = raw.minute;
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 1439) return null;
  return { days, minute };
}
function slotAt(from, offset, minute) {
  return new Date(
    from.getFullYear(), from.getMonth(), from.getDate() + offset,
    Math.floor(minute / 60), minute % 60, 0, 0,
  );
}
function nextWeeklyFireMs(w, nowMs) {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const from = new Date(nowMs);
  for (let offset = 0; offset <= 7; offset++) {
    const slot = slotAt(from, offset, n.minute);
    if (!n.days.includes(slot.getDay())) continue;
    const t = slot.getTime();
    if (t > nowMs) return t;
  }
  return null;
}
function previousWeeklyFireMs(w, nowMs) {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const from = new Date(nowMs);
  for (let offset = 0; offset >= -7; offset--) {
    const slot = slotAt(from, offset, n.minute);
    if (!n.days.includes(slot.getDay())) continue;
    const t = slot.getTime();
    if (t <= nowMs) return t;
  }
  return null;
}
function weeklyDelayMs(w, nowMs, lastFiredAt = 0) {
  const n = normalizeWeekly(w);
  if (!n) return null;
  const prev = previousWeeklyFireMs(n, nowMs);
  if (prev !== null && prev > lastFiredAt && nowMs - prev <= WEEKLY_CATCHUP_MS) return 0;
  const next = nextWeeklyFireMs(n, nowMs);
  return next === null ? null : Math.max(0, next - nowMs);
}

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: h => clearTimeout(h),
  clearInterval: h => clearInterval(h),
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

function missionsArmingKey(missions) {
  return JSON.stringify((missions ?? []).map(m => {
    const { lastFiredAt, ...rest } = m;
    return canonical(rest);
  }));
}
function webhooksArmingKey(hooks) {
  return JSON.stringify((hooks ?? []).map(canonical));
}
function mergeSavedMissions(incoming, persisted) {
  const list = Array.isArray(incoming) ? incoming : [];
  const persistedById = new Map(persisted.map(m => [m.id, m]));
  return list.map(m => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
}

/**
 * createMissionScheduler({ readMissions, fire, armHeartbeat, clock }) — one
 * timer entry per enabled mission. Weekly missions rearm after each fire;
 * interval missions wait `intervalMs - elapsed since lastFiredAt` then tick.
 */
function createMissionScheduler(deps) {
  const clock = deps.clock ?? REAL_CLOCK;
  const timers = new Map();
  let armedKey = null;
  const clear = () => {
    for (const t of timers.values()) {
      if (t.timeout) clock.clearTimeout(t.timeout);
      if (t.interval) clock.clearInterval(t.interval);
    }
    timers.clear();
    armedKey = null;
  };
  const sync = () => {
    clear();
    const missions = deps.readMissions();
    armedKey = missionsArmingKey(missions);
    for (const m of missions) {
      if (!m.enabled) continue;
      const weekly = m.kind === 'heartbeat' ? null : normalizeWeekly(m.weekly);
      if (!weekly && !(m.intervalMs > 0)) continue;
      if (m.kind === 'heartbeat') { deps.armHeartbeat(m); continue; }
      const fire = () => deps.fire(m);
      const entry = {};
      if (weekly) {
        const rearm = justFired => {
          const now = clock.now();
          const persisted = deps.readMissions().find(x => x.id === m.id)?.lastFiredAt ?? 0;
          const delay = weeklyDelayMs(weekly, now, justFired ? Math.max(persisted, now) : persisted);
          if (delay === null) return;
          entry.timeout = clock.setTimeout(() => { fire(); rearm(true); }, delay);
        };
        rearm(false);
        timers.set(m.id, entry);
        continue;
      }
      const remaining = Math.max(0, m.intervalMs - (clock.now() - (m.lastFiredAt ?? 0)));
      entry.timeout = clock.setTimeout(() => {
        fire();
        entry.interval = clock.setInterval(fire, m.intervalMs);
      }, remaining);
      timers.set(m.id, entry);
    }
  };
  const syncIfChanged = () => {
    if (missionsArmingKey(deps.readMissions()) === armedKey) return false;
    sync();
    return true;
  };
  return { timers, sync, clear, syncIfChanged };
}

/**
 * startArmingWatch — config-change watcher: after every config write (and on
 * a slow poll) re-arms missions whose key changed and reconciles webhooks
 * whose key changed. The stamp check means a write made by THIS process
 * triggers `compare` exactly once via afterWrite.
 */
function startArmingWatch(deps) {
  const clock = deps.clock ?? REAL_CLOCK;
  let stopped = false;
  let webhooksKey = webhooksArmingKey(deps.readConfig().webhookTriggers);
  let seenStamp;
  const stampNow = () => { try { return deps.configStamp(); } catch { return null; } };
  const compare = () => {
    try {
      if (deps.missions.syncIfChanged()) deps.onMissionsRearmed?.();
      const key = webhooksArmingKey(deps.readConfig().webhookTriggers);
      if (key !== webhooksKey) {
        webhooksKey = key;
        deps.reconcileWebhooks();
      }
    } catch (e) { console.error('[arming] check failed:', e); }
  };
  const check = () => {
    if (stopped) return;
    const stamp = stampNow();
    if (stamp === seenStamp) return;
    seenStamp = stamp;
    compare();
  };
  const afterWrite = () => {
    if (stopped) return;
    seenStamp = stampNow();
    compare();
  };
  const unsubscribe = deps.subscribe(afterWrite);
  const poll = clock.setInterval(check, deps.pollMs ?? ARMING_POLL_MS);
  poll.unref?.();
  check();
  return {
    check,
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clock.clearInterval(poll);
    },
  };
}

// ─── context triggers (compact / clear schedules) ───────────────────────────

const CONTEXT_LAST_RUN_KV_KEY = 'triggers.context.lastRun';

/**
 * ContextTriggers — the compact/clear schedules from config.contextTrigger.
 * Each rule fires emitContextTrigger(action, rule) → a 'trigger:context' event
 * to the renderer (and 'mission:autoCompact' for compact). lastRun is
 * persisted in kv so a restarted app waits out the remainder of an interval
 * instead of firing immediately.
 *
 * Deps: { readConfig(), kv:{get,set}, emit(action, rule) }
 */
class ContextTriggers {
  constructor(deps, defaults) {
    this.deps = deps;
    this.defaults = defaults;
    this.timers = new Map();
    this.lastRun = null;
  }
  runMap() {
    if (!this.lastRun) {
      try { this.lastRun = this.deps.kv.get(CONTEXT_LAST_RUN_KV_KEY) ?? {}; }
      catch { this.lastRun = {}; }
    }
    return this.lastRun;
  }
  lastRunAt(action) {
    const v = this.runMap()[action];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return this.stamp(action);
  }
  stamp(action) {
    const map = this.runMap();
    const at = Date.now();
    map[action] = at;
    try { this.deps.kv.set(CONTEXT_LAST_RUN_KV_KEY, map); } catch {}
    return at;
  }
  rule(action) {
    return this.deps.readConfig().contextTrigger?.[action] ?? this.defaults[action];
  }
  clearTimers() {
    for (const t of this.timers.values()) {
      if (t.timeout) clearTimeout(t.timeout);
      if (t.interval) clearInterval(t.interval);
    }
    this.timers.clear();
  }
  emit(action, rule) {
    try { this.deps.emit?.(action, rule); } catch {}
  }
  sync() {
    this.clearTimers();
    for (const action of ['compact', 'clear']) {
      const rule = this.rule(action);
      if (!rule.enabled || !(rule.everyMs > 0)) continue;
      const fire = () => {
        try {
          this.stamp(action);
          this.emit(action, this.rule(action));
        } catch (e) { console.error('[triggers] context', action, e); }
      };
      const remaining = Math.max(0, rule.everyMs - (Date.now() - this.lastRunAt(action)));
      const entry = {};
      entry.timeout = setTimeout(() => {
        fire();
        entry.interval = setInterval(fire, rule.everyMs);
      }, remaining);
      this.timers.set(action, entry);
    }
  }
}

function sanitizeContextRule(patch, current) {
  const p = patch ?? {};
  const num = (v, fallback, min, max) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    everyMs: num(p.everyMs, current.everyMs, 6e4, 864e5),
    minContextPct: num(p.minContextPct, current.minContextPct, 0, 100),
    minContextPctLargeWindow: num(p.minContextPctLargeWindow, current.minContextPctLargeWindow, 0, 100),
    message: typeof p.message === 'string' ? p.message : current.message,
  };
}

/**
 * ensureDefaultMissions — the boot-time seeding/migration sequence, verbatim:
 *  1. OPS_STANDUP lands once (opsStandupSeeded flag)
 *  2. HEARTBEAT lands once (heartbeatSeeded flag)
 *  3. a stored compact-maintenance mission is RETIRED into
 *     contextTrigger.compact (its lastFiredAt carried into the kv lastRun map)
 *  4. any leftover autoCompact flag is dropped — the context trigger is the
 *     only schedule that compacts
 */
function ensureDefaultMissions(deps, seeds) {
  const { readConfig, writeConfig, contextTriggers } = deps;
  const { OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, DEFAULT_CONTEXT_TRIGGER } = seeds;
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some(m => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true,
    });
  }
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some(m => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true,
    });
  }
  const cfg3 = readConfig();
  const missions3 = cfg3.missions ?? [];
  const retiring = missions3.find(m => m.id === COMPACT_MAINTENANCE_MISSION.id);
  if (retiring) {
    const current = cfg3.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    writeConfig({
      missions: missions3.filter(m => m.id !== COMPACT_MAINTENANCE_MISSION.id),
      contextTrigger: {
        ...current,
        compact: {
          ...current.compact,
          enabled: retiring.enabled,
          // A hand-tuned interval is a decision; only a missing/absurd one
          // falls back to whatever the trigger already carries.
          everyMs: retiring.intervalMs > 0 ? retiring.intervalMs : current.compact.everyMs,
        },
      },
      compactMaintenanceSeeded: true,
    });
    if (typeof retiring.lastFiredAt === 'number' && retiring.lastFiredAt > 0 && contextTriggers) {
      const map = contextTriggers.runMap();
      map.compact = retiring.lastFiredAt;
      try { contextTriggers.deps.kv.set(CONTEXT_LAST_RUN_KV_KEY, map); } catch {}
    }
    console.log(
      '[triggers] retired the compact-maintenance mission into contextTrigger.compact',
      `(enabled: ${retiring.enabled}, everyMs: ${retiring.intervalMs})`,
    );
  }
  const cfg4 = readConfig();
  const missions4 = cfg4.missions ?? [];
  if (missions4.some(m => m.autoCompact)) {
    writeConfig({
      missions: missions4.map(({ autoCompact, ...rest }) => rest),
    });
    console.log(
      '[triggers] dropped the legacy per-mission autoCompact flag —',
      'contextTrigger.compact is now the only schedule that compacts',
    );
  }
}

module.exports = {
  createMissionScheduler, startArmingWatch, mergeSavedMissions,
  missionsArmingKey, webhooksArmingKey, canonical,
  normalizeWeekly, nextWeeklyFireMs, previousWeeklyFireMs, weeklyDelayMs,
  ContextTriggers, sanitizeContextRule, ensureDefaultMissions,
  CONTEXT_LAST_RUN_KV_KEY, REAL_CLOCK, ARMING_POLL_MS, WEEKLY_CATCHUP_MS,
};

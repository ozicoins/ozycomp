'use strict';
/**
 * Automations — scheduled nudges. An automation = {id, agentId, text,
 * intervalMinutes, enabled, lastRunAt, nextRunAt}. Every `intervalMinutes`
 * (clamped to 5..10080, default 60) the text is sent to the agent as if the
 * human typed it — for recurring chores like "triage your inbox" or "post the
 * daily stand-up summary to board.md".
 *
 * `scheduleSlot(schedule, at)` mirrors the reference harness: given an
 * automation and a timestamp it returns the next boundary ≥ at, aligned to
 * the interval from midnight UTC (so a 60-min automation fires :00 each hour).
 */
const crypto = require('node:crypto');
const { assertAgentId } = require('./hive');
const { readJson, writeJson } = require('./hive');
const path = require('node:path');

const FILE = 'automations.json';
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 7 * 24 * 60;         // one week
const DEFAULT_INTERVAL = 60;
const TICK_MS = 30_000;

const clampInterval = n =>
  Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number(n) || DEFAULT_INTERVAL));

/**
 * Next aligned boundary strictly after `at` for a schedule created at
 * `anchor` (ms). Steps of intervalMinutes from the anchor, first slot ≥ at.
 */
function scheduleSlot(schedule, at = Date.now()) {
  const step = clampInterval(schedule.intervalMinutes) * 60_000;
  const anchor = schedule.anchorAt ?? 0;
  const k = Math.max(1, Math.ceil((at - anchor) / step));
  return anchor + k * step;
}

class AutomationsManager {
  /**
   * @param {object} deps {hive, send(id,text)→Promise, emit(ev,…)}
   */
  constructor({ hive, send, emit } = {}) {
    this.hive = hive;
    this.send = send;                       // async (agentId, text) → proof
    this.emit = emit ?? (() => {});
    this.timer = null;
    this.firing = false;
  }

  file() { return path.join(this.hive.root(), FILE); }
  all()  { return readJson(this.file(), { automations: [] }).automations; }
  save(list) { writeJson(this.file(), { automations: list }); }

  add(a) {
    const list = this.all();
    const now = Date.now();
    const rec = {
      id: crypto.randomUUID().slice(0, 8),
      agentId: assertAgentId(a.agentId),
      text: String(a.text ?? '').trim(),
      intervalMinutes: clampInterval(a.intervalMinutes),
      enabled: a.enabled !== false,
      anchorAt: now,
      lastRunAt: null,
      nextRunAt: scheduleSlot({ intervalMinutes: a.intervalMinutes, anchorAt: now }, now),
      createdAt: new Date(now).toISOString(),
    };
    if (!rec.text) throw new Error('automation requires text');
    list.push(rec);
    this.save(list);
    return rec;
  }

  patch(id, patch) {
    const list = this.all();
    const r = list.find(x => x.id === id);
    if (!r) return null;
    if (patch.intervalMinutes !== undefined) patch.intervalMinutes = clampInterval(patch.intervalMinutes);
    Object.assign(r, patch);
    if (patch.intervalMinutes !== undefined || patch.enabled !== undefined) {
      r.nextRunAt = r.enabled === false ? null : scheduleSlot(r, Date.now());
    }
    this.save(list);
    return r;
  }

  remove(id) { this.save(this.all().filter(x => x.id !== id)); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = Date.now()) {
    if (this.firing) return;
    this.firing = true;
    try {
      const list = this.all();
      let dirty = false;
      for (const r of list) {
        if (!r.enabled || r.nextRunAt == null || r.nextRunAt > now) continue;
        try {
          await this.send(r.agentId, r.text);
          this.emit('automation-fired', { id: r.id, agentId: r.agentId });
          this.hive.log({ kind: 'automation-fired', id: r.id, agentId: r.agentId });
        } catch (e) {
          this.hive.log({ kind: 'automation-failed', id: r.id, agentId: r.agentId, error: String(e?.message ?? e) });
        }
        r.lastRunAt = now;
        r.nextRunAt = scheduleSlot(r, now);
        dirty = true;
      }
      if (dirty) this.save(list);
    } finally { this.firing = false; }
  }
}

module.exports = {
  AutomationsManager, scheduleSlot, clampInterval,
  MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL,
};

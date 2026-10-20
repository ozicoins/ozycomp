'use strict';
/**
 * Analytics — verbatim port of the reference's telemetry client
 * (out/main/index.js ~23633-24059): the EVENTS allowlist (a property not named
 * there never leaves the machine), the funnel value-enums (trackFunnel drops
 * the WHOLE event on one unlisted value), per-session feature_used dedup, the
 * install-id mint under stateDir, the version-transition stamp + updater-log
 * `via` classifier, and the PostHog capture itself.
 *
 * One deviation, deliberate: the reference `require("posthog-node")` at bundle
 * scope. The clone keeps its zero-dep constraint and lazy-loads the module;
 * when it is absent init() lands in the SAME catch the reference uses for a
 * PostHog ctor failure ("[analytics] init failed (telemetry disabled)", client
 * null) — every track()/trackFunnel()/trackFeature() call then no-ops exactly
 * as it does on a machine where the client failed to boot. Install
 * posthog-node to make capture live; no code path changes.
 */
const node_fs = require('node:fs');
const path = require('node:path');
const node_crypto = require('node:crypto');

const EVENTS = {
  /** Once per install, when the install id is first minted. */
  first_run: new Set(),
  /** Every app start. The DAU/retention backbone. */
  app_launched: new Set(),
  /** Once per version change, on the first run after the version moved. */
  update_applied: new Set(['from_version', 'to_version', 'via']),
  /** An agent PTY spawned. `provider` is the CLI engine name only. */
  agent_spawned: new Set(['provider']),
  /** Onboarding wizard finished. `provider` is a closed CLI name. */
  onboarding_completed: new Set(['provider']),
  /** A spawn was REQUESTED — every path through spawnAgentCore. */
  agent_spawn_attempted: new Set(['provider']),
  /** A spawn did NOT produce a running agent. `reason` is a fixed enum. */
  agent_spawn_failed: new Set(['provider', 'reason']),
  /** The engine CLI was absent, so the auto-installer PTY started. */
  agent_install_started: new Set(['provider', 'rung']),
  /** The auto-installer PTY exited. `outcome`: agent_launched|install_failed. */
  agent_install_finished: new Set(['provider', 'rung', 'outcome']),
  /** A HUMAN sent a message to an agent. `surface` is a closed enum. */
  message_sent: new Set(['surface']),
  /** Coarse feature adoption; `feature` is a fixed enum, once per session. */
  feature_used: new Set(['feature']),
  /** Fired on quit. `duration_bucket` is a coarse label, never raw ms. */
  session_ended: new Set(['duration_bucket']),
  /** An agent run ended. Pairs with agent_spawned; ALWAYS undercounts. */
  agent_run_ended: new Set(['provider', 'duration_bucket', 'ended_reason']),
  /** The money funnel: a purchase surface was drawn. */
  paywall_shown: new Set(['plan', 'trigger']),
  /** The person left for the browser to buy. */
  checkout_opened: new Set(['plan', 'seats_bucket']),
  /** How that attempt ended. `scheduled_call` is an outcome, not abandonment. */
  checkout_finished: new Set(['plan', 'outcome', 'reason']),
  /** The only event that proves money turned into working software. */
  licence_activated: new Set(['plan', 'source', 'period']),
  /** A dead end, NOT a pitch: a block that offers no purchase surface. */
  access_blocked: new Set(['plan', 'block']),
  /** The teams growth loop, one call site. */
  invite_redeemed: new Set(['role']),
};
const FUNNEL_PLANS = ['pro', 'teams'];
const PAYWALL_TRIGGERS = [
  'pro_feature',
  'seat_limit',
  'licence_missing',
  'licence_expired',
  'manual',
];
const CHECKOUT_PERIODS = ['monthly', 'annual'];
const SEATS_BUCKETS = ['1', '2-5', '6-20', '21+'];
const CHECKOUT_OUTCOMES = ['succeeded', 'failed', 'abandoned', 'scheduled_call'];
const CHECKOUT_REASONS = [
  'card_declined',
  'auth_failed',
  'network',
  'timeout',
  'user_cancelled',
  'other',
];
const LICENCE_SOURCES = ['checkout', 'key_entry', 'invite'];
const ACCESS_BLOCKS = [
  'no_seat',
  'seat_limit_reached',
  'org_required',
  'licence_missing',
  'org_lapsed',
];
const INVITE_ROLES = ['member', 'admin'];
const FUNNEL_VALUES = {
  plan: FUNNEL_PLANS,
  trigger: PAYWALL_TRIGGERS,
  period: CHECKOUT_PERIODS,
  seats_bucket: SEATS_BUCKETS,
  outcome: CHECKOUT_OUTCOMES,
  reason: CHECKOUT_REASONS,
  source: LICENCE_SOURCES,
  block: ACCESS_BLOCKS,
  role: INVITE_ROLES,
};
const FUNNEL_EVENTS = [
  'paywall_shown',
  'checkout_opened',
  'checkout_finished',
  'licence_activated',
  'access_blocked',
  'invite_redeemed',
];
function isFunnelEvent(v) {
  return typeof v === 'string' && FUNNEL_EVENTS.includes(v);
}
function runEndReason(exitCode, signal) {
  if (typeof signal === 'number' && signal > 0) return 'stopped';
  if (exitCode === 0) return 'completed';
  if (typeof exitCode === 'number') return 'error';
  return 'unknown';
}
const MESSAGE_SURFACES = ['terminal', 'composer', 'steer', 'hive'];
const RENDERER_MESSAGE_SURFACES = new Set(['terminal', 'composer']);
function isRendererMessageSurface(v) {
  return typeof v === 'string' && RENDERER_MESSAGE_SURFACES.has(v);
}
function dntSet() {
  const v = process.env.DO_NOT_TRACK;
  return v !== undefined && v !== '' && v !== '0';
}

class Analytics {
  constructor() {
    this.client = null;
    this.distinctId = '';
    this.enabled = false;
    this.firstRun = false;
    /** False when the state dir was unwritable and loadOrMintInstallId fell back
     *  to an ephemeral id. Such an install cannot be recognised across boots, so
     *  it must never report a version transition. */
    this.idPersisted = false;
    this.startedAt = 0;
    this.sessionEnded = false;
    /** Session-scoped dedup for feature_used. */
    this.featuresSeen = new Set();
    this.common = {};
  }
  /** Boot the client (no-op without a build-time key / with DNT set). Returns
   *  whether this boot minted a fresh install id (first run ever). */
  init(opts) {
    this.enabled = opts.enabled;
    this.startedAt = Date.now();
    this.common = {
      app_version: opts.appVersion,
      os: process.platform,
      arch: process.arch,
    };
    if (dntSet()) return;
    // Lazy, optional: absent module → client stays null, silently (zero-dep:
    // posthog-node ships with the packaged app but not with the clone's
    // dev checkout — a missing optional dep is not an error worth logging).
    let posthogNode = null;
    try { posthogNode = require('posthog-node'); } catch { return; }
    try {
      this.distinctId = this.loadOrMintInstallId(opts.stateDir);
      this.client = new posthogNode.PostHog('phc_qJzsokwcbtTGHemnvywR3nSqivNNgMjHeNVEWkZNydFB', {
        host: 'https://us.i.posthog.com',
        // Events are rare — send immediately so quit loses at most the final
        // session_ended, never a whole batch.
        flushAt: 1,
        flushInterval: 1e4,
        // GeoIP stays OFF (posthog-node default).
        disableGeoip: true,
      });
    } catch (e) {
      console.error('[analytics] init failed (telemetry disabled):', e);
      this.client = null;
      return;
    }
    let transition = null;
    if (this.idPersisted) {
      const previous = readVersionStamp(opts.stateDir);
      transition = updateTransition(previous, opts.appVersion, this.firstRun);
      if (previous !== opts.appVersion) writeVersionStamp(opts.stateDir, opts.appVersion);
    }
    if (this.firstRun) this.track('first_run');
    if (transition) {
      const via = updateVia(readUpdaterLogTail(opts.stateDir), transition.to_version);
      this.track('update_applied', { ...transition, via });
    }
    this.track('app_launched');
  }
  /** Live opt-in/out from Settings. */
  setEnabled(on) {
    this.enabled = on;
  }
  /** Capture one allowlisted event. Silently drops anything not in EVENTS. */
  track(event, props = {}) {
    if (!this.client || !this.enabled || dntSet() || this.sessionEnded) return;
    const allowed = EVENTS[event];
    if (!allowed) return;
    const properties = {
      ...this.common,
      $process_person_profile: false,
      // PostHog fills $ip from the connection ONLY when the event does not
      // carry one, so sending it explicitly as null is the one client-side way
      // to stop the IP being stored.
      $ip: null,
    };
    for (const [k, v] of Object.entries(props)) {
      if (allowed.has(k) && typeof v === 'string') properties[k] = v;
    }
    try {
      this.client.capture({ distinctId: this.distinctId, event, properties });
    } catch (e) {
      console.error('[analytics] capture failed:', e);
    }
  }
  /** One human-sent message. NOT deduped — the count is the whole point. */
  trackMessageSent(surface) {
    if (!MESSAGE_SURFACES.includes(surface)) return;
    this.track('message_sent', { surface });
  }
  /**
   * One money-funnel event, with every VALUE checked, not just every key.
   * A bad value drops the WHOLE event rather than the offending property.
   */
  trackFunnel(event, props = {}) {
    if (!isFunnelEvent(event)) return;
    const allowed = EVENTS[event];
    if (!allowed) return;
    for (const [k, v] of Object.entries(props)) {
      if (!allowed.has(k)) return;
      if (!FUNNEL_VALUES[k]?.includes(v)) return;
    }
    this.track(event, props);
  }
  /** feature_used with per-session dedup (adoption signal, not a usage meter). */
  trackFeature(feature) {
    if (this.featuresSeen.has(feature)) return;
    this.featuresSeen.add(feature);
    this.track('feature_used', { feature });
  }
  /** Fire session_ended and flush. Bounded by the caller. Idempotent. */
  async endSession() {
    if (!this.client || this.sessionEnded) return;
    this.track('session_ended', { duration_bucket: durationBucket(Date.now() - this.startedAt) });
    this.sessionEnded = true;
    try {
      await this.client.shutdown();
    } catch (e) {
      console.error('[analytics] shutdown flush failed:', e);
    }
    this.client = null;
  }
  loadOrMintInstallId(stateDir) {
    const file = path.join(stateDir, 'telemetry-install-id');
    try {
      if (node_fs.existsSync(file)) {
        const id2 = node_fs.readFileSync(file, 'utf8').trim();
        if (id2) {
          this.idPersisted = true;
          return id2;
        }
      }
      const id = node_crypto.randomUUID();
      node_fs.mkdirSync(stateDir, { recursive: true });
      node_fs.writeFileSync(file, id + '\n', 'utf8');
      this.firstRun = true;
      this.idPersisted = true;
      return id;
    } catch (e) {
      console.error('[analytics] install-id persist failed (ephemeral id):', e);
      return node_crypto.randomUUID();
    }
  }
}

const VERSION_STAMP_FILE = 'telemetry-last-version';
const VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;
function updateTransition(previous, current, firstRun) {
  if (firstRun) return null;
  if (!VERSION_RE.test(current)) return null;
  if (previous === current) return null;
  return {
    from_version: previous && VERSION_RE.test(previous) ? previous : 'unknown',
    to_version: current,
  };
}
function readVersionStamp(stateDir) {
  try {
    const file = path.join(stateDir, VERSION_STAMP_FILE);
    if (!node_fs.existsSync(file)) return null;
    return node_fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
function writeVersionStamp(stateDir, version) {
  try {
    node_fs.mkdirSync(stateDir, { recursive: true });
    node_fs.writeFileSync(path.join(stateDir, VERSION_STAMP_FILE), version + '\n', 'utf8');
  } catch (e) {
    console.error('[analytics] version stamp persist failed:', e);
  }
}
const LOG_FILE = 'updater.log';
const LOG_DOWNLOADED = 'update downloaded: ';
const LOG_QUIT_REQUESTED = 'quitAndInstall requested by the user';
const LOG_QUIT_FAILED = 'quitAndInstall failed:';
const LOG_READY = /native updater ready \(current v([^)\s]+)\)/;
const LOG_QUIT_CANCELLED = 'quitAndInstall cancelled by the user at the quit warning';
const LOG_TAIL_BYTES = 128 * 1024;
function updateVia(logText, toVersion) {
  if (logText === null) return 'unknown';
  const lines = logText.split('\n');
  const downloaded = new RegExp(
    `${LOG_DOWNLOADED}${toVersion.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9.\\-])`
  );
  let i = -1;
  for (let n = 0; n < lines.length; n++) if (downloaded.test(lines[n])) i = n;
  if (i < 0) return 'manual';
  let j = -1;
  for (let n = i + 1; n < lines.length; n++) if (lines[n].includes(LOG_QUIT_REQUESTED)) j = n;
  if (j < 0) return 'manual';
  if (lines[j + 1]?.includes(LOG_QUIT_FAILED)) return 'manual';
  for (let n = j + 1; n < lines.length; n++) {
    if (lines[n].includes(LOG_QUIT_CANCELLED)) return 'manual';
    const launched = LOG_READY.exec(lines[n]);
    if (launched && launched[1] !== toVersion) return 'manual';
  }
  return 'auto';
}
function readUpdaterLogTail(stateDir) {
  let fd = null;
  try {
    const file = path.join(stateDir, LOG_FILE);
    if (!node_fs.existsSync(file)) return null;
    fd = node_fs.openSync(file, 'r');
    const size = node_fs.fstatSync(fd).size;
    if (size === 0) return null;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(length);
    node_fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        node_fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function durationBucket(ms) {
  const m = ms / 6e4;
  if (m < 5) return '<5m';
  if (m < 30) return '5-30m';
  if (m < 120) return '30m-2h';
  if (m < 480) return '2-8h';
  return '8h+';
}
function runDurationBucket(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? ms / 1e3 : 0;
  if (s < 30) return '<30s';
  if (s < 120) return '30s-2m';
  if (s < 600) return '2-10m';
  if (s < 1800) return '10-30m';
  if (s < 7200) return '30m-2h';
  return '2h+';
}

module.exports = {
  EVENTS, FUNNEL_VALUES, FUNNEL_EVENTS, isFunnelEvent,
  MESSAGE_SURFACES, RENDERER_MESSAGE_SURFACES, isRendererMessageSurface,
  runEndReason, durationBucket, runDurationBucket,
  dntSet, Analytics,
  VERSION_STAMP_FILE, VERSION_RE, updateTransition,
  readVersionStamp, writeVersionStamp,
  LOG_FILE, LOG_DOWNLOADED, LOG_QUIT_REQUESTED, LOG_QUIT_FAILED, LOG_READY,
  LOG_QUIT_CANCELLED, LOG_TAIL_BYTES, updateVia, readUpdaterLogTail,
};

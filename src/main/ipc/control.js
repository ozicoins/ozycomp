'use strict';
/**
 * Verbatim port — reference out/main/index.js lines 36394-36442
 * (`control:*` fleet-control group: setBreakerState, pause, autoDelivery,
 * resume, gateTool, steer, halt, unhalt, snapshot).
 *
 * The reference's `control` is a ControlRegistry instance (lines 24721-24820);
 * our clone keeps the same semantics behind `ctx.control` (installed here as a
 * verbatim-shaped compact copy when absent). `liveWebContents` maps to
 * ctx.win()/ctx.BrowserWindow; `analytics.trackMessageSent` has no clone dep —
 * routed through ctx.analytics?.trackMessageSent when present.
 */

const MAX_PENDING_STEERS = 20;

/** Verbatim ControlRegistry (reference lines 24721-24820). */
class ControlRegistry {
  map = new Map();
  ensure(id) {
    let c = this.map.get(id);
    if (!c) {
      c = {
        paused: false,
        halted: false,
        autoDeliveryPaused: false,
        gatedTools: new Set(),
        steerQueue: []
      };
      this.map.set(id, c);
    }
    return c;
  }
  // ─── Operator actions (wired to IPC) ───────────────────────────────────────
  pause(id, on) {
    this.ensure(id).paused = on;
  }
  pauseAutoDelivery(id, on) {
    this.ensure(id).autoDeliveryPaused = on;
  }
  replaceAutoDeliveryPauses(ids) {
    const paused = new Set(ids);
    for (const [id, control2] of this.map) {
      control2.autoDeliveryPaused = paused.has(id);
    }
    for (const id of paused) this.ensure(id).autoDeliveryPaused = true;
  }
  gateTool(id, tool, on) {
    const c = this.ensure(id);
    if (on) c.gatedTools.add(tool);
    else c.gatedTools.delete(tool);
  }
  steer(id, text) {
    const t = text.trim();
    if (!t) return;
    const q = this.ensure(id).steerQueue;
    if (q.length >= MAX_PENDING_STEERS) {
      console.warn(`[control] ${id}: steer queue full (${MAX_PENDING_STEERS}) — dropping oldest note`);
      q.shift();
    }
    q.push(t.slice(0, 1e4));
  }
  /** Request a graceful stop at the next hook boundary. */
  halt(id) {
    this.ensure(id).halted = true;
  }
  /** Cancel a pending halt before a hook boundary consumed it. The stop-after
   *  control is a toggle, and the second click means "keep going" — this
   *  touches ONLY the halt flag: pause, gated tools and queued steers stay
   *  exactly as they are (resume() is the broader clear). */
  unhalt(id) {
    const c = this.map.get(id);
    if (c) c.halted = false;
  }
  /** Drop all queued-but-undelivered steer notes (e.g. a steer withdrawn
   *  before a busy agent's next hook boundary consumed the instruction). */
  clearSteers(id) {
    const c = this.map.get(id);
    if (c) c.steerQueue.length = 0;
  }
  /** Clear pause + halt (lets a paused/halted agent run again). Keeps gates. */
  resume(id) {
    const c = this.ensure(id);
    c.paused = false;
    c.halted = false;
  }
  // ─── Reads (used by HookServer) ────────────────────────────────────────────
  shouldHalt(id) {
    return this.map.get(id)?.halted ?? false;
  }
  isAutoDeliveryPaused(id) {
    return this.map.get(id)?.autoDeliveryPaused ?? false;
  }
  /** Whether a tool call should be denied (paused agent, or this tool gated). */
  toolDecision(id, tool) {
    const c = this.map.get(id);
    if (!c) return { deny: false };
    if (c.paused) return { deny: true, reason: "Paused by operator — resume from the floor to continue." };
    if (tool && c.gatedTools.has(tool)) return { deny: true, reason: `Tool ${tool} is gated by the operator.` };
    return { deny: false };
  }
  /** Dequeue one pending steer note for delivery, or undefined. */
  takeSteer(id) {
    return this.map.get(id)?.steerQueue.shift();
  }
  snapshot(id) {
    const c = this.map.get(id);
    return {
      paused: c?.paused ?? false,
      halted: c?.halted ?? false,
      autoDeliveryPaused: c?.autoDeliveryPaused ?? false,
      gatedTools: c ? Array.from(c.gatedTools) : [],
      pendingSteers: c?.steerQueue.length ?? 0
    };
  }
}

function register(ctx) {
  // The reference `control` global — stash on ctx for hook server + other groups.
  const control = ctx.control ??= ctx.harness?.control ?? new ControlRegistry();
  if (ctx.harness && !ctx.harness.control) ctx.harness.control = control;
  // the watchdog reads pause/halt/delivery flags through this registry
  if (ctx.harness?.watchdog && !ctx.harness.watchdog.control) ctx.harness.watchdog.control = control;
  // the hook server's PreToolUse gate denies through this same registry
  if (ctx.harness?.hooks && !ctx.harness.hooks.control) ctx.harness.hooks.control = control;

  // liveWebContents() — verbatim: main window first, else any live window.
  const liveWebContents = () => {
    const wc = ctx.win()?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of ctx.BrowserWindow?.getAllWindows?.() ?? []) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };

  ctx.ipcMain.handle("control:setBreakerState", (_evt, state2) => {
    try {
      liveWebContents()?.send("control:breakerState", state2);
    } catch {
    }
    return { ok: true };
  });
  ctx.ipcMain.handle("control:pause", (_evt, agentId, on) => {
    if (typeof agentId !== "string") return null;
    control.pause(agentId, on === true);
    return control.snapshot(agentId);
  });
  ctx.ipcMain.handle("control:autoDelivery", (_evt, agentId, paused) => {
    if (typeof agentId !== "string") return null;
    const on = paused === true;
    control.pauseAutoDelivery(agentId, on);
    const current2 = new Set(ctx.readConfig().autoDeliveryPausedAgents ?? []);
    if (on) current2.add(agentId);
    else current2.delete(agentId);
    ctx.writeConfig({ autoDeliveryPausedAgents: Array.from(current2).sort() });
    return control.snapshot(agentId);
  });
  ctx.ipcMain.handle("control:resume", (_evt, agentId) => {
    if (typeof agentId !== "string") return null;
    control.resume(agentId);
    return control.snapshot(agentId);
  });
  ctx.ipcMain.handle("control:gateTool", (_evt, agentId, tool, on) => {
    if (typeof agentId !== "string" || typeof tool !== "string") return null;
    control.gateTool(agentId, tool, on === true);
    return control.snapshot(agentId);
  });
  ctx.ipcMain.handle("control:steer", (_evt, agentId, text) => {
    if (typeof agentId !== "string" || typeof text !== "string") return null;
    control.steer(agentId, text);
    ctx.analytics?.trackMessageSent?.("steer");
    return control.snapshot(agentId);
  });
  ctx.ipcMain.handle("control:halt", (_evt, agentId) => {
    if (typeof agentId !== "string") return null;
    control.halt(agentId);
    return control.snapshot(agentId);
  });
  ctx.ipcMain.handle("control:unhalt", (_evt, agentId) => {
    if (typeof agentId !== "string") return null;
    control.unhalt(agentId);
    return control.snapshot(agentId);
  });
  ctx.ipcMain.handle("control:snapshot", (_evt, agentId) => typeof agentId === "string" ? control.snapshot(agentId) : null);
}

module.exports = { register };

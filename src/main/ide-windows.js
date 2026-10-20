'use strict';
/**
 * IDE detach windows — verbatim port of the reference. A floor window can
 * detach its file panel into a separate ide.html window: IdeWindows tracks
 * owner↔IDE window pairs, the boot handoff (buffers + caret), the
 * attach-back ack dance, and collect-on-close. IdeDirtyLedger counts unsaved
 * buffers per window for the lose-your-edits confirm. meetingSystemAudio is
 * the 16 kHz PCM ring the meeting recorder cuts segments from.
 */

class IdeDirtyLedger {
  byWindow = new Map();
  /** True when the count for this window CHANGED. */
  report(id, n) {
    const count = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (this.get(id) === count) return false;
    if (count > 0) this.byWindow.set(id, count);
    else this.byWindow.delete(id);
    return true;
  }
  get(id) {
    return this.byWindow.get(id) ?? 0;
  }
  forget(id) {
    this.byWindow.delete(id);
  }
  total() {
    let sum = 0;
    for (const n of this.byWindow.values()) sum += n;
    return sum;
  }
}
function ideQuitWarning(unsaved) {
  const files = unsaved === 1 ? "1 file" : `${unsaved} files`;
  return {
    message: `${files} in the IDE ${unsaved === 1 ? "has" : "have"} unsaved changes.`,
    detail: "Closing now loses them. Unsaved text is never stored. Go back and save with Command S, or discard the changes from the tab menu."
  };
}
const str = (v) => typeof v === "string";
const strOrNull = (v) => str(v) ? v : null;
const posInt = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
const relOk = (rel) => str(rel) && rel.length > 0 && !rel.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(rel) && !rel.split(/[\\/]/).includes("..");
function cleanHandoff(x) {
  if (!x || typeof x !== "object") return null;
  const o = x;
  const raw = Array.isArray(o.buffers) ? o.buffers : [];
  const buffers = [];
  const seen = new Set();
  for (const b of raw) {
    const r = b ?? {};
    if (!relOk(r.rel) || !str(r.content) || !str(r.original) || seen.has(r.rel)) continue;
    seen.add(r.rel);
    buffers.push({ rel: r.rel, content: r.content, original: r.original });
  }
  const c = o.caret ?? null;
  const line = c ? posInt(c.line) : null;
  const column = c ? posInt(c.column) : null;
  const caret = c && relOk(c.rel) && line && column ? { rel: c.rel, line, column } : null;
  return {
    handoff: { agentId: strOrNull(o.agentId), root: strOrNull(o.root), buffers, caret },
    dropped: raw.length - buffers.length
  };
}
function cleanOpenRequest(x) {
  if (!x || typeof x !== "object") return null;
  const o = x;
  return { path: strOrNull(o.path), agentId: strOrNull(o.agentId) };
}
function cleanIdeAgents(x) {
  if (!Array.isArray(x)) return [];
  const out = [];
  for (const a of x) {
    const o = a ?? {};
    if (!str(o.id) || !str(o.name) || !str(o.cwd) || !str(o.character)) continue;
    out.push({ id: o.id, name: o.name, cwd: o.cwd, character: o.character, ...o.isGod === true ? { isGod: true } : {} });
  }
  return out;
}
class IdeWindows {
  constructor(deps) {
    this.deps = deps;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  }
  byOwner = new Map();
  ownerOf = new Map();
  pending = new Map();
  attaching = new Set();
  collecting = new Map();
  acks = new Map();
  /** Each owner's latest agent list. Kept, not only forwarded: a list sent
   *  while the IDE window is still loading would be lost, so the window asks
   *  for it with its handoff (C5). */
  agentLists = new Map();
  setTimer;
  clearTimer;
  live(ownerId) {
    const w = this.byOwner.get(ownerId);
    return w && !w.isDestroyed() ? w : null;
  }
  forget(ideId) {
    const ownerId = this.ownerOf.get(ideId);
    this.ownerOf.delete(ideId);
    this.pending.delete(ideId);
    this.attaching.delete(ideId);
    const t = this.collecting.get(ideId);
    if (t !== void 0) {
      this.clearTimer(t);
      this.collecting.delete(ideId);
    }
    if (ownerId !== void 0 && this.byOwner.get(ownerId)?.id === ideId) this.byOwner.delete(ownerId);
    return ownerId;
  }
  isIde(id) {
    return this.ownerOf.has(id);
  }
  ownerIdOf(ideId) {
    return this.ownerOf.get(ideId) ?? null;
  }
  /** The owner's IDE window id, for its unsaved count on the owner's close. */
  ideIdFor(ownerId) {
    return this.live(ownerId)?.id ?? null;
  }
  stateFor(ownerId) {
    return { detached: this.live(ownerId) !== null };
  }
  /** Detach: make the owner's IDE window and keep the handoff for it. A second
   *  Detach while one is open is refused (the owner's panel then stays open
   *  with its buffers) and the open window comes forward. */
  detach(ownerId, raw) {
    const clean = cleanHandoff(raw);
    if (!clean) return { ok: false, reason: "bad-handoff" };
    const open = this.live(ownerId);
    if (open) {
      open.show();
      return { ok: false, reason: "already" };
    }
    const win = this.deps.create(ownerId);
    this.byOwner.set(ownerId, win);
    this.ownerOf.set(win.id, ownerId);
    this.pending.set(win.id, clean.handoff);
    return { ok: true, dropped: clean.dropped };
  }
  /** The IDE window asks for its handoff once, at boot. */
  takeHandoff(ideId) {
    const h = this.pending.get(ideId) ?? null;
    this.pending.delete(ideId);
    return h;
  }
  /** An open from the owner. False when the owner has no IDE window, and the
   *  owner then opens its own panel. */
  openIn(ownerId, raw) {
    const win = this.live(ownerId);
    const req = cleanOpenRequest(raw);
    if (!win || !req) return false;
    win.send("ide:open", req);
    win.show();
    return true;
  }
  /** The owner's agents, so an agent hired after Detach is known (C5). */
  agents(ownerId, raw) {
    const list = cleanIdeAgents(raw);
    this.agentLists.set(ownerId, list);
    this.live(ownerId)?.send("ide:agents", list);
  }
  /** What an IDE window reads at boot: its handoff, once, and its owner's agents. */
  boot(ideId) {
    const ownerId = this.ownerOf.get(ideId);
    return { handoff: this.takeHandoff(ideId), agents: ownerId === void 0 ? [] : this.agentLists.get(ownerId) ?? [] };
  }
  /** Attach, from the IDE window's button or its close. */
  async attach(ideId, raw) {
    const ownerId = this.ownerOf.get(ideId);
    if (ownerId === void 0) return { ok: false, reason: "not-ide" };
    const owner = this.deps.owner(ownerId);
    if (!owner || owner.isDestroyed()) return { ok: false, reason: "no-owner" };
    const handoff = cleanHandoff(raw)?.handoff ?? { agentId: null, root: null, buffers: [], caret: null };
    this.attaching.add(ideId);
    const t = this.collecting.get(ideId);
    if (t !== void 0) {
      this.clearTimer(t);
      this.collecting.delete(ideId);
    }
    const acked = await new Promise((resolve) => {
      const timer = this.setTimer(() => {
        this.acks.delete(ownerId);
        resolve(false);
      }, this.deps.ackMs ?? 5e3);
      this.acks.set(ownerId, (ok) => {
        this.clearTimer(timer);
        this.acks.delete(ownerId);
        resolve(ok);
      });
      owner.send("ide:attached", handoff);
    });
    if (!acked) {
      this.attaching.delete(ideId);
      return { ok: false, reason: "no-ack" };
    }
    const win = this.byOwner.get(ownerId);
    this.forget(ideId);
    if (win && !win.isDestroyed()) win.destroy();
    return { ok: true };
  }
  /** The owner has the buffers in its store. */
  ack(ownerId) {
    this.acks.get(ownerId)?.(true);
  }
  /** The IDE window's close (its button, ⌘W). True lets it close. Otherwise
   *  the window is asked for its buffers and closes through `attach`. */
  closeRequested(ideId, quitting) {
    if (quitting || this.attaching.has(ideId) || !this.ownerOf.has(ideId)) return true;
    const ownerId = this.ownerOf.get(ideId);
    const owner = this.deps.owner(ownerId);
    if (!owner || owner.isDestroyed()) return true;
    if (this.collecting.has(ideId)) return false;
    const win = this.byOwner.get(ownerId);
    win?.send("ide:collect");
    this.collecting.set(ideId, this.setTimer(() => {
      this.collecting.delete(ideId);
      this.deps.giveUp(ideId);
    }, this.deps.collectMs ?? 5e3));
    return false;
  }
  /** The IDE window is gone however it went. An owner that was not handed
   *  the buffers by `attach` is still told, so it stops routing. */
  closed(ideId) {
    const ownerId = this.forget(ideId);
    if (ownerId === void 0) return;
    const owner = this.deps.owner(ownerId);
    if (owner && !owner.isDestroyed()) owner.send("ide:attached", null);
  }
  /** The owner closed: its IDE window goes with it. The owner's own close
   *  already counted the IDE window's unsaved files (index.ts). */
  ownerClosed(ownerId) {
    this.agentLists.delete(ownerId);
    const win = this.byOwner.get(ownerId);
    if (!win) return;
    this.forget(win.id);
    if (!win.isDestroyed()) win.destroy();
  }
}

// ─── meeting system-audio ring (verbatim) ───────────────────────────────────
const RING_RATE = 16e3;
function createMeetingSystemAudio() {
  let ring = null;
  return {
    begin(startedAt = Date.now()) {
      ring = { startedAt, chunks: [], samples: 0 };
    },
    active() {
      return ring !== null;
    },
    push(pcm16, ts) {
      if (!ring) return;
      const pcm = pcm16 instanceof Int16Array ? pcm16 : new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2));
      if (pcm.length === 0) return;
      const at = typeof ts === "number" && Number.isFinite(ts) ? ts : ring.startedAt + ring.samples / RING_RATE * 1e3;
      ring.chunks.push({ at, pcm: pcm.slice() });
      ring.samples += pcm.length;
    },
    /** The samples between two moments on the wall clock, silence where the
     *  helper gave nothing (a gap is a gap, never a time shift). */
    cut(fromAt, toAt) {
      const n = Math.max(0, Math.round((toAt - fromAt) / 1e3 * RING_RATE));
      const out = new Int16Array(n);
      if (!ring || n === 0) return out;
      for (const c of ring.chunks) {
        const offset = Math.round((c.at - fromAt) / 1e3 * RING_RATE);
        if (offset >= n || offset + c.pcm.length <= 0) continue;
        const src0 = Math.max(0, -offset);
        const dst0 = Math.max(0, offset);
        const len = Math.min(c.pcm.length - src0, n - dst0);
        if (len > 0) out.set(c.pcm.subarray(src0, src0 + len), dst0);
      }
      return out;
    },
    /** Drop what a delivered segment no longer needs, so a long call does not
     *  hold every chunk of itself. */
    trim(beforeAt) {
      if (!ring) return;
      ring.chunks = ring.chunks.filter((c) => c.at + c.pcm.length / RING_RATE * 1e3 > beforeAt);
    },
    end() {
      ring = null;
    }
  };
}

module.exports = {
  IdeDirtyLedger, ideQuitWarning, relOk, cleanHandoff, cleanOpenRequest,
  cleanIdeAgents, IdeWindows,
  RING_RATE, createMeetingSystemAudio,
};

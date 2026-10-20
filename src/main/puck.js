'use strict';
/**
 * Puck — the floating mascot's config surface, verbatim port of the
 * reference. The puck is a stapler-shaped companion: shape + seed feed a
 * deterministic renderer; traits are 0..0.999 floats keyed by STAPLER_TRAITS;
 * the config carries corner/snap/home, capture region, action toggles and
 * meeting-segment length. Everything is normalized so a corrupt config can't
 * wedge the window geometry or the renderer.
 */
const STAPLER_TRAITS = [
  { key: "body.r", group: "body", label: "size" },
  { key: "body.ratio", group: "body", label: "proportion" },
  { key: "body.n", group: "body", label: "squareness" },
  { key: "body.rot", group: "body", label: "tilt", shapes: ["boxy", "triangle", "hexagon"] },
  { key: "capsule.squat", group: "body", label: "squat", shapes: ["capsule"] },
  { key: "poly.round", group: "body", label: "cornerRounding", shapes: ["triangle", "hexagon"] },
  { key: "eye.rx", group: "eyes", label: "eyeSize" },
  { key: "eye.ratio", group: "eyes", label: "roundness" },
  { key: "eye.n", group: "eyes", label: "eyeSquareness" },
  { key: "eye.gap", group: "eyes", label: "separation" },
  { key: "eye.lean", group: "eyes", label: "lean" },
  { key: "gaze.x", group: "eyes", label: "gazeX" },
  { key: "gaze.y", group: "eyes", label: "gazeY" },
  { key: "sun.n", group: "decoration", label: "petals", shapes: ["sun"] },
  { key: "sun.dist", group: "decoration", label: "petalDistance", shapes: ["sun"] },
  { key: "sun.r", group: "decoration", label: "petalSize", shapes: ["sun"] },
  { key: "sun.rot", group: "decoration", label: "petalRotation", shapes: ["sun"] },
  { key: "cloud.n", group: "decoration", label: "lobes", shapes: ["cloud"] },
  { key: "nub.n", group: "decoration", label: "nubs", shapes: ["nub"] },
  { key: "nub.a0", group: "decoration", label: "nubAngle", shapes: ["nub"] },
  { key: "nub.r0", group: "decoration", label: "nubSize", shapes: ["nub"] },
  { key: "droplet.tip", group: "decoration", label: "tipLength", shapes: ["droplet"] }
];
const STAPLER_TRAIT_KEYS = STAPLER_TRAITS.map((t) => t.key);
const TRAIT_TOP = 0.999;
function clampTrait(v) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(TRAIT_TOP, Math.max(0, n)) * 1e3) / 1e3;
}
function normalizeStaplerTraits(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const key of STAPLER_TRAIT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const v = clampTrait(input[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}
const PUCK_SHAPES = ["auto", "round", "organic", "boxy", "nub", "cloud", "sun", "capsule", "triangle", "hexagon", "droplet"];
const PUCK_EXPRESSIONS = ["idle", "happy", "sad", "mad", "surprised", "wink", "sleepy", "smug", "unsure", "scared", "love", "shy", "sick", "thinking"];
const LEGACY_FACE_EXPRESSION = {
  calm: "idle",
  happy: "happy",
  wink: "wink",
  cool: "smug",
  curious: "thinking"
};
const PUCK_SEED_MAX = 64;
const PUCK_DEFAULT_SEED = "puck";
const PUCK_DEFAULT_COLOR = "#FFC94F";
const PUCK_SWATCHES = [
  { id: "cream", hex: "#FFF8E7", group: "pastel" },
  { id: "grey", hex: "#D9D3DE", group: "pastel" },
  { id: "red", hex: "#F5B3AB", group: "pastel" },
  { id: "blue", hex: "#B3D4F0", group: "pastel" },
  { id: "green", hex: "#B4DEC3", group: "pastel" },
  { id: "yellow", hex: PUCK_DEFAULT_COLOR, group: "pastel" },
  { id: "coral", hex: "#D96A62", group: "vibrant" },
  { id: "peach", hex: "#D99168", group: "vibrant" },
  { id: "lemon", hex: "#DCAB3C", group: "vibrant" },
  { id: "mint", hex: "#5CA97A", group: "vibrant" },
  { id: "sky", hex: "#4F9FAF", group: "vibrant" },
  { id: "lilac", hex: "#9482D3", group: "vibrant" }
];
function normalizeHex(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(s)) return `#${s.split("").map((c) => c + c).join("").toUpperCase()}`;
  return null;
}
const LEGACY_COLOR = {
  ...Object.fromEntries(PUCK_SWATCHES.map((s) => [s.id, s.hex])),
  auto: PUCK_DEFAULT_COLOR,
  amber: PUCK_DEFAULT_COLOR,
  lime: "#B4DEC3",
  violet: "#D9D3DE",
  rose: "#F5B3AB"
};
const PUCK_CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"];
const PUCK_ACTIONS = ["screenshot", "message", "meeting", "invisible", "computerUse"];
const PUCK_SIZE = { min: 48, max: 160, default: 80 };
const PUCK_OPACITY = { min: 40, max: 100, default: 90 };
const PUCK_SEGMENT_MINUTES = { min: 2, max: 20, default: 10 };
const PUCK_MESSAGE_MAX_SECONDS = 300;
const DEFAULT_PUCK_CONFIG = {
  seed: PUCK_DEFAULT_SEED,
  shape: "auto",
  expression: "idle",
  size: PUCK_SIZE.default,
  color: PUCK_DEFAULT_COLOR,
  opacity: PUCK_OPACITY.default,
  corner: "bottom-right",
  segmentMinutes: PUCK_SEGMENT_MINUTES.default
};
function clampInt(v, min, max, fallback) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function isPoint(v) {
  return !!v && typeof v === "object" && Number.isFinite(v.x) && Number.isFinite(v.y);
}
function isHome(v) {
  const h = v;
  return !!h && typeof h === "object" && Number.isFinite(h.displayId) && Number.isFinite(h.dx) && Number.isFinite(h.dy);
}
function isRegion(v) {
  if (!v || typeof v !== "object") return false;
  const r = v;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width >= 8 && r.height >= 8;
}
function normalizePuckConfig(input) {
  const d = DEFAULT_PUCK_CONFIG;
  const raw = input && typeof input === "object" ? input : {};
  const actions = raw.actions && typeof raw.actions === "object" ? raw.actions : {};
  const region = isRegion(raw.captureRegion) ? {
    x: Math.round(raw.captureRegion.x),
    y: Math.round(raw.captureRegion.y),
    width: Math.round(raw.captureRegion.width),
    height: Math.round(raw.captureRegion.height),
    displayId: typeof raw.captureRegion.displayId === "string" ? raw.captureRegion.displayId : null
  } : null;
  const legacyFace = raw.face;
  const legacy = typeof legacyFace === "string" ? LEGACY_FACE_EXPRESSION[legacyFace] : void 0;
  const seed = typeof raw.seed === "string" ? raw.seed.trim().slice(0, PUCK_SEED_MAX) : "";
  return {
    enabled: raw.enabled === true,
    seed: seed || d.seed,
    shape: PUCK_SHAPES.includes(raw.shape) ? raw.shape : d.shape,
    expression: PUCK_EXPRESSIONS.includes(raw.expression) ? raw.expression : legacy ?? d.expression,
    traits: normalizeStaplerTraits(raw.traits),
    eyesFollow: raw.eyesFollow !== false,
    size: clampInt(raw.size, PUCK_SIZE.min, PUCK_SIZE.max, d.size),
    color: normalizeHex(raw.color) ?? (typeof raw.color === "string" && LEGACY_COLOR[raw.color] || d.color),
    opacity: clampInt(raw.opacity, PUCK_OPACITY.min, PUCK_OPACITY.max, d.opacity),
    alwaysOnTop: raw.alwaysOnTop !== false,
    snapToEdges: raw.snapToEdges !== false,
    corner: PUCK_CORNERS.includes(raw.corner) ? raw.corner : d.corner,
    position: isPoint(raw.position) ? { x: Math.round(raw.position.x), y: Math.round(raw.position.y) } : null,
    home: isHome(raw.home) ? { displayId: raw.home.displayId, dx: Math.round(raw.home.dx), dy: Math.round(raw.home.dy) } : null,
    actions: Object.fromEntries(PUCK_ACTIONS.map((a) => [a, actions[a] !== false])),
    captureRegion: region,
    invisibleWhileRecording: raw.invisibleWhileRecording !== false,
    segmentMinutes: clampInt(raw.segmentMinutes, PUCK_SEGMENT_MINUTES.min, PUCK_SEGMENT_MINUTES.max, d.segmentMinutes),
    language: typeof raw.language === "string" ? raw.language.trim().slice(0, 8) : "",
    sendTo: typeof raw.sendTo === "string" ? raw.sendTo.trim().slice(0, 120) : ""
  };
}
const RING = {
  /** A fan (see ringLayout) may widen up to here when its buttons would
   *  otherwise touch. Never in the open. */
  maxRadius: 1.8,
  /** A ring button's diameter. */
  button: 0.62,
  /** Room for a label beside a button, and above or below one; the window
   *  footprint pays for it. */
  label: 96
};
function ringFootprint(size) {
  return Math.ceil(size + 2 * (size * RING.maxRadius + size * RING.button / 2 + RING.label));
}
const CORNER_MARGIN = 24;
const SNAP_DISTANCE = 96;
const SNAP_MARGIN = 12;
function cornerPosition(corner, area, size) {
  const half = size / 2;
  const left = area.x + CORNER_MARGIN + half;
  const right = area.x + area.width - CORNER_MARGIN - half;
  const top = area.y + CORNER_MARGIN + half;
  const bottom = area.y + area.height - CORNER_MARGIN - half;
  switch (corner) {
    case "top-left":
      return { x: left, y: top };
    case "top-right":
      return { x: right, y: top };
    case "bottom-left":
      return { x: left, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
  }
}
function clampCentre(p, area, size) {
  const half = size / 2;
  return {
    x: Math.round(Math.min(area.x + area.width - half, Math.max(area.x + half, p.x))),
    y: Math.round(Math.min(area.y + area.height - half, Math.max(area.y + half, p.y)))
  };
}
function isZoomKey(input, mac) {
  if (input.type !== "keyDown") return false;
  if (!(mac ? input.meta : input.control)) return false;
  const k = input.key ?? "";
  const c = input.code ?? "";
  return k === "+" || k === "=" || k === "-" || k === "_" || k === "0" || c === "Equal" || c === "Minus" || c === "Digit0" || c === "NumpadAdd" || c === "NumpadSubtract" || c === "Numpad0";
}
function snapToEdge(p, area, size) {
  const half = size / 2;
  const edges = [
    { axis: "x", at: area.x + SNAP_MARGIN + half, d: Math.abs(p.x - half - area.x) },
    { axis: "x", at: area.x + area.width - SNAP_MARGIN - half, d: Math.abs(area.x + area.width - (p.x + half)) },
    { axis: "y", at: area.y + SNAP_MARGIN + half, d: Math.abs(p.y - half - area.y) },
    { axis: "y", at: area.y + area.height - SNAP_MARGIN - half, d: Math.abs(area.y + area.height - (p.y + half)) }
  ].sort((a, b) => a.d - b.d);
  const nearest = edges[0];
  if (nearest.d > SNAP_DISTANCE) return clampCentre(p, area, size);
  return clampCentre(nearest.axis === "x" ? { x: Math.round(nearest.at), y: p.y } : { x: p.x, y: Math.round(nearest.at) }, area, size);
}
function centreOf(area) {
  return { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) };
}
function windowFor(centre2, area, size) {
  const side = ringFootprint(size);
  const c = clampCentre(centre2, area, size);
  const wanted = { x: c.x - side / 2, y: c.y - side / 2 };
  const maxX = area.x + Math.max(0, area.width - side);
  const maxY = area.y + Math.max(0, area.height - side);
  const x = Math.round(Math.min(maxX, Math.max(area.x, wanted.x)));
  const y = Math.round(Math.min(maxY, Math.max(area.y, wanted.y)));
  return {
    window: { x, y, width: side, height: side },
    offset: { x: c.x - x, y: c.y - y },
    screen: { x0: area.x - x, y0: area.y - y, x1: area.x + area.width - x, y1: area.y + area.height - y }
  };
}
const inside = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
function resolvePuckPlacement(input) {
  const { displays, home, position } = input;
  if (displays.length === 0) return null;
  const parked = home ? displays.find((d) => d.id === home.displayId) : void 0;
  if (parked && home) {
    return { display: parked, centre: clampCentre({ x: parked.bounds.x + home.dx, y: parked.bounds.y + home.dy }, parked.workArea, input.size), source: "home" };
  }
  const main = displays.find((d) => d.id === input.primaryId) ?? displays[0];
  if (!home && position) {
    const on = displays.find((d) => inside(position, d.bounds));
    if (on) return { display: on, centre: clampCentre(position, on.workArea, input.size), source: "position" };
    return { display: main, centre: centreOf(main.workArea), source: "centre" };
  }
  return { display: main, centre: cornerPosition(input.corner, main.workArea, input.size), source: "corner" };
}
const REGION_MIN = 24;
function initialRegion(saved, display) {
  if (saved && (saved.displayId === null || saved.displayId === display.id)) {
    const r = clampRegion(saved, display.width, display.height);
    if (r.width >= REGION_MIN && r.height >= REGION_MIN) return r;
  }
  const width = Math.max(REGION_MIN, Math.round(display.width / 3));
  const height = Math.max(REGION_MIN, Math.round(display.height / 3));
  return { x: Math.round((display.width - width) / 2), y: Math.round((display.height - height) / 2), width, height };
}
function clampRegion(r, width, height) {
  const w = Math.max(REGION_MIN, Math.min(width, Math.round(r.width)));
  const h = Math.max(REGION_MIN, Math.min(height, Math.round(r.height)));
  const x = Math.max(0, Math.min(width - w, Math.round(r.x)));
  const y = Math.max(0, Math.min(height - h, Math.round(r.y)));
  return { x, y, width: w, height: h };
}
const PUCK_MEETING_DESCRIPTION_MAX = 4e3;
const PUCK_MEETING_TEXT_MAX = 2e6;
const PUCK_MEETING_INLINE_MAX = 12e3;
const PUCK_MEETING_SEND_MAX = 20;
function meetingEditable(status) {
  return status !== "recording" && status !== "transcribing";
}
function meetingMessage(m) {
  const description = (m.description ?? "").trim();
  const text = m.text.trim();
  const inline = text.length > 0 && text.length <= PUCK_MEETING_INLINE_MAX;
  const lines = [`Meeting "${m.title}" (id ${m.id}), recorded ${m.startedAt} with the Stapler.`];
  if (description) lines.push("", "Description or prompt from the person:", description);
  if (inline) {
    lines.push("", `Transcript (also at ${m.transcriptPath}):`, "", text);
  } else if (text) {
    lines.push("", `Transcript: ${m.transcriptPath}`, `It is ${text.length} characters, too long to paste here. Read it at that path.`);
  } else {
    lines.push("", `The transcript is empty so far (${m.transcriptPath}).`);
  }
  return { subject: `Meeting: ${m.title}`.slice(0, 120), body: lines.join("\n"), inline };
}
function segmentTranscribed(s) {
  return s.transcribed && (!s.them || s.them.transcribed);
}
function segmentError(s) {
  return s.error ?? s.them?.error ?? null;
}
function settleMeetingStatus(meta) {
  if (!meta.endedAt) return "recording";
  if (meta.segments.length === 0) return "failed";
  if (meta.segments.every(segmentTranscribed)) return "done";
  if (meta.segments.some((s) => segmentError(s))) return "failed";
  return "pending";
}
function clockOf(ms2) {
  const s = Math.max(0, Math.floor(ms2 / 1e3));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${two(h)}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}
function meetingIdFor(date) {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}
function puckRecipients(activeIds, nameOf, godId = "god") {
  const ids = [godId, ...activeIds.filter((id) => id !== godId)];
  const named = ids.map((id) => ({ id, name: (nameOf(id) || id).trim() || id }));
  const count = /* @__PURE__ */ new Map();
  for (const r of named) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  return named.map((r) => (count.get(r.name) ?? 0) > 1 && r.id !== godId ? { id: r.id, name: `${r.name} (${r.id})` } : r);
}
function sendToFor(pick, godId = "god") {
  const id = pick.trim();
  return id === godId ? "" : id;
}
const DEFAULT_PUCK_STATE = {
  shown: false,
  menuOpen: false,
  invisible: false,
  recording: null,
  canTranscribe: false,
  dictation: true,
  screenAccess: "unknown",
  offset: { x: 0, y: 0 },
  screen: null,
  capturing: false,
  theme: "light",
  recipient: "",
  recipientId: "god",
  recipients: []
};
const PUCK_SHOT_TTL_MS = 24 * 60 * 60 * 1e3;
const PUCK_MAX_SHOTS = 8;
const PUCK_AUDIO_TTL_MS = 24 * 60 * 60 * 1e3;
const PUCK_SWEEP_EVERY_MS = 60 * 60 * 1e3;
const PUCK_DIR = "puck";
const PUCK_SCREENSHOTS_DIR = "screenshots";
const PUCK_MEETINGS_DIR = "meetings";
const AGENT_ORDER_MAX = 1e3;
function normalizeAgentOrder(input) {
  if (!Array.isArray(input)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= AGENT_ORDER_MAX) break;
  }
  return out;
}
const DEFAULT_TRIGGER_MODE = "strict";
function isAutoAllowed(mode2, kind) {
  if (mode2 === "allow-all") return true;
  if (mode2 === "communication-only") return kind === "communication";
  return false;
}
function classifyInboundKind(text) {
  const t = text.trim().toLowerCase();
  if (!t) return "communication";
  const asksOnly = /^(what|how|when|where|who|why|is|are|do|does|did|can|could|status|any)\b/.test(t) && t.endsWith("?") && !/\b(fix|build|ship|deploy|run|write|create|add|remove|delete|refactor|implement|update|merge|revert)\b/.test(t);
  return asksOnly ? "communication" : "directive";
}
const DEFAULT_COMPACTION_FOCUS = "Keep the current task, recent decisions, open questions, and file paths in play. Drop resolved tangents.";
const DEFAULT_CONTEXT_TRIGGER = {
  compact: {
    enabled: true,
    // Founder, 23 Sep 2026 (0.5.3): every 40 minutes at 30% of the window,
    // and 30% on a ~1M window too, his word: one bar for every model size.
    // Was 2h at 60% / 40% (and 1h before that). The maintenance mission in
    // main/config.ts carries the same 40 minutes; the two must agree.
    everyMs: 24e5,
    minContextPct: 30,
    minContextPctLargeWindow: 30,
    message: DEFAULT_COMPACTION_FOCUS
  },
  clear: {
    enabled: false,
    everyMs: 72e5,
    minContextPct: 90,
    minContextPctLargeWindow: 80,
    message: ""
  }
};

module.exports = {
  STAPLER_TRAITS, STAPLER_TRAIT_KEYS, TRAIT_TOP, clampTrait, normalizeStaplerTraits,
  PUCK_SHAPES, PUCK_EXPRESSIONS, LEGACY_FACE_EXPRESSION,
  PUCK_SEED_MAX, PUCK_DEFAULT_SEED, PUCK_DEFAULT_COLOR, PUCK_SWATCHES, LEGACY_COLOR,
  normalizeHex, PUCK_CORNERS, PUCK_ACTIONS, PUCK_SIZE, PUCK_OPACITY,
  PUCK_SEGMENT_MINUTES, PUCK_MESSAGE_MAX_SECONDS, DEFAULT_PUCK_CONFIG,
  clampInt, isPoint, isHome, isRegion, normalizePuckConfig,
  RING, ringFootprint, CORNER_MARGIN, SNAP_DISTANCE, SNAP_MARGIN,
  cornerPosition, clampCentre, isZoomKey, snapToEdge, centreOf, windowFor,
  inside, resolvePuckPlacement, REGION_MIN, initialRegion, clampRegion,
  PUCK_MEETING_DESCRIPTION_MAX, PUCK_MEETING_TEXT_MAX, PUCK_MEETING_INLINE_MAX, PUCK_MEETING_SEND_MAX,
  meetingEditable, meetingMessage, segmentTranscribed, segmentError, settleMeetingStatus,
  clockOf, meetingIdFor, puckRecipients, sendToFor,
  DEFAULT_PUCK_STATE, PUCK_SHOT_TTL_MS, PUCK_MAX_SHOTS, PUCK_AUDIO_TTL_MS, PUCK_SWEEP_EVERY_MS,
  PUCK_DIR, PUCK_SCREENSHOTS_DIR, PUCK_MEETINGS_DIR, AGENT_ORDER_MAX, normalizeAgentOrder,
  DEFAULT_TRIGGER_MODE, isAutoAllowed, classifyInboundKind,
  DEFAULT_COMPACTION_FOCUS, DEFAULT_CONTEXT_TRIGGER,
};

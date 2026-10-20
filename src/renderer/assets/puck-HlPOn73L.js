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
function traitsFor(shape, group) {
  return STAPLER_TRAITS.filter((t) => t.group === group && (!t.shapes || t.shapes.includes(shape)));
}
const utf8 = new TextEncoder();
function feed(h, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 3432918353);
    h = h << 13 | h >>> 19;
  }
  return h;
}
function finalize(h) {
  h = Math.imul(h ^ h >>> 16, 2246822507);
  h = Math.imul(h ^ h >>> 13, 3266489909);
  return (h ^ h >>> 16) >>> 0;
}
function hashedTrait(seed, key) {
  const s = seed.normalize("NFC").trim().toLowerCase();
  const state = feed(1779033703 ^ s.length, utf8.encode(s));
  return finalize(feed(feed(state, Uint8Array.of(255)), utf8.encode(key))) / 4294967296;
}
const PUCK_SHAPES = ["auto", "round", "organic", "boxy", "nub", "cloud", "sun", "capsule", "triangle", "hexagon", "droplet"];
const PUCK_SHAPE_TRAIT = {
  round: 0.11,
  organic: 0.35,
  boxy: 0.54,
  capsule: 0.65,
  nub: 0.745,
  cloud: 0.825,
  droplet: 0.8875,
  hexagon: 0.9325,
  sun: 0.965,
  triangle: 0.99
};
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
const linear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
function rgbOf(hex) {
  const h = normalizeHex(hex) ?? PUCK_DEFAULT_COLOR;
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function oklchHue(hex) {
  const [r, g, b] = rgbOf(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
}
const EYE_FLIP = 0.18;
function bodyLook(hex) {
  return { hue: Math.round(oklchHue(hex)), tone: luminance(hex) > EYE_FLIP ? 0 : 0.999 };
}
const PUCK_CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"];
const PUCK_ACTIONS = ["screenshot", "message", "meeting", "invisible", "computerUse"];
const PUCK_SIZE = { min: 48, max: 160, default: 80 };
const PUCK_OPACITY = { min: 40, max: 100, default: 90 };
const PUCK_SEGMENT_MINUTES = { min: 2, max: 20, default: 10 };
const PUCK_MESSAGE_MAX_SECONDS = 300;
const PUCK_MESSAGE_SEGMENT = { minMs: 6e3, maxMs: 3e4, pauseMs: 700, quiet: 0.02 };
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
  /** Distance from the disc centre to each button centre, in the open. The
   *  founder asked for the buttons close to the puck (7 Sep 2026): 1.1 leaves
   *  a gap of about a third of the disc between its edge and a button's. */
  radius: 1.1,
  /** A fan (see ringLayout) may widen up to here when its buttons would
   *  otherwise touch. Never in the open. */
  maxRadius: 1.8,
  /** A ring button's diameter. */
  button: 0.62,
  /** Air between two neighbouring buttons, at least, in disc units. */
  gap: 0.06,
  /** Air between a button and the screen edge, px. */
  pad: 4,
  /** A fan never spreads its buttons further apart than this, degrees. */
  maxSpacing: 48,
  /** The close control sits on the ring like every button, straight below
   *  at 180, the free slot between Invisible (130) and Computer use (230).
   *  At 1.0 the orbit line ran through the cross (founder, 1 Oct 2026: "the
   *  cross button in stapler is not aligned"). */
  closeRadius: 1.1,
  closeButton: 0.42,
  /** Room for a label beside a button, and above or below one; the window
   *  footprint pays for it. */
  label: 96,
  labelHeight: 30
};
const RING_ANGLE = {
  screenshot: 0,
  meeting: 60,
  invisible: 130,
  computerUse: 230,
  message: 300
};
function slotAt(action, angle, r, label = circleLabel(angle)) {
  const rad = angle * Math.PI / 180;
  return { action, angle: (angle % 360 + 360) % 360, x: Math.round(Math.sin(rad) * r), y: Math.round(-Math.cos(rad) * r), label };
}
function ringSlots(actions, size) {
  const r = size * RING.radius;
  return PUCK_ACTIONS.filter((a) => actions[a]).map((a) => ({ action: a, angle: RING_ANGLE[a] })).sort((a, b) => a.angle - b.angle).map(({ action, angle }) => slotAt(action, angle, r));
}
function ringFootprint(size) {
  return Math.ceil(size + 2 * (size * RING.maxRadius + size * RING.button / 2 + RING.label));
}
const PAIR_LABEL_W = { capture: 72, cancel: 42 };
const PAIR_LABEL_GAP = 6;
function capturePair(size, room) {
  const button = Math.round(size * RING.button);
  const half = button / 2;
  const byLabels = Math.ceil((PAIR_LABEL_W.capture + PAIR_LABEL_W.cancel) / 4 + PAIR_LABEL_GAP / 2);
  const dx = Math.max(Math.round(half + Math.max(8, size * 0.12)), byLabels);
  const r = Math.round(size * RING.radius);
  const below = r + half + RING.labelHeight + RING.pad <= room.bottom;
  return { below, y: below ? r : -r, capture: { x: -dx }, cancel: { x: dx }, button };
}
const PAIR_LABEL_HALF = 44;
const PAIR_GAP = 12;
function placePair(size, disc, room, space, card) {
  const base = capturePair(size, room);
  const half = base.button / 2;
  const dx = base.cancel.x;
  const wing = dx + Math.max(half, PAIR_LABEL_HALF);
  const LABEL_DROP = 14;
  const LABEL_H = 10;
  const clampX = (x) => Math.round(Math.max(space.x0 + wing, Math.min(space.x1 - wing, x)));
  const boxAt = (x, y2) => ({ x0: x - wing, x1: x + wing, y0: y2 - half, y1: y2 + half + LABEL_DROP + LABEL_H });
  const discBox = { x0: disc.cx - size / 2, x1: disc.cx + size / 2, y0: disc.cy - size / 2, y1: disc.cy + size / 2 };
  const meets = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const fits = (b) => b.x0 >= space.x0 && b.x1 <= space.x1 && b.y0 >= space.y0 && b.y1 <= space.y1;
  if (card) {
    const mid = clampX((card.x0 + card.x1) / 2);
    const tries = [
      ["above", mid, card.y0 - PAIR_GAP - LABEL_H - LABEL_DROP - half],
      ["below", mid, card.y1 + PAIR_GAP + half],
      ...disc.cx >= (card.x0 + card.x1) / 2 ? [["left", card.x0 - PAIR_GAP - wing, card.y0 + half], ["right", card.x1 + PAIR_GAP + wing, card.y0 + half]] : [["right", card.x1 + PAIR_GAP + wing, card.y0 + half], ["left", card.x0 - PAIR_GAP - wing, card.y0 + half]]
    ];
    for (const [at, x, y2] of tries) {
      const b = boxAt(x, y2);
      if (fits(b) && !meets(b, card) && !meets(b, discBox)) return { x: Math.round(x), y: Math.round(y2), dx, button: base.button, labelTop: Math.round(y2 + half + LABEL_DROP), at };
    }
  }
  const y = disc.cy + base.y;
  return { x: clampX(disc.cx), y, dx, button: base.button, labelTop: base.below ? y + half + LABEL_DROP : y - half - LABEL_DROP, at: "disc" };
}
function placeCapturePair(size, disc, room, space, card) {
  const pair = placePair(size, disc, room, space, card);
  if (!card || pair.at !== "disc") return { pair, foldCard: false };
  return { pair: placePair(size, disc, room, space, null), foldCard: true };
}
function labelSide(angle) {
  const rad = angle * Math.PI / 180;
  const s = Math.sin(rad);
  if (s >= 0.35) return "right";
  if (s <= -0.35) return "left";
  return Math.cos(rad) >= 0 ? "up" : "down";
}
function circleLabel(angle) {
  return { mode: "beside", side: labelSide(angle) };
}
function fanLabel(angle) {
  const s = Math.sin(angle * Math.PI / 180);
  return { mode: "radial", align: s < -0.15 ? "left" : s > 0.15 ? "right" : "centre" };
}
const LABEL_GAP = 8;
function ringBox(angle, r, size, place) {
  const half = size * RING.button / 2 + RING.pad;
  const rad = angle * Math.PI / 180;
  const sx = Math.sin(rad);
  const cy = -Math.cos(rad);
  const x = sx * r;
  const y = cy * r;
  const L = RING.label;
  const H = RING.labelHeight;
  let lx0 = x;
  let lx1 = x;
  let ly0 = y;
  let ly1 = y;
  if (place.mode === "beside") {
    switch (place.side) {
      case "left":
        lx0 = x - half - L;
        lx1 = x - half;
        break;
      case "right":
        lx0 = x + half;
        lx1 = x + half + L;
        break;
      case "up":
        lx0 = x - L / 2;
        lx1 = x + L / 2;
        ly0 = y - half - H;
        ly1 = y - half;
        break;
      case "down":
        lx0 = x - L / 2;
        lx1 = x + L / 2;
        ly0 = y + half;
        ly1 = y + half + H;
        break;
    }
  } else {
    const d = r + half + LABEL_GAP;
    const ax = sx * d;
    const ay = cy * d;
    ly0 = ay - H / 2;
    ly1 = ay + H / 2;
    if (place.align === "left") {
      lx0 = ax - L;
      lx1 = ax;
    } else if (place.align === "right") {
      lx0 = ax;
      lx1 = ax + L;
    } else {
      lx0 = ax - L / 2;
      lx1 = ax + L / 2;
    }
  }
  return {
    x0: Math.min(x - half, lx0),
    x1: Math.max(x + half, lx1),
    y0: Math.min(y - half, ly0),
    y1: Math.max(y + half, ly1),
    label: { x0: lx0, x1: lx1, y0: ly0, y1: ly1 }
  };
}
function ringFits(angle, r, size, room, place = circleLabel(angle)) {
  const b = ringBox(angle, r, size, place);
  return b.x0 >= -room.left && b.x1 <= room.right && b.y0 >= -room.top && b.y1 <= room.bottom;
}
const ARC_STEP = 5;
function freeArc(r, size, room, placeAt = circleLabel) {
  const n = 360 / ARC_STEP;
  const free = Array.from({ length: n }, (_, i) => ringFits(i * ARC_STEP, r, size, room, placeAt(i * ARC_STEP)));
  if (free.every(Boolean)) return { from: 0, to: 360 };
  const blocked = free.findIndex((f) => !f);
  let best = null;
  let runStart = -1;
  for (let k = 1; k <= n; k++) {
    if (free[(blocked + k) % n]) {
      if (runStart < 0) runStart = k;
      continue;
    }
    if (runStart >= 0) {
      const len = k - runStart;
      if (!best || len > best.len) best = { start: runStart, len };
      runStart = -1;
    }
  }
  if (!best) return null;
  const from = (blocked + best.start) * ARC_STEP;
  return { from, to: from + (best.len - 1) * ARC_STEP };
}
const FAN_ORDER = ["computerUse", "message", "screenshot", "meeting", "invisible"];
function turn(a, b) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180);
}
function ringLayout(actions, size, room) {
  const r0 = size * RING.radius;
  const circle = ringSlots(actions, size);
  const close = { x: 0, y: Math.round(size * RING.closeRadius) };
  const closeFits = close.y + size * RING.closeButton / 2 + RING.pad <= room.bottom;
  const asCircle = { radius: r0, slots: circle, close, fan: null };
  if (circle.length === 0) return asCircle;
  if (closeFits && circle.every((s) => ringFits(s.angle, r0, size, room))) return asCircle;
  const order = FAN_ORDER.filter((a) => actions[a]);
  const n = order.length;
  const probe = freeArc(r0, size, room, fanLabel);
  const centre0 = probe ? (probe.from + probe.to) / 2 : 270;
  const facesSide = Math.abs(Math.sin(centre0 * Math.PI / 180)) >= 0.5;
  const placeAt = fanLabel;
  let widest = null;
  for (let r = r0; r <= size * RING.maxRadius + 0.01; r += size * 0.1) {
    const arc = freeArc(r, size, room, placeAt);
    if (!arc) continue;
    const spacing = n === 1 ? 0 : Math.min(RING.maxSpacing, (arc.to - arc.from) / (n - 1));
    const centre = (arc.from + arc.to) / 2;
    const from = centre - spacing * (n - 1) / 2;
    const to = from + spacing * (n - 1);
    const target = facesSide ? 180 : 270;
    const along = turn(to, target) < turn(from, target) ? [...order].reverse() : order;
    const slots = along.map((a, i) => slotAt(a, from + spacing * i, r, placeAt(from + spacing * i)));
    const layout = { radius: r, slots, close: null, fan: { from, to } };
    widest = layout;
    const chord = 2 * r * Math.sin(spacing * Math.PI / 360);
    if (n === 1 || chord >= size * (RING.button + RING.gap)) return layout;
  }
  return widest ?? asCircle;
}
const EDGE = 16;
const WINDOW_MARGIN = 8;
function onScreen(side, screen) {
  if (!screen) return { x0: 0, y0: 0, x1: side, y1: side };
  return { x0: Math.max(0, screen.x0), y0: Math.max(0, screen.y0), x1: Math.min(side, screen.x1), y1: Math.min(side, screen.y1) };
}
function cardSpace(side, screen) {
  const v = onScreen(side, screen);
  const at = (edge, win) => screen !== null && edge !== void 0 && (win === 0 ? edge >= 0 : edge <= win);
  return {
    x0: v.x0 + (at(screen?.x0, 0) ? EDGE : WINDOW_MARGIN),
    y0: v.y0 + (at(screen?.y0, 0) ? EDGE : WINDOW_MARGIN),
    x1: v.x1 - (at(screen?.x1, side) ? EDGE : WINDOW_MARGIN),
    y1: v.y1 - (at(screen?.y1, side) ? EDGE : WINDOW_MARGIN)
  };
}
function spaceBox(space, margin) {
  return typeof space === "number" ? { x0: margin, y0: margin, x1: space - margin, y1: space - margin } : space;
}
function roomIn(visible, cx, cy) {
  return { left: cx - visible.x0, right: visible.x1 - cx, top: cy - visible.y0, bottom: visible.y1 - cy };
}
const REGION_MIN = 24;
function clampRegion(r, width, height) {
  const w = Math.max(REGION_MIN, Math.min(width, Math.round(r.width)));
  const h = Math.max(REGION_MIN, Math.min(height, Math.round(r.height)));
  const x = Math.max(0, Math.min(width - w, Math.round(r.x)));
  const y = Math.max(0, Math.min(height - h, Math.round(r.y)));
  return { x, y, width: w, height: h };
}
const PUCK_MEETING_DESCRIPTION_MAX = 4e3;
function meetingEditable(status) {
  return status !== "recording" && status !== "transcribing";
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
const PUCK_MAX_SHOTS = 8;
function ringExtent(layout, size) {
  const boxes = layout.slots.map((s) => ringBox(s.angle, layout.radius, size, s.label));
  if (layout.close) {
    const h = size * RING.closeButton / 2 + RING.pad;
    boxes.push({ x0: layout.close.x - h, x1: layout.close.x + h, y0: layout.close.y - h, y1: layout.close.y + h });
  }
  if (!boxes.length) return null;
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    y1: Math.max(...boxes.map((b) => b.y1))
  };
}
function placeCard(card, space, disc, avoid, margin = WINDOW_MARGIN) {
  const { w, h } = card;
  const { cx, cy, size } = disc;
  const { x0, y0, x1, y1 } = spaceBox(space, margin);
  const gap = 14;
  const clampX = (x2) => Math.round(Math.max(x0, Math.min(x1 - w, x2)));
  const clampY = (y2) => Math.round(Math.max(y0, Math.min(y1 - h, y2)));
  if (avoid) {
    const bx0 = cx + avoid.x0;
    const bx1 = cx + avoid.x1;
    const by0 = cy + avoid.y0;
    const by1 = cy + avoid.y1;
    const leftOf = { left: bx0 - gap - w, top: clampY(cy - h / 2) };
    const rightOf = { left: bx1 + gap, top: clampY(cy - h / 2) };
    const above = { left: clampX(cx - w / 2), top: by0 - gap - h };
    const below = { left: clampX(cx - w / 2), top: by1 + gap };
    const mx = (avoid.x0 + avoid.x1) / 2;
    const my = (avoid.y0 + avoid.y1) / 2;
    const order = Math.abs(mx) > size / 4 ? mx > 0 ? [leftOf, above, below, rightOf] : [rightOf, above, below, leftOf] : my > 0 ? [above, leftOf, rightOf, below] : [below, leftOf, rightOf, above];
    for (const p of order) {
      if (p.left >= x0 && p.top >= y0 && p.left + w <= x1 && p.top + h <= y1) return p;
    }
  }
  const roomRight = x1 - (cx + size / 2) - gap;
  const roomLeft = cx - size / 2 - gap - x0;
  const beside = roomRight >= w || roomLeft >= w;
  const x = roomRight >= w ? cx + size / 2 + gap : roomLeft >= w ? cx - size / 2 - gap - w : (x0 + x1 - w) / 2;
  const y = beside ? cy - 120 : (y0 + y1 - h) / 2;
  return { left: clampX(x), top: clampY(y) };
}
const FLASH = { w: 236, gap: 12, margin: 8 };
function placeFlash(space, disc, h, gapBelow = FLASH.gap) {
  const { x0, y0, x1, y1 } = spaceBox(space, FLASH.margin);
  const width = Math.max(120, Math.min(FLASH.w, x1 - x0));
  const left = Math.round(Math.max(x0, Math.min(x1 - width, disc.cx - width / 2)));
  const below = disc.cy + disc.size / 2 + gapBelow;
  const top = below + h <= y1 ? below : Math.max(y0, disc.cy - disc.size / 2 - FLASH.gap - h);
  return { left, top: Math.round(top), width };
}
const CARD = { w: 292, pad: 12, gap: 8, baseH: 220 };
function shotBox(shot, space, margin = WINDOW_MARGIN) {
  const w = Math.max(1, Number(shot.width) || 1);
  const h = Math.max(1, Number(shot.height) || 1);
  const { y0, y1 } = spaceBox(space, margin);
  const maxW = CARD.w - 2 * CARD.pad;
  const maxH = Math.max(1, y1 - y0 - CARD.baseH - CARD.gap);
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
function cardHeight(shot) {
  return shot ? CARD.baseH + CARD.gap + shot.height : CARD.baseH;
}
const THUMB = { h: 72, gap: 6 };
function shotsLayout(shots, space, margin = WINDOW_MARGIN) {
  if (shots.length === 0) return { height: 0, boxes: [] };
  if (shots.length === 1) {
    const b = shotBox(shots[0], space, margin);
    return { height: b.height, boxes: [b] };
  }
  const rowW = CARD.w - 2 * CARD.pad;
  const maxW = Math.floor((rowW - THUMB.gap) / 2);
  const raw = shots.map((s) => {
    const w = Math.max(1, Number(s.width) || 1);
    const h2 = Math.max(1, Number(s.height) || 1);
    return Math.max(1, Math.min(maxW, Math.round(w / h2 * THUMB.h)));
  });
  let rows = 1;
  let used = 0;
  for (const w of raw) {
    if (used > 0 && used + THUMB.gap + w > rowW) {
      rows += 1;
      used = w;
    } else used += (used > 0 ? THUMB.gap : 0) + w;
  }
  const full = rows * THUMB.h + (rows - 1) * THUMB.gap;
  const { y0, y1 } = spaceBox(space, margin);
  const maxH = Math.max(1, y1 - y0 - CARD.baseH - CARD.gap);
  const h = full <= maxH ? THUMB.h : Math.max(1, Math.floor((maxH - (rows - 1) * THUMB.gap) / rows));
  const k = h / THUMB.h;
  return {
    height: rows * h + (rows - 1) * THUMB.gap,
    boxes: raw.map((w) => ({ width: Math.max(1, Math.floor(w * k)), height: h }))
  };
}
function puckProblem(error) {
  const e = (error ?? "").toLowerCase();
  if (e === "mic-denied") return "micDenied";
  if (e === "mic-failed" || e === "no microphone api" || e === "recording not supported") return "micFailed";
  if (e.includes("no transcription engine")) return "noEngine";
  if (e === "dictation off") return "dictationOff";
  if (e.includes("no transcription key") || e.includes("missing groq api key")) return "noKey";
  if (/groq 40[13]|invalid api key|invalid_api_key|unauthori[sz]ed/.test(e)) return "badKey";
  if (/groq 429|rate limit/.test(e)) return "busy";
  if (/groq 5\d\d|fetch failed|enotfound|econn|etimedout|network|socket hang up|dns/.test(e)) return "network";
  if (e.includes("hive disabled") || e === "not registered") return "noHive";
  return "other";
}
export {
  onScreen as A,
  placeCapturePair as B,
  CARD as C,
  DEFAULT_PUCK_STATE as D,
  placeCard as E,
  FLASH as F,
  placeFlash as G,
  placePair as H,
  puckProblem as I,
  ringExtent as J,
  ringFootprint as K,
  LABEL_GAP as L,
  ringLayout as M,
  roomIn as N,
  shotsLayout as O,
  PUCK_ACTIONS as P,
  traitsFor as Q,
  REGION_MIN as R,
  STAPLER_TRAITS as S,
  TRAIT_TOP as T,
  PUCK_CORNERS as a,
  PUCK_DEFAULT_COLOR as b,
  PUCK_DEFAULT_SEED as c,
  PUCK_EXPRESSIONS as d,
  PUCK_MAX_SHOTS as e,
  PUCK_MEETING_DESCRIPTION_MAX as f,
  PUCK_MESSAGE_MAX_SECONDS as g,
  PUCK_MESSAGE_SEGMENT as h,
  PUCK_OPACITY as i,
  PUCK_SEED_MAX as j,
  PUCK_SEGMENT_MINUTES as k,
  PUCK_SHAPES as l,
  PUCK_SHAPE_TRAIT as m,
  PUCK_SIZE as n,
  PUCK_SWATCHES as o,
  RING as p,
  RING_ANGLE as q,
  bodyLook as r,
  cardHeight as s,
  cardSpace as t,
  clampRegion as u,
  clampTrait as v,
  hashedTrait as w,
  meetingEditable as x,
  normalizeHex as y,
  normalizePuckConfig as z
};

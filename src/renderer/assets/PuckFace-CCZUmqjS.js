import { k as jsxRuntimeExports, m as reactExports } from "./index-CsK_GEYj.js";
import { y as normalizeHex, b as PUCK_DEFAULT_COLOR, r as bodyLook, m as PUCK_SHAPE_TRAIT } from "./puck-HlPOn73L.js";
const WAV_SAMPLE_RATE = 16e3;
function floatToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i2 = 0; i2 < samples.length; i2++) {
    const s = Math.max(-1, Math.min(1, samples[i2]));
    out[i2] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}
function mixToMono(channels) {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i2 = 0; i2 < n; i2++) out[i2] += ch[i2] / channels.length;
  return out;
}
function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const n = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(n);
  for (let i2 = 0; i2 < n; i2++) {
    const pos = i2 * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = pos - i0;
    out[i2] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}
function encodeWav(pcm, sampleRate = WAV_SAMPLE_RATE) {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v2 = new DataView(buf);
  const ascii = (off, s) => {
    for (let i2 = 0; i2 < s.length; i2++) v2.setUint8(off + i2, s.charCodeAt(i2));
  };
  ascii(0, "RIFF");
  v2.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v2.setUint32(16, 16, true);
  v2.setUint16(20, 1, true);
  v2.setUint16(22, 1, true);
  v2.setUint32(24, sampleRate, true);
  v2.setUint32(28, sampleRate * 2, true);
  v2.setUint16(32, 2, true);
  v2.setUint16(34, 16, true);
  ascii(36, "data");
  v2.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}
async function blobToWav16k(blob, filenameBase = "clip") {
  if (typeof AudioContext === "undefined") return null;
  let ctx = null;
  try {
    ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = await toMono16k(decoded);
    const pcm = floatToInt16(mono);
    return { audio: encodeWav(pcm, WAV_SAMPLE_RATE), mimeType: "audio/wav", filename: `${filenameBase}.wav`, seconds: pcm.length / WAV_SAMPLE_RATE };
  } catch {
    return null;
  } finally {
    void ctx?.close().catch(() => void 0);
  }
}
async function toMono16k(decoded) {
  const channels = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const mono = mixToMono(channels);
  if (decoded.sampleRate === WAV_SAMPLE_RATE) return mono;
  if (typeof OfflineAudioContext === "undefined") return resampleLinear(mono, decoded.sampleRate, WAV_SAMPLE_RATE);
  try {
    const frames = Math.max(1, Math.ceil(mono.length * WAV_SAMPLE_RATE / decoded.sampleRate));
    const off = new OfflineAudioContext(1, frames, WAV_SAMPLE_RATE);
    const src = off.createBufferSource();
    const buf = off.createBuffer(1, mono.length, decoded.sampleRate);
    buf.copyToChannel(new Float32Array(mono), 0);
    src.buffer = buf;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  } catch {
    return resampleLinear(mono, decoded.sampleRate, WAV_SAMPLE_RATE);
  }
}
const METER_BARS = 14;
const IDLE_VIEW = { phase: "idle", levels: [] };
function levelOf(rms) {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return Math.min(1, Math.sqrt(rms / 0.2));
}
function dictationStep(v2, e) {
  const sound = (s) => e.sounds ? s : null;
  switch (e.type) {
    case "keydown":
      return { view: { phase: "listening", levels: [] }, sound: sound("start") };
    case "level":
      if (v2.phase !== "listening") return { view: v2, sound: null };
      return { view: { ...v2, levels: [...v2.levels, levelOf(Number(e.rms ?? 0))].slice(-METER_BARS) }, sound: null };
    case "keyup":
      return { view: { phase: "transcribing", levels: v2.levels }, sound: v2.phase === "listening" ? sound("stop") : null };
    case "transcribing":
      return { view: { phase: "transcribing", levels: v2.levels }, sound: null };
    case "cancelled":
      return { view: IDLE_VIEW, sound: v2.phase === "listening" ? sound("stop") : null };
    case "injected":
    case "empty":
    case "tap":
    case "helper-exited":
      return { view: IDLE_VIEW, sound: null };
    case "error":
      return { view: { phase: "error", levels: [], error: e.error ?? "error", detail: e.detail }, sound: v2.phase === "listening" ? sound("stop") : null };
    default:
      return { view: v2, sound: null };
  }
}
const DICTATION_SOUNDS = {
  start: [{ freq: 660, at: 0, dur: 0.07 }, { freq: 990, at: 0.07, dur: 0.09 }],
  stop: [{ freq: 880, at: 0, dur: 0.07 }, { freq: 587, at: 0.07, dur: 0.09 }]
};
const DICTATION_SOUND_GAIN = 0.05;
let nudgeCtx = null;
function playNudge(kind) {
  try {
    nudgeCtx ??= new AudioContext();
    const ctx = nudgeCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const n of DICTATION_SOUNDS[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = n.freq;
      gain.gain.setValueAtTime(0, t0 + n.at);
      gain.gain.linearRampToValueAtTime(DICTATION_SOUND_GAIN, t0 + n.at + 0.01);
      gain.gain.exponentialRampToValueAtTime(1e-4, t0 + n.at + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.dur + 0.02);
    }
  } catch {
  }
}
const PUCK_GLYPH_PATHS = {
  screenshot: "M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M9 12h6",
  mic: "M9 3h6v8a3 3 0 01-6 0zM5 11a7 7 0 0014 0M12 18v3M9 21h6",
  video: "M3 7a1 1 0 011-1h11a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1zM16 10l5-3v10l-5-3",
  eyeOff: "M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A10 10 0 0121 12a10.6 10.6 0 01-2.2 3.1M6.6 6.6A10.6 10.6 0 003 12a10 10 0 0013.4 4.4",
  eye: "M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM12 12m-2.5 0a2.5 2.5 0 105 0a2.5 2.5 0 10-5 0",
  computer: "M3 5h18v11H3zM8 20h8M12 16v4",
  close: "M6 6l12 12M18 6L6 18",
  stop: "M7 7h10v10H7z",
  check: "M5 12l5 5L20 7"
};
const PUCK_ACTION_GLYPH = {
  screenshot: "screenshot",
  message: "mic",
  meeting: "video",
  invisible: "eye",
  computerUse: "computer"
};
function PuckGlyph({ name, size = 22 }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", children: /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: PUCK_GLYPH_PATHS[name] ?? "" }) });
}
var G$1 = (t, e) => `mo-root${t === "always" ? " mo-always" : ""}${e ? " mo-expr" : ""}`;
function It(t) {
  let e = Math.round(t.num("motion.blink", 3500, 6500)), n = Math.round(t.num("motion.saccade", 4200, 7600)), a = t.num("motion.lookX", 1, 2.2), o = t.num("motion.lookY", 0.8, 1.7), r = (s) => Math.round(s * 100) / 100;
  return { phase: Math.round(t.num("motion.phase", 0, 2800)), bob: Math.round(t.num("motion.bob", 0, 3400)), blink: e, blinkPhase: Math.round(t.num("motion.blinkPhase", 0, e)), saccade: n, saccadePhase: Math.round(t.num("motion.saccadePhase", 0, n)), lookX: r(a) * (t.bool("motion.lookXFlip") ? -1 : 1), lookY: r(o) * (t.bool("motion.lookYFlip") ? -1 : 1), lookMX: r(a), lookMY: r(o) };
}
function N$1(t) {
  let e = (a) => `${-a}ms`, n = It(t);
  return { "--mo-phase": e(n.phase), "--mo-bob-phase": e(n.bob), "--mo-blink": `${n.blink}ms`, "--mo-blink-phase": e(n.blinkPhase), "--mo-look-x": String(n.lookX), "--mo-look-mx": String(n.lookMX), "--mo-look-y": String(n.lookY), "--mo-look-my": String(n.lookMY), "--mo-saccade": `${n.saccade}ms`, "--mo-saccade-phase": e(n.saccadePhase) };
}
function R$1({ l: t, c: e, h: n }) {
  let a = n * Math.PI / 180, o = e * Math.cos(a), r = e * Math.sin(a), s = t + 0.3963377774 * o + 0.2158037573 * r, c = t - 0.1055613458 * o - 0.0638541728 * r, i2 = t - 0.0894841775 * o - 1.291485548 * r, u2 = s * s * s, m2 = c * c * c, l = i2 * i2 * i2;
  return [4.0767416621 * u2 - 3.3077115913 * m2 + 0.2309699292 * l, -1.2684380046 * u2 + 2.6097574011 * m2 - 0.3413193965 * l, -0.0041960863 * u2 - 0.7034186147 * m2 + 1.707614701 * l];
}
var U = (t) => t.every((e) => e >= -1e-4 && e <= 1.0001);
function Q(t) {
  let e = R$1(t);
  if (!U(e)) {
    let n = 0, a = t.c;
    for (let o = 0; o < 12; o++) {
      let r = (n + a) / 2;
      if (U(R$1({ ...t, c: r }))) n = r;
      else a = r;
    }
    e = R$1({ ...t, c: n });
  }
  return e.map((n) => Math.min(1, Math.max(0, n)));
}
function q(t) {
  let [e, n, a] = Q(t);
  return 0.2126 * e + 0.7152 * n + 0.0722 * a;
}
function B$1(t, e) {
  let n = q(t), a = q(e);
  return (Math.max(n, a) + 0.05) / (Math.min(n, a) + 0.05);
}
function v$1(t, e, n) {
  if (B$1(t, e) >= n) return t;
  let a = t.l >= e.l ? 1 : -1;
  for (let s of [a, -a]) {
    let c = { ...t };
    for (let i2 = 0; i2 < 60; i2++) {
      if (c.l = Math.min(1, Math.max(0, c.l + s * 0.02)), B$1(c, e) >= n) return c;
      if (c.l === 0 || c.l === 1) break;
    }
  }
  let o = { ...t, l: 0, c: 0 }, r = { ...t, l: 1, c: 0 };
  return B$1(o, e) >= B$1(r, e) ? o : r;
}
function T(t) {
  return "#" + Q(t).map((e) => {
    let n = e <= 31308e-7 ? 12.92 * e : 1.055 * Math.pow(e, 0.4166666666666667) - 0.055;
    return Math.round(n * 255).toString(16).padStart(2, "0");
  }).join("");
}
var K = [[0.2, { l: 0.86, c: 0.085 }], [0.36, { l: 0.9, c: 0.028 }], [0.62, { l: 0.73, c: 0.135 }], [0.8, { l: 0.62, c: 0.165 }], [0.93, { l: 0.87, c: 0.16 }], [1, { l: 0.34, c: 0.035 }]], At = (t) => K.find(([e]) => t < e)?.[1] ?? K[0][1], J = { l: 0.145, c: 0, h: 0 }, W = 1.5, Rt = (t, e) => {
  let n = At(e), a = v$1({ l: n.l, c: n.c, h: t }, J, W);
  return { bg: { l: 0.965, c: 0.01, h: t }, head: a, eye: a.l >= 0.5 ? { l: 0.17, c: 0.02, h: t } : { l: 0.97, c: 0.012, h: t } };
}, Ht = [["head", "bg", 1.25], ["eye", "head", 4.5]];
function Ft(t, e = true, n = 0) {
  let a = Rt(t, n);
  if (e) for (let [o, r, s] of Ht) a[o] = v$1(a[o], a[r], s);
  return a;
}
function tt(t, e = true, n = 0) {
  let a = Ft(t, e, n), o = {};
  for (let r in a) o[r] = T(a[r]);
  return o;
}
var y = (t) => {
  let e = Math.round(t * 100) / 100;
  return Object.is(e, -0) ? "0" : String(e);
};
function P$1({ cx: t, cy: e, rx: n, ry: a, n: o = 4, rot: r = 0 }) {
  let s = Math.min(1, (8 * Math.pow(2, -1 / o) - 4) / 3), c = n, i2 = a, u2 = c * s, m2 = i2 * s, l = [[c, 0], [c, m2], [u2, i2], [0, i2], [-u2, i2], [-c, m2], [-c, 0], [-c, -m2], [-u2, -i2], [0, -i2], [u2, -i2], [c, -m2], [c, 0]], b2 = r * Math.PI / 180, p2 = Math.cos(b2), d = Math.sin(b2), g = (x2) => {
    let [f2, M2] = l[x2];
    return `${y(t + f2 * p2 - M2 * d)} ${y(e + f2 * d + M2 * p2)}`;
  }, h = `M${g(0)}`;
  for (let x2 = 1; x2 < 13; x2 += 3) h += `C${g(x2)} ${g(x2 + 1)} ${g(x2 + 2)}`;
  return h + "Z";
}
function et(t, e, n, a, o, r = 0) {
  let s = o.length, c = r * Math.PI / 180, i2 = o.map((l, b2) => {
    let p2 = c + 2 * Math.PI * b2 / s;
    return [t + n * l * Math.cos(p2), e + a * l * Math.sin(p2)];
  }), u2 = (l) => i2[(l % s + s) % s], m2 = `M${y(u2(0)[0])} ${y(u2(0)[1])}`;
  for (let l = 0; l < s; l++) {
    let [b2, p2] = u2(l - 1), [d, g] = u2(l), [h, x2] = u2(l + 1), [f2, M2] = u2(l + 2);
    m2 += `C${y(d + (h - b2) / 6)} ${y(g + (x2 - p2) / 6)} ${y(h - (f2 - d) / 6)} ${y(x2 - (M2 - g) / 6)} ${y(h)} ${y(x2)}`;
  }
  return m2 + "Z";
}
function nt({ cx: t, cy: e, rx: n, ry: a, sides: o, round: r = 0.3, rot: s = 0 }) {
  let c = r > 0 ? r < 1 ? r / 2 : 0.5 : 0, i2 = s * Math.PI / 180 - Math.PI / 2, u2 = Array.from({ length: o }, (p2, d) => {
    let g = i2 + 2 * Math.PI * d / o;
    return [t + n * Math.cos(g), e + a * Math.sin(g)];
  }), m2 = (p2) => u2[(p2 % o + o) % o], l = (p2, d) => {
    let [g, h] = m2(p2), [x2, f2] = m2(d);
    return `${y(g + (x2 - g) * c)} ${y(h + (f2 - h) * c)}`;
  }, b2 = `M${l(0, -1)}`;
  for (let p2 = 0; p2 < o; p2++) {
    let [d, g] = m2(p2);
    if (b2 += `Q${y(d)} ${y(g)} ${l(p2, p2 + 1)}`, c < 0.5) b2 += `L${l(p2 + 1, p2)}`;
  }
  return b2 + "Z";
}
function rt(t, e, n, a) {
  let o = y(t - n), r = y(t + n);
  return `M${o} ${y(e - a)}H${r}V${y(e + a)}H${o}Z`;
}
function ot(t, e, n, a, o) {
  let r = Math.max(1.05, o), s = n * Math.sqrt(1 - 1 / (r * r)), c = e - a / r, i2 = e - r * a, u2 = s * 0.14, m2 = c + 0.86 * (i2 - c);
  return `M${y(t - s)} ${y(c)}L${y(t - u2)} ${y(m2)}Q${y(t)} ${y(i2)} ${y(t + u2)} ${y(m2)}L${y(t + s)} ${y(c)}Z`;
}
function H$1(t, e) {
  for (let n = 0; n < e.length; n++) t = Math.imul(t ^ e[n], 3432918353), t = t << 13 | t >>> 19;
  return t;
}
function jt(t) {
  return t = Math.imul(t ^ t >>> 16, 2246822507), t = Math.imul(t ^ t >>> 13, 3266489909), (t ^ t >>> 16) >>> 0;
}
var at = new TextEncoder();
function _t(t) {
  return t.normalize("NFC").trim().toLowerCase();
}
function st(t, e = true) {
  let n = e ? _t(t) : t;
  return H$1(1779033703 ^ n.length, at.encode(n));
}
function F$1(t, e) {
  return jt(H$1(H$1(t, Uint8Array.of(255)), at.encode(e))) / 4294967296;
}
function ct(t, e = true, n) {
  let a = st(t, e), o = (r) => {
    let s = n?.[r], c = Array.isArray(s) ? s[Math.floor(F$1(a, r) * s.length)] : s;
    return c === void 0 ? F$1(a, r) : c > 0 ? c < 1 ? c : 0.999999 : 0;
  };
  return o.num = (r, s, c) => s + o(r) * (c - s), o.int = (r, s, c) => s + Math.floor(o(r) * (c - s + 1)), o.pick = (r, s) => s[Math.floor(o(r) * s.length)], o.bool = (r, s = 0.5) => o(r) < s, o.jitter = (r, s) => (o(r) * 2 - 1) * s, o;
}
function I(t, e, n) {
  let a = e.expression;
  if (n || !a) return { l: t, wrap: "" };
  return a.bake(t, a.p);
}
var j = (t, e) => e?.tint ? e.tint(t, e.p) : t, it = (t, e) => e ? `<g transform="${e}">${t}</g>` : t, Ct = (t) => t.replace(/[&<>]/g, (e) => e === "&" ? "&amp;" : e === "<" ? "&lt;" : "&gt;");
function O$1(t, e) {
  let n = ct(t, e.normalize ?? true, e.traits);
  return { t: n, palette: { ...tt(e.hue ?? n.num("hue", 0, 360), e.contrast ?? true, e.tone ?? n("tone")), ...e.palette } };
}
var Vt = (t) => t.title ? `<title>${Ct(t.title)}</title>` : "";
function w$1(t, e, n) {
  let a = e.background ?? t.background;
  if (a === false) return;
  return { d: a === "square" ? "M0 0H100V100H0Z" : P$1({ cx: 50, cy: 50, rx: 50, ry: 50, n: a === "circle" ? 2 : 6 }), fill: n.bg };
}
var Xt = (t) => t ? `<path d="${t.d}" fill="${t.fill}"/>` : "";
function lt(t) {
  return (e, n = {}) => {
    let { t: a, palette: o } = O$1(e, n), r = j(o, n.expression), s = n.size ? ` width="${n.size}" height="${n.size}"` : "", c = I(t.layout(a), n), i2 = Vt(n) + Xt(w$1(t, n, r)) + it(t.render(c.l, r), c.wrap);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${s}>${i2}</svg>`;
  };
}
function ut(t) {
  return (e, n = {}, a) => {
    let { t: o, palette: r } = O$1(e, n), s = a?.(o, r), c = I(t.layout(o), n, s);
    return { cls: s?.cls, bg: w$1(t, n, r), inner: it(t.render(c.l, r, !!s), c.wrap), vars: s?.vars };
  };
}
var mt = (t, e, n) => {
  let a = e.rx, o = t.num("eye.rx", 0.075, 0.105) * a, r = t.num("eye.ratio", 1.9, 3.2), s = t.num("eye.scale", 0.78, 1.24), c = t.num("eye.stretch", 0.85, 1.18), i2 = t.num("eye.gap", 0.1, 0.24) * a, u2 = o * Math.max(1, s), m2 = o * r * Math.max(1, s * c), l = u2 + a * 0.03 + i2, b2 = t.jitter("gaze.x", 0.09) * n.rx, p2 = t.num("gaze.y", -0.2, 0.08) * n.ry, d = t.jitter("eye.dy", 0.04) * n.ry, g = Math.hypot(u2, m2), h = Math.hypot((Math.abs(b2) + l + g) / n.rx, (Math.abs(p2) + Math.abs(d) + g) / n.ry), x2 = h > 0.9 ? 0.9 / h : 1, f2 = o * x2, M2 = f2 * r, L2 = l * x2, A2 = Math.max(0, Math.min(1, i2 / m2)), Lt = Math.min(12, Math.asin(A2) * 180 / Math.PI), X = t.num("eye.lean", -1, 1) * Lt, vt = Math.max(-12, Math.min(12, X + t.jitter("eye.lean2", 3.5))), Y = n.cx + b2 * x2, z = n.cy + p2 * x2;
  return [{ cx: Y - L2, cy: z, rx: f2, ry: M2, n: t.num("eye.n", 3.5, 6), rot: X }, { cx: Y + L2, cy: z + d * x2, rx: f2 * s, ry: M2 * s * c, n: t.num("eye.n", 3.5, 6), rot: vt }];
};
function pt(t, e) {
  let n = (r) => (t.find(([, s]) => r < s) ?? t[t.length - 1])[0];
  function a(r) {
    let s = n(r("shape")), c = r.num("body.r", 31, 38) * s.core, i2 = { cx: 50 + r.jitter("body.x", 1.5), cy: 50 + r.jitter("body.y", 1.5), rx: c, ry: c * r.num("body.ratio", 0.92, 1.08), n: r.num("body.n", 1.9, 2.5), rot: 0, radii: Array.from({ length: r.int("body.pts", 6, 8) }, (l, b2) => 1 + r.jitter(`body.r${b2}`, 0.16)) };
    s.body?.(r, i2);
    let u2 = s.face?.(i2) ?? i2, m2 = { petals: [], extra: [] };
    return s.decorate?.(r, i2, m2), { shape: s.name, draw: s.path, body: i2, face: u2, petals: m2.petals, extra: m2.extra, eyes: e(r, i2, u2) };
  }
  function o(r, s, c) {
    let i2 = (l) => Math.round(l * 100) / 100, u2 = (l, b2) => {
      let p2 = `<path d="${P$1(l)}"/>`;
      return c ? `<g class="mo-eye" style="--mo-wrap:${b2 ? 1 : -1};--mo-lean:${i2(l.rot)};transform-origin:${i2(l.cx)}px ${i2(l.cy)}px">${p2}</g>` : p2;
    }, m2 = `<g fill="${s.head}">` + r.petals.map((l) => `<circle cx="${i2(l.cx)}" cy="${i2(l.cy)}" r="${i2(l.r)}"/>`).join("") + r.extra.map((l) => `<path d="${l}"/>`).join("") + `<path d="${r.draw ? r.draw(r.body) : P$1(r.body)}"/></g><g fill="${s.eye}"${c ? ' class="mo-eyes"' : ""}>` + r.eyes.map(u2).join("") + "</g>";
    return c ? `<g class="mo-breathe"><g class="mo-bob">${m2}</g></g>` : m2;
  }
  return { layout: a, render: o, background: false };
}
var yt = (t) => nt(t), bt = (t) => et(t.cx, t.cy, t.rx, t.ry, t.radii, t.rot), C$1 = (t) => (e) => ({ cx: e.cx, cy: e.cy, rx: e.rx * t, ry: e.ry * t }), ht = (t) => C$1(Math.min(...t.radii) * 0.95)(t), Yt = (t) => C$1(0.84)(t), xt = { name: "round", core: 1 }, dt = { name: "organic", core: 0.98, path: bt, face: ht }, gt = { name: "boxy", core: 0.86, body: (t, e) => {
  e.n = t.num("body.n", 3.4, 6), e.rot = t.num("body.rot", -20, 20);
} }, ft = { name: "capsule", core: 1.02, body: (t, e) => {
  e.ry *= t.num("capsule.squat", 0.55, 0.68);
}, face: C$1(0.94), decorate: (t, e, n) => {
  for (let a of [-1, 1]) n.petals.push({ cx: e.cx + a * (e.rx - e.ry), cy: e.cy, r: e.ry });
}, path: (t) => rt(t.cx, t.cy, t.rx - t.ry, t.ry) }, Mt = { name: "nub", core: 0.88, decorate: (t, e, n) => {
  let a = t.int("nub.n", 1, 2);
  for (let o = 0; o < a; o++) {
    let r = t.num(`nub.a${o}`, 0, 2 * Math.PI);
    n.petals.push({ cx: e.cx + Math.cos(r) * e.rx * 0.88, cy: e.cy + Math.sin(r) * e.rx * 0.88, r: e.rx * t.num(`nub.r${o}`, 0.24, 0.4) });
  }
} }, kt = { name: "cloud", core: 0.78, face: ht, path: bt, decorate: (t, e, n) => {
  let a = t.int("cloud.n", 4, 6);
  for (let o = 0; o < a; o++) {
    let r = Math.PI + Math.PI * (o + 0.5) / a;
    n.petals.push({ cx: e.cx + Math.cos(r) * e.rx * 0.8, cy: e.cy + Math.sin(r) * e.rx * 0.5, r: e.rx * t.num(`cloud.r${o}`, 0.44, 0.62) });
  }
} }, $t = { name: "droplet", core: 0.78, body: (t, e) => {
  e.cy += 0.22 * e.ry, e.n = 2;
}, face: (t) => ({ cx: t.cx, cy: t.cy + t.ry * 0.05, rx: t.rx * 0.88, ry: t.ry * 0.88 }), decorate: (t, e, n) => {
  n.extra.push(ot(e.cx, e.cy, e.rx, e.ry, t.num("droplet.tip", 1.4, 1.65)));
} }, Pt = { name: "hexagon", core: 1.05, path: yt, face: Yt, body: (t, e) => {
  e.sides = 6, e.rot = t.num("body.rot", -12, 12), e.round = t.num("poly.round", 0.24, 0.5);
} }, St = { name: "sun", core: 0.7, decorate: (t, e, n) => {
  let a = t.int("sun.n", 6, 9), o = e.rx * t.num("sun.dist", 1, 1.08), r = e.rx * t.num("sun.r", 0.2, 0.26), s = t.num("sun.rot", 0, 2 * Math.PI);
  for (let c = 0; c < a; c++) {
    let i2 = s + 2 * Math.PI * c / a;
    n.petals.push({ cx: e.cx + Math.cos(i2) * o, cy: e.cy + Math.sin(i2) * o, r });
  }
} }, Ot = { name: "triangle", core: 1.15, path: yt, body: (t, e) => {
  e.sides = 3, e.rot = t.num("body.rot", -5, 5), e.round = t.num("poly.round", 0.24, 0.5);
}, face: (t) => ({ cx: t.cx, cy: t.cy + t.ry * 0.1, rx: t.rx * 0.54, ry: t.ry * 0.36 }) };
var zt = [[xt, 0.22], [dt, 0.48], [gt, 0.6], [ft, 0.7], [Mt, 0.79], [kt, 0.86], [$t, 0.915], [Pt, 0.95], [St, 0.98], [Ot, 1]], k$1 = pt(zt, mt);
var Bt = lt(k$1), Gt = (t, e) => (n, a) => {
  let o = e ? e.vars(e.p) : {}, r = e?.tint ? e.tint(a, e.p) : a;
  return { cls: G$1(t, !!Object.keys(o).length || !!e?.tint), vars: { ...N$1(n), "--mo-head": r.head, "--mo-eye": r.eye, ...o } };
};
function Tt(t, e = {}) {
  return ut(k$1)(t, e, e.animate && Gt(e.animate, e.expression));
}
function wt(t, e) {
  return "data:image/svg+xml," + Bt(t, e).replace(/"/g, "'").replace(/[%#<>{}|\\^[\]`]/g, (a) => "%" + a.charCodeAt(0).toString(16).toUpperCase()).replace(/\s+/g, " ");
}
function Le({ name: t, size: e, background: n, palette: a, hue: o, tone: r, normalize: s, contrast: c, title: i2, animate: u2, expression: m2, traits: l, ...b2 }) {
  let p2 = { size: e, background: n, palette: a, hue: o, tone: r, normalize: s, contrast: c, title: i2, expression: m2, traits: l }, d = JSON.stringify([t, p2, u2]), g = reactExports.useMemo(() => u2 ? "" : wt(t, p2), [d]), h = reactExports.useMemo(() => u2 ? Tt(t, { ...p2, animate: u2 }) : null, [d]), x2 = reactExports.useMemo(() => ({ __html: h?.inner ?? "" }), [h?.inner]);
  if (h) {
    let { style: L2, ...A2 } = b2;
    return jsxRuntimeExports.jsxs("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 100 100", width: e, height: e, role: i2 ? "img" : void 0, "aria-hidden": i2 ? void 0 : true, style: { ...h.vars, ...L2 }, ...A2, children: [i2 ? jsxRuntimeExports.jsx("title", { children: i2 }) : null, h.bg ? jsxRuntimeExports.jsx("path", { d: h.bg.d, fill: h.bg.fill }) : null, jsxRuntimeExports.jsx("g", { className: h.cls, dangerouslySetInnerHTML: x2 })] });
  }
  let { alt: f2, ...M2 } = b2;
  return jsxRuntimeExports.jsx("img", { src: g, width: e, height: e, alt: f2 ?? i2 ?? "", ...M2 });
}
function O({ l: t, c: e, h: s }) {
  let n = s * Math.PI / 180, r = e * Math.cos(n), o = e * Math.sin(n), c = t + 0.3963377774 * r + 0.2158037573 * o, a = t - 0.1055613458 * r - 0.0638541728 * o, l = t - 0.0894841775 * r - 1.291485548 * o, y2 = c * c * c, h = a * a * a, d = l * l * l;
  return [4.0767416621 * y2 - 3.3077115913 * h + 0.2309699292 * d, -1.2684380046 * y2 + 2.6097574011 * h - 0.3413193965 * d, -0.0041960863 * y2 - 0.7034186147 * h + 1.707614701 * d];
}
var v = (t) => t.every((e) => e >= -1e-4 && e <= 1.0001);
function S(t) {
  let e = O(t);
  if (!v(e)) {
    let s = 0, n = t.c;
    for (let r = 0; r < 12; r++) {
      let o = (s + n) / 2;
      if (v(O({ ...t, c: o }))) s = o;
      else n = o;
    }
    e = O({ ...t, c: s });
  }
  return e.map((s) => Math.min(1, Math.max(0, s)));
}
function L(t) {
  let [e, s, n] = S(t);
  return 0.2126 * e + 0.7152 * s + 0.0722 * n;
}
function k(t, e) {
  let s = L(t), n = L(e);
  return (Math.max(s, n) + 0.05) / (Math.min(s, n) + 0.05);
}
function P(t, e, s) {
  if (k(t, e) >= s) return t;
  let n = t.l >= e.l ? 1 : -1;
  for (let c of [n, -n]) {
    let a = { ...t };
    for (let l = 0; l < 60; l++) {
      if (a.l = Math.min(1, Math.max(0, a.l + c * 0.02)), k(a, e) >= s) return a;
      if (a.l === 0 || a.l === 1) break;
    }
  }
  let r = { ...t, l: 0, c: 0 }, o = { ...t, l: 1, c: 0 };
  return k(r, e) >= k(o, e) ? r : o;
}
function m(t) {
  return "#" + S(t).map((e) => {
    let s = e <= 31308e-7 ? 12.92 * e : 1.055 * Math.pow(e, 0.4166666666666667) - 0.055;
    return Math.round(s * 255).toString(16).padStart(2, "0");
  }).join("");
}
function p(t) {
  let e = parseInt(t.slice(1), 16), [s, n, r] = [e >> 16 & 255, e >> 8 & 255, e & 255].map((h) => {
    let d = h / 255;
    return d <= 0.04045 ? d / 12.92 : Math.pow((d + 0.055) / 1.055, 2.4);
  }), o = Math.cbrt(0.4122214708 * s + 0.5363325363 * n + 0.0514459929 * r), c = Math.cbrt(0.2119034982 * s + 0.6806995451 * n + 0.1073969566 * r), a = Math.cbrt(0.0883024619 * s + 0.2817188376 * n + 0.6299787005 * r), l = 1.9779984951 * o - 2.428592205 * c + 0.4505937099 * a, y2 = 0.0259040371 * o + 0.7827717662 * c - 0.808675766 * a;
  return { l: 0.2104542553 * o + 0.793617785 * c - 0.0040720468 * a, c: Math.hypot(l, y2), h: Math.atan2(y2, l) * 180 / Math.PI };
}
function N(t, e, s) {
  let n = (h) => h * Math.PI / 180, r = t.c * Math.cos(n(t.h)), o = t.c * Math.sin(n(t.h)), c = e.c * Math.cos(n(e.h)), a = e.c * Math.sin(n(e.h)), l = r + (c - r) * s, y2 = o + (a - o) * s;
  return { l: t.l + (e.l - t.l) * s, c: Math.hypot(l, y2), h: Math.atan2(y2, l) * 180 / Math.PI };
}
var f = (t, e, s) => m(N(p(t), p(e), s));
var H = { h: 27, l: 0.58, pull: 0.6, c: 0.18 }, w = { h: 358, l: 0.72, pull: 0.55, c: 0.16 }, A = { h: 12, l: 0.84, pull: 0.4, c: 0.1 }, C = { h: 142, l: 0.66, pull: 0.6, c: 0.13 };
var R = 4.55;
function _(t, e, s) {
  let n = p(t), r = p(e), o = { l: n.l + (s.l - n.l) * s.pull, c: Math.max(n.c, s.c), h: s.h };
  o = P(o, B, F);
  let c = P(r, o, R), a = c.l >= o.l ? 1 : -1, l = m(o);
  for (let y2 = 0; y2 < 40; y2++) {
    let h = m(c), d = 1 / 0;
    for (let g = 0; g <= 10; g++) {
      let T2 = g / 10;
      d = Math.min(d, k(p(f(e, h, T2)), p(f(t, l, T2))));
    }
    if (d >= R) return [l, h];
    let E = Math.min(1, Math.max(0, c.l + a * 0.02));
    if (E === c.l) return [l, h];
    c = { ...c, l: E };
  }
  return [l, m(c)];
}
var B = { l: 0.145, c: 0, h: 0 }, F = 1.5;
var b = { esx: 1, esy: 1, tilt: 0, edy: 0, edx: 0, esx2: 0, esy2: 0, tilt2: 0, edy2: 0, lock: 0, heat: 0, shake: 0, rock: 0, bdy: 0 }, u = (t) => String(Math.round(t * 1e3) / 1e3);
function i(t, e) {
  return { l: { ...t, eyes: t.eyes.map((s, n) => ({ ...s, cx: s.cx + e.edx * (n ? 1 : -1), cy: s.cy + e.edy + (n ? e.edy2 : 0), rx: s.rx * (e.esx + (n ? e.esx2 : 0)), ry: s.ry * (e.esy + (n ? e.esy2 : 0)), rot: s.rot * (1 - e.lock) + (e.tilt + (n ? e.tilt2 : 0)) * (n ? 1 : -1) })) }, wrap: e.bdy !== 0 ? `translate(0 ${u(e.bdy)})` : "" };
}
function x(t) {
  let e = {};
  for (let s in b) {
    if (s === "heat") continue;
    let n = t[s];
    if (n !== b[s]) e["--mo-" + s] = u(n);
  }
  return e;
}
function M(t, e, s) {
  let [n, r] = _(t.head, t.eye, s);
  return { ...t, head: f(t.head, n, e.heat), eye: f(t.eye, r, e.heat) };
}
var G = (t, e) => M(t, e, H), Z = { p: b, vars: x, bake: i }, ee = { p: { esx: 1.72, esy: 0.3, tilt: 8, edy: -1.5, edx: 1.5, esx2: 0.08, esy2: 0.05, tilt2: -16, edy2: 0, lock: 1, heat: 0, shake: 0, rock: 0, bdy: -2.2 }, vars: x, bake: i }, te = { p: { esx: 0.6, esy: 0.56, tilt: 26, edy: 3.6, edx: 1.9, esx2: -0.05, esy2: -0.07, tilt2: -7, edy2: 0, lock: 1, heat: 0, shake: 0, rock: 0, bdy: 2.6 }, vars: x, bake: i }, se = { p: { esx: 1.85, esy: 0.26, tilt: -33, edy: 0.4, edx: 0.6, esx2: 0, esy2: -0.03, tilt2: 5, edy2: 0, lock: 1, heat: 0.62, shake: 0.55, rock: 0, bdy: 0.8 }, vars: x, bake: i, tint: G }, ne = { p: { esx: 1.34, esy: 1.2, tilt: -6, edy: -1.05, edx: 0.5, esx2: 0.05, esy2: 0.07, tilt2: 3, edy2: 0, lock: 1, heat: 0, shake: 0, rock: 0, bdy: -1.4 }, vars: x, bake: i }, re = { p: { esx: 1.32, esy: 0.76, tilt: 5, edy: -0.6, edx: 0.8, esx2: 0.26, esy2: -0.56, tilt2: -11, edy2: 0, lock: 1, heat: 0, shake: 0, rock: 0, bdy: -1.1 }, vars: x, bake: i }, oe$1 = { p: { esx: 1.14, esy: 0.22, tilt: 0, edy: 2.4, edx: 0.3, esx2: -0.04, esy2: 0.03, tilt2: 4, edy2: 0, lock: 1, heat: 0, shake: 0, rock: 0, bdy: 1.2 }, vars: x, bake: i }, ce$1 = { p: { esx: 1.3, esy: 0.42, tilt: 18, edy: -0.5, edx: 0.5, esx2: 0.06, esy2: -0.06, tilt2: -36, edy2: 0, lock: 1, heat: 0, shake: 0, rock: 0, bdy: -1 }, vars: x, bake: i }, ae$1 = { p: { esx: 0.95, esy: 1.02, tilt: 4, edy: -0.2, edx: 0.3, esx2: 0.24, esy2: -0.44, tilt2: -18, edy2: 0, lock: 1, heat: 0, shake: 0, rock: 0, bdy: 0 }, vars: x, bake: i }, le$1 = { p: { esx: 0.78, esy: 0.96, tilt: -12, edy: -1.5, edx: -0.8, esx2: -0.04, esy2: 0.05, tilt2: 4, edy2: 0, lock: 1, heat: 0, shake: 0.35, rock: 0, bdy: -0.6 }, vars: x, bake: i }, ie$1 = { p: { esx: 0.86, esy: 1.28, tilt: -14, edy: -0.5, edx: -0.35, esx2: 0.05, esy2: 0.06, tilt2: 6, edy2: 0, lock: 1, heat: 0.6, shake: 0, rock: 0, bdy: -1.6 }, vars: x, bake: i, tint: (t, e) => M(t, e, w) }, xe = { p: { esx: 0.62, esy: 0.5, tilt: 10, edy: 1.4, edx: -0.2, esx2: -0.05, esy2: -0.04, tilt2: -8, edy2: 0, lock: 1, heat: 0.55, shake: 0, rock: 0, bdy: 0.9 }, vars: x, bake: i, tint: (t, e) => M(t, e, A) }, ye$1 = { p: { esx: 1.25, esy: 0.34, tilt: 20, edy: 1.8, edx: 0.8, esx2: 0.05, esy2: -0.05, tilt2: -6, edy2: 0, lock: 1, heat: 0.6, shake: 0.18, rock: 0, bdy: 1.4 }, vars: x, bake: i, tint: (t, e) => M(t, e, C) }, ue$1 = { p: { esx: 1.15, esy: 0.62, tilt: 0, edy: 4.2, edx: 0.4, esx2: 0.02, esy2: 0.06, tilt2: 0, edy2: -8.4, lock: 1, heat: 0, shake: 0, rock: 0.8, bdy: -0.4 }, vars: x, bake: i };
var ae = (e) => e * e * (3 - 2 * e), ce = (e, n, a) => Math.min(a, Math.max(n, e)), ie = (e, n = 110) => n <= 0 ? 1 : 1 - Math.exp(-e / n);
function le(e, n) {
  let a = n * (e / 100);
  return a > 0 ? ce(0.15 / a, 2e-3, 0.06) : 0.06;
}
var D = 0.97, me = 4, oe = (e, n, a) => {
  let r = e * e + n * n;
  if (r < 1e-9) return { sx: 1, sy: 1, sh: 0 };
  let h = Math.max(0, a);
  return { sx: (h * e * e + n * n) / r, sy: (h * n * n + e * e) / r, sh: (h - 1) * e * n / r };
};
function ue(e, n, a) {
  let r = e.x * e.x + e.y * e.y, h = r > 1 ? 1 / Math.sqrt(r) : 1, y2 = e.x * h, m2 = e.y * h, E = Math.sqrt(Math.max(0, 1 - y2 * y2 - m2 * m2)), g = Math.cos(n), S2 = Math.sin(n), f2 = y2 * g + E * S2, P2 = E * g - y2 * S2, b2 = Math.cos(a), i2 = Math.sin(a), c = m2 * b2 + P2 * i2, o = P2 * b2 - m2 * i2, s = Math.hypot(f2, c), l = o <= 0 || s > D, M2 = l ? D / (s || 1) : 1, d = f2 * M2, x2 = c * M2, G2 = l ? Math.sqrt(1 - D * D) : o, u2 = oe(y2, m2, E), v2 = oe(d, x2, G2);
  return { dx: d - e.x, dy: x2 - e.y, sx: Math.min(1, v2.sx / (u2.sx || 1)), sy: Math.min(1, v2.sy / (u2.sy || 1)), t: me * (v2.sh - u2.sh) };
}
function he(e) {
  let n = Math.hypot(e.dx, e.dy), a = e.radius > 0 ? ae(Math.min(1, n / (e.radius * 0.55))) : 1, r = (e.gain ?? 1) * a, h = n > 0 ? e.dx / n * r : 0, y2 = n > 0 ? e.dy / n * r : 0, m2 = Math.hypot(h - e.x, y2 - e.y) > (e.snap ?? 1.6) ? 1 : e.k;
  return { x: e.x + (h - e.x) * m2, y: e.y + (y2 - e.y) * m2, tx: h, ty: y2, f: m2 };
}
function ye(e) {
  let n = e.querySelector(".mo-bob > g:not(.mo-eyes)"), a = [...e.querySelectorAll(".mo-eye")];
  if (!n || !a.length) return null;
  try {
    let r = n.getBBox(), h = [...n.querySelectorAll("path,circle")], y2 = r.x + r.width / 2, m2 = r.y + r.height / 2, E = (o, s, l) => h.some((M2) => M2.isPointInFill(new DOMPoint(y2 + o * r.width / 2 * s, m2 + o * r.height / 2 * l))), g = 1;
    for (let o = 0; o < 16; o++) {
      let s = o / 16 * Math.PI * 2, l = Math.cos(s), M2 = Math.sin(s);
      if (E(1, l, M2)) continue;
      let d = 0, x2 = 1;
      for (let G2 = 0; G2 < 12; G2++) {
        let u2 = (d + x2) / 2;
        if (E(u2, l, M2)) d = u2;
        else x2 = u2;
      }
      g = Math.min(g, d);
    }
    let S2 = 0, f2 = 0, P2 = a.map((o) => {
      let s = o.getBBox();
      return S2 = Math.max(S2, s.width / 2), f2 = Math.max(f2, s.height / 2), { x: s.x + s.width / 2 - y2, y: s.y + s.height / 2 - m2 };
    }), b2 = Math.max(1, r.width / 2 * g - S2), i2 = Math.max(1, r.height / 2 * g - f2), c = 0;
    for (let o of P2) c = Math.max(c, Math.hypot(o.x / b2, o.y / i2));
    if (c > 0.85) b2 *= c / 0.85, i2 *= c / 0.85;
    return { marks: P2.map((o) => ({ x: o.x / b2, y: o.y / i2 })), rx: b2, ry: i2 };
  } catch {
    return null;
  }
}
function Me(e, n = {}) {
  let a = matchMedia("(hover: hover) and (pointer: fine)"), r = matchMedia("(prefers-reduced-motion: reduce)"), h = n.settle ?? 110, y2 = n.snap ?? 1.6, m2 = 0, E = 0, g = 1, S2 = 1, f2 = 0, P2 = -1e6, b2 = -1e6, i2 = 0, c = 0, o = 0, s = 0, l = 0, M2 = 0, d = 0, x2 = 0, G2 = false, u2 = false, v2 = null, k2 = null, N2 = false, B2 = 1, p2 = e, R2 = [], _2 = [], X = 50, C2 = 50, Z2 = 0, U2 = 0, Y = () => {
    let t = ye(e);
    if (!t) return;
    _2 = t.marks, X = t.rx, C2 = t.ry;
  }, J2 = () => {
    p2 = e.querySelector(".mo-eyes") ?? e, R2 = [...e.querySelectorAll(".mo-eye")], Y();
  }, K2 = () => {
    if (!k2) return;
    let t = k2.getBoundingClientRect();
    v2 = { x: t.left + t.width / 2, y: t.top + t.height / 2 };
  }, j2 = () => {
    K2();
    let t = e.getBoundingClientRect();
    if (m2 = t.left + t.width / 2, E = t.top + t.height / 2, g = Math.max(1, Math.min(t.width, t.height) / 2), S2 = Math.max(1, t.width), f2 = parseFloat(getComputedStyle(p2).getPropertyValue("--mo-track-travel")) || 0, !_2.length) Y();
    Z2 = f2 / X, U2 = f2 / C2;
  }, Q2 = (t) => {
    x2 = 0;
    let H2 = d ? Math.min(t - d, 64) : 16;
    if (d = t, !p2.isConnected) J2(), j2(), o = s = 1 / 0;
    let re2 = ie(H2, h), L2 = he({ x: i2, y: c, dx: N2 ? 0 : (v2 ? v2.x : P2) - m2, dy: N2 ? 0 : (v2 ? v2.y : b2) - E, radius: g, k: re2, snap: y2 });
    i2 = L2.x, c = L2.y;
    let O2 = le(S2, f2), V = false;
    if (Math.abs(L2.tx - i2) <= O2 && Math.abs(L2.ty - c) <= O2) i2 = L2.tx, c = L2.ty;
    else V = true;
    if (l += (B2 - l) * re2, Math.abs(B2 - l) <= 0.01) l = B2;
    else V = true;
    if (Math.abs(l - M2) > 0.01) M2 = l, e.style.setProperty("--mo-track-hold", l.toFixed(3)), V = true;
    if (Math.abs(i2 - o) > O2 || Math.abs(c - s) > O2) {
      o = i2, s = c, p2.style.setProperty("--mo-track-x", i2.toFixed(3)), p2.style.setProperty("--mo-track-y", c.toFixed(3));
      for (let I2 = 0; I2 < _2.length && I2 < R2.length; I2++) {
        let T2 = ue(_2[I2], i2 * Z2, c * U2), q2 = I2 + 1;
        p2.style.setProperty(`--mo-gz-dx${q2}`, (T2.dx * X).toFixed(3)), p2.style.setProperty(`--mo-gz-dy${q2}`, (T2.dy * C2).toFixed(3)), p2.style.setProperty(`--mo-gz-sx${q2}`, T2.sx.toFixed(4)), p2.style.setProperty(`--mo-gz-sy${q2}`, T2.sy.toFixed(4)), p2.style.setProperty(`--mo-gz-t${q2}`, T2.t.toFixed(3));
      }
      V = true;
    }
    if (V || G2) G2 = false, x2 = requestAnimationFrame(Q2);
    else d = 0;
  }, w2 = () => {
    if (!u2) return;
    if (G2 = true, !x2) x2 = requestAnimationFrame(Q2);
  }, W2 = (t) => {
    P2 = t.clientX, b2 = t.clientY, w2();
  }, ee2 = () => {
    P2 = -1e6, b2 = -1e6, w2();
  }, z = () => {
    j2(), w2();
  }, A2 = new ResizeObserver(z), se2 = () => {
    if (u2) return;
    if (u2 = true, J2(), j2(), A2.observe(e), k2) A2.observe(k2);
    addEventListener("pointermove", W2, { passive: true }), addEventListener("pointerleave", ee2, { passive: true }), addEventListener("scroll", z, { passive: true, capture: true }), addEventListener("resize", z, { passive: true }), w2();
  }, te2 = () => {
    if (!u2) return;
    if (u2 = false, A2.disconnect(), removeEventListener("pointermove", W2), removeEventListener("pointerleave", ee2), removeEventListener("scroll", z, { capture: true }), removeEventListener("resize", z), x2) cancelAnimationFrame(x2);
    x2 = 0, d = 0, i2 = c = o = s = l = M2 = 0, p2.style.removeProperty("--mo-track-x"), p2.style.removeProperty("--mo-track-y");
    for (let t = 1; t <= R2.length; t++) for (let H2 of ["dx", "dy", "sx", "sy", "t"]) p2.style.removeProperty(`--mo-gz-${H2}${t}`);
    e.style.removeProperty("--mo-track-hold");
  }, F2 = () => a.matches && !r.matches ? se2() : te2();
  a.addEventListener("change", F2), r.addEventListener("change", F2), F2();
  let ne2 = (t) => {
    if (k2 && u2) A2.unobserve(k2);
    if (k2 = v2 = null, N2 = t === null || t === "rest", B2 = t === null ? 0 : 1, typeof t !== "object" || !t) return;
    if ("getBoundingClientRect" in t) {
      if (k2 = t, u2) A2.observe(t);
      K2();
      return;
    }
    v2 = { x: t.x, y: t.y };
  };
  return ne2(n.target ?? null), { lookAt: (t) => {
    ne2(t), w2();
  }, remeasure: z, stop: () => {
    te2(), a.removeEventListener("change", F2), r.removeEventListener("change", F2);
  } };
}
const SILENCE_FLOOR = 4e-3;
const VOICE_STROKE = 6.5;
const VOICE_STROKE_MIN_PX = 3;
const STRING_SPAN = 1.3;
const STRING_BODY_SPAN = 0.5;
const WAVE_STEEP = 0.35;
const EYE_REACH = 0.75;
const PIN_EDGE = 0.15;
const STRING_POINTS = 48;
const WAVE_CYCLES = 2;
const WAVE_SPEED = 1.4;
const VOICE_FLOOR = levelOf(SILENCE_FLOOR);
const SWING_EASE = 0.5;
const BODY_MARGIN = 2;
const DOT_R_MIN = 3;
const DOT_R_MAX = 6;
function eyeZone(eyes, body) {
  const ok = eyes.filter((b2) => !!b2 && [b2.x, b2.y, b2.w, b2.h].every(Number.isFinite) && b2.w > 0 && b2.h > 0);
  if (!ok.length) return null;
  const x0 = Math.min(...ok.map((b2) => b2.x));
  const y0 = Math.min(...ok.map((b2) => b2.y));
  const x1 = Math.max(...ok.map((b2) => b2.x + b2.w));
  const y1 = Math.max(...ok.map((b2) => b2.y + b2.h));
  const bodyOk = !!body && [body.x, body.y, body.w, body.h].every(Number.isFinite) && body.w > 0 && body.h > 0;
  const cx = bodyOk ? body.x + body.w / 2 : (x0 + x1) / 2;
  const zone = { cx, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, eyeW: Math.max(...ok.map((b2) => b2.w)) };
  if (bodyOk) {
    zone.top = body.y;
    zone.bottom = body.y + body.h;
    zone.bodyW = body.w;
  }
  return zone;
}
function strokeFor(size) {
  return size > 0 ? Math.max(VOICE_STROKE, VOICE_STROKE_MIN_PX * 100 / size) : VOICE_STROKE;
}
function stringSpan(z) {
  return Math.max(z.w * STRING_SPAN, (z.bodyW ?? 0) * STRING_BODY_SPAN);
}
function stringReach(z, stroke = VOICE_STROKE) {
  let reach = Math.min(z.h * EYE_REACH, WAVE_STEEP * (stringSpan(z) / WAVE_CYCLES));
  const inset = stroke / 2 + BODY_MARGIN;
  if (z.top !== void 0) reach = Math.min(reach, z.cy - z.top - inset);
  if (z.bottom !== void 0) reach = Math.min(reach, z.bottom - z.cy - inset);
  return Math.max(0, reach);
}
function swingOf(level) {
  const lv = Number.isFinite(level) ? level : 0;
  if (lv <= VOICE_FLOOR) return 0;
  return Math.pow(Math.min(1, (lv - VOICE_FLOOR) / (1 - VOICE_FLOOR)), SWING_EASE);
}
function pinned(u2) {
  const e = Math.min(1, Math.max(0, Math.min(u2, 1 - u2) / PIN_EDGE));
  return e * e * (3 - 2 * e);
}
function stringPath(z, swing, phase, stroke = VOICE_STROKE) {
  const a = Math.min(1, Math.max(0, Number.isFinite(swing) ? swing : 0)) * stringReach(z, stroke);
  const p2 = Number.isFinite(phase) ? phase : 0;
  const span = stringSpan(z);
  const x0 = z.cx - span / 2;
  const r = (n) => String(Math.round(n * 100) / 100);
  let d = "";
  for (let i2 = 0; i2 <= STRING_POINTS; i2++) {
    const u2 = i2 / STRING_POINTS;
    d += `${i2 ? "L" : "M"}${r(x0 + span * u2)} ${r(z.cy + a * pinned(u2) * Math.sin(2 * Math.PI * WAVE_CYCLES * u2 + p2))}`;
  }
  return d;
}
function smoothSwing(prev, level, dtMs) {
  const target = swingOf(level);
  const tau = target > prev ? 50 : target === 0 ? 60 : 120;
  return prev + (target - prev) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
}
function nextPhase(phase, level, dtMs) {
  if (!(Number.isFinite(level) && level > VOICE_FLOOR)) return phase;
  return (phase + 2 * Math.PI * WAVE_SPEED * (Math.max(0, dtMs) / 1e3)) % (2 * Math.PI);
}
function dotLayout(z) {
  const r = Math.min(DOT_R_MAX, Math.max(DOT_R_MIN, z.eyeW / 2));
  const gap = r * 2.7;
  return [-1, 0, 1].map((i2) => ({ cx: z.cx + i2 * gap, cy: z.cy, r }));
}
const WRAPPED = Symbol.for("md.svgPointShim");
function acceptDomPoint(proto) {
  const original = proto?.isPointInFill;
  if (!proto || typeof original !== "function" || proto[WRAPPED]) return false;
  const wrapped = function(point, ...rest) {
    try {
      return original.call(this, point, ...rest);
    } catch (err) {
      const owner = this?.ownerSVGElement;
      if (!(err instanceof TypeError) || !owner || !point || typeof point !== "object") throw err;
      const { x: x2, y: y2 } = point;
      if (typeof x2 !== "number" || typeof y2 !== "number") throw err;
      const p2 = owner.createSVGPoint();
      p2.x = x2;
      p2.y = y2;
      return original.call(this, p2, ...rest);
    }
  };
  proto.isPointInFill = wrapped;
  proto[WRAPPED] = true;
  return true;
}
function installSvgPointShim() {
  const ctor = globalThis.SVGGeometryElement;
  return acceptDomPoint(ctor?.prototype);
}
installSvgPointShim();
const SWING_REST = 4e-3;
const GAZE_TRAVEL = 3.5;
function traitsOf(look) {
  const pins = look.traits ?? {};
  const map = look.shape === "auto" ? { ...pins } : { ...pins, shape: PUCK_SHAPE_TRAIT[look.shape] };
  return Object.keys(map).length ? map : void 0;
}
const untinted = (e) => ({ ...e, tint: void 0 });
const POSE = {
  idle: untinted(Z),
  happy: untinted(ee),
  sad: untinted(te),
  mad: untinted(se),
  surprised: untinted(ne),
  wink: untinted(re),
  sleepy: untinted(oe$1),
  smug: untinted(ce$1),
  unsure: untinted(ae$1),
  scared: untinted(le$1),
  love: untinted(ie$1),
  shy: untinted(xe),
  sick: untinted(ye$1),
  thinking: untinted(ue$1)
};
function PuckFace({ look, size, style, shadow = true, animate = "hover", gaze, voice }) {
  const box = reactExports.useRef(null);
  const driver = reactExports.useRef(null);
  const traits = traitsOf(look);
  const traitsKey = JSON.stringify(traits ?? null);
  const traitsProp = reactExports.useMemo(() => traits, [traitsKey]);
  reactExports.useEffect(() => {
    if (!gaze) return;
    const svg = box.current?.querySelector?.("svg");
    if (!svg) return;
    let g;
    try {
      g = Me(svg, { target: gaze === "pointer" ? "pointer" : null });
    } catch {
      return;
    }
    driver.current = g;
    const off = typeof gaze === "function" ? gaze((p2) => g.lookAt(p2)) : void 0;
    return () => {
      off?.();
      g.stop();
      driver.current = null;
    };
  }, [gaze]);
  reactExports.useEffect(() => {
    driver.current?.remeasure();
  }, [traitsKey, look.seed, look.expression, size]);
  const voiceOn = !!voice;
  const [measure, setMeasure] = reactExports.useState(null);
  const levelOf2 = reactExports.useRef(voice?.level);
  levelOf2.current = voice?.level;
  reactExports.useEffect(() => {
    if (!voiceOn) {
      setMeasure(null);
      return;
    }
    setMeasure(measureVoice(box.current));
  }, [voiceOn, look.color, traitsKey, look.seed, look.expression, size]);
  const body = normalizeHex(look.color) ?? PUCK_DEFAULT_COLOR;
  const { hue, tone } = bodyLook(body);
  const voiceShown = voice && measure ? voice.phase : void 0;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      ref: box,
      "aria-hidden": true,
      "data-voice": voiceShown,
      style: {
        width: size,
        height: size,
        flexShrink: 0,
        lineHeight: 0,
        ...voiceShown ? { position: "relative" } : null,
        filter: shadow ? "drop-shadow(0 2px 5px rgba(26, 19, 32, 0.18))" : void 0,
        ...gaze ? { ["--mo-track-travel"]: `${GAZE_TRAVEL}px` } : null,
        ...style
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          Le,
          {
            name: look.seed,
            size,
            background: false,
            hue,
            tone,
            palette: { head: body },
            expression: POSE[look.expression],
            traits: traitsProp,
            animate,
            style: { display: "block" }
          }
        ),
        voiceShown && measure && /* @__PURE__ */ jsxRuntimeExports.jsx(VoiceOverlay, { m: measure, phase: voiceShown, size, level: levelOf2 })
      ]
    }
  );
}
function measureVoice(box) {
  const svg = box?.querySelector?.("svg");
  if (!svg) return null;
  try {
    const boxOf = (e) => {
      if (!e) return null;
      const b2 = e.getBBox();
      return { x: b2.x, y: b2.y, w: b2.width, h: b2.height };
    };
    const eyes = [...svg.querySelectorAll(".mo-eye")].map(boxOf);
    const zone = eyeZone(eyes, boxOf(svg.querySelector(".mo-bob > g:not(.mo-eyes)")));
    if (!zone) return null;
    const vars = {};
    for (let i2 = 0; i2 < svg.style.length; i2++) {
      const k2 = svg.style.item(i2);
      if (k2.startsWith("--mo-")) vars[k2] = svg.style.getPropertyValue(k2);
    }
    const rootClass = svg.querySelector(".mo-root")?.getAttribute("class") ?? "mo-root";
    return { zone, vars, rootClass, source: svg };
  } catch {
    return null;
  }
}
function VoiceOverlay({ m: m2, phase, size, level }) {
  const root = reactExports.useRef(null);
  const string = reactExports.useRef(null);
  reactExports.useEffect(() => {
    const mine = root.current;
    if (!mine) return;
    for (const cls of ["mo-breathe", "mo-bob"]) {
      try {
        const theirs = m2.source.querySelector(`.${cls}`)?.getAnimations?.()[0];
        const ours = mine.querySelector(`.${cls}`)?.getAnimations?.()[0];
        if (theirs && ours && theirs.currentTime !== null) ours.currentTime = theirs.currentTime;
      } catch {
      }
    }
  }, [m2]);
  reactExports.useEffect(() => {
    const el = string.current;
    if (phase !== "listening" || !el) return;
    const stroke = strokeFor(size);
    el.setAttribute("d", stringPath(m2.zone, 0, 0, stroke));
    const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still || typeof requestAnimationFrame !== "function") return;
    let raf = 0;
    let last = performance.now();
    let wave = 0;
    let swing = 0;
    let flat = true;
    const frame = (now) => {
      const dt2 = Math.min(64, Math.max(0, now - last));
      last = now;
      const lv = level.current?.() ?? 0;
      swing = smoothSwing(swing, lv, dt2);
      wave = nextPhase(wave, lv, dt2);
      if (swing < SWING_REST) {
        swing = 0;
        if (!flat) {
          el.setAttribute("d", stringPath(m2.zone, 0, wave, stroke));
          flat = true;
        }
      } else {
        el.setAttribute("d", stringPath(m2.zone, swing, wave, stroke));
        flat = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [phase, m2, level, size]);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("svg", { className: "puck-voice", viewBox: "0 0 100 100", width: size, height: size, style: m2.vars, children: /* @__PURE__ */ jsxRuntimeExports.jsx("g", { ref: root, className: m2.rootClass, children: /* @__PURE__ */ jsxRuntimeExports.jsx("g", { className: "mo-breathe", children: /* @__PURE__ */ jsxRuntimeExports.jsx("g", { className: "mo-bob", children: /* @__PURE__ */ jsxRuntimeExports.jsx("g", { className: "puck-voice-mark", "data-voice-mark": phase, children: phase === "listening" ? /* @__PURE__ */ jsxRuntimeExports.jsx("path", { ref: string, className: "puck-voice-string", strokeWidth: strokeFor(size), d: stringPath(m2.zone, 0, 0, strokeFor(size)) }) : dotLayout(m2.zone).map((d, i2) => /* @__PURE__ */ jsxRuntimeExports.jsx("circle", { className: "puck-voice-dot", cx: d.cx, cy: d.cy, r: d.r, style: { animationDelay: `${i2 * 0.16}s` } }, i2)) }) }) }) }) });
}
export {
  IDLE_VIEW as I,
  METER_BARS as M,
  PUCK_ACTION_GLYPH as P,
  PuckFace as a,
  PuckGlyph as b,
  blobToWav16k as c,
  dictationStep as d,
  levelOf as l,
  playNudge as p,
  traitsOf as t
};

import { q as useTranslation, m as reactExports, k as jsxRuntimeExports, a as createRoot } from "./index-CsK_GEYj.js";
/* empty css                */
import { h as PUCK_MESSAGE_SEGMENT, g as PUCK_MESSAGE_MAX_SECONDS, D as DEFAULT_PUCK_STATE, e as PUCK_MAX_SHOTS, N as roomIn, A as onScreen, t as cardSpace, M as ringLayout, p as RING, O as shotsLayout, s as cardHeight, J as ringExtent, E as placeCard, B as placeCapturePair, H as placePair, L as LABEL_GAP, G as placeFlash, F as FLASH, K as ringFootprint, C as CARD, I as puckProblem } from "./puck-HlPOn73L.js";
import { c as blobToWav16k, I as IDLE_VIEW, d as dictationStep, p as playNudge, l as levelOf, b as PuckGlyph, M as METER_BARS, a as PuckFace, P as PUCK_ACTION_GLYPH } from "./PuckFace-CCZUmqjS.js";
function takePhase(i) {
  if (!i.ringTake) return i.card ? "card" : "idle";
  if (i.busy === "starting") return "starting";
  if (i.recording) return "listening";
  if (i.busy === "transcribe" || i.busy === "stopping") return "transcribing";
  return i.card ? "card" : "idle";
}
const TAKE_WATCHDOG_MS = 6e4;
function takeExpired(phase, lastActive2, now, limit = TAKE_WATCHDOG_MS) {
  if (phase !== "starting" && phase !== "listening" && phase !== "transcribing") return false;
  return now - lastActive2 >= limit;
}
function dictationExpired(phase, lastEvent, now, limit = TAKE_WATCHDOG_MS) {
  return (phase === "listening" || phase === "transcribing") && now - lastEvent >= limit;
}
let stream = null;
let recorder = null;
let chunks = [];
let themStream = null;
let themRecorder = null;
let themChunks = [];
let themDone = null;
let mode = null;
let seq = 0;
let startedAt = 0;
let segmentStartedAt = 0;
let timer = null;
let capTimer = null;
let onClip = null;
let finalResolve = null;
let meter = null;
let quietSince = 0;
let delivering = false;
let written = Promise.resolve();
let generation = 0;
let lastLevel = 0;
let lastActivity = 0;
function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
    }
  }
  return "";
}
function teardown() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (capTimer) {
    clearTimeout(capTimer);
    capTimer = null;
  }
  if (meter) {
    clearInterval(meter.tick);
    void meter.ctx.close().catch(() => void 0);
    meter = null;
  }
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
  }
  try {
    themStream?.getTracks().forEach((t) => t.stop());
  } catch {
  }
  stream = null;
  recorder = null;
  chunks = [];
  themStream = null;
  themRecorder = null;
  themChunks = [];
  themDone = null;
  mode = null;
}
function startSegment() {
  if (!stream) return;
  const mimeType = pickMimeType();
  const r = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  chunks = [];
  segmentStartedAt = Date.now();
  quietSince = 0;
  r.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data);
      lastActivity = Date.now();
    }
  };
  const take = generation;
  r.onstop = () => {
    if (take !== generation) return;
    const type = r.mimeType || mimeType || "audio/webm";
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (mode?.kind === "message" && finalResolve === null) {
      startSegment();
      arm();
      delivering = false;
      const prev2 = written;
      written = prev2.then(() => deliverPart(blob, type, take));
      return;
    }
    delivering = true;
    const prev = written;
    written = prev.then(() => deliver(blob, type)).finally(() => {
      delivering = false;
    });
  };
  recorder = r;
  if (themStream) {
    const tr = mimeType ? new MediaRecorder(themStream, { mimeType }) : new MediaRecorder(themStream);
    themChunks = [];
    tr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) themChunks.push(ev.data);
    };
    let settle = () => {
    };
    themDone = new Promise((res) => {
      settle = res;
    });
    tr.onstop = () => {
      void deliverThem(tr.mimeType || mimeType || "audio/webm").finally(settle);
    };
    themRecorder = tr;
    tr.start();
  }
  r.start();
}
async function deliverThem(type) {
  const blob = new Blob(themChunks, { type });
  themChunks = [];
  if (blob.size === 0) return;
  const wav = await blobToWav16k(blob, "them");
  const clip = wav ? { audio: wav.audio, mimeType: wav.mimeType } : { audio: await blob.arrayBuffer(), mimeType: type.split(";")[0] };
  const cb = onClip;
  if (cb) {
    try {
      await cb(clip, false, "them");
    } catch {
    }
  }
}
async function deliverPart(blob, type, take) {
  if (take !== generation || blob.size === 0) return;
  const wav = await blobToWav16k(blob, "segment");
  const clip = wav ? { audio: wav.audio, mimeType: wav.mimeType } : { audio: await blob.arrayBuffer(), mimeType: type.split(";")[0] };
  if (take !== generation) return;
  const cb = onClip;
  if (cb) {
    try {
      await cb(clip, false, "you");
    } catch {
    }
  }
}
async function deliver(blob, type) {
  const gen = generation;
  if (themDone) {
    await themDone;
    themDone = null;
  }
  const wav = blob.size > 0 ? await blobToWav16k(blob, "segment") : null;
  const clip = wav ? { audio: wav.audio, mimeType: wav.mimeType } : { audio: await blob.arrayBuffer(), mimeType: type.split(";")[0] };
  if (gen !== generation) return;
  const final = finalResolve !== null;
  const cb = onClip;
  if (cb && (blob.size > 0 || final)) {
    try {
      await cb(clip, final, "you");
    } catch {
    }
  }
  if (final) {
    const done = finalResolve;
    finalResolve = null;
    teardown();
    done?.();
    return;
  }
  if (finalResolve) {
    await finishEmpty();
    return;
  }
  seq += 1;
  startSegment();
  arm();
}
function roll() {
  if (!recorder || recorder.state !== "recording") return;
  delivering = true;
  if (themRecorder && themRecorder.state === "recording") {
    try {
      themRecorder.stop();
    } catch {
    }
  }
  try {
    recorder.stop();
  } catch {
  }
}
function arm() {
  if (timer) clearTimeout(timer);
  if (!mode) return;
  const ms = mode.kind === "meeting" ? mode.segmentMs : PUCK_MESSAGE_SEGMENT.maxMs;
  timer = setTimeout(roll, ms);
}
function armCap() {
  if (capTimer) clearTimeout(capTimer);
  if (mode?.kind !== "message") return;
  capTimer = setTimeout(() => {
    void stop();
  }, PUCK_MESSAGE_MAX_SECONDS * 1e3);
}
function startMeter() {
  if (mode?.kind !== "message" || !stream || typeof AudioContext === "undefined") return;
  try {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const tick = setInterval(() => {
      if (!recorder || recorder.state !== "recording") return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      lastLevel = rms;
      if (rms >= PUCK_MESSAGE_SEGMENT.quiet) lastActivity = now;
      if (rms >= PUCK_MESSAGE_SEGMENT.quiet) {
        quietSince = 0;
        return;
      }
      if (!quietSince) {
        quietSince = now;
        return;
      }
      if (now - segmentStartedAt >= PUCK_MESSAGE_SEGMENT.minMs && now - quietSince >= PUCK_MESSAGE_SEGMENT.pauseMs) roll();
    }, 100);
    meter = { ctx, tick };
  } catch {
    meter = null;
  }
}
function isRecording() {
  return mode !== null;
}
function level() {
  return mode ? lastLevel : 0;
}
function lastActive() {
  return lastActivity;
}
function segmentInfo() {
  return { seq, startMs: segmentStartedAt - startedAt, durationMs: Date.now() - segmentStartedAt };
}
async function start(m, clip, opts = {}) {
  if (mode) return { ok: false, error: "already recording" };
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return { ok: false, error: "no microphone api" };
  const gen = ++generation;
  mode = m;
  lastActivity = Date.now();
  lastLevel = 0;
  let opened;
  try {
    opened = await navigator.mediaDevices.getUserMedia(m.kind === "meeting" ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } } : { audio: true });
  } catch (e) {
    if (gen === generation) mode = null;
    const name = e instanceof DOMException ? e.name : "";
    return { ok: false, error: name === "NotAllowedError" ? "mic-denied" : "mic-failed" };
  }
  if (gen !== generation) {
    try {
      opened.getTracks().forEach((t) => t.stop());
    } catch {
    }
    return { ok: false, error: "cancelled" };
  }
  stream = opened;
  themStream = m.kind === "meeting" && opts.them && opts.them.getAudioTracks().length > 0 ? opts.them : null;
  mode = m;
  onClip = clip;
  seq = 0;
  written = Promise.resolve();
  startedAt = Date.now();
  try {
    startSegment();
  } catch {
    teardown();
    return { ok: false, error: "recording not supported" };
  }
  arm();
  armCap();
  startMeter();
  return { ok: true };
}
function stop() {
  if (!mode) return Promise.resolve();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (capTimer) {
    clearTimeout(capTimer);
    capTimer = null;
  }
  if (finalResolve) {
    const first = finalResolve;
    return new Promise((resolve) => {
      finalResolve = () => {
        first();
        resolve();
      };
    });
  }
  return new Promise((resolve) => {
    finalResolve = resolve;
    if (delivering) {
      releaseMic();
      return;
    }
    if (!recorder || recorder.state !== "recording") {
      releaseMic();
      void finishEmpty();
      return;
    }
    if (themRecorder && themRecorder.state === "recording") {
      try {
        themRecorder.stop();
      } catch {
      }
    }
    try {
      recorder.stop();
    } catch {
      void finishEmpty();
    }
    releaseMic();
  });
}
function releaseMic() {
  if (meter) {
    clearInterval(meter.tick);
    void meter.ctx.close().catch(() => void 0);
    meter = null;
  }
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
  }
  try {
    themStream?.getTracks().forEach((t) => t.stop());
  } catch {
  }
}
async function finishEmpty() {
  generation += 1;
  const cb = onClip;
  const done = finalResolve;
  finalResolve = null;
  if (cb) {
    try {
      await cb({ audio: new ArrayBuffer(0), mimeType: "audio/webm" }, true, "you");
    } catch {
    }
  }
  teardown();
  done?.();
}
function cancel() {
  generation += 1;
  const done = finalResolve;
  finalResolve = null;
  onClip = null;
  try {
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state === "recording") recorder.stop();
    }
  } catch {
  }
  try {
    if (themRecorder) {
      themRecorder.onstop = null;
      if (themRecorder.state === "recording") themRecorder.stop();
    }
  } catch {
  }
  teardown();
  delivering = false;
  lastLevel = 0;
  done?.();
}
function doors() {
  const platform = typeof window !== "undefined" && window.cth?.platform ? String(window.cth.platform) : "";
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : void 0;
  return {
    platform,
    getDisplayMedia: md?.getDisplayMedia ? (c) => md.getDisplayMedia(c) : void 0,
    getUserMedia: md?.getUserMedia ? (c) => md.getUserMedia(c) : void 0,
    enumerateDevices: md?.enumerateDevices ? () => md.enumerateDevices() : void 0,
    reportMonitor: typeof window !== "undefined" && window.cth?.systemAudioMonitor ? (m) => window.cth.systemAudioMonitor(m) : void 0,
    onDeviceChange: md ? (fn) => {
      md.addEventListener("devicechange", fn);
      return () => md.removeEventListener("devicechange", fn);
    } : void 0
  };
}
function audioOnly(stream2) {
  for (const t of stream2.getVideoTracks()) {
    try {
      t.stop();
    } catch {
    }
    try {
      stream2.removeTrack(t);
    } catch {
    }
  }
  return stream2.getAudioTracks().length > 0 ? stream2 : null;
}
function findMonitor(devices) {
  const hit = devices.find((d) => d.kind === "audioinput" && /^monitor of\b/i.test(d.label.trim()));
  return hit ? { deviceId: hit.deviceId, label: hit.label.trim() } : null;
}
const stopAll = (s) => {
  for (const t of s.getTracks()) {
    try {
      t.stop();
    } catch {
    }
  }
};
async function probeMonitor(d = doors()) {
  let found = null;
  try {
    if (d.platform === "linux" && d.enumerateDevices) {
      let devices = await d.enumerateDevices();
      const inputs = devices.filter((x) => x.kind === "audioinput");
      if (inputs.length > 0 && inputs.every((x) => !x.label) && d.getUserMedia) {
        try {
          stopAll(await d.getUserMedia({ audio: true }));
          devices = await d.enumerateDevices();
        } catch {
        }
      }
      found = findMonitor(devices);
    }
  } catch {
    found = null;
  }
  try {
    d.reportMonitor?.(found);
  } catch {
  }
  return found;
}
function watchMonitor(d = doors()) {
  if (d.platform !== "linux") return () => {
  };
  void probeMonitor(d);
  const off = d.onDeviceChange ? d.onDeviceChange(() => {
    void probeMonitor(d);
  }) : () => {
  };
  return off;
}
async function openSystemStream(d = doors()) {
  try {
    if (d.platform === "win32") {
      if (!d.getDisplayMedia) return null;
      const stream2 = await d.getDisplayMedia({ video: true, audio: true });
      return audioOnly(stream2);
    }
    if (d.platform === "linux") {
      if (!d.getUserMedia) return null;
      const monitor = await probeMonitor(d);
      if (!monitor) return null;
      const stream2 = await d.getUserMedia({ audio: { deviceId: { exact: monitor.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      if (stream2.getAudioTracks().length === 0) {
        stopAll(stream2);
        return null;
      }
      return stream2;
    }
    return null;
  } catch {
    return null;
  }
}
function speakersAreBuiltIn(label) {
  if (!label) return false;
  if (/head(phone|set)|ear(bud|phone)s?|airpods|\bbuds\b/i.test(label)) return false;
  return /\bspeakers?\b/i.test(label) || /built-?in output/i.test(label);
}
const DEAD_ZONE = 4;
const DICTATE_PILL_H = 22;
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1e3));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function join(prev, more) {
  const t = more.trim();
  if (!t) return prev;
  return prev.trim() ? `${prev.trimEnd()} ${t}` : t;
}
function PuckApp({ preview } = {}) {
  const { t } = useTranslation();
  const [cfg, setCfg] = reactExports.useState(preview?.config ?? null);
  const [st, setSt] = reactExports.useState(preview?.state ?? DEFAULT_PUCK_STATE);
  const [compose, setCompose] = reactExports.useState(preview?.compose ?? null);
  const [note, setNote] = reactExports.useState("");
  const [transcript, setTranscript] = reactExports.useState("");
  const [quiet, setQuiet] = reactExports.useState(false);
  const [busy, setBusy] = reactExports.useState(null);
  const [flash, setFlash] = reactExports.useState(preview?.flash ?? null);
  const [dict, setDict] = reactExports.useState(preview?.dictation ?? IDLE_VIEW);
  const [ringTake, setRingTake] = reactExports.useState(preview?.take ?? false);
  const [takeLevels, setTakeLevels] = reactExports.useState(preview?.takeLevels ?? []);
  const takeMark = reactExports.useRef(0);
  const lastDictAt = reactExports.useRef(0);
  const [hover, setHover] = reactExports.useState(false);
  const [dragging, setDragging] = reactExports.useState(false);
  const [now, setNow] = reactExports.useState(Date.now());
  const drag = reactExports.useRef(null);
  const pending = reactExports.useRef({ dx: 0, dy: 0, raf: 0 });
  const transcriptBox = reactExports.useRef(null);
  const cardRef = reactExports.useRef(null);
  const [cardDrawn, setCardDrawn] = reactExports.useState(0);
  const [cardDrawnW, setCardDrawnW] = reactExports.useState(0);
  const flashRef = reactExports.useRef(null);
  const [flashDrawn, setFlashDrawn] = reactExports.useState(0);
  const composeRef = reactExports.useRef(null);
  const toggleRef = reactExports.useRef(null);
  composeRef.current = compose;
  reactExports.useEffect(() => {
    if (preview) return;
    document.documentElement.dataset.cthTheme = st.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.cthSkin = "professional";
  }, [preview, st.theme]);
  reactExports.useEffect(() => {
    if (preview) return;
    void window.cth.puckConfig().then(setCfg);
    void window.cth.puckState().then(setSt);
    const offCfg = window.cth.onPuckConfig(setCfg);
    const offSt = window.cth.onPuckState(setSt);
    const offShot = window.cth.onPuckCaptured((shot) => {
      const prev = composeRef.current;
      const had = prev?.kind === "screenshot" ? prev.shots.filter((s) => s.path !== shot.path) : [];
      const attached = prev?.kind === "message" || prev?.kind === "screenshot" && prev.attached === true;
      const card = { kind: "screenshot", shots: [...had, shot].slice(0, PUCK_MAX_SHOTS), ...attached ? { attached: true } : {} };
      composeRef.current = card;
      setCompose(card);
      if (prev?.kind !== "message" && prev?.kind !== "screenshot") setNote("");
      setQuiet(false);
    });
    const offMonitor = watchMonitor();
    const offToggle = window.cth.onPuckMeetingToggle ? window.cth.onPuckMeetingToggle(() => toggleRef.current?.()) : () => {
    };
    const offDict = window.cth.onPuckDictation ? window.cth.onPuckDictation((e) => dictRef.current?.(e)) : () => {
    };
    const offShotFail = window.cth.onPuckCaptureFailed ? window.cth.onPuckCaptureFailed((e) => captureFailRef.current?.(e.error)) : () => {
    };
    return () => {
      offCfg();
      offSt();
      offShot();
      offMonitor();
      offToggle();
      offDict();
      offShotFail();
    };
  }, [preview]);
  const cursorFeed = reactExports.useCallback((aim) => window.cth.onPuckCursor ? window.cth.onPuckCursor(aim) : () => {
  }, []);
  reactExports.useEffect(() => {
    if (!st.recording) setQuiet(false);
  }, [st.recording]);
  reactExports.useEffect(() => {
    if (!st.recording) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [st.recording]);
  const twoTrack = st.recording?.kind === "meeting" && st.recording.tracks === 2;
  const [onSpeakers, setOnSpeakers] = reactExports.useState(false);
  reactExports.useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : void 0;
    if (!twoTrack || !md?.enumerateDevices) {
      setOnSpeakers(false);
      return;
    }
    let live = true;
    const read = () => {
      void md.enumerateDevices().then((all) => {
        const outs = all.filter((d) => d.kind === "audiooutput");
        const out = outs.find((d) => d.deviceId === "default") ?? outs[0];
        if (live) setOnSpeakers(!!out && speakersAreBuiltIn(out.label));
      }).catch(() => {
        if (live) setOnSpeakers(false);
      });
    };
    read();
    md.addEventListener("devicechange", read);
    return () => {
      live = false;
      md.removeEventListener("devicechange", read);
    };
  }, [twoTrack]);
  const meetingId = compose?.kind === "meeting" ? compose.meetingId : null;
  const written2 = st.recording?.kind === "meeting" ? st.recording.transcribed : 0;
  reactExports.useEffect(() => {
    if (!meetingId) {
      setTranscript("");
      return;
    }
    let live = true;
    void window.cth.puckMeetingTranscript({ id: meetingId }).then((r) => {
      if (live && r.ok) setTranscript(r.text);
    });
    return () => {
      live = false;
    };
  }, [meetingId, written2]);
  reactExports.useEffect(() => {
    const box = transcriptBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [transcript, note]);
  const cardVisible = compose !== null && !ringTake && (!quiet || !st.recording || st.menuOpen);
  reactExports.useEffect(() => {
    const el = cardRef.current;
    if (!el || !cardVisible) {
      setCardDrawn(0);
      setCardDrawnW(0);
      return;
    }
    const read = () => {
      setCardDrawn(el.offsetHeight);
      setCardDrawnW(el.offsetWidth);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cardVisible, compose?.kind]);
  reactExports.useEffect(() => {
    const el = flashRef.current;
    setFlashDrawn(el ? el.offsetHeight : 0);
  }, [flash, cardVisible]);
  const wantMouse = hover || dragging || st.menuOpen || cardVisible || flash !== null || st.capturing || ringTake;
  reactExports.useEffect(() => {
    if (!preview) void window.cth.puckIgnoreMouse(!wantMouse);
  }, [wantMouse, preview]);
  const showFlash = reactExports.useCallback((f, ms = 2600) => {
    setFlash(f);
    if (f && !f.action) setTimeout(() => setFlash((cur) => cur === f ? null : cur), ms);
  }, []);
  const dictRef = reactExports.useRef(null);
  const captureFailRef = reactExports.useRef(null);
  const dictView = reactExports.useRef(dict);
  dictRef.current = (e) => {
    lastDictAt.current = Date.now();
    const { view, sound } = dictationStep(dictView.current, e);
    dictView.current = view;
    setDict(view);
    if (sound) playNudge(sound);
    if (e.type === "error") {
      if (e.error === "permission") {
        const pane = e.detail === "microphone" ? "microphone" : "accessibility";
        showFlash({ text: t(`pro.puck.dictation.needs.${pane}`), bad: true, action: { label: t("pro.puck.dictation.fix"), run: () => {
          void window.cth.anyAppOpenSettings(pane);
          setFlash(null);
        } } });
      } else {
        showFlash({ text: t("pro.puck.dictation.failed"), bad: true }, 3200);
      }
      setTimeout(() => {
        if (dictView.current.phase === "error") {
          dictView.current = IDLE_VIEW;
          setDict(IDLE_VIEW);
        }
      }, 3200);
    }
  };
  const closeMenu = reactExports.useCallback(() => {
    void window.cth.puckMenu(false);
  }, []);
  const voiceLevel = reactExports.useCallback(() => {
    const l = dictView.current.levels;
    return l[l.length - 1] ?? 0;
  }, []);
  const voicePhase = !st.recording && (dict.phase === "listening" || dict.phase === "transcribing") ? dict.phase : null;
  const voice = reactExports.useMemo(() => voicePhase ? { phase: voicePhase, level: voiceLevel } : void 0, [voicePhase, voiceLevel]);
  const lastClip = reactExports.useRef(null);
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const problem = (error, ctx = "start") => {
    const kind = puckProblem(error);
    const openVoice = { label: t("pro.puck.flash.openVoice"), run: () => {
      void window.cth.puckOpenSettings("Voice");
      setFlash(null);
    } };
    const openDictation = { label: t("pro.puck.flash.openDictation"), run: () => {
      void window.cth.puckOpenSettings("Dictation & Meetings");
      setFlash(null);
    } };
    const retry = ctx === "final" && lastClip.current ? { label: t("pro.puck.flash.tryAgain"), run: () => {
      void retryFinal();
    } } : void 0;
    switch (kind) {
      case "noKey":
        return { text: t("pro.puck.flash.noKey"), bad: true, action: openVoice };
      case "noEngine":
        return { text: t("pro.puck.flash.noEngine"), bad: true, action: openDictation };
      case "dictationOff":
        return { text: t("pro.puck.flash.dictationOff"), bad: true, action: openDictation };
      case "badKey":
        return { text: t("pro.puck.flash.badKey"), bad: true, action: openVoice };
      case "busy":
        return { text: t("pro.puck.flash.busyService"), bad: true, action: retry };
      case "network":
        return { text: t("pro.puck.flash.network"), bad: true, action: retry };
      case "noHive":
        return { text: t("pro.puck.flash.noHive"), bad: true, action: { label: t("pro.puck.flash.openApp"), run: () => {
          void window.cth.puckOpenSettings();
          setFlash(null);
        } } };
      case "micDenied":
        return { text: t("pro.puck.flash.micDenied"), bad: true, action: isMac ? { label: t("pro.puck.flash.openSettings"), run: () => {
          void window.cth.puckOpenMicAccess();
          setFlash(null);
        } } : void 0 };
      case "micFailed":
        return { text: t("pro.puck.flash.micFailed"), bad: true };
      default: {
        const reason = error ?? "";
        if (ctx === "part") return { text: t("pro.puck.flash.partLost", { reason }), bad: true };
        if (ctx === "capture") return { text: t("pro.puck.flash.captureFailed", { reason }), bad: true };
        return { text: reason, bad: true, action: retry };
      }
    }
  };
  const retryFinal = async () => {
    const clip = lastClip.current;
    if (!clip) return;
    setFlash(null);
    setBusy("transcribe");
    const out = await window.cth.puckMessageStop(clip);
    setBusy(null);
    if (out.ok) {
      lastClip.current = null;
      setNote((n) => join(n, out.text));
    } else showFlash(problem(out.error, "final"));
  };
  const flushDrag = reactExports.useCallback(() => {
    pending.current.raf = 0;
    const { dx, dy } = pending.current;
    pending.current.dx = 0;
    pending.current.dy = 0;
    void window.cth.puckDrag({ dx, dy });
  }, []);
  const onPointerDown = (e) => {
    if (e.button !== 0 || compose && !st.recording) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, y0: e.clientY, grab: { x: e.clientX - cx, y: e.clientY - cy }, started: false };
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.started) return false;
    setDragging(false);
    if (pending.current.raf) {
      cancelAnimationFrame(pending.current.raf);
      pending.current.raf = 0;
    }
    void window.cth.puckDragEnd();
    return true;
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if ((e.buttons & 1) === 0) {
      endDrag();
      return;
    }
    if (!d.started) {
      if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) <= DEAD_ZONE) return;
      d.started = true;
      setDragging(true);
      if (st.menuOpen) closeMenu();
      void window.cth.puckDragStart(d.grab);
      return;
    }
    pending.current.dx += e.movementX;
    pending.current.dy += e.movementY;
    if (!pending.current.raf) pending.current.raf = requestAnimationFrame(flushDrag);
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    if (endDrag()) return;
    if (st.capturing || ringTake) return;
    setFlash(null);
    void window.cth.puckMenu(!st.menuOpen);
  };
  const [shotBusy, setShotBusy] = reactExports.useState(false);
  reactExports.useEffect(() => {
    if (!st.capturing) setShotBusy(false);
  }, [st.capturing]);
  const requestCapture = async () => {
    if (shotBusy) return;
    setShotBusy(true);
    const r = await window.cth.puckCaptureRequest();
    if (!r.ok) {
      setShotBusy(false);
      showFlash(problem(r.error, "capture"));
    }
  };
  const cancelCapture = () => {
    if (shotBusy) return;
    void window.cth.puckCaptureCancel();
  };
  const captureProblem = (error) => {
    if (error === "screen-denied" || error === "screen-empty") {
      const text = error === "screen-empty" ? t("pro.puck.flash.screenEmpty") : t("pro.puck.flash.screenDenied");
      showFlash({ text, bad: true, action: { label: t("pro.puck.flash.openSettings"), run: () => {
        void window.cth.puckOpenScreenAccess();
        setFlash(null);
      } } }, 12e3);
    } else {
      showFlash(problem(error, "capture"));
    }
  };
  captureFailRef.current = captureProblem;
  const screenshot = async () => {
    const r = await window.cth.puckCaptureStart();
    if (r.ok) return;
    captureProblem(r.error);
  };
  const startMeeting = async () => {
    setBusy("starting");
    const r = await window.cth.puckMeetingStart();
    if (!r.ok) {
      setBusy(null);
      showFlash(problem(r.error));
      return;
    }
    const { meetingId: meetingId2, segmentMinutes, systemAudio } = r;
    const them = systemAudio === "renderer" ? await openSystemStream() : null;
    const started = await start({ kind: "meeting", meetingId: meetingId2, segmentMs: segmentMinutes * 6e4 }, async (clip, final, track) => {
      const info = segmentInfo();
      if (clip.audio.byteLength > 0) await window.cth.puckMeetingSegment({ meetingId: meetingId2, seq: info.seq, audio: clip.audio, mimeType: clip.mimeType, startMs: info.startMs, durationMs: info.durationMs, track });
      if (final && track === "you") await window.cth.puckMeetingStop({ meetingId: meetingId2 });
    }, { them });
    setBusy(null);
    if (!started.ok) {
      await window.cth.puckMeetingStop({ meetingId: meetingId2 });
      showFlash(problem(started.error));
      return;
    }
    const card = { kind: "meeting", meetingId: meetingId2 };
    composeRef.current = card;
    setCompose(card);
    setTranscript("");
    setQuiet(true);
  };
  const speak = async () => {
    setBusy("starting");
    const r = await window.cth.puckMessageStart();
    if (!r.ok) {
      setBusy(null);
      showFlash(problem(r.error));
      return;
    }
    if (!composeRef.current || composeRef.current.kind === "meeting") {
      const card = { kind: "message", text: "" };
      composeRef.current = card;
      setCompose(card);
      setNote("");
      setQuiet(true);
      setRingTake(true);
      setTakeLevels([]);
    }
    takeMark.current = Date.now();
    const started = await start({ kind: "message" }, async (clip, final) => {
      const wanted = composeRef.current !== null && composeRef.current.kind !== "meeting";
      if (!wanted) {
        if (final) await window.cth.puckMessageStop({ audio: new ArrayBuffer(0), mimeType: clip.mimeType }).catch(() => void 0);
        return;
      }
      if (final) {
        setBusy("transcribe");
        lastClip.current = clip;
      }
      const out = final ? await window.cth.puckMessageStop({ audio: clip.audio, mimeType: clip.mimeType }) : await window.cth.puckMessageSegment({ audio: clip.audio, mimeType: clip.mimeType });
      if (out.ok) {
        if (final) lastClip.current = null;
        setNote((n) => join(n, out.text));
      } else if (out.error !== "no audio") showFlash(problem(out.error, final ? "final" : "part"));
      if (final) {
        setBusy(null);
        setRingTake(false);
        setQuiet(false);
      }
    });
    if (!started.ok) {
      if (started.error === "cancelled") return;
      setBusy(null);
      await window.cth.puckMessageStop({ audio: new ArrayBuffer(0), mimeType: "audio/webm" }).catch(() => void 0);
      if (ringTake || composeRef.current?.kind === "message") dropTakeCard();
      showFlash(problem(started.error));
      return;
    }
    setBusy(null);
  };
  const dropTakeCard = () => {
    setRingTake(false);
    setTakeLevels([]);
    if (composeRef.current?.kind === "message" && !note.trim()) {
      composeRef.current = null;
      setCompose(null);
      setNote("");
    }
  };
  const doneTake = () => {
    if (busy === "starting" || !isRecording()) {
      cancelTake();
      return;
    }
    takeMark.current = Date.now();
    setBusy("transcribe");
    void stop();
  };
  const cancelTake = () => {
    cancel();
    lastClip.current = null;
    setBusy(null);
    setRingTake(false);
    setTakeLevels([]);
    composeRef.current = null;
    setCompose(null);
    setNote("");
    void window.cth.puckMessageStop({ audio: new ArrayBuffer(0), mimeType: "audio/webm" }).catch(() => void 0);
  };
  const phase = takePhase({ ringTake, recording: st.recording?.kind === "message", busy, card: compose !== null });
  reactExports.useEffect(() => {
    if (phase !== "listening" || preview) return;
    const id = setInterval(() => setTakeLevels((l) => [...l, levelOf(level())].slice(-METER_BARS)), 80);
    return () => clearInterval(id);
  }, [phase, preview]);
  const watchRef = reactExports.useRef(() => {
  });
  watchRef.current = () => {
    const now2 = Date.now();
    if (takeExpired(phase, Math.max(lastActive(), takeMark.current), now2)) {
      cancelTake();
      showFlash({ text: t("pro.puck.take.expired"), bad: true }, 3200);
    }
    if (dictationExpired(dictView.current.phase, lastDictAt.current, now2)) {
      dictView.current = IDLE_VIEW;
      setDict(IDLE_VIEW);
    }
  };
  const watching = phase === "starting" || phase === "listening" || phase === "transcribing" || dict.phase === "listening" || dict.phase === "transcribing";
  reactExports.useEffect(() => {
    if (!watching || preview) return;
    const id = setInterval(() => watchRef.current(), 5e3);
    return () => clearInterval(id);
  }, [watching, preview]);
  reactExports.useEffect(() => {
    if (!ringTake) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelTake();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const dictating = st.recording?.kind === "message";
  const listening = dictating && busy !== "stopping" && busy !== "transcribe";
  const dictate = () => {
    if (dictating) {
      if (busy === null) setBusy("stopping");
      void stop();
      return;
    }
    if (busy || st.recording) return;
    setFlash(null);
    void speak();
  };
  const closeCard = () => {
    composeRef.current = null;
    if (dictating || isRecording()) {
      cancel();
      setBusy(null);
      void window.cth.puckMessageStop({ audio: new ArrayBuffer(0), mimeType: "audio/webm" }).catch(() => void 0);
    }
    setRingTake(false);
    setCompose(null);
    setNote("");
  };
  toggleRef.current = () => {
    if (busy) return;
    if (st.recording?.kind === "meeting") {
      void stopRecording();
      return;
    }
    if (!st.recording) void startMeeting();
  };
  const stopRecording = async () => {
    setBusy("stopping");
    closeMenu();
    const was = st.recording?.kind;
    await stop();
    if (was !== "message") setBusy(null);
    if (was === "meeting") {
      if (composeRef.current?.kind === "meeting") {
        composeRef.current = null;
        setCompose(null);
      }
      showFlash({ text: t("pro.puck.flash.meetingSaved") });
    }
  };
  const toggleInvisible = () => {
    void window.cth.puckInvisible(!st.invisible);
  };
  const pickRecipient = async (id) => {
    if (preview) {
      setSt((s) => ({ ...s, recipientId: id, recipient: s.recipients.find((r) => r.id === id)?.name ?? s.recipient }));
      return;
    }
    setSt(await window.cth.puckSendTo(id));
  };
  const send = async () => {
    if (!compose || compose.kind === "meeting" || busy) return;
    const text = note.trim();
    if (compose.kind === "message" && !text) return;
    setFlash(null);
    setBusy("send");
    const r = await window.cth.puckSend(compose.kind === "screenshot" ? { note: text, screenshots: compose.shots.map((s) => s.path) } : { note: text });
    setBusy(null);
    if (r.ok) {
      setCompose(null);
      setNote("");
      showFlash({ text: t("pro.puck.flash.sent", { recipient: r.to }) });
    } else showFlash(problem(r.error, "send"));
  };
  const size = cfg?.size ?? 80;
  const side = ringFootprint(size);
  const cx = st.offset.x || side / 2;
  const cy = st.offset.y || side / 2;
  const room = roomIn(onScreen(side, st.screen), cx, cy);
  const space = cardSpace(side, st.screen);
  const layout = reactExports.useMemo(() => {
    if (!cfg) return null;
    const actions = st.recording ? { screenshot: false, message: false, meeting: true, invisible: true, computerUse: false } : cfg.actions;
    return ringLayout(actions, size, room);
  }, [cfg, size, st.recording, room.left, room.right, room.top, room.bottom]);
  const ring = layout?.slots ?? [];
  const orbit = (layout?.radius ?? size * RING.radius) * 2;
  const btnSize = Math.round(size * RING.button);
  const labelFor = (a) => {
    if (st.recording && a === "meeting") return { text: t("pro.puck.ring.stop") };
    if (a === "invisible") return { text: st.invisible ? t("pro.puck.ring.visible") : t("pro.puck.ring.invisible") };
    if (a === "computerUse") return { text: t("pro.puck.ring.computerUse"), sub: t("pro.puck.ring.comingSoon") };
    if (a === "message" && !st.dictation) return { text: t("pro.puck.ring.message"), sub: t("pro.puck.ring.dictationOff") };
    if ((a === "message" || a === "meeting") && !st.canTranscribe) return { text: t(`pro.puck.ring.${a}`), sub: t("pro.puck.ring.needsKey") };
    return { text: t(`pro.puck.ring.${a}`) };
  };
  const iconFor = (a) => {
    if (st.recording && a === "meeting") return "stop";
    if (a === "invisible") return st.invisible ? "eyeOff" : "eye";
    return PUCK_ACTION_GLYPH[a];
  };
  const run = (a) => {
    if (busy) return;
    if (st.recording) {
      if (a === "meeting") void stopRecording();
      else if (a === "invisible") toggleInvisible();
      return;
    }
    switch (a) {
      case "screenshot":
        void screenshot();
        break;
      case "meeting":
        void startMeeting();
        break;
      case "message":
        dictate();
        break;
      case "invisible":
        toggleInvisible();
        break;
    }
  };
  const showRing = st.menuOpen && !st.capturing && (!compose || st.recording !== null);
  const recordingMs = st.recording ? now - st.recording.startedAt : 0;
  const shots = compose?.kind === "screenshot" && !compose.attached ? shotsLayout(compose.shots, space) : null;
  const CARD_H = Math.max(cardHeight(shots), cardDrawn);
  const shotsFull = compose?.kind === "screenshot" && compose.shots.length >= PUCK_MAX_SHOTS;
  const dropShot = (path) => {
    const cur = composeRef.current;
    if (cur?.kind !== "screenshot") return;
    if (cur.attached && cur.shots.length === 1) {
      const msg = { kind: "message", text: "" };
      composeRef.current = msg;
      setCompose(msg);
      return;
    }
    if (cur.shots.length < 2) return;
    const card = { kind: "screenshot", shots: cur.shots.filter((s) => s.path !== path), ...cur.attached ? { attached: true } : {} };
    composeRef.current = card;
    setCompose(card);
  };
  const avoid = showRing && st.recording && layout ? ringExtent(layout, size) : null;
  const CARD_W = Math.max(CARD.w, cardDrawnW);
  const cardStyle = placeCard({ w: CARD_W, h: CARD_H }, space, { cx, cy, size }, avoid);
  const cardBox = compose && cardVisible ? { x0: Number(cardStyle.left), y0: Number(cardStyle.top), x1: Number(cardStyle.left) + CARD_W, y1: Number(cardStyle.top) + CARD_H } : null;
  const capturePlace = st.capturing ? placeCapturePair(size, { cx, cy }, room, space, cardBox) : null;
  const cardFolded = capturePlace?.foldCard === true;
  const pair = capturePlace ? capturePlace.pair : placePair(size, { cx, cy }, room, space, cardBox);
  const cardTitle = compose?.kind === "screenshot" && !compose.attached ? t("pro.puck.card.screenshot") : compose?.kind === "meeting" ? t("pro.puck.card.meeting") : t("pro.puck.card.message");
  const rowText = () => {
    if (flash) return flash.text;
    if (busy === "starting") return t("pro.puck.card.starting");
    if (busy === "stopping") return t("pro.puck.card.stopping");
    if (busy === "transcribe") return t("pro.puck.card.transcribing");
    if (busy === "send") return t("pro.puck.card.sending");
    if (st.recording?.kind === "meeting") {
      const time = t("pro.puck.card.recording", { time: clock(recordingMs) });
      return st.canTranscribe ? `${time} · ${t("pro.puck.card.parts", { done: st.recording.transcribed, total: st.recording.segments })}` : `${time} · ${t("pro.puck.card.noKeyMeeting")}`;
    }
    if (dictating) return t("pro.puck.card.recording", { time: clock(recordingMs) });
    if (compose?.kind === "screenshot" && compose.attached) return t("pro.puck.card.attached", { count: compose.shots.length });
    if (compose?.kind === "screenshot") {
      if (shotsFull) return t("pro.puck.card.shotsFull", { count: PUCK_MAX_SHOTS });
      if (compose.shots.length > 1) return t("pro.puck.card.shots", { count: compose.shots.length });
      return `${compose.shots[0].width}×${compose.shots[0].height}`;
    }
    return t("pro.puck.card.review");
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      style: { width: side, height: side, position: "relative" },
      onMouseDown: (e) => {
        if (e.target === e.currentTarget && st.menuOpen) closeMenu();
      },
      ...showRing || cardVisible ? { "data-hit": true } : {},
      children: [
        cfg && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `puck-ring${showRing ? " in" : ""}`, "aria-hidden": !showRing, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-orbit", style: { left: cx, top: cy, width: orbit, height: orbit } }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-orbit dashed", style: { left: cx, top: cy, width: orbit + 28, height: orbit + 28 } }),
          ring.map((slot, i) => {
            const label = labelFor(slot.action);
            const disabled = slot.action === "computerUse" || slot.action === "message" && !st.dictation && !st.recording || (slot.action === "message" || slot.action === "meeting") && !st.canTranscribe && !st.recording;
            const on = slot.action === "invisible" && st.invisible;
            const danger = st.recording !== null && slot.action === "meeting";
            let lx;
            let labelPos;
            if (slot.label.mode === "beside") {
              const outward = slot.label.side;
              lx = outward === "left" ? "calc(-100% - 10px)" : outward === "right" ? "10px" : "-50%";
              labelPos = outward === "up" ? { left: cx + slot.x, top: cy + slot.y - btnSize / 2 - 14 } : outward === "down" ? { left: cx + slot.x, top: cy + slot.y + btnSize / 2 + 14 } : { left: cx + slot.x + (outward === "right" ? btnSize / 2 : -btnSize / 2), top: cy + slot.y };
            } else {
              const rad = slot.angle * Math.PI / 180;
              const d = (layout?.radius ?? 0) + btnSize / 2 + RING.pad + LABEL_GAP;
              lx = slot.label.align === "left" ? "-100%" : slot.label.align === "right" ? "0" : "-50%";
              labelPos = { left: Math.round(cx + Math.sin(rad) * d), top: Math.round(cy - Math.cos(rad) * d) };
            }
            return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "button",
                {
                  type: "button",
                  className: `puck-btn${on ? " on" : ""}${danger ? " danger" : ""}`,
                  "data-hit": true,
                  "data-action": slot.action,
                  disabled,
                  tabIndex: showRing ? 0 : -1,
                  "aria-label": label.text,
                  style: { left: cx, top: cy, width: btnSize, height: btnSize, ["--x"]: `${slot.x}px`, ["--y"]: `${slot.y}px`, ["--i"]: i },
                  onClick: () => run(slot.action),
                  children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: iconFor(slot.action), size: Math.round(btnSize * 0.46) })
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "puck-label", style: { ...labelPos, ["--lx"]: lx }, children: [
                label.text,
                label.sub && /* @__PURE__ */ jsxRuntimeExports.jsx("small", { children: label.sub })
              ] })
            ] }, slot.action);
          }),
          layout?.close && /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              type: "button",
              className: "puck-btn close",
              "data-hit": true,
              tabIndex: showRing ? 0 : -1,
              "aria-label": t("pro.puck.ring.close"),
              title: t("pro.puck.ring.close"),
              style: { left: cx, top: cy, width: Math.round(size * RING.closeButton), height: Math.round(size * RING.closeButton), ["--x"]: `${layout.close.x}px`, ["--y"]: `${layout.close.y}px`, ["--i"]: ring.length },
              onClick: closeMenu,
              children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: "close", size: 14 })
            }
          )
        ] }),
        st.recording && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-rec", style: { left: cx, top: cy, width: size + 10, height: size + 10 } }),
          !ringTake && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "puck-clock", style: { left: cx, top: cy + size / 2 + 10 }, children: [
            busy === "starting" ? t("pro.puck.card.starting") : `${st.recording.kind === "meeting" ? t("pro.puck.recording.meeting") : t("pro.puck.recording.message")} ${clock(recordingMs)}`,
            busy === "transcribe" && ` · ${t("pro.puck.recording.transcribing")}`
          ] })
        ] }),
        cfg && ringTake && (phase === "starting" || phase === "listening" || phase === "transcribing") && (() => {
          const labelTop = pair.labelTop;
          const pillTop = labelTop > pair.y ? cy - size / 2 - 10 - DICTATE_PILL_H : labelTop - 26 - DICTATE_PILL_H;
          const one = (kind, i) => {
            const x = kind === "done" ? -pair.dx : pair.dx;
            const text = kind === "done" ? t("pro.puck.take.done") : t("pro.puck.take.cancel");
            return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "button",
                {
                  type: "button",
                  className: `puck-btn ${kind === "done" ? "on" : "close"}`,
                  "data-hit": true,
                  "data-take": kind,
                  disabled: kind === "done" && phase !== "listening",
                  "aria-label": text,
                  style: { left: pair.x, top: pair.y, width: pair.button, height: pair.button, ["--x"]: `${x}px`, ["--y"]: "0px", ["--i"]: i },
                  onClick: kind === "done" ? doneTake : cancelTake,
                  children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: kind === "done" ? "check" : "close", size: Math.round(pair.button * 0.46) })
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-label always", style: { left: pair.x + x, top: pair.labelTop, ["--lx"]: "-50%" }, children: text })
            ] }, kind);
          };
          return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-dictate", "data-take-phase": phase, style: { left: cx, top: pillTop }, "aria-live": "polite", children: phase === "listening" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "puck-meter", "aria-label": t("pro.puck.dictation.listening"), children: Array.from({ length: METER_BARS }, (_, i) => {
              const lv = takeLevels[takeLevels.length - METER_BARS + i] ?? 0;
              return /* @__PURE__ */ jsxRuntimeExports.jsx("i", { style: { height: 3 + Math.round(lv * 13) } }, i);
            }) }) : phase === "starting" ? t("pro.puck.card.starting") : t("pro.puck.recording.transcribing") }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "puck-ring in puck-capture", "data-hit": true, "data-take-buttons": true, "data-pair": pair.at, children: [
              one("done", 0),
              one("cancel", 1)
            ] })
          ] });
        })(),
        cfg && /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            className: `puck-disc${hover || dragging || st.menuOpen ? " lifted" : ""}`,
            "data-hit": true,
            role: "button",
            "aria-label": t("pro.puck.disc"),
            "aria-expanded": st.menuOpen,
            style: { left: cx, top: cy, opacity: hover || dragging || st.menuOpen || st.recording || compose || dict.phase !== "idle" ? 1 : cfg.opacity / 100 },
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: () => {
              endDrag();
            },
            onLostPointerCapture: () => {
              endDrag();
            },
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckFace, { look: ringTake && phase !== "card" && phase !== "idle" ? { ...cfg, expression: "thinking" } : cfg, size, animate: "always", gaze: !preview && cfg.eyesFollow ? cursorFeed : void 0, voice })
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "puck-sr", "aria-live": "polite", children: voice ? voice.phase === "listening" ? t("pro.puck.dictation.listening") : t("pro.puck.recording.transcribing") : "" }),
        compose && cardVisible && /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            ref: cardRef,
            className: `puck-card${cardFolded ? " folded" : ""}`,
            ...cardFolded ? { inert: "", "aria-hidden": true } : { "data-hit": true },
            style: cardStyle,
            role: "dialog",
            "aria-label": cardTitle,
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "puck-head", children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { children: cardTitle }),
                compose.kind !== "meeting" && st.recipients.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "puck-to", children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: t("pro.puck.card.to") }),
                  /* @__PURE__ */ jsxRuntimeExports.jsx(
                    "select",
                    {
                      "data-recipient": true,
                      "aria-label": t("pro.puck.card.sendTo"),
                      value: st.recipientId,
                      disabled: busy === "send",
                      onChange: (e) => {
                        void pickRecipient(e.target.value);
                      },
                      children: st.recipients.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: r.id, children: r.name }, r.id))
                    }
                  )
                ] })
              ] }),
              compose.kind === "screenshot" && !compose.attached && compose.shots.length === 1 && /* @__PURE__ */ jsxRuntimeExports.jsx("img", { src: compose.shots[0].preview, alt: "", width: shots?.boxes[0]?.width, height: shots?.boxes[0]?.height }),
              compose.kind === "screenshot" && !compose.attached && compose.shots.length > 1 && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-shots", "data-shots": compose.shots.length, children: compose.shots.map((s, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "puck-thumb", style: { width: shots?.boxes[i]?.width, height: shots?.boxes[i]?.height }, children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("img", { src: s.preview, alt: "" }),
                /* @__PURE__ */ jsxRuntimeExports.jsx(
                  "button",
                  {
                    type: "button",
                    className: "puck-b icon",
                    "data-drop-shot": true,
                    disabled: busy !== null,
                    "aria-label": t("pro.puck.card.dropShot", { n: i + 1 }),
                    title: t("pro.puck.card.dropShot", { n: i + 1 }),
                    onClick: () => dropShot(s.path),
                    children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: "close", size: 10 })
                  }
                )
              ] }, s.path)) }),
              compose.kind === "meeting" && onSpeakers && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-hint", role: "note", "data-speakers-hint": true, children: t("pro.puck.card.headphones") }),
              compose.kind === "meeting" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
                "textarea",
                {
                  ref: transcriptBox,
                  readOnly: true,
                  value: transcript,
                  placeholder: t("pro.puck.card.transcriptWaits"),
                  onKeyDown: (e) => {
                    if (e.key === "Escape") closeCard();
                  }
                }
              ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
                "textarea",
                {
                  ref: transcriptBox,
                  autoFocus: true,
                  value: note,
                  placeholder: compose.kind === "screenshot" && !compose.attached ? t("pro.puck.card.notePlaceholder", { recipient: st.recipient }) : dictating ? t("pro.puck.card.listening") : t("pro.puck.card.messagePlaceholder"),
                  onChange: (e) => setNote(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === "Escape") closeCard();
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }
                }
              ),
              compose.kind === "screenshot" && compose.attached && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-attached", "data-attached": compose.shots.length, children: compose.shots.map((s, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "puck-chip", "data-chip": true, children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("img", { src: s.preview, alt: "" }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: t("pro.puck.card.chip", { n: i + 1 }) }),
                /* @__PURE__ */ jsxRuntimeExports.jsx(
                  "button",
                  {
                    type: "button",
                    className: "puck-b icon",
                    "data-drop-shot": true,
                    disabled: busy !== null,
                    "aria-label": t("pro.puck.card.dropShot", { n: i + 1 }),
                    title: t("pro.puck.card.dropShot", { n: i + 1 }),
                    onClick: () => dropShot(s.path),
                    children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: "close", size: 10 })
                  }
                )
              ] }, s.path)) }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `puck-status${flash?.bad ? " bad" : ""}`, role: "status", children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: rowText() }),
                flash?.action && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b", onClick: flash.action.run, children: flash.action.label }),
                flash?.action && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b", "aria-label": t("pro.puck.card.dismiss"), title: t("pro.puck.card.dismiss"), onClick: () => setFlash(null), children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: "close", size: 11 }) })
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-row", children: compose.kind === "meeting" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b", onClick: quiet ? closeMenu : closeCard, children: t("pro.puck.card.hide") }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b danger", "data-stop": true, disabled: busy !== null, onClick: () => {
                  void stopRecording();
                }, children: t("pro.puck.ring.stop") })
              ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
                (compose.kind === "message" || compose.kind === "screenshot") && /* @__PURE__ */ jsxRuntimeExports.jsx(
                  "button",
                  {
                    type: "button",
                    className: "puck-b icon",
                    "data-shot": true,
                    disabled: busy !== null || st.capturing || shotsFull,
                    "aria-label": t("pro.puck.card.addScreenshot"),
                    title: t("pro.puck.card.addScreenshot"),
                    onClick: () => {
                      void screenshot();
                    },
                    children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: "screenshot", size: 15 })
                  }
                ),
                /* @__PURE__ */ jsxRuntimeExports.jsx(
                  "button",
                  {
                    type: "button",
                    className: `puck-b icon${listening ? " danger" : ""}`,
                    "data-dictate": true,
                    disabled: busy !== null || (!st.canTranscribe || !st.dictation) && !dictating,
                    "aria-label": listening ? t("pro.puck.card.stopDictate") : t("pro.puck.card.dictate"),
                    title: !st.dictation && !dictating ? t("pro.puck.ring.dictationOff") : !st.canTranscribe && !dictating ? t("pro.puck.ring.needsKey") : listening ? t("pro.puck.card.stopDictate") : t("pro.puck.card.dictate"),
                    onClick: dictate,
                    children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: listening ? "stop" : "mic", size: 15 })
                  }
                ),
                /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b", onClick: closeCard, children: t("pro.puck.card.cancel") }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b primary", disabled: busy !== null || dictating || compose.kind === "message" && !note.trim(), onClick: () => {
                  void send();
                }, children: busy === "send" ? t("pro.puck.card.sending") : t("pro.puck.card.send") })
              ] }) })
            ]
          }
        ),
        cfg && st.capturing && !preview && (() => {
          const one = (kind, i) => {
            const x = kind === "capture" ? -pair.dx : pair.dx;
            const text = kind === "capture" ? shotBusy ? t("pro.puck.capture.capturing") : t("pro.puck.capture.capture") : t("pro.puck.capture.cancel");
            return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "button",
                {
                  type: "button",
                  className: `puck-btn ${kind === "capture" ? "on" : "close"}`,
                  "data-hit": true,
                  "data-action": kind,
                  disabled: shotBusy,
                  "aria-label": text,
                  style: { left: pair.x, top: pair.y, width: pair.button, height: pair.button, ["--x"]: `${x}px`, ["--y"]: "0px", ["--i"]: i },
                  onClick: kind === "capture" ? () => {
                    void requestCapture();
                  } : cancelCapture,
                  children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckGlyph, { name: kind === "capture" ? "check" : "close", size: Math.round(pair.button * 0.46) })
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "puck-label always", style: { left: pair.x + x, top: pair.labelTop, ["--lx"]: "-50%" }, children: text })
            ] }, kind);
          };
          return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "puck-ring in puck-capture", "data-hit": true, "data-pair": pair.at, children: [
            one("capture", 0),
            one("cancel", 1)
          ] });
        })(),
        flash && !cardVisible && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { ref: flashRef, className: `puck-flash${flash.bad ? " bad" : ""}`, "data-hit": true, style: placeFlash(space, { cx, cy, size }, Math.max(flash.action ? 96 : 36, flashDrawn), st.recording ? 36 : FLASH.gap), role: "status", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: flash.text }),
          flash.action && /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "puck-row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b", onClick: flash.action.run, children: flash.action.label }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "puck-b", onClick: () => setFlash(null), children: t("pro.puck.card.cancel") })
          ] })
        ] })
      ]
    }
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("No root element");
createRoot(root).render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(PuckApp, {}) })
);

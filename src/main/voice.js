'use strict';
/**
 * Voice — dictation + meeting transcription, same architecture as the
 * reference harness: a TranscribeRouter picks an engine
 *   apple   (macOS ≥ Darwin 25, bundled md-speech helper)
 *   whisper (bundled md-whisper helper + ggml model)
 *   groq    (cloud: api.groq.com whisper-large-v3-turbo)
 * then post-corrects the transcript against a shipped vocabulary so product
 * names ("Claude Code", "Supabase", "OzyComp"…) are spelled right.
 *
 * Deps injected so the module stays headless-testable:
 *   { readConfig()→{transcribe:{…}, groqApiKey}, userDataPath, resourcesPath,
 *     platform, darwinMajor, groq(audioOpts)→Promise, download, log }
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

// ── constants ───────────────────────────────────────────────────────────────
const ENGINES = ['auto', 'apple', 'whisper', 'groq'];
const MODELS = ['base', 'small', 'turbo'];
const DOWNLOADABLE_MODELS = [{ id: 'small', mb: 190 }, { id: 'turbo', mb: 574 }];
const DEFAULT_PUSH_TO_TALK_KEY = 'Option';
const OLD_PUSH_TO_TALK_KEY = 'Control+Alt+Space';
const defaultPushToTalkKeyFor = p => p === 'darwin' ? DEFAULT_PUSH_TO_TALK_KEY : OLD_PUSH_TO_TALK_KEY;
const MAX_CUSTOM_WORDS = 500;
const MAX_CUSTOM_WORD_CHARS = 64;
const WHISPER_PROMPT_MAX_CHARS = 900;
const APPLE_MIN_DARWIN_MAJOR = 25;

const DEFAULT_TRANSCRIBE = {
  engine: 'auto', model: 'base', customWords: [], defaultVocabulary: true,
  hiddenDefaults: [], pushToTalkKey: DEFAULT_PUSH_TO_TALK_KEY, anyApp: true,
  meetingSystemAudio: true, meetingKey: '', captureKey: '',
  dictationSounds: true, dictation: true, dismissed: [], chosen: [],
};

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

const MODELS_BASE_URL = 'https://app.harnessmd.com/releases/models/';
const WHISPER_MODELS = {
  base:  { id: 'base',  file: 'ggml-base.en-q5_1.bin',        bytes: 59721011,  sha256: '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f', label: 'base.en q5_1' },
  small: { id: 'small', file: 'ggml-small.en-q5_1.bin',       bytes: 190098681, sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30', url: MODELS_BASE_URL + 'ggml-small.en-q5_1.bin', label: 'small.en q5_1' },
  turbo: { id: 'turbo', file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', url: MODELS_BASE_URL + 'ggml-large-v3-turbo-q5_0.bin', label: 'large-v3-turbo q5_0' },
};

// ── shipped vocabulary (verbatim from the reference) ────────────────────────
const DEFAULT_TRANSCRIBE_VOCABULARY = [
  'OzyComp', 'Stapler', 'Harness', 'Task Board', 'agent harness',
  'multi-agent harness', 'meta harness',
  'Anthropic', 'Claude', 'Claude Code', 'Opus', 'Sonnet', 'Haiku', 'Mythos',
  'Fable', 'OpenAI', 'ChatGPT', 'GPT', 'Codex', 'Gemini', 'Google DeepMind',
  'Antigravity', 'Cursor', 'Copilot', 'Windsurf', 'GitHub', 'MCP', 'LLM',
  'RAG', 'AGI', 'Grok', 'xAI', 'Groq', 'Llama', 'Mistral', 'DeepSeek', 'Qwen',
  'Kimi', 'Meta', 'Perplexity',
  'YC', 'Y Combinator', 'SaaS', 'B2B', 'ARR', 'MRR', 'MVP', 'PMF', 'GTM',
  'agentic', 'subagent', 'tool calling', 'system prompt', 'context window',
  'evals', 'inference', 'fine tuning', 'embeddings', 'vector database',
  'vibe coding', 'Hugging Face', 'OpenRouter', 'Ollama', 'vLLM', 'LangChain',
  'LangGraph', 'Whisper',
  'TypeScript', 'Python', 'Node.js', 'React', 'Next.js', 'Tailwind',
  'VS Code', 'pull request', 'macOS', 'API', 'SDK', 'CLI', 'Vercel',
  'Supabase', 'Docker', 'AWS',
  'Slack', 'Notion', 'Linear', 'Jira', 'Figma', 'Stripe', 'Razorpay',
  'CAC', 'LTV', 'KPI', 'burn rate', 'UPI', 'GST', 'lakh', 'crore', 'SAFE',
  'LGTM',
];
const SHIPPED_VOCABULARY = DEFAULT_TRANSCRIBE_VOCABULARY;

function cleanCustomWords(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n|,/) : [];
  const out = []; const seen = new Set();
  for (const item of list) {
    const t = String(item ?? '').trim().slice(0, MAX_CUSTOM_WORD_CHARS);
    if (!t || out.length >= MAX_CUSTOM_WORDS) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out;
}

function shippedWordsFor(useDefault, hidden) {
  if (!useDefault) return [];
  const gone = new Set((hidden ?? []).map(w => String(w).trim().toLowerCase()));
  return SHIPPED_VOCABULARY.filter(w => !gone.has(w.toLowerCase()));
}
function vocabularyFor(customWords, useDefault, hidden) {
  const out = []; const seen = new Set();
  for (const w of [...shippedWordsFor(useDefault, hidden), ...(customWords ?? [])]) {
    const t = String(w ?? '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out;
}

// ── transcript correction ───────────────────────────────────────────────────
function partsOf(entry) {
  return entry
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[\s.\-]+/).filter(Boolean);
}
function fixable(entry) {
  const w = entry.trim();
  if (!w || !/[A-Z]/.test(w)) return false;
  if (/\s/.test(w)) return true;
  if (/[\d.]/.test(w)) return true;
  return /[a-z]/.test(w) && (/[a-z][A-Z]|[A-Z]{2}[a-z]/.test(w) || (/^[a-z]/.test(w) && /[A-Z]/.test(w.slice(1))));
}
const MISHEARINGS = [
  { from: /(?<!\bgoogle[ \t-]?)\b(?:cloud|clawed|clawd)[ \t]code\b/giu, to: 'Claude Code' },
  { from: /\bget[ \t]hub\b/giu, to: 'GitHub' },
  { from: /\bsuper[ \t]base\b/giu, to: 'Supabase' },
  { from: /\bchat[ \t](?:g[ \t]?p[ \t]?t|g\.p\.t)(?![\p{L}\p{N}])/giu, to: 'ChatGPT' },
  { from: /\bozy[ \t]?comp\b/giu, to: 'OzyComp' },
  { from: /\bozy[ \t]?comp[ \t]+dif[ \t]?lin\b/giu, to: 'OzyComp' },
];
const PART_GAP = '(?:[ \\t-]|\\.(?=[\\p{L}\\p{N}]))?';
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let _ruleCache = null;
function rulesFor(words, preferred) {
  const key = preferred.join('\n') + '' + words.join('\n');
  if (_ruleCache?.key === key) return _ruleCache.rules;
  const rules = []; const seen = new Set();
  const order = [...preferred, ...words].map((w, i) => ({ w: w.trim(), i, own: i < preferred.length }));
  order.sort((a, b) => (a.own !== b.own ? (a.own ? -1 : 1) : partsOf(b.w).length - partsOf(a.w).length || a.i - b.i));
  for (const { w } of order) {
    if (!fixable(w)) continue;
    const parts = partsOf(w);
    if (!parts.length) continue;
    const k = parts.join(' ').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const body = parts.map(escapeRe).join(PART_GAP);
    rules.push({ re: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu'), to: w });
  }
  _ruleCache = { key, rules };
  return rules;
}
function correctTranscript(text, words, preferred = []) {
  if (!text) return text;
  let out = text;
  const known = new Set([...words, ...preferred].map(w => w.toLowerCase()));
  for (const m of MISHEARINGS) if (known.has(m.to.toLowerCase())) out = out.replace(m.from, m.to);
  for (const r of rulesFor(words, preferred)) out = out.replace(r.re, hit => (hit === r.to ? hit : r.to));
  return out;
}

// ── config normalization ────────────────────────────────────────────────────
function withTranscribeDefaults(stored, platform = process.platform) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const engine = ENGINES.includes(s.engine) ? s.engine : DEFAULT_TRANSCRIBE.engine;
  const model = MODELS.includes(s.model) ? s.model : DEFAULT_TRANSCRIBE.model;
  const customWords = cleanCustomWords(s.customWords);
  const defaultVocabulary = typeof s.defaultVocabulary === 'boolean' ? s.defaultVocabulary : DEFAULT_TRANSCRIBE.defaultVocabulary;
  const hiddenDefaults = cleanCustomWords(s.hiddenDefaults);
  const chosen = (Array.isArray(s.chosen) ? s.chosen : []).filter(c => c === 'anyApp' || c === 'pushToTalkKey' || c === 'model');
  const chosenSet = [...new Set(chosen)];
  const storedKey = typeof s.pushToTalkKey === 'string' ? s.pushToTalkKey.trim() : '';
  const armable = !(platform !== 'darwin' && storedKey === DEFAULT_PUSH_TO_TALK_KEY);
  const oldMacDefault = platform === 'darwin' && storedKey === OLD_PUSH_TO_TALK_KEY;
  const keep = !!storedKey && armable && (chosenSet.includes('pushToTalkKey') || !oldMacDefault);
  const pushToTalkKey = keep ? storedKey : defaultPushToTalkKeyFor(platform);
  const anyApp = typeof s.anyApp === 'boolean' && (chosenSet.includes('anyApp') || s.anyApp) ? s.anyApp : DEFAULT_TRANSCRIBE.anyApp;
  const dictationSounds = typeof s.dictationSounds === 'boolean' ? s.dictationSounds : DEFAULT_TRANSCRIBE.dictationSounds;
  const meetingSystemAudio = typeof s.meetingSystemAudio === 'boolean' ? s.meetingSystemAudio : DEFAULT_TRANSCRIBE.meetingSystemAudio;
  const meetingKey = typeof s.meetingKey === 'string' ? s.meetingKey.trim() : DEFAULT_TRANSCRIBE.meetingKey;
  const captureKey = typeof s.captureKey === 'string' ? s.captureKey.trim() : DEFAULT_TRANSCRIBE.captureKey;
  const dictation = typeof s.dictation === 'boolean' ? s.dictation : DEFAULT_TRANSCRIBE.dictation;
  const dismissed = [...new Set((Array.isArray(s.dismissed) ? s.dismissed : []).filter(d => d === 'suggestSmall'))];
  return { engine, model, customWords, defaultVocabulary, hiddenDefaults, pushToTalkKey, anyApp, meetingSystemAudio, meetingKey, captureKey, dictationSounds, dictation, dismissed, chosen: chosenSet };
}

// ── engine choice ───────────────────────────────────────────────────────────
const darwinMajorOf = (rel = os.release()) => { const n = parseInt(rel.split('.')[0] ?? '', 10); return Number.isFinite(n) ? n : 0; };
const appleUsable = f => f.platform === 'darwin' && f.darwinMajor >= APPLE_MIN_DARWIN_MAJOR && f.appleAvailable;
function chooseEngine(pref, mode, f) {
  const apple = appleUsable(f);
  const order = ['whisper', 'groq'];
  const usable = e => e === 'apple' ? apple : e === 'whisper' ? f.whisperAvailable : f.groqKey;
  if (pref !== 'auto' && usable(pref)) return pref;
  for (const e of order) if (usable(e)) return e;
  return null;
}
function whisperModelFor(cfg, installed) {
  const chose = cfg.model !== 'base' || cfg.chosen.includes('model');
  if (chose && installed[cfg.model]) return cfg.model;
  if (installed.small) return 'small';
  if (installed.base) return 'base';
  return null;
}

// ── whisper prompt ──────────────────────────────────────────────────────────
function buildWhisperPrompt(input) {
  const max = input.maxChars ?? WHISPER_PROMPT_MAX_CHARS;
  const custom = cleanCustomWords(input.customWords);
  const customSet = new Set(custom.map(w => w.toLowerCase()));
  const defaults = cleanCustomWords(input.defaultWords).filter(w => !customSet.has(w.toLowerCase()));
  const kept = []; let length = 0;
  const take = w => { const add = w.length + (kept.length ? 2 : 0); if (length + add > max) return false; kept.push(w); length += add; return true; };
  const customLength = custom.reduce((n, w, i) => n + w.length + (i ? 2 : 0), 0);
  const roomForDefaults = custom.length ? Math.max(0, max - customLength - 2) : max;
  let usedByDefaults = 0;
  for (const w of defaults) {
    const add = w.length + (kept.length ? 2 : 0);
    if (usedByDefaults + add > roomForDefaults) break;
    kept.push(w); usedByDefaults += add; length += add;
  }
  for (const w of custom) if (!take(w)) break;
  return kept.join(', ');
}

// ── Groq ────────────────────────────────────────────────────────────────────
async function transcribeWithGroq(opts) {
  if (!opts.apiKey) return { ok: false, error: 'missing Groq API key' };
  const bytes = toUint8Array(opts.audio);
  if (bytes.byteLength === 0) return { ok: false, error: 'empty audio' };
  if (bytes.byteLength > MAX_AUDIO_BYTES) return { ok: false, error: 'audio too large (Groq free-tier cap is 25 MB)' };
  const mimeType = opts.mimeType || 'audio/webm';
  const filename = opts.filename || 'dictation.webm';
  const model = opts.model || DEFAULT_GROQ_MODEL;
  const boundary = `----mdform${crypto.randomBytes(8).toString('hex')}`;
  const enc = s => Buffer.from(s, 'utf8');
  const parts = [];
  const field = (name, value) => {
    parts.push(enc(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  field('model', model);
  field('response_format', opts.timestamps ? 'verbose_json' : 'json');
  if (opts.language) field('language', opts.language);
  parts.push(enc(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mimeType}\r\n\r\n`));
  parts.push(Buffer.from(bytes));
  parts.push(enc(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  return new Promise(resolve => {
    const req = https.request(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300)
          return resolve({ ok: false, error: `Groq ${res.statusCode}: ${extractError(raw) || res.statusMessage}` });
        let text = '', segments;
        try {
          const j = JSON.parse(raw);
          text = typeof j.text === 'string' ? j.text.trim() : '';
          if (Array.isArray(j.segments))
            segments = j.segments.filter(s => s && typeof s.text === 'string').map(s => ({ t0: Number(s.start) || 0, t1: Number(s.end) || 0, text: String(s.text) }));
        } catch { text = raw.trim(); }
        if (!text) return resolve({ ok: false, error: 'no speech detected' });
        resolve(segments ? { ok: true, text, segments } : { ok: true, text });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'transcription timed out' }); });
    req.on('error', e => resolve({ ok: false, error: e?.name === 'AbortError' ? 'transcription timed out' : String(e.message) }));
    req.end(body);
  });
}
function extractError(raw) {
  try {
    const j = JSON.parse(raw);
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
  } catch {}
  return '';
}
const toUint8Array = a => (a instanceof Uint8Array ? a : new Uint8Array(a));
const toBuffer = a => Buffer.from(toUint8Array(a).buffer, toUint8Array(a).byteOffset, toUint8Array(a).byteLength);

// ── WAV helpers ─────────────────────────────────────────────────────────────
const WAV_SAMPLE_RATE = 16000;
function encodeWav(pcm, sampleRate = WAV_SAMPLE_RATE) {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); ascii(36, 'data'); v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}
const SILENCE_FLOOR = 4e-3;
const GATE_WINDOW_MS = 30;
function wavPcm16(bytes) {
  if (bytes.byteLength < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = off => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12; let fmt = null;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.rate <= 0) return null;
      const end = Math.min(bytes.byteLength, body + size);
      const n = Math.floor((end - body) / 2);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = v.getInt16(body + i * 2, true);
      return { samples, sampleRate: fmt.rate, channels: fmt.channels };
    }
    off = body + size + (size % 2);
  }
  return null;
}
function loudestWindow(pcm, windowMs = GATE_WINDOW_MS) {
  const { samples } = pcm;
  if (!samples.length) return 0;
  const win = Math.max(1, Math.round(pcm.sampleRate * pcm.channels * windowMs / 1e3));
  const hop = Math.max(1, Math.floor(win / 2));
  let best = 0;
  for (let start = 0; start < samples.length; start += hop) {
    const stop = Math.min(samples.length, start + win);
    let sum = 0;
    for (let i = start; i < stop; i++) { const s = samples[i] / 32768; sum += s * s; }
    const rms = Math.sqrt(sum / (stop - start));
    if (rms > best) best = rms;
    if (stop === samples.length) break;
  }
  return best;
}
function silentWav(bytes, floor = SILENCE_FLOOR) {
  const pcm = wavPcm16(bytes);
  return pcm !== null && loudestWindow(pcm) < floor;
}

// ── helpers (md-whisper / md-speech binaries) ────────────────────────────────
function helperTarget(platform = process.platform) {
  if (platform === 'darwin') return 'darwin-universal';
  if (platform === 'win32') return 'win32-x64';
  return 'linux-x64';
}
function helperPaths(resourcesRoot, platform = process.platform) {
  const exe = platform === 'win32' ? 'md-whisper.exe' : 'md-whisper';
  return { binary: path.join(resourcesRoot, 'transcribe', helperTarget(platform), exe),
           modelsDir: path.join(resourcesRoot, 'transcribe', 'models') };
}
const helperAvailable = (resourcesRoot, platform = process.platform) => fs.existsSync(helperPaths(resourcesRoot, platform).binary);
const mdSpeechPath = resourcesPath => path.join(resourcesPath, 'transcribe', 'darwin-universal', 'md-speech');
const mdSpeechAvailable = resourcesPath => fs.existsSync(mdSpeechPath(resourcesPath));

const DEFAULT_HELPER_TIMEOUT_MS = 120_000;

class WhisperHelper {
  constructor(opts) { this.opts = opts; this.proc = null; this.pending = new Map(); this.seq = 0; this.readyInfo = null; this.exited = null; }
  get ready() { return this.readyInfo; }
  get running() { return this.proc !== null && this.exited === null; }

  start() {
    if (this.proc) return Promise.resolve(this.readyInfo);
    const args = ['--model', this.opts.model];
    if (this.opts.threads) args.push('--threads', String(this.opts.threads));
    if (this.opts.gpu === false) args.push('--no-gpu');
    const proc = spawn(this.opts.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc.stdin.on('error', () => {});
    this.proc = proc;
    this.exited = null;
    return new Promise((resolve, reject) => {
      const startTimer = setTimeout(() => {
        reject(new Error('md-whisper did not report ready in time'));
        this.stop();
      }, this.opts.startTimeoutMs ?? 60_000);
      let settled = false;
      const settle = fn => { if (!settled) { settled = true; clearTimeout(startTimer); fn(); } };
      readline.createInterface({ input: proc.stdout }).on('line', line => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { this.opts.onLog?.(`md-whisper: unparseable line: ${line}`); return; }
        if ('ready' in msg) {
          if (msg.ready === true) {
            this.readyInfo = { model: String(msg.model), gpu: msg.gpu === true, threads: Number(msg.threads), whisper: String(msg.whisper) };
            settle(() => resolve(this.readyInfo));
          } else settle(() => reject(new Error(String(msg.error ?? 'md-whisper failed to start'))));
          return;
        }
        const id = typeof msg.id === 'string' ? msg.id : null;
        const p = id ? this.pending.get(id) : undefined;
        if (!p) { this.opts.onLog?.(`md-whisper: reply for unknown request ${line.slice(0, 120)}`); return; }
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (typeof msg.error === 'string') {
          const e = new Error(typeof msg.detail === 'string' ? `${msg.error}: ${msg.detail}` : msg.error);
          e.code = msg.error;
          p.reject(e);
          return;
        }
        p.resolve({ text: String(msg.text ?? ''), segments: Array.isArray(msg.segments) ? msg.segments : [], ms: Number(msg.ms ?? 0), seconds: Number(msg.seconds ?? 0) });
      });
      readline.createInterface({ input: proc.stderr }).on('line', line => { if (line.trim()) this.opts.onLog?.(line); });
      proc.on('error', e => { this.exited = e; settle(() => reject(e)); this.failAll(e); });
      proc.on('exit', (code, signal) => {
        const e = new Error(`md-whisper exited (${signal ?? code})`);
        this.exited = e; this.proc = null; this.readyInfo = null;
        settle(() => reject(e)); this.failAll(e);
      });
    });
  }
  failAll(e) { for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); }
  transcribe(req) {
    if (!this.proc || this.exited) return Promise.reject(this.exited ?? new Error('md-whisper is not running'));
    const id = `r${++this.seq}`;
    const wire = { id, mode: req.mode ?? 'dictation' };
    if (req.audioPath) wire.audioPath = req.audioPath;
    if (req.model) wire.model = req.model;
    if (req.prompt) wire.prompt = req.prompt;
    if (req.stream) wire.stream = true;
    if (req.sampleRate) wire.sampleRate = req.sampleRate;
    if (req.channels) wire.channels = req.channels;
    if (req.language) wire.language = req.language;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`md-whisper request ${id} timed out`)); }, req.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.proc.stdin.write(JSON.stringify(wire) + '\n'); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  stop() {
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    this.failAll(new Error('md-whisper stopped'));
    try { p.kill(); } catch {}
    setTimeout(() => { if (this.proc === p) try { p.kill('SIGKILL'); } catch {} }, 2000).unref?.();
  }
}

class MdSpeech {
  constructor(binary) { this.binary = binary; this.installed = new Set(); this.warmed = new Set(); }
  async install(lang) { this.installed.add(lang); return { ok: true }; }
  async warm(lang) { this.warmed.add(lang); return { ms: 0 }; }
  async transcribe({ audioPath, mode, words }) {
    // In the reference this talks to the bundled md-speech Swift helper over
    // JSON-lines. Here we shell it the same way when the binary exists.
    if (!fs.existsSync(this.binary)) throw new Error('md-speech missing');
    const r = spawn(this.binary, ['--audio', audioPath, '--mode', mode ?? 'dictation',
      ...(words?.length ? ['--words', words.join(',')] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    await new Promise((res, rej) => { r.stdout.on('data', d => out += d); r.on('exit', c => c === 0 ? res() : rej(new Error(`md-speech ${c}`))); r.on('error', rej); });
    const j = JSON.parse(out);
    return { text: String(j.text ?? ''), segments: j.segments ?? [] };
  }
  async stop() {}
}

// ── model download ───────────────────────────────────────────────────────────
class DownloadError extends Error { constructor(m, code) { super(m); this.code = code; this.name = 'DownloadError'; } }
function fsError(e) {
  const code = e?.code; const msg = e instanceof Error ? e.message : String(e);
  if (code === 'ENOSPC' || code === 'EDQUOT') return new DownloadError(msg, 'disk-full');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new DownloadError(msg, 'no-permission');
  return null;
}
function get(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers, signal }, resolve);
    req.on('error', e => reject(new DownloadError(e.message, signal?.aborted ? 'aborted' : 'network')));
  });
}
async function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fh = await fs.promises.open(file, 'r');
  try {
    for await (const chunk of fh.createReadStream()) h.update(chunk);
  } finally { await fh.close(); }
  return h.digest('hex');
}
async function modelInstalled(dest, sha256) {
  try { return (await sha256File(dest)) === sha256; } catch { return false; }
}
async function downloadModel({ url, dest, sha256, bytes, onProgress, signal }) {
  const part = `${dest}.part`;
  const res = await get(url, {}, signal);
  if (res.statusCode !== 200) throw new DownloadError(`download ${res.statusCode}`, 'network');
  const out = fs.createWriteStream(part, { mode: 0o600 });
  let got = 0;
  try {
    for await (const chunk of res) {
      if (signal?.aborted) throw new DownloadError('aborted', 'aborted');
      got += chunk.length;
      out.write(chunk);
      onProgress?.({ got, total: bytes });
    }
  } finally { await new Promise(r => out.end(r)); }
  if (bytes && got !== bytes) throw new DownloadError(`short read ${got}/${bytes}`, 'network');
  const sum = await sha256File(part);
  if (sum !== sha256) { try { fs.rmSync(part, { force: true }); } catch {} throw new DownloadError(`sha256 ${sum}`, 'checksum'); }
  fs.renameSync(part, dest);
}
const isDownloadableModel = id => DOWNLOADABLE_MODELS.some(m => m.id === id);

// ── TranscribeRouter ─────────────────────────────────────────────────────────
class TranscribeRouter {
  /** deps: {readConfig, userDataPath, resourcesPath, platform, darwinMajor, groq, download, log} */
  constructor(deps) {
    this.deps = deps;
    this.platform = deps.platform ?? process.platform;
    this.darwinMajor = deps.darwinMajor ?? (this.platform === 'darwin' ? darwinMajorOf() : 0);
    this.groq = deps.groq ?? transcribeWithGroq;
    this.whisper = null;
    this.whisperModelPath = null;
    this.speech = null;
    this.speechWarmed = null;
    this.whisperStarting = null;
    this.download = null;
  }
  log(line) { this.deps.log?.(`[transcribe] ${line}`); }
  config() { return withTranscribeDefaults(this.deps.readConfig().transcribe); }

  modelPath(id) {
    const info = WHISPER_MODELS[id];
    if (info.url) return path.join(this.deps.userDataPath, 'models', info.file);
    return path.join(helperPaths(this.deps.resourcesPath, this.platform).modelsDir, info.file);
  }
  modelInstalledSync(id) { return fs.existsSync(this.modelPath(id)); }
  installed() { return { base: this.modelInstalledSync('base'), small: this.modelInstalledSync('small'), turbo: this.modelInstalledSync('turbo') }; }
  modelInUse(cfg = this.config()) { return whisperModelFor(cfg, this.installed()) ?? 'base'; }
  facts(cfg = this.config()) {
    const groqKey = typeof this.deps.readConfig().groqApiKey === 'string' && this.deps.readConfig().groqApiKey.trim().length > 0;
    return {
      platform: this.platform, darwinMajor: this.darwinMajor,
      appleAvailable: this.platform === 'darwin' && mdSpeechAvailable(this.deps.resourcesPath),
      whisperAvailable: helperAvailable(this.deps.resourcesPath, this.platform) && whisperModelFor(cfg, this.installed()) !== null,
      groqKey,
    };
  }
  words(cfg = this.config()) { return vocabularyFor(cfg.customWords, cfg.defaultVocabulary, cfg.hiddenDefaults); }
  whisperPrompt(cfg = this.config()) {
    return buildWhisperPrompt({ defaultWords: shippedWordsFor(cfg.defaultVocabulary, cfg.hiddenDefaults), customWords: cfg.customWords });
  }
  status() {
    const cfg = this.config(); const f = this.facts(cfg); const prompt = this.whisperPrompt(cfg);
    return {
      platform: this.platform,
      engines: { apple: appleUsable(f), whisper: f.whisperAvailable, groq: f.groqKey },
      chosen: { dictation: chooseEngine(cfg.engine, 'dictation', f), meeting: chooseEngine(cfg.engine, 'meeting', f) },
      model: { selected: cfg.model, inUse: this.modelInUse(cfg), installed: this.installed(),
               path: { base: this.modelPath('base'), small: this.modelPath('small'), turbo: this.modelPath('turbo') },
               downloading: this.download?.id ?? null },
      words: { total: this.words(cfg).length, custom: cfg.customWords.length,
               whisperKept: prompt ? prompt.split(', ').length : 0, whisperPromptChars: prompt.length },
      config: cfg,
      warming: this.whisperStarting !== null,
    };
  }
  canTranscribe(mode = 'meeting') { const cfg = this.config(); return chooseEngine(cfg.engine, mode, this.facts(cfg)) !== null; }

  downloadModel(id, onProgress) {
    const info = WHISPER_MODELS[id];
    if (!info.url) return Promise.resolve({ ok: false, error: 'bundled', code: 'bundled' });
    if (this.download) {
      if (this.download.id === id) return this.download.done;
      return Promise.resolve({ ok: false, error: `another model is downloading (${this.download.id})`, code: 'busy' });
    }
    const url = info.url;
    const slot = { id, abort: new AbortController(), done: Promise.resolve({ ok: false, error: 'not started', code: 'other' }) };
    this.download = slot;
    slot.done = (async () => {
      const dest = this.modelPath(id);
      try {
        fs.mkdirSync(path.join(this.deps.userDataPath, 'models'), { recursive: true });
        if (await modelInstalled(dest, info.sha256)) return { ok: true, path: dest };
        await (this.deps.download ?? downloadModel)({ url, dest, sha256: info.sha256, bytes: info.bytes, onProgress, signal: slot.abort.signal });
        this.log(`downloaded ${info.file}`);
        return { ok: true, path: dest };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = e instanceof DownloadError ? e.code : (e?.code === 'ENOSPC' ? 'disk-full' : (e?.code === 'EACCES' || e?.code === 'EPERM' || e?.code === 'EROFS') ? 'no-permission' : 'other');
        this.log(`download of ${info.file} failed (${code}): ${msg}`);
        return { ok: false, error: msg, code };
      } finally { if (this.download === slot) this.download = null; }
    })();
    return slot.done;
  }
  cancelDownload() { if (!this.download) return false; this.download.abort.abort(); return true; }

  /** Transcribe then spell-check against the vocabulary. */
  async transcribe(call) {
    const r = await this.transcribeRaw(call);
    if (!r.ok) return r;
    const words = this.words();
    const fix = t => correctTranscript(t, words, this.config().customWords);
    return { ...r,
      ...(r.text ? { text: fix(r.text) } : {}),
      ...(r.segments ? { segments: r.segments.map(s => ({ ...s, text: fix(s.text) })) } : {}) };
  }

  async transcribeRaw(call) {
    const cfg = this.config();
    const mode = call.mode ?? 'dictation';
    const f = this.facts(cfg);
    const engine = chooseEngine(cfg.engine, mode, f);
    if (!engine) return { ok: false, error: 'no transcription engine: the local helpers are missing and no Groq key is set' };
    const mime = (call.mimeType ?? 'audio/webm').split(';')[0].trim().toLowerCase();
    const isWav = mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave';
    if (isWav && silentWav(toBuffer(call.audio))) {
      this.log(`${mode}: silent clip, nothing sent to ${engine}`);
      return { ok: true, text: '' };
    }
    if (engine === 'groq') return this.viaGroq(call);
    if (!isWav) {
      if (f.groqKey) return this.viaGroq(call);
      return { ok: false, error: `local transcription needs wav audio, got ${mime}` };
    }
    const tmp = path.join(os.tmpdir(), `md-transcribe-${crypto.randomUUID()}.wav`);
    try {
      fs.writeFileSync(tmp, toBuffer(call.audio), { mode: 0o600 });
      const failed = []; const errors = [];
      let heardNothing = false;
      let next = engine;
      while (next) {
        const started = Date.now();
        try {
          if (next === 'groq') {
            const r = await this.viaGroq(call);
            if (r.ok || errors.length === 0) return r;
            return { ok: false, error: [...errors, `groq: ${r.error ?? 'failed'}`].join('; ') };
          }
          const { text, segments } = next === 'apple'
            ? await this.viaApple(tmp, mode, this.words(cfg))
            : await this.viaWhisper(tmp, mode, cfg);
          this.log(`${next} ${mode} ${Date.now() - started} ms, ${text.length} chars${failed.length ? ` (after ${failed.join(', ')} failed)` : ''}`);
          if (!text && mode === 'dictation') {
            const tried = [...failed, next];
            const other = chooseEngine('auto', mode, {
              ...f, groqKey: false,
              appleAvailable: f.appleAvailable && !tried.includes('apple'),
              whisperAvailable: f.whisperAvailable && !tried.includes('whisper'),
            });
            if (other && !tried.includes(other)) {
              this.log(`${next} ${mode} heard nothing; trying ${other}`);
              heardNothing = true; failed.push(next); next = other; continue;
            }
          }
          return call.timestamps && segments?.length ? { ok: true, text, segments } : { ok: true, text };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.log(`${next} ${mode} failed: ${msg}`);
          failed.push(next); errors.push(`${next}: ${msg}`);
          next = chooseEngine('auto', mode, {
            ...f,
            appleAvailable: f.appleAvailable && !failed.includes('apple'),
            whisperAvailable: f.whisperAvailable && !failed.includes('whisper'),
          });
          if (next && failed.includes(next)) next = null;
          if (heardNothing && next === 'groq') next = null;
        }
      }
      if (heardNothing) return { ok: true, text: '' };
      return { ok: false, error: errors.join('; ') };
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  }

  /** Raw 16 kHz PCM16 → text (the any-app loop on non-Mac). */
  async transcribePcm16(req) {
    const bytes = req.pcm16.buffer.slice(req.pcm16.byteOffset, req.pcm16.byteOffset + req.pcm16.byteLength - (req.pcm16.byteLength % 2));
    const wav = Buffer.from(encodeWav(new Int16Array(bytes), req.sampleRate));
    const r = await this.transcribe({ audio: wav, mimeType: 'audio/wav', filename: 'anyapp.wav', mode: req.mode ?? 'dictation' });
    if (!r.ok) throw new Error(r.error ?? 'transcription failed');
    return { text: r.text ?? '' };
  }

  viaGroq(call) {
    const cfg = this.deps.readConfig();
    return this.groq({ ...call, apiKey: cfg.groqApiKey ?? '', model: call.model ?? cfg.freeflowModel ?? DEFAULT_GROQ_MODEL });
  }
  speechHelper() {
    this.speech ??= new MdSpeech(mdSpeechPath(this.deps.resourcesPath));
    const s = this.speech;
    if (this.speechWarmed !== s) {
      this.speechWarmed = s;
      void s.install('en_US').then(() => s.warm('en_US'))
        .then(r => this.log(`md-speech warm in ${r.ms} ms`))
        .catch(e => this.log(`md-speech warm failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    return s;
  }
  warmUp() {
    const s = this.status();
    if (s.chosen.dictation === 'apple') this.speechHelper();
    if (s.chosen.dictation === 'whisper') {
      const started = Date.now();
      void this.whisperReady(this.config())
        .then(() => this.log(`md-whisper warm in ${Date.now() - started} ms`))
        .catch(e => this.log(`md-whisper warm failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  whisperReady(cfg) {
    if (this.whisperStarting) return this.whisperStarting;
    if (this.whisper && this.whisper.running) return Promise.resolve(this.whisper);
    const modelPath = this.modelPath(this.modelInUse(cfg));
    this.whisper?.stop();
    const w = new WhisperHelper({ binary: helperPaths(this.deps.resourcesPath, this.platform).binary, model: modelPath, onLog: l => this.log(`whisper: ${l}`) });
    this.whisper = w;
    const starting = w.start().then(() => { this.whisperModelPath = modelPath; return w; });
    this.whisperStarting = starting;
    const clear = () => { if (this.whisperStarting === starting) this.whisperStarting = null; };
    starting.then(clear, clear);
    return starting;
  }
  async viaApple(audioPath, mode, words) {
    const r = await this.speechHelper().transcribe({ audioPath, mode, words, stream: false, autoInstall: true });
    return { text: r.text.trim(), segments: r.segments };
  }
  async viaWhisper(audioPath, mode, cfg) {
    const modelPath = this.modelPath(this.modelInUse(cfg));
    const whisper = await this.whisperReady(cfg);
    const prompt = this.whisperPrompt(cfg);
    const swap = this.whisperModelPath !== modelPath ? { model: modelPath } : {};
    const r = await whisper.transcribe({ audioPath, mode, prompt: prompt || undefined, ...swap });
    this.whisperModelPath = modelPath;
    return { text: r.text.trim(), segments: r.segments };
  }
  stop() {
    this.whisper?.stop(); this.whisper = null;
    void this.speech?.stop().catch(() => {});
  }
}

module.exports = {
  TranscribeRouter, WhisperHelper, MdSpeech,
  transcribeWithGroq, correctTranscript, vocabularyFor, shippedWordsFor,
  buildWhisperPrompt, withTranscribeDefaults, chooseEngine, whisperModelFor,
  encodeWav, wavPcm16, silentWav, loudestWindow,
  helperPaths, helperAvailable, mdSpeechPath, mdSpeechAvailable,
  downloadModel, modelInstalled, sha256File, DownloadError,
  WHISPER_MODELS, DEFAULT_TRANSCRIBE, DEFAULT_TRANSCRIBE_VOCABULARY,
  SHIPPED_VOCABULARY, MISHEARINGS, ENGINES, MODELS, DOWNLOADABLE_MODELS,
  isDownloadableModel, defaultPushToTalkKeyFor, darwinMajorOf,
  DEFAULT_GROQ_MODEL, GROQ_TRANSCRIBE_URL, MAX_AUDIO_BYTES,
  DEFAULT_PUSH_TO_TALK_KEY, OLD_PUSH_TO_TALK_KEY, WHISPER_PROMPT_MAX_CHARS,
  APPLE_MIN_DARWIN_MAJOR, MAX_CUSTOM_WORDS, MAX_CUSTOM_WORD_CHARS,
};

'use strict';
/**
 * transcribe:* / freeflow:* IPC surface — verbatim port of reference
 * index.js ~36883-36960. ctx.voice is the TranscribeRouter; the anyApp
 * group exposes ctx.syncAnyAppToConfig + the loop it created so
 * afterTranscribeChange can stop it verbatim.
 */
const {
  withTranscribeDefaults, isDownloadableModel, DEFAULT_GROQ_MODEL,
  MAX_CUSTOM_WORDS, MAX_CUSTOM_WORD_CHARS,
} = require('../voice');

// verbatim cleanCustomWords (voice.js local, not exported)
function cleanCustomWords(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n|,/) : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const w = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_WORD_CHARS);
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= MAX_CUSTOM_WORDS) break;
  }
  return out;
}

function register(ctx) {
  const { ipcMain, BrowserWindow } = ctx;
  const getTranscribeRouter = () => ctx.voice;
  const puck = () => ctx.puckRuntime ?? require('../puck-runtime');
  const anyAppLoopGet = () => (typeof ctx.anyAppLoop === 'function' ? ctx.anyAppLoop() : null) ?? ctx.anyApp ?? null;
  const anyAppLoopClear = () => { try { ctx.anyApp?.stop?.(); } catch {} };

  async function afterTranscribeChange(engineBefore, t = withTranscribeDefaults(ctx.readConfig().transcribe)) {
    if (getTranscribeRouter().status().chosen.dictation !== engineBefore && anyAppLoopGet()) {
      await anyAppLoopGet().stop();
      anyAppLoopClear();
      if (ctx.anyAppLoopRef) ctx.anyAppLoopRef.loop = null;
    }
    await ctx.syncAnyAppToConfig?.(t);
    puck().puckTranscribeChanged?.();
  }

  ipcMain.handle('transcribe:status', () => getTranscribeRouter().status());
  ipcMain.handle('transcribe:setConfig', async (_evt, patch) => {
    const p = patch ?? {};
    const cur = withTranscribeDefaults(ctx.readConfig().transcribe);
    const next = withTranscribeDefaults({
      ...cur,
      ...p.engine !== void 0 ? { engine: p.engine } : {},
      ...p.model !== void 0 ? { model: p.model } : {},
      ...p.customWords !== void 0 ? { customWords: cleanCustomWords(p.customWords) } : {},
      ...p.defaultVocabulary !== void 0 ? { defaultVocabulary: p.defaultVocabulary } : {},
      ...p.hiddenDefaults !== void 0 ? { hiddenDefaults: cleanCustomWords(p.hiddenDefaults) } : {},
      ...p.pushToTalkKey !== void 0 ? { pushToTalkKey: p.pushToTalkKey } : {},
      ...p.anyApp !== void 0 ? { anyApp: p.anyApp } : {},
      ...p.meetingSystemAudio !== void 0 ? { meetingSystemAudio: p.meetingSystemAudio } : {},
      ...p.meetingKey !== void 0 ? { meetingKey: p.meetingKey } : {},
      ...p.captureKey !== void 0 ? { captureKey: p.captureKey } : {},
      ...p.dictationSounds !== void 0 ? { dictationSounds: p.dictationSounds } : {},
      ...p.dictation !== void 0 ? { dictation: p.dictation } : {},
      ...p.dismissed !== void 0 ? { dismissed: p.dismissed } : {},
      chosen: [...cur.chosen, ...p.anyApp !== void 0 ? ['anyApp'] : [], ...p.pushToTalkKey !== void 0 ? ['pushToTalkKey'] : [], ...p.model !== void 0 ? ['model'] : []],
    });
    const engineBefore = getTranscribeRouter().status().chosen.dictation;
    ctx.writeConfig({ transcribe: next });
    await afterTranscribeChange(engineBefore, next);
    await ctx.syncMeetingHotkeyToConfig?.(next);
    await ctx.syncCaptureHotkeyToConfig?.(next);
    return { ok: true, config: next, status: getTranscribeRouter().status() };
  });
  ipcMain.handle('transcribe:downloadModel', async (_evt, id) => {
    if (!isDownloadableModel(id)) return { ok: false, error: 'unknown model', code: 'other' };
    const engineBefore = getTranscribeRouter().status().chosen.dictation;
    const r = await getTranscribeRouter().downloadModel(id, (received, total) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('transcribe:downloadProgress', { id, received, total });
      }
    });
    if (r.ok) await afterTranscribeChange(engineBefore);
    return r;
  });
  ipcMain.handle('transcribe:cancelDownload', () => ({ ok: getTranscribeRouter().cancelDownload() }));
  ipcMain.handle('freeflow:setConfig', async (_evt, patch) => {
    const p = patch ?? {};
    const next = {};
    if (typeof p.apiKey === 'string') next.groqApiKey = p.apiKey.trim() || void 0;
    if (typeof p.model === 'string') next.freeflowModel = p.model.trim() || DEFAULT_GROQ_MODEL;
    const engineBefore = getTranscribeRouter().status().chosen.dictation;
    ctx.writeConfig(next);
    if (next.groqApiKey !== void 0 || typeof p.apiKey === 'string') await afterTranscribeChange(engineBefore);
    return { ok: true };
  });
  ipcMain.handle('freeflow:transcribe', async (_evt, arg) => {
    const cfg = ctx.readConfig();
    const a = arg ?? {};
    if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) {
      return { ok: false, error: 'no audio' };
    }
    const out = await getTranscribeRouter().transcribe({
      mode: 'dictation',
      audio: a.audio,
      mimeType: typeof a.mimeType === 'string' ? a.mimeType : void 0,
      filename: typeof a.filename === 'string' ? a.filename : void 0,
      model: cfg.freeflowModel || DEFAULT_GROQ_MODEL,
      language: typeof a.language === 'string' && a.language ? a.language : void 0,
    });
    if (out.ok) ctx.analytics?.trackFeature?.('voice_dictation');
    return out;
  });
}

module.exports = { register };

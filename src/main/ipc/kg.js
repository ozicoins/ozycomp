'use strict';
/**
 * kg:* IPC surface — verbatim port of reference index.js ~36031-36053 +
 * dialog:attachFiles ~36071 (its verbatim helpers attachDialogOptions /
 * asAttachWant / ATTACH_FILTERS live here since this is the dialog group).
 *
 * The reference `knowledge` object exposes status/list/search/get/remove/
 * ingestFile; the clone's KnowledgeManager (../kg.js) exposes the same calls
 * as stats()/list()/search()/getDoc()/remove()/ingest() — thin adapters keep
 * the renderer-facing shapes verbatim:
 *   status() → {enabled, root, docCount, chunkCount, byModality}
 *   search() → hits already carry {docId, chunk, score, snippet, title}
 *   ingestFile(srcPath, {tags}) → {docId, chunkCount} from the meta row
 */
const fs = require('node:fs');

const ATTACH_FILTERS = [
  { name: 'All Files', extensions: ['*'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff', 'avif'] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpg', 'mpeg'] },
];
function mixesFilesAndFolders(platform) { return platform === 'darwin'; }
function attachDialogOptions(platform, want = 'any') {
  const kind = want === 'any' && !mixesFilesAndFolders(platform) ? 'files' : want;
  if (kind === 'folders') return { title: 'Attach folders', properties: ['openDirectory', 'multiSelections'] };
  if (kind === 'files') return { title: 'Attach files', properties: ['openFile', 'multiSelections'], filters: ATTACH_FILTERS };
  return { title: 'Attach files or folders', properties: ['openFile', 'openDirectory', 'multiSelections'], filters: ATTACH_FILTERS };
}
function attachName(p2, isFolder) {
  const parts = p2.replace(/[\\/]+$/, '').split(/[\\/]/);
  const base = parts.pop() || p2;
  return isFolder ? `${base}/` : base;
}
function asAttachWant(v) { return v === 'files' || v === 'folders' ? v : 'any'; }

function register(ctx) {
  const { ipcMain, BrowserWindow, dialog } = ctx;
  const knowledge = {
    status: () => {
      const kg = ctx.harness?.kg;
      if (!kg) return { enabled: false, root: null, docCount: 0, chunkCount: 0, byModality: {} };
      const s = kg.enabled() ? kg.stats() : { docs: 0, chunks: 0, byModality: {} };
      return {
        enabled: kg.enabled(),
        root: kg.root,
        docCount: s.docs ?? s.docCount ?? 0,
        chunkCount: s.chunks ?? s.chunkCount ?? 0,
        byModality: s.byModality ?? {},
      };
    },
    list: () => ctx.harness?.kg?.list() ?? [],
    search: (q, limit) => ctx.harness?.kg?.search(q, limit) ?? [],
    get: (id) => ctx.harness?.kg?.getDoc(id) ?? null,
    remove: (id) => ctx.harness?.kg?.remove(id) ?? false,
    ingestFile: (srcPath, opts) => {
      const meta = ctx.harness.kg.ingest(srcPath, opts ?? {});
      return { docId: meta.id ?? meta.docId, chunkCount: meta.chunks ?? meta.chunkCount ?? 0 };
    },
  };

  ipcMain.handle('kg:status', () => knowledge.status());
  ipcMain.handle('kg:list', () => knowledge.list());
  ipcMain.handle('kg:search', (_evt, query, limit) => {
    if (typeof query !== 'string' || !query.trim()) return [];
    return knowledge.search(query, typeof limit === 'number' ? limit : void 0);
  });
  ipcMain.handle('kg:get', (_evt, id) => typeof id === 'string' && id ? knowledge.get(id) : null);
  ipcMain.handle('kg:remove', (_evt, id) => ({ ok: typeof id === 'string' && id ? knowledge.remove(id) : false }));
  ipcMain.handle('kg:ingestFiles', (_evt, payload) => {
    const p = payload ?? {};
    const paths = Array.isArray(p.paths) ? p.paths.filter((x) => typeof x === 'string') : [];
    const tags = Array.isArray(p.tags) ? p.tags.filter((x) => typeof x === 'string') : void 0;
    const results = paths.map((srcPath) => {
      try {
        const r = knowledge.ingestFile(srcPath, { tags });
        return { ok: true, srcPath, docId: r.docId, chunkCount: r.chunkCount };
      } catch (e) {
        return { ok: false, srcPath, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { results };
  });
  ipcMain.handle('kg:addFiles', async (evt) => {
    const win2 = BrowserWindow.fromWebContents(evt.sender);
    if (!win2) return { ok: false, error: 'no window' };
    const res = await dialog.showOpenDialog(win2, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add documents to the Knowledge Graph',
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'cancelled' };
    const results = res.filePaths.map((srcPath) => {
      try {
        const r = knowledge.ingestFile(srcPath);
        return { ok: true, srcPath, docId: r.docId, chunkCount: r.chunkCount };
      } catch (e) {
        return { ok: false, srcPath, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { ok: true, results };
  });
  ipcMain.handle('dialog:attachFiles', async (evt, want) => {
    const win2 = BrowserWindow.fromWebContents(evt.sender);
    if (!win2) return { ok: false, error: 'no window' };
    const res = await dialog.showOpenDialog(win2, attachDialogOptions(process.platform, asAttachWant(want)));
    if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'cancelled' };
    const isFolder = (p) => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    };
    return { ok: true, files: res.filePaths.map((p) => ({ path: p, name: attachName(p, isFolder(p)) })) };
  });
}

module.exports = { register };

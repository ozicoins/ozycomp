'use strict';
/**
 * Verbatim port — `fs` IPC group (11 channels).
 * Reference: out/main/index.js handlers at lines 35219–35293; helpers verbatim
 * from lines 123–503 (MIME_BY_EXT, extensionOf, imageMimeForPath, lexicalJoin,
 * canonicalize, hasSymlinkComponent, safeResolve, open flags, listDir,
 * readFileText, readFileBinary, writeFileText, SEARCH_*, buildMatcher,
 * searchInRoot, badName, makeDirIn, createFileIn, renameIn, expandTilde,
 * statAbs). File ops confined to the workspace root via safeResolve.
 */
const node_fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const promises = require('node:fs/promises');
const electron = require('electron');

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml'
};
function extensionOf(p) {
  if (typeof p !== 'string') return '';
  const clean2 = p.split('#')[0].split('?')[0];
  const base = clean2.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}
function imageMimeForPath(p) {
  return MIME_BY_EXT[extensionOf(p)] ?? null;
}
function lexicalJoin(root, rel) {
  const absRoot = path.resolve(root);
  const absPath = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(absRoot, rel);
  const rel2 = path.relative(absRoot, absPath);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) return null;
  return { absRoot, absPath };
}
async function canonicalize(realRoot, absPath) {
  let probe = absPath;
  const tail = [];
  for (; ; ) {
    try {
      const real2 = await promises.realpath(probe);
      const full = tail.length ? path.resolve(real2, ...tail) : real2;
      const r = path.relative(realRoot, full);
      if (r.startsWith('..') || path.isAbsolute(r)) return null;
      return full;
    } catch (e) {
      if (e.code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
}
async function hasSymlinkComponent(realRoot, absPath) {
  let cur = realRoot;
  for (const part of path.relative(realRoot, absPath).split(path.sep).filter(Boolean)) {
    cur = path.resolve(cur, part);
    try {
      if ((await promises.lstat(cur)).isSymbolicLink()) return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}
async function safeResolve(root, rel) {
  const lex = lexicalJoin(root, rel);
  if (!lex) return null;
  let realRoot;
  try {
    realRoot = await promises.realpath(lex.absRoot);
  } catch {
    return null;
  }
  const abs = await canonicalize(realRoot, lex.absPath);
  if (!abs) return null;
  if (await hasSymlinkComponent(realRoot, abs)) return null;
  return abs;
}
const READ_FLAGS = node_fs.constants.O_RDONLY | (node_fs.constants.O_NOFOLLOW | 0) | (node_fs.constants.O_NONBLOCK | 0);
const WRITE_FLAGS = node_fs.constants.O_WRONLY | node_fs.constants.O_CREAT | node_fs.constants.O_TRUNC | (node_fs.constants.O_NOFOLLOW | 0);
function openForRead(abs) {
  return promises.open(abs, READ_FLAGS);
}
async function listDir(root, rel) {
  const abs = await safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const names = await promises.readdir(abs);
    const entries = await Promise.all(names.map(async (name) => {
      try {
        const s = await promises.stat(path.join(abs, name));
        return { name, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
      } catch {
        return { name, isDir: false, size: 0, mtime: 0 };
      }
    }));
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
const MAX_READ_BYTES = 2 * 1024 * 1024;
async function readFileText(root, rel) {
  const abs = await safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  let fh;
  try {
    fh = await openForRead(abs);
    const s = await fh.stat();
    if (!s.isFile()) return { ok: false, error: 'not a regular file' };
    if (s.size > MAX_READ_BYTES) {
      return { ok: false, error: `file too large (${(s.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const buf = await fh.readFile();
    if (buf.includes(0)) return { ok: false, error: 'binary file (not displayable)' };
    return { ok: true, content: buf.toString('utf8'), path: abs, size: s.size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await fh?.close().catch(() => {
    });
  }
}
const MAX_BINARY_READ_BYTES = 10 * 1024 * 1024;
async function readFileBinary(root, rel, maxBytes = MAX_BINARY_READ_BYTES) {
  const abs = await safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  let fh;
  try {
    fh = await openForRead(abs);
    const s = await fh.stat();
    if (!s.isFile()) return { ok: false, error: 'not a regular file' };
    if (s.size > maxBytes) {
      return { ok: false, error: `file too large (${(s.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const buf = await fh.readFile();
    if (buf.byteLength > maxBytes) {
      return { ok: false, error: 'file grew past the size limit while reading' };
    }
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    return {
      ok: true,
      bytes,
      mime: imageMimeForPath(abs) ?? 'application/octet-stream',
      path: abs,
      size: s.size
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await fh?.close().catch(() => {
    });
  }
}
async function writeFileText(root, rel, content) {
  const abs = await safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  let fh;
  try {
    fh = await promises.open(abs, WRITE_FLAGS, 438);
    await fh.writeFile(content, 'utf8');
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await fh?.close().catch(() => {
    });
  }
}
const SEARCH_SKIP_DIRS = /* @__PURE__ */ new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  'vendor',
  'Pods',
  '.gradle',
  '.dart_tool'
]);
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
const SEARCH_SNIFF_BYTES = 8192;
const MAX_LINE_CHARS = 400;
function buildMatcher(query, o) {
  const flags = o.caseSensitive ? 'g' : 'gi';
  let source;
  if (o.regex) {
    source = query;
  } else {
    source = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (o.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, flags);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'bad pattern' };
  }
}
async function searchInRoot(root, query, opts = {}) {
  const absRoot = await safeResolve(root, '');
  if (!absRoot) return { ok: false, error: 'path escapes root' };
  if (!query) return { ok: true, hits: [], truncated: false, filesScanned: 0 };
  const matcher = buildMatcher(query, opts);
  if ('error' in matcher) return { ok: false, error: matcher.error };
  const maxHits = Math.min(Math.max(opts.maxHits ?? 500, 1), 5e3);
  const deadline = Date.now() + Math.min(Math.max(opts.timeBudgetMs ?? 5e3, 250), 3e4);
  const hits = [];
  let filesScanned = 0;
  let truncated = false;
  const walk = async (dirAbs, dirRel) => {
    if (truncated) return;
    let entries;
    try {
      entries = await promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dirAbs, e.name), rel);
        continue;
      }
      if (!e.isFile()) continue;
      let buf;
      try {
        const s = await promises.stat(path.join(dirAbs, e.name));
        if (s.size > SEARCH_MAX_FILE_BYTES) continue;
        buf = await promises.readFile(path.join(dirAbs, e.name));
      } catch {
        continue;
      }
      if (buf.subarray(0, SEARCH_SNIFF_BYTES).includes(0)) continue;
      filesScanned++;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        matcher.lastIndex = 0;
        let m;
        while ((m = matcher.exec(line)) !== null) {
          hits.push({
            rel,
            line: i + 1,
            col: m.index + 1,
            text: line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line,
            length: m[0].length
          });
          if (hits.length >= maxHits) {
            truncated = true;
            return;
          }
          if (m[0].length === 0) matcher.lastIndex++;
        }
      }
    }
  };
  await walk(absRoot, '');
  return { ok: true, hits, truncated, filesScanned };
}
function badName(rel) {
  if (!rel || !rel.trim()) return 'name is empty';
  if (rel.includes('\0')) return 'name contains a null byte';
  if (rel.length > 1024) return 'name is too long';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return 'name is empty';
  for (const p of parts) {
    if (p === '.' || p === '..') return 'name contains a path segment that is not a name';
    if (p.trim() !== p) return 'name starts or ends with a space';
  }
  return null;
}
async function makeDirIn(root, rel) {
  const bad = badName(rel);
  if (bad) return { ok: false, error: bad };
  const abs = await safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    await promises.mkdir(abs, { recursive: false });
    return { ok: true, path: abs, rel };
  } catch (e) {
    const err = e;
    if (err.code === 'EEXIST') return { ok: false, error: 'already exists' };
    if (err.code === 'ENOENT') return { ok: false, error: 'the folder above it does not exist' };
    return { ok: false, error: err.message ?? String(e) };
  }
}
async function createFileIn(root, rel) {
  const bad = badName(rel);
  if (bad) return { ok: false, error: bad };
  const abs = await safeResolve(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const h = await promises.open(abs, 'wx');
    await h.close();
    return { ok: true, path: abs, rel };
  } catch (e) {
    const err = e;
    if (err.code === 'EEXIST') return { ok: false, error: 'already exists' };
    if (err.code === 'ENOENT') return { ok: false, error: 'the folder above it does not exist' };
    return { ok: false, error: err.message ?? String(e) };
  }
}
async function renameIn(root, fromRel, toRel) {
  const bad = badName(fromRel) ?? badName(toRel);
  if (bad) return { ok: false, error: bad };
  const from = await safeResolve(root, fromRel);
  const to = await safeResolve(root, toRel);
  if (!from || !to) return { ok: false, error: 'path escapes root' };
  if (from === to) return { ok: true, path: to, rel: toRel };
  try {
    await promises.stat(to);
    return { ok: false, error: 'already exists' };
  } catch {
  }
  try {
    await promises.stat(path.dirname(to));
  } catch {
    return { ok: false, error: 'the folder above it does not exist' };
  }
  try {
    await promises.rename(from, to);
    return { ok: true, path: to, rel: toRel };
  } catch (e) {
    const err = e;
    if (err.code === 'ENOENT') return { ok: false, error: 'not found' };
    return { ok: false, error: err.message ?? String(e) };
  }
}
function expandTilde(p) {
  if (typeof p !== 'string') return p;
  const t = p.trim();
  if (!t) return p;
  let out = t;
  if (t === '~') out = os.homedir();
  else if (t.startsWith('~/') || t.startsWith('~\\')) out = path.join(os.homedir(), t.slice(2));
  if (!path.isAbsolute(out)) return t;
  return path.resolve(out);
}
async function statAbs(p) {
  const abs = expandTilde(p);
  if (!path.isAbsolute(abs)) return { exists: false, isFile: false, path: p };
  try {
    const s = await promises.stat(abs);
    return { exists: true, isFile: s.isFile(), path: abs };
  } catch {
    return { exists: false, isFile: false, path: abs };
  }
}

function register(ctx) {
  const ipcMain = ctx.ipcMain;
  const shell = ctx.shell ?? electron.shell;
  ipcMain.handle('fs:listDir', (_evt, root, rel) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return listDir(root, rel);
  });
  ipcMain.handle('fs:readFile', (_evt, root, rel) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return readFileText(root, rel);
  });
  ipcMain.handle('fs:readBinary', (_evt, root, rel) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return readFileBinary(root, rel);
  });
  ipcMain.handle('fs:writeFile', (_evt, root, rel, content) => {
    if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
      return { ok: false, error: 'invalid args' };
    }
    return writeFileText(root, rel, content);
  });
  ipcMain.handle('fs:statAbs', (_evt, p) => {
    if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) {
      return { exists: false, isFile: false, path: '' };
    }
    return statAbs(p);
  });
  ipcMain.handle('fs:revealPath', async (_evt, p) => {
    if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
      return { ok: false, error: 'bad request' };
    }
    const st = await statAbs(p);
    if (!st.exists) return { ok: false, error: 'not found' };
    if (st.isFile) {
      shell.showItemInFolder(st.path);
      return { ok: true };
    }
    const err = await shell.openPath(st.path);
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('fs:search', (_evt, root, query, opts) => {
    if (typeof root !== 'string' || typeof query !== 'string') return { ok: false, error: 'invalid args' };
    if (query.length > 1024) return { ok: false, error: 'query too long' };
    const o = opts && typeof opts === 'object' ? opts : {};
    return searchInRoot(root, query, {
      regex: o.regex === true,
      caseSensitive: o.caseSensitive === true,
      wholeWord: o.wholeWord === true,
      maxHits: typeof o.maxHits === 'number' ? o.maxHits : void 0
    });
  });
  ipcMain.handle('fs:mkdir', (_evt, root, rel) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return makeDirIn(root, rel);
  });
  ipcMain.handle('fs:createFile', (_evt, root, rel) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    return createFileIn(root, rel);
  });
  ipcMain.handle('fs:rename', (_evt, root, from, to) => {
    if (typeof root !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
      return { ok: false, error: 'invalid args' };
    }
    return renameIn(root, from, to);
  });
  ipcMain.handle('fs:trash', async (_evt, root, rel) => {
    if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
    if (!rel.trim() || rel.includes('\0')) return { ok: false, error: 'invalid args' };
    const abs = await safeResolve(root, rel);
    if (!abs) return { ok: false, error: 'path escapes root' };
    if (abs === await safeResolve(root, '')) return { ok: false, error: 'that is the workspace itself' };
    try {
      await shell.trashItem(abs);
      return { ok: true, path: abs };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

module.exports = { register, safeResolve, openForRead };

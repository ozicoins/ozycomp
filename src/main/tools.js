'use strict';
/**
 * Tools — the "is everything installed" surface, verbatim from the reference:
 * BASE_TOOLS (prerequisites) + one engine row per provider preset, and
 * loadModelCatalog — the remote model-picker data with a 6h on-disk cache.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getText } = require('./skills-hub');
const { PROVIDERS, which } = require('./providers');

const MEMPALACE_PIN = { version: '3.3.5', python: '3.10' };
const MEMPALACE_INSTALL = `uv tool install mempalace==${MEMPALACE_PIN.version} --python ${MEMPALACE_PIN.python}`;
const MEMPALACE_SWITCH = `${MEMPALACE_INSTALL} --force`;

const BASE_TOOLS = [
  {
    id: 'uv', bin: 'uv', label: 'uv', kind: 'prerequisite', essential: true,
    why: 'Installs and runs mempalace. A self-contained Python toolchain — it does not touch any Python you already have.',
    install: {
      posix: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
    },
    docsUrl: 'https://docs.astral.sh/uv/',
  },
  {
    id: 'mempalace', bin: null, label: 'MemPalace — semantic memory', kind: 'memory', essential: true,
    why: 'Meaning-based recall across everything your agents have learned. Without it they still keep plain markdown notes, but cannot search them by meaning.',
    install: { posix: MEMPALACE_INSTALL, win32: MEMPALACE_INSTALL },
    note: 'Needs uv first.',
  },
  {
    id: 'git', bin: 'git', label: 'git', kind: 'prerequisite', essential: true,
    why: 'Worktrees let agents work in parallel without fighting over one checkout, and the hive keeps its own history in git.',
    install: {
      posix: 'xcode-select --install   # macOS · or: sudo apt install git',
      win32: 'winget install --id Git.Git -e',
    },
    docsUrl: 'https://git-scm.com/downloads',
  },
  {
    id: 'node', bin: 'node', label: 'Node.js', kind: 'prerequisite', essential: false,
    why: 'Runs the npm-installed agent engines (OpenCode, and Claude Code on machines without the native build).',
    install: { posix: '', win32: '' },
    note: 'The app installs this for you when an engine needs it — nothing to do by hand.',
    docsUrl: 'https://nodejs.org',
  },
];

function toolCatalog() {
  const engines = Object.values(PROVIDERS)
    .filter(p => p.id !== 'custom' && p.id !== 'shell' && !!p.defaultCommand)
    .map(p => ({
      id: `engine:${p.id}`,
      bin: p.defaultCommand,
      label: p.label,
      kind: 'engine',
      why: `Agent engine — ${p.defaultCommand}.`,
      // Claude Code is the recommended engine and the only one the floor
      // assumes by default, so it is the one "set up everything" installs.
      essential: p.id === 'claude',
      install: {
        posix: p.installCommand ?? p.nativeInstallCommand?.posix ?? '',
        win32: p.installCommand ?? p.nativeInstallCommand?.win32 ?? '',
      },
      docsUrl: p.docsUrl,
    }));
  return [...BASE_TOOLS, ...engines];
}

/**
 * tools:status — each catalog row resolved against PATH. `mempalace` presence
 * comes from the memory manager (its bin may live inside a uv tool dir), the
 * rest resolve with which().
 */
function toolsStatus({ mempalace } = {}) {
  const win = process.platform === 'win32';
  return toolCatalog().map(spec => {
    const installCommand = win ? spec.install.win32 : spec.install.posix;
    if (spec.id === 'mempalace') {
      return {
        ...spec, installCommand,
        found: !!mempalace?.available,
        path: mempalace?.bin ?? null,
        pinnedVersion: MEMPALACE_PIN.version,
        switchCommand: MEMPALACE_SWITCH,
      };
    }
    if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
    const resolved = which(spec.bin);
    const found = resolved && resolved !== spec.bin && fs.existsSync(resolved) ? resolved : (resolved && fs.existsSync(resolved) ? resolved : null);
    return { ...spec, installCommand, found: !!found, path: found };
  });
}

// ─── models:catalog ────────────────────────────────────────────────────────

const MODEL_CATALOG_URL = 'https://raw.githubusercontent.com/chaitanyagiri/ozycomp/main/docs/model-catalog.json';
const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1e3;
const MODEL_CATALOG_SCHEMA_VERSION = 1;
const MODEL_MAX = { id: 120, label: 60, key: 40, version: 24, providers: 40, models: 60 };

function strCap(value, cap) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > cap ? clean.slice(0, cap) : clean;
}
function parseModelEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = strCap(raw.label, MODEL_MAX.label);
  if (!label) return null;
  const model = { label };
  const id = strCap(raw.id, MODEL_MAX.id);
  if (id) model.id = id;
  const min = strCap(raw.minAppVersion, MODEL_MAX.version);
  const max = strCap(raw.maxAppVersion, MODEL_MAX.version);
  if (min) model.minAppVersion = min;
  if (max) model.maxAppVersion = max;
  return model;
}
function parseModelKey(key) {
  if (key.length > MODEL_MAX.key) return null;
  if (!/^[a-z][a-z0-9_-]*$/i.test(key)) return null;
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return null;
  return key;
}
function parseModelCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== MODEL_CATALOG_SCHEMA_VERSION) return null;
  if (!raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) return null;
  const providers = Object.create(null);
  let kept = 0;
  for (const [rawKey, rawList] of Object.entries(raw.providers)) {
    if (kept >= MODEL_MAX.providers) break;
    const key = parseModelKey(rawKey);
    if (!key || !Array.isArray(rawList)) continue;
    const models = [];
    const seen = new Set();
    for (const entry of rawList.slice(0, MODEL_MAX.models)) {
      const model = parseModelEntry(entry);
      if (!model) continue;
      const dedupe = model.id ?? '';
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      models.push(model);
    }
    if (!models.length && rawList.length > 0) continue;
    providers[key] = models;
    kept += 1;
  }
  if (!kept) return null;
  return { version: MODEL_CATALOG_SCHEMA_VERSION, providers: { ...providers } };
}

/**
 * loadModelCatalog(cachePath, {force}) — 6h TTL on disk; stale cache beats a
 * fetch failure (returns `stale: true`), null catalog when nothing works.
 */
async function loadModelCatalog(cachePath, opts = {}) {
  let cached = null;
  try {
    if (fs.existsSync(cachePath)) {
      const read = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const catalog = parseModelCatalog(read?.catalog);
      if (catalog && typeof read.fetchedAt === 'number') cached = { catalog, fetchedAt: read.fetchedAt };
    }
  } catch { cached = null; }
  if (cached && !opts.force && Date.now() - cached.fetchedAt < MODEL_CATALOG_TTL_MS)
    return { catalog: cached.catalog, fetchedAt: cached.fetchedAt, stale: false };
  try {
    const body = await getText(MODEL_CATALOG_URL, { timeoutMs: 8000 });
    const catalog = parseModelCatalog(JSON.parse(body));
    if (!catalog) throw new Error('not a model catalog');
    const payload = { catalog, fetchedAt: Date.now() };
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(payload));
    } catch {}
    return { ...payload, stale: false };
  } catch {
    if (cached) return { catalog: cached.catalog, fetchedAt: cached.fetchedAt, stale: true };
    return { catalog: null, fetchedAt: 0, stale: true };
  }
}

module.exports = {
  toolCatalog, toolsStatus, loadModelCatalog, parseModelCatalog,
  BASE_TOOLS, MEMPALACE_PIN, MEMPALACE_INSTALL, MEMPALACE_SWITCH,
  MODEL_CATALOG_URL, MODEL_CATALOG_TTL_MS,
};
